"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

const {
  PNG_IEND_CHUNK,
  PNG_SIGNATURE,
  assemblePngFromIdat,
  createPngChunk,
  toBufferView,
} = require("../scripts/lib/noaa-beta/png-encode");

function referenceAssemblePngFromIdat(idat, width, height) {
  const cols = Math.max(0, Math.round(Number(width) || 0));
  const rows = Math.max(0, Math.round(Number(height) || 0));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(cols, 0);
  ihdr.writeUInt32BE(rows, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([PNG_SIGNATURE, createPngChunk("IHDR", ihdr), createPngChunk("IDAT", idat), PNG_IEND_CHUNK]);
}

function patternBytes(length, salt = 0) {
  const out = Buffer.allocUnsafe(length);
  for (let index = 0; index < out.length; index += 1) {
    out[index] = (index * 31 + (index >> 7) * 17 + salt * 13) & 255;
  }
  return out;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function crc32(parts) {
  let crc = 0xffffffff;
  for (const part of parts) {
    for (const byte of part) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) {
        crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
      }
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function parseChunks(png) {
  assert.deepEqual(png.subarray(0, PNG_SIGNATURE.length), PNG_SIGNATURE);
  const chunks = [];
  let offset = PNG_SIGNATURE.length;
  while (offset < png.length) {
    assert.ok(offset + 12 <= png.length, `truncated chunk header at byte ${offset}`);
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const crcOffset = dataStart + length;
    const end = crcOffset + 4;
    assert.ok(end <= png.length, `${type} chunk overruns the PNG body`);
    const typeBytes = png.subarray(offset + 4, offset + 8);
    const data = png.subarray(dataStart, crcOffset);
    const storedCrc = png.readUInt32BE(crcOffset);
    assert.equal(storedCrc, crc32([typeBytes, data]), `${type} CRC mismatch`);
    chunks.push({ offset, length, type, data, crcOffset, end });
    offset = end;
  }
  assert.equal(offset, png.length);
  return chunks;
}

test("single-allocation assembly preserves exact PNG bytes for zero, small, and large IDAT payloads", () => {
  for (const [length, salt] of [
    [0, 0],
    [1, 1],
    [257, 2],
    [2 * 1024 * 1024 + 17, 3],
  ]) {
    const idat = patternBytes(length, salt);
    const expected = referenceAssemblePngFromIdat(idat, 1600, 980);
    const actual = assemblePngFromIdat(idat, 1600, 980);
    assert.equal(actual.length, idat.length + 57);
    assert.equal(sha256(actual), sha256(expected), `SHA mismatch for ${length}-byte IDAT`);
    assert.deepEqual(actual, expected);
  }
});

test("width and height normalization remains identical at numeric edge cases", () => {
  for (const [width, height, expectedWidth, expectedHeight] of [
    [undefined, Number.NaN, 0, 0],
    [-4.6, Number.NEGATIVE_INFINITY, 0, 0],
    ["3.6", 2.4, 4, 2],
    [4294967294.6, 1, 0xffffffff, 1],
  ]) {
    const expected = referenceAssemblePngFromIdat(Buffer.alloc(0), width, height);
    const actual = assemblePngFromIdat(Buffer.alloc(0), width, height);
    assert.deepEqual(actual, expected);
    const [ihdr] = parseChunks(actual);
    assert.equal(ihdr.data.readUInt32BE(0), expectedWidth);
    assert.equal(ihdr.data.readUInt32BE(4), expectedHeight);
  }

  for (const value of [0x100000000, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => referenceAssemblePngFromIdat(Buffer.alloc(0), value, 1),
      (error) => error?.code === "ERR_OUT_OF_RANGE",
    );
    assert.throws(
      () => assemblePngFromIdat(Buffer.alloc(0), value, 1),
      (error) => error?.code === "ERR_OUT_OF_RANGE",
    );
  }
});

test("dimension range errors retain precedence over invalid IDAT coercion", () => {
  const invalidIdat = {
    valueOf() {
      throw new Error("IDAT coercion ran first");
    },
  };
  assert.throws(
    () => referenceAssemblePngFromIdat(invalidIdat, 0x100000000, 1),
    (error) => error?.code === "ERR_OUT_OF_RANGE",
  );
  assert.throws(
    () => assemblePngFromIdat(invalidIdat, 0x100000000, 1),
    (error) => error?.code === "ERR_OUT_OF_RANGE",
  );
});

test("a detached Uint8Array retains the former empty-IDAT behavior", () => {
  const detached = new Uint8Array([1, 2, 3]);
  structuredClone(detached, { transfer: [detached.buffer] });
  assert.equal(detached.byteLength, 0);
  assert.deepEqual(assemblePngFromIdat(detached, 3, 2), referenceAssemblePngFromIdat(detached, 3, 2));
  assert.throws(() => toBufferView(detached), TypeError, "shared RGBA coercion must retain its detached-input error");
});

test("chunk boundaries, lengths, types, and CRCs are independently valid", () => {
  const idat = patternBytes(4099, 7);
  const png = assemblePngFromIdat(idat, 17, 23);
  const chunks = parseChunks(png);

  assert.deepEqual(
    chunks.map(({ offset, length, type, crcOffset, end }) => ({ offset, length, type, crcOffset, end })),
    [
      { offset: 8, length: 13, type: "IHDR", crcOffset: 29, end: 33 },
      { offset: 33, length: idat.length, type: "IDAT", crcOffset: 41 + idat.length, end: 45 + idat.length },
      { offset: 45 + idat.length, length: 0, type: "IEND", crcOffset: 53 + idat.length, end: 57 + idat.length },
    ],
  );
  assert.deepEqual(chunks[1].data, idat);
  assert.equal(chunks[2].crcOffset < png.length, true);
});

test("Buffer and Uint8Array subarrays are bounded snapshots with no output alias", () => {
  for (const makeView of [
    (backing) => backing.subarray(31, backing.length - 29),
    (backing) => new Uint8Array(backing.buffer, backing.byteOffset + 31, backing.length - 60),
  ]) {
    const backing = patternBytes(8192 + 60, 11);
    const idat = makeView(backing);
    const inputSnapshot = Buffer.from(idat);
    const png = assemblePngFromIdat(idat, 19, 29);
    const pngSnapshot = Buffer.from(png);
    const chunks = parseChunks(png);
    assert.deepEqual(chunks[1].data, inputSnapshot, "bytes outside the subarray must not enter IDAT");

    backing.fill(0xa5);
    assert.deepEqual(png, pngSnapshot, "mutating the input after return must not affect the PNG");

    idat.set(inputSnapshot);
    png[41] ^= 0xff;
    assert.deepEqual(Buffer.from(idat), inputSnapshot, "mutating the PNG must not affect its input");
  }
});

test("createPngChunk retains its allocating snapshot behavior", () => {
  const source = new Uint8Array([1, 2, 3, 4]);
  const chunk = createPngChunk("tEXt", source);
  const snapshot = Buffer.from(chunk);
  source.fill(99);
  assert.deepEqual(chunk, snapshot);
  assert.deepEqual(chunk.subarray(8, 12), Buffer.from([1, 2, 3, 4]));
  assert.notEqual(chunk.buffer, source.buffer);
});
