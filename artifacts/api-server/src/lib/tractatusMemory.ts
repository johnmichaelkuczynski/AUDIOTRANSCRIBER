import OpenAI from "openai";
import { and, asc, eq } from "drizzle-orm";
import { db, tractatusArchiveTable, tractatusTiersTable } from "@workspace/db";
import { logger } from "./logger";
import { ANTI_SYCOPHANCY } from "./coherencePrompts";

type Tree = Record<string, string>;

function client(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");
  return new OpenAI({ apiKey });
}

function parseObject(text: string): Tree {
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```[\s\S]*$/i, "").trim();
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first < 0 || last < first) throw new Error("Model did not return a JSON object");
  const value: unknown = JSON.parse(cleaned.slice(first, last + 1));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid memory tree");
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function skeletonTree(skeleton: Record<string, unknown>): Tree {
  const tree: Tree = {};
  let index = 0;
  const add = (tag: string, value: unknown) => {
    if (typeof value === "string" && value.trim()) tree[`0.${index++}`] = `${tag}: ${value.trim()}`;
  };
  add("ASSERTS", skeleton.thesis ?? skeleton.purpose);
  for (const step of Array.isArray(skeleton.steps) ? skeleton.steps : []) add("ASSERTS", step);
  const ledger = (skeleton.commitmentLedger ?? {}) as Record<string, unknown>;
  for (const [field, tag] of [["asserts", "ASSERTS"], ["rejects", "REJECTS"], ["assumes", "ASSUMES"], ["open", "OPEN"]] as const) {
    for (const value of Array.isArray(ledger[field]) ? ledger[field] : []) add(tag, value);
  }
  for (const term of Array.isArray(skeleton.terms) ? skeleton.terms : []) {
    if (term && typeof term === "object") {
      const item = term as Record<string, unknown>;
      add("KEY_TERM", `"${String(item.term ?? "")}" = ${String(item.definition ?? "")}`);
    } else add("KEY_TERM", term);
  }
  for (const entity of Array.isArray(skeleton.entities) ? skeleton.entities : []) add("ENTITY", entity);
  for (const speaker of Array.isArray(skeleton.speakerMap) ? skeleton.speakerMap : []) add("ENTITY", speaker);
  return tree;
}

export async function skeletonToTier0(skeleton: Record<string, unknown>, jobId: string, jobType: string): Promise<void> {
  const tree = skeletonTree(skeleton);
  const rendered = renderTree(tree);
  if (rendered.length > 6000) {
    throw new Error(
      `Immutable Tier 0 exceeds its 6,000-character budget (${rendered.length}); refusing to truncate coherence commitments`,
    );
  }
  await db.insert(tractatusTiersTable).values({ jobId, jobType, tier: 0, tree, nodeCount: Object.keys(tree).length })
    .onConflictDoNothing({ target: [tractatusTiersTable.jobId, tractatusTiersTable.jobType, tractatusTiersTable.tier] });
}

async function extractDelta(chunkText: string): Promise<Tree> {
  const completion = await client().chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    temperature: 0,
    messages: [
      { role: "system", content: `Extract a compact flat JSON memory tree from the completed chunk. Values must begin with one of ASSERTS, REJECTS, ASSUMES, OPEN, KEY_TERM, ENTITY, CROSS_REF, CONFLICT_FLAG. Use keys 1.0, 1.1, etc.\n\n${ANTI_SYCOPHANCY}` },
      { role: "user", content: chunkText },
    ],
  });
  return parseObject(completion.choices[0]?.message.content ?? "");
}

export async function updateLiveTier(jobId: string, jobType: string, chunkText: string): Promise<{ nodeCount: number; compressed: boolean }> {
  const delta = await extractDelta(chunkText);
  const [existing] = await db.select().from(tractatusTiersTable).where(and(eq(tractatusTiersTable.jobId, jobId), eq(tractatusTiersTable.jobType, jobType), eq(tractatusTiersTable.tier, 1)));
  const oldTree = (existing?.tree ?? {}) as Tree;
  const offset = Object.keys(oldTree).length;
  const appended = Object.fromEntries(Object.values(delta).map((value, index) => [`1.${offset + index}`, value]));
  const tree = { ...oldTree, ...appended };
  if (existing) {
    await db.update(tractatusTiersTable).set({ tree, nodeCount: Object.keys(tree).length, lastUpdate: new Date() }).where(eq(tractatusTiersTable.id, existing.id));
  } else {
    await db.insert(tractatusTiersTable).values({ jobId, jobType, tier: 1, tree, nodeCount: Object.keys(tree).length });
  }
  const compressed = Object.keys(tree).length >= 150;
  if (compressed) await compressTier(jobId, jobType, 1);
  return { nodeCount: Object.keys(tree).length, compressed };
}

export async function compressTier(jobId: string, jobType: string, sourceTier: number): Promise<void> {
  const [source] = await db.select().from(tractatusTiersTable).where(and(eq(tractatusTiersTable.jobId, jobId), eq(tractatusTiersTable.jobType, jobType), eq(tractatusTiersTable.tier, sourceTier)));
  if (!source) return;
  const sourceTree = source.tree as Tree;
  await db.insert(tractatusArchiveTable).values({ jobId, jobType, tier: sourceTier, treeSnapshot: sourceTree, nodeCountAtSnapshot: source.nodeCount, reason: "pre_compression" });
  const prompt = `${ANTI_SYCOPHANCY}\n\nCompress this flat memory tree to at most 80 entries. Return one valid JSON object only.\n\n${renderTree(sourceTree)}`;
  let compressed: Tree | null = null;
  let compressionError: unknown;
  for (let attempt = 0; attempt < 2 && !compressed; attempt += 1) {
    try {
      const completion = await client().chat.completions.create({
        model: "gpt-4o-mini",
        response_format: { type: "json_object" },
        temperature: 0,
        messages: [
          { role: "system", content: attempt === 0 ? prompt : `${ANTI_SYCOPHANCY}\nReturn only a simple valid JSON object containing the essential entries below.` },
          { role: "user", content: attempt === 0 ? "Compress now." : renderTree(sourceTree) },
        ],
      });
      compressed = parseObject(completion.choices[0]?.message.content ?? "");
    } catch (error) {
      compressionError = error;
    }
  }
  if (!compressed) {
    logger.error({ err: compressionError, jobId, sourceTier }, "Tractatus compression failed twice; archive remains canonical");
    return;
  }
  const protectedValues = Object.values(sourceTree).filter((value) => /\b(REJECTS|CONFLICT_FLAG):/.test(value));
  const surviving = new Set(Object.values(compressed));
  let protectedIndex = Object.keys(compressed).length;
  for (const value of protectedValues) {
    if (!surviving.has(value)) compressed[`P.${protectedIndex++}`] = value;
  }
  const nextTier = sourceTier + 1;
  const [target] = await db.select().from(tractatusTiersTable).where(and(eq(tractatusTiersTable.jobId, jobId), eq(tractatusTiersTable.jobType, jobType), eq(tractatusTiersTable.tier, nextTier)));
  const merged = { ...((target?.tree ?? {}) as Tree), ...compressed };
  if (target) await db.update(tractatusTiersTable).set({ tree: merged, nodeCount: Object.keys(merged).length, lastUpdate: new Date() }).where(eq(tractatusTiersTable.id, target.id));
  else await db.insert(tractatusTiersTable).values({ jobId, jobType, tier: nextTier, tree: merged, nodeCount: Object.keys(merged).length, parentTierId: source.id });
  const recent = Object.entries(sourceTree).slice(-30);
  await db.update(tractatusTiersTable).set({ tree: Object.fromEntries(recent), nodeCount: recent.length, compressionCount: source.compressionCount + 1, lastUpdate: new Date() }).where(eq(tractatusTiersTable.id, source.id));
  if (Object.keys(merged).length >= 150 + nextTier * 50) await compressTier(jobId, jobType, nextTier);
}

function renderTree(tree: Tree): string {
  return Object.entries(tree).map(([key, value]) => `${key}: ${value}`).join("\n");
}

function budgetTree(tree: Tree, budget: number, newestFirst: boolean): { text: string; exceeded: boolean } {
  const entries = Object.entries(tree);
  if (newestFirst) entries.reverse();
  const protectedEntries = entries.filter(([, value]) => /\b(REJECTS|CONFLICT_FLAG):/.test(value));
  const selected = [...protectedEntries];
  let used = protectedEntries.reduce((sum, [key, value]) => sum + key.length + value.length + 3, 0);
  for (const entry of entries) {
    if (protectedEntries.includes(entry)) continue;
    const size = entry[0].length + entry[1].length + 3;
    if (used + size > budget) continue;
    selected.push(entry);
    used += size;
  }
  return { text: selected.map(([key, value]) => `${key}: ${value}`).join("\n"), exceeded: used > budget };
}

export async function loadAllTiers(jobId: string, jobType: string) {
  return db.select().from(tractatusTiersTable).where(and(eq(tractatusTiersTable.jobId, jobId), eq(tractatusTiersTable.jobType, jobType))).orderBy(asc(tractatusTiersTable.tier));
}

export async function buildTieredPromptContext(jobId: string, jobType: string): Promise<string> {
  const tiers = await loadAllTiers(jobId, jobType);
  const sections: string[] = [];
  let deepBudgetRemaining = 1500;
  for (const row of tiers) {
    const budget = row.tier === 0 ? 6000 : row.tier === 1 ? 5000 : row.tier === 2 ? 2500 : deepBudgetRemaining;
    const rendered = budgetTree(row.tree as Tree, budget, row.tier === 1);
    if (row.tier === 0 && rendered.exceeded) {
      throw new Error("Immutable Tier 0 exceeds its 6,000-character prompt budget");
    }
    if (row.tier >= 3) deepBudgetRemaining = Math.max(0, deepBudgetRemaining - rendered.text.length);
    if (rendered.exceeded) logger.warn({ jobId, tier: row.tier, budget }, "Memory budget exceeded to preserve REJECTS or CONFLICT_FLAG");
    sections.push(`TIER ${row.tier}\n${rendered.text}`);
  }
  return sections.join("\n\n");
}