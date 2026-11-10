import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(resolve("artifacts/api-server/package.json"));
const { build } = require("esbuild");
const databaseUrl =
  process.env.NEON_DATABASE_API ||
  process.env.NEON_DATABASE_URL ||
  process.env.DATABASE_URL;
assert.ok(databaseUrl, "Set DATABASE_URL to test a production start.");
const temp = await mkdtemp(join(tmpdir(), "transcriber-deploy-test-"));
let child;
try {
  const storageBundle = join(temp, "storage.mjs");
  await build({
    entryPoints: ["artifacts/api-server/src/lib/objectStorage.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: storageBundle,
  });
  process.env.STORAGE_DIR = join(temp, "objects");
  const { ObjectStorageService, ObjectNotFoundError } = await import(
    pathToFileURL(storageBundle).href
  );
  const storage = new ObjectStorageService();
  const source = join(temp, "sample.bin");
  const data = Buffer.from("persistent recording test");
  await writeFile(source, data);
  const key = await storage.persistFile(source, "audio/mpeg");
  const stored = await storage.getObjectEntityFile(key);
  assert.deepEqual((await stored.getMetadata())[0], {
    size: data.length,
    contentType: "audio/mpeg",
  });
  const chunks = [];
  for await (const chunk of stored.createReadStream({ start: 2, end: 7 }))
    chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), data.subarray(2, 8));
  await assert.rejects(
    storage.getObjectEntityFile("/objects/../../etc/passwd"),
    ObjectNotFoundError,
  );
  await assert.rejects(
    storage.getObjectEntityFile("/objects/uploads/missing"),
    ObjectNotFoundError,
  );
  await stored.delete();
  await assert.rejects(storage.getObjectEntityFile(key), ObjectNotFoundError);
  console.log(
    "PASS: durable audio copy, metadata, byte ranges, path validation, deletion",
  );

  // Intentionally do not inherit provider keys, Replit variables, or other secrets.
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: "production",
    DATABASE_URL: databaseUrl,
    STORAGE_DIR: join(temp, "objects"),
    RESUME_JOBS_ON_START: "false",
  };
  // PORT is deliberately absent: validates the required 5000 default.
  child = spawn("pnpm", ["start"], {
    cwd: process.cwd(),
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (chunk) => {
    logs += chunk;
  });
  child.stderr.on("data", (chunk) => {
    logs += chunk;
  });
  const base = "http://127.0.0.1:5000";
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null)
      throw new Error(`Production start exited: ${logs}`);
    if (logs.includes('"msg":"Server listening"')) {
      ready = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(ready, `Production start did not become ready: ${logs}`);
  const health = await fetch(`${base}/api/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });
  const home = await fetch(base);
  const html = await home.text();
  assert.equal(home.status, 200);
  assert.match(html, /<div id="root"><\/div>/);
  const script = html.match(/src="([^"]+\.js)"/)[1];
  const asset = await fetch(`${base}${script}`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get("content-type"), /javascript/);
  const page = await fetch(`${base}/diagnostics`, {
    headers: { accept: "text/html", "x-forwarded-proto": "https" },
  });
  assert.equal(page.status, 200);
  assert.equal(await page.text(), html);
  assert.equal((await fetch(`${base}/api/not-a-route`)).status, 404);
  assert.equal((await fetch(`${base}/assets/not-a-file.js`)).status, 404);
  const list = await fetch(`${base}/api/transcriptions`);
  assert.equal(
    list.status,
    200,
    "Database API must work with the configured schema",
  );
  assert.ok(Array.isArray(await list.json()));
  assert.doesNotMatch(
    logs,
    /"level":(?:50|60)/,
    "Startup must not log an error",
  );
  console.log(
    "PASS: pnpm start, default port 5000, missing optional keys, health, built assets, SPA routes, API 404, database read",
  );
  console.log("PASS: production startup has no error-level logs");
} finally {
  if (child?.pid) {
    const exited = new Promise((r) => child.once("exit", r));
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
    await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }
  await rm(temp, { recursive: true, force: true });
}
