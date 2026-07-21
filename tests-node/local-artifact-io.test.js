"use strict";

// Regression tests for two local-artifact-io audit findings:
//   - readJsonIfExists was TOCTOU-racy (pathExists then readFile, so a file
//     pruned between the two threw ENOENT out of a "null if missing" contract)
//     and mapped EACCES/EPERM to "missing".
//   - writeBufferAtomic leaked its `.tmp-<pid>-<rand>` file when writeFile or
//     rename failed (manifest/pointer/marker writes still rethrow — only the
//     temp-file leak was the bug).

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { readJsonIfExists, writeBufferAtomic, writeJsonAtomic } = require("../scripts/lib/local-artifact-io");

async function makeTempDir(t) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wx-artifact-io-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function listTmpEntries(dir) {
  const entries = await fs.promises.readdir(dir).catch(() => []);
  return entries.filter((name) => name.includes(".tmp-"));
}

test("readJsonIfExists returns null for a missing file", async (t) => {
  const dir = await makeTempDir(t);
  assert.equal(await readJsonIfExists(path.join(dir, "does-not-exist.json")), null);
});

test("readJsonIfExists parses an existing file", async (t) => {
  const dir = await makeTempDir(t);
  const filePath = path.join(dir, "manifest.json");
  await fs.promises.writeFile(filePath, JSON.stringify({ ok: 1 }));
  assert.deepEqual(await readJsonIfExists(filePath), { ok: 1 });
});

test("readJsonIfExists does not throw when the file vanishes after an existence check", async (t) => {
  // Simulates a concurrent cache prune: any exists-style pre-check
  // (fs.promises.access) deletes the file before the subsequent read. The
  // fixed implementation reads directly, so the hook never fires and a
  // genuinely concurrent deletion surfaces as the ENOENT -> null path.
  const dir = await makeTempDir(t);
  const filePath = path.join(dir, "latest.json");
  await fs.promises.writeFile(filePath, JSON.stringify({ runId: "20260716-00" }));

  const realAccess = fs.promises.access.bind(fs.promises);
  t.mock.method(fs.promises, "access", async (target, ...rest) => {
    await realAccess(target, ...rest);
    if (target === filePath) {
      await fs.promises.unlink(filePath).catch(() => {});
    }
  });

  let result;
  await assert.doesNotReject(async () => {
    result = await readJsonIfExists(filePath);
  });
  assert.ok(result === null || typeof result === "object");
});

test("readJsonIfExists still throws on malformed JSON", async (t) => {
  const dir = await makeTempDir(t);
  const filePath = path.join(dir, "corrupt.json");
  await fs.promises.writeFile(filePath, "{ not json");
  await assert.rejects(() => readJsonIfExists(filePath), SyntaxError);
});

test("readJsonIfExists rethrows non-ENOENT errors instead of reading them as missing", async (t) => {
  // An unsearchable parent directory makes both an exists-style access check
  // and the read fail with EACCES; the old pathExists pre-check swallowed
  // that as "missing" and returned null.
  const dir = await makeTempDir(t);
  const deniedDir = path.join(dir, "denied");
  const filePath = path.join(deniedDir, "manifest.json");
  await fs.promises.mkdir(deniedDir);
  await fs.promises.writeFile(filePath, JSON.stringify({ secret: true }));
  await fs.promises.chmod(deniedDir, 0o000);
  try {
    await assert.rejects(
      () => readJsonIfExists(filePath),
      (error) => error?.code === "EACCES",
    );
  } finally {
    await fs.promises.chmod(deniedDir, 0o700).catch(() => {});
  }
});

test("writeBufferAtomic round-trips content without leaving temp files", async (t) => {
  const dir = await makeTempDir(t);
  const filePath = path.join(dir, "frame.bin");
  await writeBufferAtomic(filePath, Buffer.from("payload"));
  assert.equal(await fs.promises.readFile(filePath, "utf8"), "payload");
  assert.deepEqual(await listTmpEntries(dir), []);
});

test("writeBufferAtomic cleans up its temp file when the rename fails and still rethrows", async (t) => {
  const dir = await makeTempDir(t);
  // The target path exists as a directory: writeFile(tempPath) succeeds, the
  // rename onto the directory fails.
  const filePath = path.join(dir, "manifest.json");
  await fs.promises.mkdir(filePath);

  await assert.rejects(
    () => writeBufferAtomic(filePath, Buffer.from("{}")),
    (error) => typeof error?.code === "string" && error.code !== "",
  );
  assert.deepEqual(await listTmpEntries(dir), []);
});

test("writeBufferAtomic still rethrows when the initial write fails", async (t) => {
  const dir = await makeTempDir(t);
  const filePath = path.join(dir, "missing-parent", "marker.json");
  await assert.rejects(
    () => writeBufferAtomic(filePath, Buffer.from("{}"), { ensureDir: false }),
    (error) => error?.code === "ENOENT",
  );
  assert.deepEqual(await listTmpEntries(dir), []);
});

test("writeJsonAtomic serializes through the atomic writer", async (t) => {
  const dir = await makeTempDir(t);
  const filePath = path.join(dir, "pointer.json");
  await writeJsonAtomic(filePath, { runId: "20260716-06" });
  assert.deepEqual(JSON.parse(await fs.promises.readFile(filePath, "utf8")), { runId: "20260716-06" });
  assert.deepEqual(await listTmpEntries(dir), []);
});
