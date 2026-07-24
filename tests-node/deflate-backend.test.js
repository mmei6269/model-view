"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const path = require("node:path");
const test = require("node:test");
const zlib = require("node:zlib");
const { zlib: libdeflateZlib } = require("libdeflate");
const {
  deflatePngIdatSync,
  pngDeflateBackendName,
  _testBufferFromLibdeflateResult,
} = require("../scripts/lib/noaa-beta/deflate-backend");

function patternBuffer(bytes, salt = 0) {
  const out = Buffer.allocUnsafe(bytes);
  for (let index = 0; index < bytes; index += 1) {
    out[index] = (index * 31 + ((index >> 3) % 7) + salt * 17) & 255;
  }
  return out;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

test("libdeflate backend keeps exact IDAT bytes without the redundant Uint8Array copy", () => {
  assert.equal(pngDeflateBackendName(), "libdeflate");
  for (const [bytes, salt] of [
    [0, 0],
    [1, 1],
    [4096, 2],
    [262144, 3],
  ]) {
    const raw = patternBuffer(bytes, salt);
    const expected = Buffer.from(libdeflateZlib(raw, 1));
    const actual = deflatePngIdatSync(raw, 1);
    assert.ok(Buffer.isBuffer(actual));
    assert.equal(actual.length, expected.length);
    assert.equal(sha256(actual), sha256(expected));
    assert.deepEqual(actual, expected);
    assert.deepEqual(zlib.inflateSync(actual), raw);
  }
});

test("returned IDAT owns stable bytes across later WASM calls and sequential outputs do not alias", () => {
  const firstRaw = patternBuffer(256 * 1024, 4);
  const secondRaw = patternBuffer(384 * 1024, 5);
  const first = deflatePngIdatSync(firstRaw, 1);
  const firstSnapshot = Buffer.from(first);

  for (let salt = 6; salt < 18; salt += 1) {
    deflatePngIdatSync(patternBuffer(64 * 1024 + salt * 8192, salt), 1);
  }
  assert.deepEqual(first, firstSnapshot, "later WASM allocations must not overwrite an earlier result");
  assert.deepEqual(zlib.inflateSync(first), firstRaw);

  const second = deflatePngIdatSync(secondRaw, 1);
  const secondSnapshot = Buffer.from(second);
  first[0] ^= 0xff;
  assert.deepEqual(second, secondSnapshot, "mutating one returned output must not affect another");
  assert.deepEqual(zlib.inflateSync(second), secondRaw);
});

test("exact-sized plain Uint8Array uses a zero-copy Buffer view", () => {
  const owned = new Uint8Array([1, 2, 3, 4]);
  const result = _testBufferFromLibdeflateResult(owned);
  assert.ok(Buffer.isBuffer(result));
  assert.equal(result.buffer, owned.buffer);
  result[1] = 29;
  assert.equal(owned[1], 29, "the adapter should view the transferred allocation, not copy it");
});

test("installed libdeflate engages the zero-copy view and its backing store transfers safely", () => {
  const raw = patternBuffer(512 * 1024, 20);
  const libdeflateResult = libdeflateZlib(raw, 1);
  const wrapped = _testBufferFromLibdeflateResult(libdeflateResult);
  const expected = Buffer.from(wrapped);

  assert.equal(
    wrapped.buffer,
    libdeflateResult.buffer,
    "the installed libdeflate result shape must engage the zero-copy branch",
  );
  const transferred = structuredClone(wrapped.buffer, { transfer: [wrapped.buffer] });
  assert.equal(wrapped.byteLength, 0, "transferring the worker reply must detach the helper's view");
  assert.deepEqual(Buffer.from(transferred), expected);
  assert.deepEqual(zlib.inflateSync(transferred), raw);
});

test("subarrays, typed-array subclasses, and unusual results conservatively copy", () => {
  const backing = new Uint8Array([9, 1, 2, 3, 4, 8]);
  const subarray = backing.subarray(1, 5);
  const fromSubarray = _testBufferFromLibdeflateResult(subarray);
  assert.deepEqual(fromSubarray, Buffer.from([1, 2, 3, 4]));
  assert.notEqual(fromSubarray.buffer, backing.buffer);
  backing[2] = 99;
  assert.deepEqual(fromSubarray, Buffer.from([1, 2, 3, 4]));

  class DerivedUint8Array extends Uint8Array {}
  const derived = new DerivedUint8Array([5, 6, 7]);
  const fromDerived = _testBufferFromLibdeflateResult(derived);
  derived[0] = 42;
  assert.deepEqual(fromDerived, Buffer.from([5, 6, 7]));

  const arrayResult = [11, 12, 13];
  const fromArray = _testBufferFromLibdeflateResult(arrayResult);
  arrayResult[0] = 99;
  assert.deepEqual(fromArray, Buffer.from([11, 12, 13]));

  if (typeof SharedArrayBuffer === "function") {
    const shared = new Uint8Array(new SharedArrayBuffer(3));
    shared.set([21, 22, 23]);
    const fromShared = _testBufferFromLibdeflateResult(shared);
    shared[0] = 99;
    assert.deepEqual(fromShared, Buffer.from([21, 22, 23]));
  }
});

test("forced zlib backend preserves the existing node:zlib fallback bytes", () => {
  const backendPath = path.join(__dirname, "../scripts/lib/noaa-beta/deflate-backend.js");
  const script = `
    const backend = require(${JSON.stringify(backendPath)});
    const raw = Buffer.from(process.argv[1], "base64");
    const result = {
      backend: backend.pngDeflateBackendName(),
      levelOne: backend.deflatePngIdatSync(raw, 1).toString("base64"),
      levelSix: backend.deflatePngIdatSync(raw, 6).toString("base64"),
    };
    process.stdout.write(JSON.stringify(result));
  `;
  const raw = patternBuffer(65536, 19);
  const child = JSON.parse(
    execFileSync(process.execPath, ["-e", script, raw.toString("base64")], {
      encoding: "utf8",
      env: { ...process.env, MODELVIEW_PNG_DEFLATE_BACKEND: "zlib" },
    }),
  );
  assert.equal(child.backend, "zlib");
  assert.deepEqual(Buffer.from(child.levelOne, "base64"), zlib.deflateSync(raw, { level: 1 }));
  assert.deepEqual(Buffer.from(child.levelSix, "base64"), zlib.deflateSync(raw, { level: 6 }));
});
