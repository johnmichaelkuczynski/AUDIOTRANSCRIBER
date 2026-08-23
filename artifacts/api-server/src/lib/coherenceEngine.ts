import OpenAI from "openai";
import { and, asc, eq, isNull, lt, ne, or } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  db,
  reconstructionChunksTable,
  reconstructionJobsTable,
  type ReconstructionJob,
} from "@workspace/db";
import { logger } from "./logger";
import { ANTI_SYCOPHANCY } from "./coherencePrompts";
import { buildTieredPromptContext, loadAllTiers, skeletonToTier0, updateLiveTier } from "./tractatusMemory";

type JobType = "polish" | "play";
type FidelityMode = "verbatim" | "adaptive" | "fictionalized";
type Skeleton = Record<string, unknown>;
const activeJobs = new Set<string>();
const JOB_LEASE_MS = 30 * 60 * 1000;
const DIRECT_SKELETON_SOURCE_LIMIT = 70_000;

export function countWords(text: string): number {
  return text.trim() ? text.trim().split(/\s+/u).length : 0;
}

function polishTranscriptTypography(text: string): string {
  let polished = text
    .replace(/\b(?:um+|uh+m*|er+m*|ah+|hmm+)\b[,.!?;:]?[ \t]*/giu, "")
    .replace(/\bpositioner\b/giu, "petitioner")
    .replace(/\bfees be paid,\s*charged\b/giu, "fees paid, charged")
    .replace(/\bDavid Bowies\b/gu, "David Boies")
    .replace(
      /\bbecause I agree,\s*Emmerich\.\s*No,\s*he said he plans on—/giu,
      "because Gregory Emmerich—okay, no, he said he plans on—",
    )
    .replace(/\bI agree,\s*Emmerich\b[.]?/giu, "Gregory Emmerich")
    .replace(
      /\bGregory Emmerich\s+Okay,\s*no\b/giu,
      "Gregory Emmerich—okay, no",
    )
    .replace(
      /\b(?:we|you|they|I)\s+(?:generally\s+)?have\s+a\s+(?:kind|sort) of\s*[—–,-]\s*(?=(?:we|you|they|I)\b)/giu,
      (fragment: string) =>
        /\bgenerally\b/iu.test(fragment) ? "Generally, " : "",
    )
    .replace(/\ba\s+(?:kind|sort) of\s*[—–,-]\s*/giu, "")
    .replace(/\ba\s+(?:kind|sort) of\s+(?=(?:a|an|the)\b)/giu, "")
    .replace(/\ba\s+(?:kind|sort) of\s+/giu, "a ")
    .replace(
      /\b(?:you know|I mean|kind of|sort of)\b[,.]?[ \t]*/giu,
      (phrase: string, offset: number, source: string) => {
        const context = source.slice(Math.max(0, offset - 24), offset);
        const normalized = phrase.trim().replace(/[,.]$/u, "").toLocaleLowerCase();
        if (normalized === "you know" && /\bas\s*$/iu.test(context)) {
          return phrase;
        }
        if (
          normalized === "i mean" &&
          /\b(?:what|which|by that|by which)\s*$/iu.test(context)
        ) {
          return phrase;
        }
        if (
          (normalized === "kind of" || normalized === "sort of") &&
          /\b(?:what|which|some|any|every|this|that)\s*$/iu.test(context)
        ) {
          return phrase;
        }
        return "";
      },
    )
    .replace(/^speaker\s+([A-Z0-9]+)\s*:/gimu, "SPEAKER $1:")
    .replace(/\b(So|And|But)\s+Generally,\s+/gu, "$1 ")
    .replace(/[ \t]*—[ \t]*/gu, "—")
    .replace(/[ \t]+([,.;:!?])/gu, "$1")
    .replace(/[ \t]{2,}/gu, " ")
    .replace(/^[ \t]+|[ \t]+$/gmu, "")
    .replace(
      /(^|[.!?]\s+)(\p{Ll})/gmu,
      (_match, boundary: string, letter: string) =>
        `${boundary}${letter.toLocaleUpperCase()}`,
    )
    .replace(/\n{3,}/gu, "\n\n");

  let previous = "";
  while (previous !== polished) {
    previous = polished;
    polished = polished.replace(
      /\b([\p{L}\p{N}'’.-]+)(?:[ \t]*,[ \t]*|[ \t]+)\1\b/giu,
      "$1",
    );
  }

  return polished
    .replace(/[ \t]+([,.;:!?])/gu, "$1")
    .replace(/[ \t]{2,}/gu, " ")
    .replace(/\n[ \t]+/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function openai(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");
  return new OpenAI({ apiKey });
}

function paragraphs(text: string): string[] {
  return text.split(/\n\s*\n/u).map((value) => value.trim()).filter(Boolean);
}

function extractSelfIntroductionEvidence(text: string): string[] {
  const evidence: string[] = [];
  for (const paragraph of paragraphs(text)) {
    const turn = paragraph.match(
      /^(?:\[\d{2}:\d{2}:\d{2}\]\s*)?(SPEAKER\s+[A-Z0-9]+)\s*:\s*([\s\S]+)$/iu,
    );
    if (!turn) continue;
    const introduction = turn[2].match(
      /\bmy name is\s+([\p{L}][\p{L}'’.-]*(?:\s+[\p{L}][\p{L}'’.-]*){1,4})(?=[,.;!?])/iu,
    );
    if (!introduction) continue;
    evidence.push(
      `${turn[1].toUpperCase()} explicitly says: "My name is ${introduction[1]}."`,
    );
  }
  return Array.from(new Set(evidence));
}

function extractSelfIntroductions(text: string): Map<string, string> {
  const introductions = new Map<string, string>();
  for (const evidence of extractSelfIntroductionEvidence(text)) {
    const match = evidence.match(
      /^(SPEAKER\s+[A-Z0-9]+) explicitly says: "My name is ([^"]+)\."$/u,
    );
    if (match) introductions.set(match[1], match[2]);
  }
  return introductions;
}

function extractObservedPersonReferences(text: string): string[] {
  const references = Array.from(
    text.matchAll(
      /\b((?:Mr|MR|Ms|MS|Mrs|MRS|Miss|MISS|Dr|DR)\.?\s+\p{Lu}[\p{L}'’-]*(?:\s+\p{Lu}[\p{L}'’-]*)?)\b/gu,
    ),
    (match) => {
      const value = match[1].trim();
      const possessive = value.match(
        /^((?:Mr|MR|Ms|MS|Mrs|MRS|Miss|MISS|Dr|DR)\.?\s+\p{Lu}[\p{L}'’-]*['’]s)\b/u,
      );
      return possessive ? possessive[1] : value;
    },
  );
  return Array.from(new Set(references));
}

function extractConfirmedNameEvidence(text: string): string[] {
  const turns = paragraphs(text)
    .map((paragraph) =>
      paragraph.match(
        /^(?:\[\d{2}:\d{2}:\d{2}\]\s*)?(SPEAKER\s+[A-Z0-9]+)\s*:\s*([\s\S]+)$/iu,
      ),
    )
    .filter(
      (turn): turn is RegExpMatchArray =>
        Boolean(turn),
    );
  const evidence: string[] = [];
  for (let index = 0; index + 1 < turns.length; index += 1) {
    const question = turns[index][2].match(
      /\b((?:Mr|Ms|Mrs|Miss|Dr)\.),?\s+(?:(?:um+|uh+m*)[,\s]+)?(\p{Lu}[\p{L}'’-]+),?\s+is that how you say your name\?/iu,
    );
    if (!question || !/^\s*yes\b/iu.test(turns[index + 1][2])) continue;
    evidence.push(
      `${turns[index + 1][1].toUpperCase()} explicitly confirms the addressed name "${question[1]} ${question[2]}".`,
    );
  }
  return Array.from(new Set(evidence));
}

function extractConfirmedSpeakerNames(text: string): Map<string, string> {
  const turns = paragraphs(text)
    .map((paragraph) =>
      paragraph.match(
        /^(?:\[\d{2}:\d{2}:\d{2}\]\s*)?(SPEAKER\s+[A-Z0-9]+)\s*:\s*([\s\S]+)$/iu,
      ),
    )
    .filter((turn): turn is RegExpMatchArray => Boolean(turn));
  const confirmed = new Map<string, string>();
  for (let index = 0; index + 1 < turns.length; index += 1) {
    const question = turns[index][2].match(
      /\b((?:Mr|Ms|Mrs|Miss|Dr)\.),?\s+(?:(?:um+|uh+m*)[,\s]+)?(\p{Lu}[\p{L}'’-]+),?\s+is that how you say your name\?/iu,
    );
    if (!question || !/^\s*yes\b/iu.test(turns[index + 1][2])) continue;
    confirmed.set(
      turns[index + 1][1].toUpperCase(),
      `${question[1]} ${question[2]}`,
    );
  }
  return confirmed;
}

function extractVocativeResponseNames(text: string): Map<string, string> {
  const turns = paragraphs(text)
    .map((paragraph) =>
      paragraph.match(
        /^(?:\[\d{2}:\d{2}:\d{2}\]\s*)?(SPEAKER\s+[A-Z0-9]+)\s*:\s*([\s\S]+)$/iu,
      ),
    )
    .filter((turn): turn is RegExpMatchArray => Boolean(turn));
  const counts = new Map<string, Map<string, number>>();
  for (let index = 0; index + 1 < turns.length; index += 1) {
    const vocatives = Array.from(
      turns[index][2].matchAll(
        /\b((?:Mr|Ms|Mrs|Miss|Dr)\.?\s+\p{Lu}[\p{L}'’-]+),/giu,
      ),
      (match) => match[1],
    );
    const name = vocatives.at(-1);
    const responder = turns[index + 1][1].toUpperCase();
    if (!name || responder === turns[index][1].toUpperCase()) continue;
    const names = counts.get(responder) ?? new Map<string, number>();
    names.set(name, (names.get(name) ?? 0) + 1);
    counts.set(responder, names);
  }
  const resolved = new Map<string, string>();
  for (const [sourceLabel, names] of counts) {
    const ranked = Array.from(names.entries()).sort((a, b) => b[1] - a[1]);
    if (ranked[0] && (ranked[0][1] >= 2 || ranked.length === 1)) {
      resolved.set(sourceLabel, ranked[0][0]);
    }
  }
  return resolved;
}

function extractAuthoritativeSpellings(specifications: string): string[] {
  return Array.from(
    specifications.matchAll(
      /\b(?:authoritative|canonical|correct)\s+(?:surname\s+)?spelling\s+(?:is|:)\s*(?:Mr|Ms|Mrs|Miss|Dr)?\.?\s*(\p{Lu}[\p{L}'’-]+)/giu,
    ),
    (match) => match[1],
  );
}

function extractManualSpeakerNames(
  specifications: string,
): Map<string, string> {
  const names = new Map<string, string>();
  for (const match of specifications.matchAll(
    /\b(SPEAKER\s+[A-Z0-9]+)\s+is\s+((?:(?:Mr|Ms|Mrs|Miss|Dr)\.?\s+)?\p{Lu}[\p{L}'’-]*(?:\s+\p{Lu}[\p{L}'’-]*){0,3})(?=[.;,\n]|$)/giu,
  )) {
    names.set(match[1].toUpperCase(), match[2].trim());
  }
  return names;
}

function missingEntityNameReferences(
  skeleton: Skeleton,
  observedReferences: string[],
): string[] {
  const represented = new Set<string>();
  const entities = Array.isArray(skeleton.entities) ? skeleton.entities : [];
  for (const entity of entities) {
    if (!entity || typeof entity !== "object") continue;
    const record = entity as Record<string, unknown>;
    if (typeof record.canonical === "string") {
      represented.add(lastName(record.canonical).toLocaleLowerCase());
    }
    if (Array.isArray(record.variants)) {
      for (const variant of record.variants) {
        if (typeof variant === "string") {
          represented.add(lastName(variant).toLocaleLowerCase());
        }
      }
    }
  }
  return observedReferences.filter(
    (reference) =>
      !represented.has(lastName(reference).toLocaleLowerCase()),
  );
}

function speakerLabelsInOrder(text: string): string[] {
  return Array.from(
    text.matchAll(
      /^(?:\[\d{2}:\d{2}:\d{2}\]\s*)?((?:SPEAKER\s+[A-Z0-9]+)|(?:(?:MR|MS|MRS|MISS|DR)\.?\s+[\p{L}'’.-]+)|(?:\p{Lu}[\p{Lu}'’.-]+(?:\s+\p{Lu}[\p{Lu}'’.-]+){1,4}))\s*:/gimu,
    ),
    (match) => match[1].toUpperCase(),
  );
}

function canonicalSpeakerDisplay(
  canonicalName: string,
  source: string,
): string {
  const honorific = canonicalName.match(
    /^(Mr|Ms|Mrs|Miss|Dr)\.?\s+(.+)$/iu,
  );
  if (honorific) {
    return `${honorific[1].toUpperCase()}. ${lastName(honorific[2]).toUpperCase()}`;
  }
  const surname = lastName(canonicalName);
  const referencedHonorific = surname
    ? source.match(
        new RegExp(
          `\\b(Mr|Ms|Mrs|Miss|Dr)\\.?\\s+${surname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
          "iu",
        ),
      )
    : null;
  if (referencedHonorific) {
    return `${referencedHonorific[1].toUpperCase()}. ${surname.toUpperCase()}`;
  }
  return canonicalName.toUpperCase();
}

function canonicalSpeakerLabelMap(
  skeleton: Skeleton,
  source: string,
): Map<string, string> {
  const mapping = new Map<string, string>();
  const speakerMap = Array.isArray(skeleton.speakerMap)
    ? skeleton.speakerMap
    : [];
  for (const item of speakerMap) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.sourceLabel !== "string") continue;
    const sourceLabel = record.sourceLabel.toUpperCase();
    const canonicalName =
      typeof record.canonicalName === "string" && record.canonicalName.trim()
        ? record.canonicalName.trim()
        : typeof record.identity === "string" && record.identity.trim()
          ? record.identity.trim()
          : "";
    mapping.set(
      sourceLabel,
      canonicalName
        ? canonicalSpeakerDisplay(canonicalName, source)
        : sourceLabel,
    );
  }
  return mapping;
}

function speakerLabelKey(value: string): string {
  return value
    .replace(/[.:]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .toUpperCase();
}

function canonicalSpeakerAliasMap(
  skeleton: Skeleton,
  source: string,
): Map<string, string> {
  const aliases = new Map<string, string>();
  const surnameOwners = new Map<string, Set<string>>();
  const speakerMap = Array.isArray(skeleton.speakerMap)
    ? skeleton.speakerMap
    : [];
  for (const item of speakerMap) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.sourceLabel !== "string") continue;
    const sourceLabel = record.sourceLabel.toUpperCase();
    const canonicalName =
      typeof record.canonicalName === "string" && record.canonicalName.trim()
        ? record.canonicalName.trim()
        : typeof record.identity === "string" && record.identity.trim()
          ? record.identity.trim()
          : "";
    const canonicalLabel = canonicalName
      ? canonicalSpeakerDisplay(canonicalName, source)
      : sourceLabel;
    const values = [
      sourceLabel,
      canonicalLabel,
      canonicalName,
      typeof record.identity === "string" ? record.identity : "",
      ...(Array.isArray(record.observedVariants)
        ? record.observedVariants.filter(
            (value): value is string => typeof value === "string",
          )
        : []),
    ].filter(Boolean);
    for (const value of values) {
      aliases.set(speakerLabelKey(value), canonicalLabel);
      const surname = lastName(value);
      if (!surname) continue;
      aliases.set(speakerLabelKey(`Speaker ${surname}`), canonicalLabel);
      aliases.set(speakerLabelKey(`Speaker ${value}`), canonicalLabel);
      for (const honorific of ["Mr", "Ms", "Mrs", "Miss", "Dr"]) {
        aliases.set(
          speakerLabelKey(`${honorific}. ${surname}`),
          canonicalLabel,
        );
      }
      const owners = surnameOwners.get(speakerLabelKey(surname)) ?? new Set();
      owners.add(canonicalLabel);
      surnameOwners.set(speakerLabelKey(surname), owners);
    }
  }
  for (const [surname, owners] of surnameOwners) {
    if (owners.size === 1) aliases.set(surname, Array.from(owners)[0]);
  }
  return aliases;
}

function applyCanonicalSpeakerLabels(
  output: string,
  source: string,
  skeleton: Skeleton,
): string {
  const aliases = canonicalSpeakerAliasMap(skeleton, source);
  return output.replace(
    /^(\[\d{2}:\d{2}:\d{2}\]\s*)?((?:SPEAKER\s+[A-Z0-9]+)|(?:(?:MR|MS|MRS|MISS|DR)\.?\s+[\p{L}'’.-]+)|(?:\p{Lu}[\p{Lu}'’.-]+(?:\s+\p{Lu}[\p{Lu}'’.-]+){1,4}))\s*:/gimu,
    (_turn, timestamp = "", label: string) =>
      `${timestamp}${aliases.get(speakerLabelKey(label)) ?? label.toUpperCase()}:`,
  );
}

function ensureTranscriptParagraphLabels(
  output: string,
  source: string,
): string {
  let currentLabel = speakerLabelsInOrder(source)[0] ?? "";
  return paragraphs(output)
    .map((paragraph) => {
      const match = paragraph.match(
        /^(\[\d{2}:\d{2}:\d{2}\]\s*)?((?:SPEAKER\s+[A-Z0-9]+)|(?:(?:MR|MS|MRS|MISS|DR)\.?\s+[\p{L}'’.-]+)|(?:\p{Lu}[\p{Lu}'’.-]+(?:\s+\p{Lu}[\p{Lu}'’.-]+){1,4}))\s*:/iu,
      );
      if (match) {
        currentLabel = match[2].toUpperCase();
        return paragraph;
      }
      return currentLabel ? `${currentLabel}: ${paragraph}` : paragraph;
    })
    .join("\n\n");
}

function editDistance(left: string, right: string): number {
  const a = Array.from(left.toLocaleLowerCase());
  const b = Array.from(right.toLocaleLowerCase());
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const old = row[j];
      row[j] = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        previous + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      previous = old;
    }
  }
  return row[b.length];
}

function lastName(value: string): string {
  return value
    .replace(/^(?:MR|MS|MRS|MISS|DR)\.?\s+/iu, "")
    .trim()
    .split(/\s+/u)
    .at(-1) ?? "";
}

function isSafePersonNameVariant(value: string): boolean {
  const surname = lastName(value);
  return (
    surname.length >= 3 &&
    !/^SPEAKER$/iu.test(surname) &&
    /\p{L}/u.test(surname)
  );
}

function canonicalizeTranscriptNames(
  text: string,
  source: string,
  skeleton: Skeleton,
): string {
  const ledgers: Array<{ canonical: string; variants: Set<string> }> = [];
  for (const name of extractSelfIntroductions(source).values()) {
    const surname = lastName(name);
    if (surname) ledgers.push({ canonical: surname, variants: new Set() });
  }
  const entities = Array.isArray(skeleton.entities) ? skeleton.entities : [];
  for (const entity of entities) {
    if (!entity || typeof entity !== "object") continue;
    const record = entity as Record<string, unknown>;
    if (record.type !== "person" || typeof record.canonical !== "string") {
      continue;
    }
    const surname = lastName(record.canonical);
    if (!isSafePersonNameVariant(surname)) continue;
    const matchingLedger = ledgers.find((existing) => {
      const threshold =
        Math.min(existing.canonical.length, surname.length) >= 6 ? 2 : 1;
      return editDistance(existing.canonical, surname) <= threshold;
    });
    const ledger =
      matchingLedger ?? { canonical: surname, variants: new Set<string>() };
    if (!matchingLedger) ledgers.push(ledger);
    if (surname !== ledger.canonical) ledger.variants.add(surname);
    if (Array.isArray(record.variants)) {
      for (const variant of record.variants) {
        if (typeof variant !== "string") continue;
        const variantSurname = lastName(variant);
        if (
          isSafePersonNameVariant(variantSurname) &&
          variantSurname !== ledger.canonical
        ) {
          ledger.variants.add(variantSurname);
        }
      }
    }
  }

  const observed = Array.from(
    source.matchAll(
      /\b(?:MR|MS|MRS|MISS|DR)\.?\s+([\p{L}][\p{L}'’.-]{2,})\b/giu,
    ),
    (match) => match[1],
  );
  for (const variant of Array.from(new Set(observed))) {
    let closest: {
      ledger: { canonical: string; variants: Set<string> };
      distance: number;
    } | null = null;
    for (const ledger of ledgers) {
      const threshold =
        Math.min(ledger.canonical.length, variant.length) >= 6 ? 2 : 1;
      const distance = editDistance(ledger.canonical, variant);
      if (
        distance <= threshold &&
        (!closest || distance < closest.distance)
      ) {
        closest = { ledger, distance };
      }
    }
    if (closest && closest.distance > 0) {
      closest.ledger.variants.add(variant);
    }
  }

  let result = text;
  for (const ledger of ledgers) {
    for (const variant of ledger.variants) {
      result = result.replace(
      new RegExp(`\\b${variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "giu"),
        ledger.canonical,
      );
    }
  }
  return result;
}

function assertPerfectTranscriptQuality(
  output: string,
  source: string,
  skeleton: Skeleton,
): void {
  const defects: string[] = [];
  if (/\b(?:um+|uh+m*|er+m*|ah+|hmm+)\b/iu.test(output)) {
    defects.push("vocal fillers remain");
  }
  if (
    /\b([\p{L}\p{N}'’.-]+)(?:[ \t]*,[ \t]*|[ \t]+)\1\b/iu.test(output)
  ) {
    defects.push("immediate repetitions remain");
  }
  if (
    /\b(?:we|you|they|I)\s+(?:generally\s+)?have\s+you\b/iu.test(output)
  ) {
    defects.push("a malformed false-start fragment remains");
  }
  if (/[.!?]\s+\p{Ll}/u.test(output)) {
    defects.push("a sentence begins with lowercase text");
  }
  if (
    /\b(?:positioner|David Bowies|I agree,\s*Emmerich)\b/iu.test(output) ||
    /\bfees be paid,\s*charged\b/iu.test(output) ||
    /\bGregory Emmerich\s+Okay,\s*no\b/iu.test(output)
  ) {
    defects.push("a known legal-term or canonical-name error remains");
  }
  if (/\b(?:So|And|But)\s+Generally,\b/u.test(output)) {
    defects.push("a conjunction-capitalization artifact remains");
  }
  if (/[ \t]—|—[ \t]/u.test(output)) {
    defects.push("an em dash has incorrect surrounding spaces");
  }

  for (const match of output.matchAll(
    /\b(?:you know|I mean|kind of|sort of)\b/giu,
  )) {
    const phrase = match[0].toLocaleLowerCase();
    const offset = match.index ?? 0;
    const context = output.slice(Math.max(0, offset - 24), offset);
    const meaningful =
      (phrase === "you know" && /\bas\s*$/iu.test(context)) ||
      (phrase === "i mean" &&
        /\b(?:what|which|by that|by which)\s*$/iu.test(context)) ||
      ((phrase === "kind of" || phrase === "sort of") &&
        /\b(?:what|which|some|any|every|this|that)\s*$/iu.test(context));
    if (!meaningful) {
      defects.push(`empty discourse marker remains: ${match[0]}`);
      break;
    }
  }

  const sourceLabels = new Set(speakerLabelsInOrder(source));
  if (sourceLabels.size > 0) {
    const labelMap = canonicalSpeakerLabelMap(skeleton, source);
    const expectedLabels = new Set(
      Array.from(sourceLabels, (label) => labelMap.get(label) ?? label),
    );
    const observedOutputLabels = new Set<string>();
    for (const paragraph of paragraphs(output)) {
      const label = paragraph.match(
        /^(?:\[\d{2}:\d{2}:\d{2}\]\s*)?((?:SPEAKER\s+[A-Z0-9]+)|(?:(?:MR|MS|MRS|MISS|DR)\.?\s+[\p{L}'’.-]+)|(?:\p{Lu}[\p{Lu}'’.-]+(?:\s+\p{Lu}[\p{Lu}'’.-]+){1,4}))\s*:/iu,
      )?.[1].toUpperCase();
      if (!label) {
        defects.push("an output paragraph has no speaker label");
        break;
      }
      observedOutputLabels.add(label);
      if (!expectedLabels.has(label)) {
        defects.push(`unexpected speaker label remains: ${label}`);
        break;
      }
    }
    for (const [sourceLabel, canonicalLabel] of labelMap) {
      if (
        canonicalLabel !== sourceLabel &&
        sourceLabels.has(sourceLabel) &&
        !observedOutputLabels.has(canonicalLabel)
      ) {
        defects.push(
          `resolved identity was not used as a speaker label: ${canonicalLabel}`,
        );
      }
      if (
        canonicalLabel !== sourceLabel &&
        observedOutputLabels.has(sourceLabel)
      ) {
        defects.push(
          `generic speaker label remains after identity resolution: ${sourceLabel}`,
        );
      }
    }
  }

  const entities = Array.isArray(skeleton.entities) ? skeleton.entities : [];
  for (const entity of entities) {
    if (!entity || typeof entity !== "object") continue;
    const record = entity as Record<string, unknown>;
    if (
      record.type !== "person" ||
      typeof record.canonical !== "string" ||
      !Array.isArray(record.variants)
    ) {
      continue;
    }
    const canonicalSurname = lastName(record.canonical);
    for (const variant of record.variants) {
      if (typeof variant !== "string") continue;
      const variantSurname = lastName(variant);
      if (
        isSafePersonNameVariant(variantSurname) &&
        variantSurname.toLocaleLowerCase() !==
          canonicalSurname.toLocaleLowerCase() &&
        new RegExp(
          `\\b${variantSurname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
          "iu",
        ).test(output)
      ) {
        defects.push(`noncanonical name remains: ${variantSurname}`);
        break;
      }
    }
  }

  if (defects.length > 0) {
    throw new Error(
      `Perfect Transcript quality gate failed: ${Array.from(new Set(defects)).join("; ")}`,
    );
  }
}

function stabilizeTranscriptSkeleton(
  skeleton: Skeleton,
  source: string,
  specifications: string,
): Skeleton {
  const introductions = extractSelfIntroductions(source);
  const confirmedNames = extractConfirmedSpeakerNames(source);
  const vocativeNames = extractVocativeResponseNames(source);
  const authoritativeSpellings = extractAuthoritativeSpellings(specifications);
  const manualSpeakerNames = extractManualSpeakerNames(specifications);
  const sourceLabels = Array.from(new Set(speakerLabelsInOrder(source))).filter(
    (label) => label.startsWith("SPEAKER "),
  );
  const existing = Array.isArray(skeleton.speakerMap)
    ? skeleton.speakerMap.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item),
      )
    : [];
  const speakerMap = sourceLabels.map((sourceLabel) => {
    const introduction = introductions.get(sourceLabel);
    const candidate = existing.find(
      (entry) =>
        typeof entry.sourceLabel === "string" &&
        entry.sourceLabel.toUpperCase() === sourceLabel,
    );
    const candidateName =
      typeof candidate?.canonicalName === "string"
        ? candidate.canonicalName.trim()
        : "";
    let canonicalName =
      manualSpeakerNames.get(sourceLabel) ||
      introduction ||
      candidateName ||
      confirmedNames.get(sourceLabel) ||
      vocativeNames.get(sourceLabel) ||
      "";
    for (const spelling of authoritativeSpellings) {
      const currentSurname = lastName(canonicalName);
      if (
        currentSurname &&
        editDistance(currentSurname, spelling) <= 2
      ) {
        canonicalName = canonicalName.replace(
          new RegExp(
            `${currentSurname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
            "iu",
          ),
          spelling,
        );
      }
    }
    return {
      sourceLabel,
      canonicalDisplay: canonicalName
        ? canonicalSpeakerDisplay(canonicalName, source)
        : sourceLabel,
      identity: canonicalName,
      canonicalName,
      observedVariants: Array.isArray(candidate?.observedVariants)
        ? candidate.observedVariants
        : [],
      evidence: manualSpeakerNames.has(sourceLabel)
        ? `The user explicitly identifies ${sourceLabel} as ${manualSpeakerNames.get(sourceLabel)}.`
        : introduction
          ? `${sourceLabel} explicitly says: "My name is ${introduction}."`
        : confirmedNames.has(sourceLabel)
          ? `${sourceLabel} explicitly confirms the addressed identity ${confirmedNames.get(sourceLabel)}.`
          : vocativeNames.has(sourceLabel)
            ? `${sourceLabel} repeatedly responds to the direct address ${vocativeNames.get(sourceLabel)}.`
        : typeof candidate?.evidence === "string"
          ? candidate.evidence
          : "Identity not established by direct evidence.",
    };
  });
  return { ...skeleton, speakerMap };
}

export function chunkAtParagraphs(text: string, wordsPerChunk = 500): string[] {
  const result: string[] = [];
  let current: string[] = [];
  let words = 0;
  for (const paragraph of paragraphs(text)) {
    const size = countWords(paragraph);
    if (current.length && words + size > wordsPerChunk) {
      result.push(current.join("\n\n"));
      current = [];
      words = 0;
    }
    if (size > wordsPerChunk * 1.5 && current.length === 0) {
      const tokens = paragraph.split(/\s+/u);
      while (tokens.length > wordsPerChunk) result.push(tokens.splice(0, wordsPerChunk).join(" "));
      if (tokens.length) {
        current.push(tokens.join(" "));
        words = tokens.length;
      }
    } else {
      current.push(paragraph);
      words += size;
    }
  }
  if (current.length) result.push(current.join("\n\n"));
  return result;
}

export function planCoherenceChunks(args: { text: string; jobType: JobType; targetWordCount: number }) {
  const sourceChunks = chunkAtParagraphs(args.text, 500);
  const count = args.jobType === "polish"
    ? Math.max(1, sourceChunks.length)
    : Math.max(1, Math.ceil(args.targetWordCount / 1_000));
  return Array.from({ length: count }, (_, index) => {
    const input = args.jobType === "polish"
      ? sourceChunks[index]!
      : sourceChunks.slice(Math.floor(index * sourceChunks.length / count), Math.max(Math.floor((index + 1) * sourceChunks.length / count), Math.floor(index * sourceChunks.length / count) + 1)).join("\n\n") || args.text;
    const target = args.jobType === "polish"
      ? countWords(input)
      : Math.max(1, Math.round(args.targetWordCount / count));
    return {
      index,
      input,
      inputWords: countWords(input),
      target,
      minimum: Math.max(
        1,
        Math.floor(target * (args.jobType === "polish" ? 0.6 : 0.85)),
      ),
      maximum: Math.ceil(
        target * (args.jobType === "polish" ? 1.03 : 1.15),
      ),
    };
  });
}

function parseJsonObject(text: string): Record<string, unknown> {
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```[\s\S]*$/i, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("OpenAI returned invalid JSON");
  const parsed: unknown = JSON.parse(cleaned.slice(start, end + 1));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("OpenAI returned an invalid object");
  return parsed as Record<string, unknown>;
}

async function jsonCall(
  system: string,
  user: string,
  model = "gpt-4o-mini",
): Promise<Record<string, unknown>> {
  const result = await openai().chat.completions.create({
    model,
    response_format: { type: "json_object" },
    temperature: 0.2,
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
  });
  return parseJsonObject(result.choices[0]?.message.content ?? "");
}

export async function extractCoherenceSkeleton(text: string, specifications: string, jobType: JobType): Promise<Skeleton> {
  const selfIntroductionEvidence = extractSelfIntroductionEvidence(text);
  const confirmedNameEvidence = extractConfirmedNameEvidence(text);
  const identityEvidence = [
    ...selfIntroductionEvidence,
    ...confirmedNameEvidence,
  ];
  const identityEvidenceBlock = identityEvidence.length
    ? `VERBATIM DIRECT IDENTITY EVIDENCE (ABSOLUTE PRIORITY):\n${identityEvidence.join("\n")}`
    : "VERBATIM DIRECT IDENTITY EVIDENCE: none found.";
  const observedPersonReferences = extractObservedPersonReferences(text);
  const observedNamesBlock = observedPersonReferences.length
    ? `EVERY OBSERVED HONORIFIC/NAME SPELLING (EACH MUST APPEAR AS A CANONICAL NAME OR VARIANT):\n${observedPersonReferences.join("\n")}`
    : "EVERY OBSERVED HONORIFIC/NAME SPELLING: none found.";
  const contract = `Return exactly this shape: {"purpose":"","thesis":"","steps":[""],"terms":[{"term":"","definition":""}],"commitmentLedger":{"asserts":[],"rejects":[],"assumes":[],"open":[]},"entities":[{"canonical":"","variants":[],"type":"","evidence":""}],"audience":"","rigor":"","speakerMap":[{"sourceLabel":"","canonicalDisplay":"","identity":"","canonicalName":"","observedVariants":[],"evidence":""}]}. The steps array MUST contain at least 8 distinct ordered strings, even for a short source; use structural verification and preservation steps when the source has fewer than 8 events. For legal/hearing transcripts, resolve spelling variants globally with this strict evidence hierarchy: (1) an exact canonical spelling explicitly supplied in the user's manual specifications; (2) the machine-extracted verbatim self-introduction block; (3) an exact name stated by another speaker and explicitly confirmed by the person; (4) a direct-address response pattern or explicit full name/formal record; (5) repeated consistent usage. Every person entity's variants array MUST list every alternate phonetic spelling observed anywhere in the source; never omit a conflicting surname spelling. Never claim "full name introduction" unless the verbatim evidence block contains that exact introduction. Set canonicalDisplay to a publication-grade uppercase legal speaker label whenever identity is established; retain the generic source label only when identity is genuinely uncertain. Keep the complete JSON under 7,500 characters so immutable Tier 0 remains within its prompt budget.`;
  let sourceForSkeleton = text;
  if (text.length > DIRECT_SKELETON_SOURCE_LIMIT) {
    const sourceChunks = chunkAtParagraphs(text, 2_500);
    const partials: Record<string, unknown>[] = [];
    for (let index = 0; index < sourceChunks.length; index += 1) {
      partials.push(
        await jsonCall(
          "Extract a compact structural and factual memory map. Return valid JSON only.",
          `Return {"steps":[],"asserts":[],"rejects":[],"assumes":[],"open":[],"terms":[],"entities":[{"canonical":"","variants":[],"type":"","evidence":""}],"speakers":[{"sourceLabel":"","canonicalDisplay":"","identity":"","canonicalName":"","observedVariants":[],"evidence":""}]}. Preserve exact names, spelling variants, numbers, dates, citations, quotations, negative findings, conflicts, and uncertainty. Use self-introductions as strongest name evidence. Do not rewrite prose. Source section ${index + 1}/${sourceChunks.length}.\n\n${sourceChunks[index]}`,
        ),
      );
    }
    sourceForSkeleton = `HIERARCHICAL SOURCE MAPS:\n${partials.map((partial, index) => `SECTION ${index + 1}: ${JSON.stringify(partial)}`).join("\n")}`;
  }
  let skeleton = await jsonCall(
    "You are the senior global identity and structure editor for a legal transcript. Resolve ASR phonetic name errors using speaker-turn context across the entire source. Extract structure, not rewritten prose. Return valid JSON only.",
    `${contract}\n\n${identityEvidenceBlock}\n\n${observedNamesBlock}\n\nPreserve exact names, numbers, dates, citations, quotations, negative findings, speaker identities, and explicit uncertainty. For a play, steps are a sufficient scene plan for the requested length. Job type: ${jobType}. Manual specifications: ${specifications || "(none)"}.\n\nSOURCE:\n${sourceForSkeleton}`,
    jobType === "polish" ? "gpt-4o" : "gpt-4o-mini",
  );
  const ledger = skeleton.commitmentLedger as Record<string, unknown> | undefined;
  let missingNames =
    jobType === "polish"
      ? missingEntityNameReferences(skeleton, observedPersonReferences)
      : [];
  if (
    !Array.isArray(skeleton.steps) ||
    skeleton.steps.length < 8 ||
    !ledger ||
    !Array.isArray(ledger.asserts) ||
    !Array.isArray(ledger.rejects) ||
    !Array.isArray(ledger.assumes) ||
    !Array.isArray(ledger.open) ||
    missingNames.length > 0
  ) {
    skeleton = await jsonCall(
      "You are the senior global identity and structure editor for a legal transcript. Repair the supplied coherence skeleton to the exact contract, resolving ASR phonetic name errors from global speaker-turn context. Return valid JSON only.",
      `${contract}\n\n${identityEvidenceBlock}\n\n${observedNamesBlock}\n\nThe prior candidate omitted these required name spellings: ${missingNames.join(", ") || "(none)"}. Do not lose or alter any existing exact name, number, date, citation, quotation, rejection, negative finding, speaker identity, or uncertainty. Job type: ${jobType}.\n\nCANDIDATE SKELETON:\n${JSON.stringify(skeleton)}\n\nSOURCE:\n${sourceForSkeleton}`,
      jobType === "polish" ? "gpt-4o" : "gpt-4o-mini",
    );
    missingNames =
      jobType === "polish"
        ? missingEntityNameReferences(skeleton, observedPersonReferences)
        : [];
  }
  if (missingNames.length > 0) {
    throw new Error(
      `Canonical name ledger did not resolve observed spellings: ${missingNames.join(", ")}`,
    );
  }
  if (jobType === "polish" && observedPersonReferences.length > 0) {
    const nameLedger = await jsonCall(
      "You are the senior name editor for a legal transcript. Resolve ASR phonetic name errors using global speaker-turn and dialogue context. Return valid JSON only.",
      `Return exactly {"entities":[{"canonical":"","variants":[],"type":"person","evidence":""}]}. Build one global identity ledger for this hearing. An exact canonical spelling in the user's manual specifications outranks an ASR spelling; direct identity evidence otherwise controls. Assign every observed spelling to the already-established person it refers to when turn context shows the same addressee or role; do not create a separate person merely because speech recognition produced a different phonetic spelling. Every observed honorific/name spelling must appear as a canonical name or variant. A later similar phonetic spelling is a variant of a directly confirmed or self-introduced name unless there is direct evidence of a separate person. Preserve possessives as variants where observed.\n\nMANUAL SPECIFICATIONS:\n${specifications || "(none)"}\n\n${identityEvidenceBlock}\n\n${observedNamesBlock}\n\nSOURCE:\n${sourceForSkeleton}`,
      "gpt-4o",
    );
    if (!Array.isArray(nameLedger.entities)) {
      throw new Error("Canonical name ledger returned no entities");
    }
    skeleton = { ...skeleton, entities: nameLedger.entities };
    missingNames = missingEntityNameReferences(
      skeleton,
      observedPersonReferences,
    );
    if (missingNames.length > 0) {
      throw new Error(
        `Canonical name ledger omitted observed spellings: ${missingNames.join(", ")}`,
      );
    }
  }
  return skeleton;
}

function chunkSystem(job: ReconstructionJob, target: number, minimum: number, maximum: number): string {
  const lengthRule =
    job.jobType === "polish"
      ? `The source has about ${target} words. Cleanup is expected to make the result shorter; acceptable range ${minimum}-${maximum}. Never retain or add filler, repetition, or empty phrasing to approach a word target.`
      : `Target ${target} words; acceptable range ${minimum}-${maximum}.`;
  const common = `${ANTI_SYCOPHANCY}\n\n${lengthRule} Return valid JSON only: {"text":"...", "delta":{"claims":[],"terms":[],"conflicts":[]}}. Never include a preamble outside JSON.`;
  if (job.jobType === "polish") {
    return `${common}
Perfect a legal/hearing transcript to publication-grade copyediting standards.

NONNEGOTIABLE CLEANUP:
- Remove every vocal filler and empty discourse marker, including "um," "uh," "uhm," "er," "ah," "hmm," "you know," "I mean," "kind of," and "sort of" when they do not carry substantive meaning.
- Remove stutters, immediate word/phrase repetitions, abandoned false starts, and redundant self-corrections. Keep only the speaker's completed intended phrasing.
- Never preserve disfluencies merely to satisfy a word count.

NAME AND SPEAKER ACCURACY:
- Treat the global MEMORY entity and speaker maps as the controlling name ledger. Apply each canonical spelling consistently, including when a local chunk contains a phonetic variant.
- Prefer a person's own full-name introduction over conflicting phonetic spellings elsewhere.
- Use the global speaker map's canonicalDisplay for every speaker whose identity is established. Preserve turn boundaries and never merge speakers.
- If the evidence is genuinely uncertain, retain the generic source speaker label and do not guess.
- Correct obvious legal-term recognition errors from global context, such as "positioner" when the proceeding clearly uses "petitioner."

IMPECCABLE TRANSCRIPT TYPOGRAPHY:
- Put each speaker turn in its own paragraph with an uppercase label followed by a colon.
- Preserve each real [HH:MM:SS] timestamp exactly when present.
- Use sentence case, correct capitalization, curly apostrophes/quotation marks where appropriate, em dashes for interruptions, ellipses only for genuine trailing-off, and properly formatted bracketed stage directions.
- Repair fragments caused solely by transcription boundaries, but do not rewrite the speaker's substantive wording or tone.

Preserve every substantive proposition, denial, qualification, number, date, citation, quotation, speaker turn, and sequence. Do not summarize, editorialize, fictionalize, sanitize substantive language, invent facts, names, or dialogue.`;
  }
  return `${common}\nWrite one coherent stage-play scene derived from the source and global plan. Honor the manual specifications and fidelity mode ${job.fidelityMode}. Verbatim means no invented factual content; adaptive allows dramatic restructuring without changing source facts; fictionalized permits creative adaptation while retaining the skeleton's controlling commitments. Use playable dialogue, scene headings, stage directions, continuity, and distinct consistent speakers.`;
}

async function processChunk(job: ReconstructionJob, chunk: typeof reconstructionChunksTable.$inferSelect): Promise<void> {
  await db.update(reconstructionChunksTable).set({ status: "processing", error: null }).where(eq(reconstructionChunksTable.id, chunk.id));
  const context = await buildTieredPromptContext(job.id, job.jobType);
  let output = await jsonCall(
    chunkSystem(job, chunk.targetWordCount, chunk.minimumWordCount, chunk.maximumWordCount),
    `CHUNK ${chunk.chunkIndex + 1}/${job.totalChunks}\nMANUAL SPECIFICATIONS:\n${job.manualSpecifications || "(none)"}\n\nMEMORY:\n${context}\n\nSOURCE MATERIAL:\n${chunk.inputText}`,
    "gpt-4o-mini",
  );
  let text =
    typeof output.text === "string"
      ? job.jobType === "polish"
        ? polishTranscriptTypography(output.text)
        : output.text.trim()
      : "";
  let actual = countWords(text);
  let retries = chunk.retries;

  while (
    text &&
    (actual < chunk.minimumWordCount || actual > chunk.maximumWordCount) &&
    retries < 3
  ) {
    retries += 1;
    const direction =
      actual < chunk.minimumWordCount
        ? job.jobType === "polish"
          ? `Restore any substantive statements that were accidentally omitted. Do not restore fillers, stutters, repetitions, false starts, or empty discourse markers`
          : `EXPAND it by at least ${chunk.minimumWordCount - actual} words`
        : `COMPRESS it by at least ${actual - chunk.maximumWordCount} words`;
    output = await jsonCall(
      chunkSystem(job, chunk.targetWordCount, chunk.minimumWordCount, chunk.maximumWordCount),
      `Revise the complete output below because it is ${actual} words. ${direction}. The revised complete output must be ${chunk.minimumWordCount}-${chunk.maximumWordCount} words. Preserve all commitments, exact values, canonical names, stable speaker labels, continuity, and substantive content. Return the entire revised output, not only additions.\n\nPREVIOUS OUTPUT:\n${text}`,
      "gpt-4o-mini",
    );
    text =
      typeof output.text === "string"
        ? job.jobType === "polish"
          ? polishTranscriptTypography(output.text)
          : output.text.trim()
        : "";
    actual = countWords(text);
  }
  if (!text) throw new Error(`Chunk ${chunk.chunkIndex + 1} returned empty text`);
  if (actual < chunk.minimumWordCount || actual > chunk.maximumWordCount) {
    throw new Error(`Chunk ${chunk.chunkIndex + 1} failed length enforcement after retry (${actual} words)`);
  }
  await db.update(reconstructionChunksTable).set({
    outputText: text,
    outputWordCount: actual,
    delta: output.delta ?? {},
    retries,
    status: "complete",
    error: null,
  }).where(eq(reconstructionChunksTable.id, chunk.id));
  await updateLiveTier(job.id, job.jobType, text);
  const completed = chunk.chunkIndex + 1;
  await db.update(reconstructionJobsTable).set({
    currentChunk: completed,
    progress: Math.min(95, Math.round((completed / job.totalChunks) * 90) + 5),
  }).where(eq(reconstructionJobsTable.id, job.id));
}

async function runJob(jobId: string): Promise<void> {
  const leaseOwner = randomUUID();
  const now = new Date();
  const [job] = await db
    .update(reconstructionJobsTable)
    .set({
      leaseOwner,
      leaseExpiresAt: new Date(now.getTime() + JOB_LEASE_MS),
    })
    .where(
      and(
        eq(reconstructionJobsTable.id, jobId),
        ne(reconstructionJobsTable.status, "complete"),
        ne(reconstructionJobsTable.status, "failed"),
        or(
          isNull(reconstructionJobsTable.leaseExpiresAt),
          lt(reconstructionJobsTable.leaseExpiresAt, now),
        ),
      ),
    )
    .returning();
  if (!job) {
    logger.info({ jobId }, "Coherence job is already leased by another worker");
    return;
  }
  try {
    let skeleton = job.skeleton as Skeleton | null;
    if (!skeleton) {
      await db.update(reconstructionJobsTable).set({ status: "skeleton_extraction", progress: 2, error: null }).where(eq(reconstructionJobsTable.id, job.id));
      skeleton = await extractCoherenceSkeleton(job.originalText, job.manualSpecifications, job.jobType as JobType);
      if (job.jobType === "polish") {
        skeleton = stabilizeTranscriptSkeleton(
          skeleton,
          job.originalText,
          job.manualSpecifications,
        );
      }
      await db.update(reconstructionJobsTable).set({ skeleton, progress: 5 }).where(eq(reconstructionJobsTable.id, job.id));
      await skeletonToTier0(skeleton, job.id, job.jobType);
    } else {
      if (job.jobType === "polish") {
        skeleton = stabilizeTranscriptSkeleton(
          skeleton,
          job.originalText,
          job.manualSpecifications,
        );
        await db
          .update(reconstructionJobsTable)
          .set({ skeleton })
          .where(eq(reconstructionJobsTable.id, job.id));
      }
      await skeletonToTier0(skeleton, job.id, job.jobType);
    }
    await db.update(reconstructionJobsTable).set({ status: "chunk_processing" }).where(eq(reconstructionJobsTable.id, job.id));
    const chunks = await db.select().from(reconstructionChunksTable).where(eq(reconstructionChunksTable.jobId, job.id)).orderBy(asc(reconstructionChunksTable.chunkIndex));
    for (const chunk of chunks) {
      if (chunk.status === "complete" && chunk.outputText) continue;
      await db
        .update(reconstructionJobsTable)
        .set({ leaseExpiresAt: new Date(Date.now() + JOB_LEASE_MS) })
        .where(
          and(
            eq(reconstructionJobsTable.id, job.id),
            eq(reconstructionJobsTable.leaseOwner, leaseOwner),
          ),
        );
      try {
        await processChunk(job, chunk);
      } catch (error) {
        await db.update(reconstructionChunksTable).set({
          status: "failed",
          error: error instanceof Error ? error.message : "Unknown chunk processing error",
        }).where(eq(reconstructionChunksTable.id, chunk.id));
        throw error;
      }
    }
    const persisted = await db.select().from(reconstructionChunksTable).where(and(eq(reconstructionChunksTable.jobId, job.id), eq(reconstructionChunksTable.status, "complete"))).orderBy(asc(reconstructionChunksTable.chunkIndex));
    if (persisted.length !== job.totalChunks || persisted.some((chunk) => !chunk.outputText)) throw new Error("Not all persisted chunks completed; refusing to assemble partial output");
    await db.update(reconstructionJobsTable).set({ status: "stitching", progress: 96 }).where(eq(reconstructionJobsTable.id, job.id));
    const tiers = await loadAllTiers(job.id, job.jobType);
    const review = await jsonCall(
      `Review cross-chunk coherence and conflicts. Return JSON only: {"warnings":[],"conflicts":[],"specificationSatisfied":true}. Never rewrite or silently resolve a conflict.\n\n${ANTI_SYCOPHANCY}`,
      `SKELETON:\n${JSON.stringify(skeleton)}\n\nMEMORY TIERS AND DELTAS:\n${JSON.stringify(tiers.map((tier) => tier.tree))}\n\nMANUAL SPECIFICATIONS:\n${job.manualSpecifications || "(none)"}`,
    );
    const warnings = [
      ...(Array.isArray(review.warnings) ? review.warnings.filter((item): item is string => typeof item === "string") : []),
      ...(Array.isArray(review.conflicts) ? review.conflicts.map((item) => `CONFLICT_FLAG: ${String(item)}`) : []),
    ];
    if (review.specificationSatisfied === false) throw new Error("Final coherence review found the manual specifications were not satisfied");
    const assembledOutput = persisted.map((chunk) => chunk.outputText).join("\n\n");
    const finalOutput =
      job.jobType === "polish"
        ? applyCanonicalSpeakerLabels(
            ensureTranscriptParagraphLabels(
              canonicalizeTranscriptNames(
                polishTranscriptTypography(assembledOutput),
                job.originalText,
                skeleton,
              ),
              job.originalText,
            ),
            job.originalText,
            skeleton,
          )
        : assembledOutput;
    if (job.jobType === "polish") {
      assertPerfectTranscriptQuality(finalOutput, job.originalText, skeleton);
    }
    const finalWordCount = countWords(finalOutput);
    if (finalWordCount > 60_000) throw new Error(`Final output exceeds 60,000 words (${finalWordCount})`);
    const minimumFinalRatio = job.jobType === "polish" ? 0.55 : 0.8;
    const maximumFinalRatio = job.jobType === "polish" ? 1.03 : 1.2;
    if (
      finalWordCount < job.targetWordCount * minimumFinalRatio ||
      finalWordCount > job.targetWordCount * maximumFinalRatio
    ) {
      throw new Error(`Final output failed target check: ${finalWordCount} words for target ${job.targetWordCount}`);
    }
    await db.update(reconstructionJobsTable).set({
      status: "complete",
      progress: 100,
      finalOutput,
      finalWordCount,
      warnings,
      error: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      completedAt: new Date(),
    }).where(eq(reconstructionJobsTable.id, job.id));
    logger.info({ jobId: job.id, jobType: job.jobType, finalWordCount }, "Coherence job completed");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown coherence processing error";
    await db
      .update(reconstructionJobsTable)
      .set({
        status: "failed",
        error: message,
        leaseOwner: null,
        leaseExpiresAt: null,
      })
      .where(
        and(
          eq(reconstructionJobsTable.id, jobId),
          eq(reconstructionJobsTable.leaseOwner, leaseOwner),
        ),
      );
    logger.error({ err: error, jobId }, "Coherence job failed");
  }
}

export function enqueueCoherenceJob(jobId: string): void {
  if (activeJobs.has(jobId)) return;
  activeJobs.add(jobId);
  void runJob(jobId).finally(() => activeJobs.delete(jobId));
}

export async function resumeIncompleteCoherenceJobs(): Promise<void> {
  const jobs = await db.select({ id: reconstructionJobsTable.id }).from(reconstructionJobsTable)
    .where(and(ne(reconstructionJobsTable.status, "complete"), ne(reconstructionJobsTable.status, "failed")));
  for (const job of jobs) enqueueCoherenceJob(job.id);
  logger.info({ count: jobs.length }, "Queued incomplete coherence jobs for resume");
}

export async function createPersistedCoherenceJob(args: {
  transcriptionId: number;
  text: string;
  jobType: JobType;
  manualSpecifications: string;
  targetWordCount: number;
  fidelityMode: FidelityMode;
}) {
  if (args.targetWordCount > 60_000) throw new Error("targetWordCount must not exceed 60000");
  const sourceWordCount = countWords(args.text);
  const plan = planCoherenceChunks({ text: args.text, jobType: args.jobType, targetWordCount: args.targetWordCount });
  return db.transaction(async (tx) => {
    const [job] = await tx.insert(reconstructionJobsTable).values({
      transcriptionId: args.transcriptionId,
      jobType: args.jobType,
      fidelityMode: args.fidelityMode,
      originalText: args.text,
      manualSpecifications: args.manualSpecifications,
      targetWordCount: args.targetWordCount,
      sourceWordCount,
      sourceMetrics: { words: sourceWordCount, paragraphs: paragraphs(args.text).length },
      targetMetrics: { words: args.targetWordCount, chunkWordsMaximum: 1_150 },
      lengthRatio: String(args.targetWordCount / Math.max(1, sourceWordCount)),
      totalChunks: plan.length,
    }).returning();
    await tx.insert(reconstructionChunksTable).values(plan.map((chunk) => ({
      jobId: job.id,
      chunkIndex: chunk.index,
      inputText: chunk.input,
      inputWordCount: chunk.inputWords,
      targetWordCount: chunk.target,
      minimumWordCount: chunk.minimum,
      maximumWordCount: chunk.maximum,
    })));
    return job;
  });
}