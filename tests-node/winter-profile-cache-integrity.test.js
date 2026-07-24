"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { cacheMetadataWithPayload } = require("../scripts/lib/noaa-beta/cache-io");
const {
  PREVIOUS_PROFILE_GRID_CACHE_VERSION,
  previousProfileGridCachePath,
  profileGridCachePath,
  readCachedProfileGrids,
  writeCachedProfileGrids,
} = require("../scripts/lib/noaa-beta/winter-profile-decode");

const PAYLOAD = {
  version: "derived-profile-grid-v3-sha256-complete",
  modelKey: "hrrr",
  productKey: "wrfprs",
  date: "20260716",
  cycle: "13",
  hour: 3,
  width: 3,
  height: 2,
  bounds: { west: -129, south: 21, east: -63, north: 53 },
  records: {
    profileHgt925: { record: "10" },
    profileTmp925: { record: "11" },
  },
};

function makeGrid(seed) {
  const grid = new Float32Array(PAYLOAD.width * PAYLOAD.height);
  for (let index = 0; index < grid.length; index += 1) {
    grid[index] = Math.fround(seed + index * 0.25);
  }
  return grid;
}

async function makeCache(t, prefix) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  return path.join(dir, "profile");
}

async function makeMigrationFixture(t, prefix) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const context = {
    profileGridCacheDir: path.join(dir, "cache"),
    modelKey: PAYLOAD.modelKey,
    date: PAYLOAD.date,
    cycle: PAYLOAD.cycle,
  };
  const cachePath = profileGridCachePath(PAYLOAD, context);
  const previousCachePath = previousProfileGridCachePath(cachePath, PAYLOAD, context);
  assert.equal(
    previousCachePath,
    profileGridCachePath(
      {
        ...PAYLOAD,
        version: PREVIOUS_PROFILE_GRID_CACHE_VERSION,
      },
      context,
    ),
  );
  assert.notEqual(previousCachePath, cachePath);
  await fs.promises.mkdir(path.dirname(previousCachePath), { recursive: true });
  await fs.promises.writeFile(`${previousCachePath}.bin`, "v2-body");
  await fs.promises.writeFile(`${previousCachePath}.json`, "v2-metadata");
  return { cachePath, context, previousCachePath };
}

function profileGrids() {
  return { profileHgt925: makeGrid(100), profileTmp925: makeGrid(250) };
}

test("winter profile cache requires a body hash and exact record-grid coverage", async (t) => {
  const cachePath = await makeCache(t, "wx-profile-integrity-");
  const hgt = makeGrid(100);
  const tmp = makeGrid(250);
  new Uint32Array(tmp.buffer)[2] = 0x7fc12345;

  assert.equal(
    await writeCachedProfileGrids(cachePath, PAYLOAD, {
      profileTmp925: tmp,
      profileHgt925: hgt,
    }),
    true,
  );
  const metadata = JSON.parse(await fs.promises.readFile(`${cachePath}.json`, "utf8"));
  const body = await fs.promises.readFile(`${cachePath}.bin`);
  assert.deepEqual(
    metadata.grids.map((grid) => grid.key),
    Object.keys(PAYLOAD.records).sort(),
  );
  assert.equal(metadata.binBytes, body.byteLength);
  assert.equal(metadata.binSha256, crypto.createHash("sha256").update(body).digest("hex"));

  const restored = await readCachedProfileGrids(cachePath, PAYLOAD);
  assert.ok(restored);
  assert.deepEqual(
    Buffer.from(restored.profileHgt925.buffer, restored.profileHgt925.byteOffset, restored.profileHgt925.byteLength),
    Buffer.from(hgt.buffer),
  );
  assert.deepEqual(
    Buffer.from(restored.profileTmp925.buffer, restored.profileTmp925.byteOffset, restored.profileTmp925.byteLength),
    Buffer.from(tmp.buffer),
  );

  assert.equal(
    await writeCachedProfileGrids(cachePath, PAYLOAD, { profileHgt925: hgt }),
    false,
    "partial writes are refused",
  );
  assert.equal(
    await writeCachedProfileGrids(cachePath, PAYLOAD, {
      profileHgt925: hgt,
      profileTmp925: tmp,
      unexpected: makeGrid(1),
    }),
    false,
    "extra-grid writes are refused",
  );
});

test("winter profile cache rejects same-size corruption and legacy unhashed metadata", async (t) => {
  const cachePath = await makeCache(t, "wx-profile-corruption-");
  const grids = { profileHgt925: makeGrid(100), profileTmp925: makeGrid(250) };
  assert.equal(await writeCachedProfileGrids(cachePath, PAYLOAD, grids), true);

  const body = await fs.promises.readFile(`${cachePath}.bin`);
  body[body.length >> 1] ^= 0xff;
  await fs.promises.writeFile(`${cachePath}.bin`, body);
  assert.equal(await readCachedProfileGrids(cachePath, PAYLOAD), null, "same-size body corruption is a miss");

  const gridBytes = PAYLOAD.width * PAYLOAD.height * 4;
  const legacyBody = Buffer.concat([Buffer.from(grids.profileHgt925.buffer), Buffer.from(grids.profileTmp925.buffer)]);
  await fs.promises.writeFile(`${cachePath}.bin`, legacyBody);
  await fs.promises.writeFile(
    `${cachePath}.json`,
    JSON.stringify(
      cacheMetadataWithPayload(PAYLOAD, {
        grids: [
          { key: "profileHgt925", byteOffset: 0, byteLength: gridBytes },
          { key: "profileTmp925", byteOffset: gridBytes, byteLength: gridBytes },
        ],
      }),
    ),
  );
  assert.equal(await readCachedProfileGrids(cachePath, PAYLOAD), null, "unhashed legacy metadata is a miss");
  assert.equal(await writeCachedProfileGrids(cachePath, PAYLOAD, grids), true, "legacy entry is replaceable");
  assert.ok(await readCachedProfileGrids(cachePath, PAYLOAD));
});

test("racing complete winter profile publications never yield a hybrid hit", async (t) => {
  const cachePath = await makeCache(t, "wx-profile-race-");
  const left = { profileHgt925: makeGrid(10), profileTmp925: makeGrid(20) };
  const right = { profileHgt925: makeGrid(30), profileTmp925: makeGrid(40) };
  await Promise.all([
    writeCachedProfileGrids(cachePath, PAYLOAD, left),
    writeCachedProfileGrids(cachePath, PAYLOAD, right),
  ]);

  const restored = await readCachedProfileGrids(cachePath, PAYLOAD);
  if (!restored) {
    return;
  }
  const restoredBody = Buffer.concat([
    Buffer.from(restored.profileHgt925.buffer, restored.profileHgt925.byteOffset, restored.profileHgt925.byteLength),
    Buffer.from(restored.profileTmp925.buffer, restored.profileTmp925.byteOffset, restored.profileTmp925.byteLength),
  ]);
  const leftBody = Buffer.concat([Buffer.from(left.profileHgt925.buffer), Buffer.from(left.profileTmp925.buffer)]);
  const rightBody = Buffer.concat([Buffer.from(right.profileHgt925.buffer), Buffer.from(right.profileTmp925.buffer)]);
  assert.ok(
    restoredBody.equals(leftBody) || restoredBody.equals(rightBody),
    "accepted hit must be one complete writer",
  );
});

test("successful winter profile v3 publication removes only the exact v2 body and metadata", async (t) => {
  const { cachePath, context, previousCachePath } = await makeMigrationFixture(t, "wx-profile-migration-");
  const previousLockPath = `${previousCachePath}.lock`;
  const unrelatedPath = `${previousCachePath}-unrelated.bin`;
  await fs.promises.writeFile(previousLockPath, "keep-lock");
  await fs.promises.writeFile(unrelatedPath, "keep-unrelated");

  assert.equal(await writeCachedProfileGrids(cachePath, PAYLOAD, profileGrids(), context), true);
  assert.ok(await readCachedProfileGrids(cachePath, PAYLOAD));
  assert.equal(fs.existsSync(`${previousCachePath}.bin`), false);
  assert.equal(fs.existsSync(`${previousCachePath}.json`), false);
  assert.equal(await fs.promises.readFile(previousLockPath, "utf8"), "keep-lock");
  assert.equal(await fs.promises.readFile(unrelatedPath, "utf8"), "keep-unrelated");
});

test("failed winter profile v3 metadata publication preserves the complete v2 cache", async (t) => {
  const { cachePath, context, previousCachePath } = await makeMigrationFixture(t, "wx-profile-migration-fail-");
  const originalRename = fs.promises.rename;
  t.mock.method(fs.promises, "rename", async (sourcePath, destinationPath) => {
    if (destinationPath === `${cachePath}.json`) {
      throw new Error("injected v3 metadata publication failure");
    }
    return originalRename(sourcePath, destinationPath);
  });
  t.mock.method(console, "warn", () => {});

  assert.equal(await writeCachedProfileGrids(cachePath, PAYLOAD, profileGrids(), context), false);
  assert.equal(await fs.promises.readFile(`${previousCachePath}.bin`, "utf8"), "v2-body");
  assert.equal(await fs.promises.readFile(`${previousCachePath}.json`, "utf8"), "v2-metadata");
  assert.equal(fs.existsSync(`${cachePath}.bin`), true, "the body rename completed before metadata failed");
  assert.equal(fs.existsSync(`${cachePath}.json`), false);
});

test("winter profile v2 cleanup failures cannot fail a valid v3 publication", async (t) => {
  const { cachePath, context, previousCachePath } = await makeMigrationFixture(t, "wx-profile-migration-cleanup-fail-");
  const stalePaths = [`${previousCachePath}.bin`, `${previousCachePath}.json`].sort();
  const attempted = [];
  const originalRm = fs.promises.rm;
  t.mock.method(fs.promises, "rm", (targetPath, options) => {
    if (stalePaths.includes(String(targetPath))) {
      attempted.push(String(targetPath));
      throw new Error("injected v2 cleanup failure");
    }
    return originalRm(targetPath, options);
  });

  assert.equal(await writeCachedProfileGrids(cachePath, PAYLOAD, profileGrids(), context), true);
  assert.deepEqual(attempted.sort(), stalePaths);
  assert.ok(await readCachedProfileGrids(cachePath, PAYLOAD));
  assert.equal(await fs.promises.readFile(`${previousCachePath}.bin`, "utf8"), "v2-body");
  assert.equal(await fs.promises.readFile(`${previousCachePath}.json`, "utf8"), "v2-metadata");
});
