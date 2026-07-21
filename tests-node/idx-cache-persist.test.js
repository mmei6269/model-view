"use strict";

// Idx and content-length cache persistence is best-effort: the fetched data
// is already in hand, so a disk failure (full disk, parent path collision)
// must not fail the read or strand a tmp file — the writeRegriddedBinCache
// containment policy, extended to these two fetch-and-persist paths.

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { fetchAndWriteNoaaIdxText } = require("../scripts/lib/noaa-beta/grib-source");

const IDX_TEXT = "1:0:d=2026010100:TMP:2 m above ground:anl:\n";

async function withIdxServer(run) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(IDX_TEXT);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await run(`http://127.0.0.1:${port}/probe.grib2.idx`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("idx fetch survives an unwritable cache path and leaves no tmp file", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "idx-persist-"));
  // The cache path's parent is a regular FILE, so mkdir/write must fail.
  const blocker = path.join(dir, "blocker");
  await fs.promises.writeFile(blocker, "not a directory");
  const cachePath = path.join(blocker, "cached.idx");
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...parts) => warnings.push(parts.join(" "));
  try {
    const text = await withIdxServer((idxUrl) => fetchAndWriteNoaaIdxText({ idxUrl, cachePath }));
    assert.equal(text, IDX_TEXT, "the fetched text must be returned despite the persist failure");
  } finally {
    console.warn = originalWarn;
  }
  assert.ok(
    warnings.some((line) => line.includes("idx cache write failed")),
    `expected a persist warning, got: ${warnings}`,
  );
  const leftovers = (await fs.promises.readdir(dir)).filter((name) => name.includes(".tmp-"));
  assert.deepEqual(leftovers, [], "no tmp files may be stranded");
  await fs.promises.rm(dir, { recursive: true, force: true });
});

test("idx fetch persists to a writable cache path (engagement control)", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "idx-persist-"));
  const cachePath = path.join(dir, "nested", "cached.idx");
  const text = await withIdxServer((idxUrl) => fetchAndWriteNoaaIdxText({ idxUrl, cachePath }));
  assert.equal(text, IDX_TEXT);
  assert.equal(await fs.promises.readFile(cachePath, "utf8"), IDX_TEXT);
  const leftovers = (await fs.promises.readdir(path.dirname(cachePath))).filter((name) => name.includes(".tmp-"));
  assert.deepEqual(leftovers, [], "tmp file must be renamed away on success");
  await fs.promises.rm(dir, { recursive: true, force: true });
});
