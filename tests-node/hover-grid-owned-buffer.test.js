"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const esbuild = require("esbuild");
const { buildHoverGridBinaryRaw } = require("../scripts/lib/hover-grid-binary");

function loadParser() {
  const entry = path.join(__dirname, "..", "next", "src", "core", "hover-grid-payload.ts");
  const { outputFiles } = esbuild.buildSync({
    entryPoints: [entry],
    bundle: true,
    format: "cjs",
    platform: "neutral",
    write: false,
    logLevel: "silent",
  });
  const moduleShim = { exports: {} };
  const fn = new vm.Script(`(function (module, exports, require) { ${outputFiles[0].text}\n})`).runInThisContext();
  fn(moduleShim, moduleShim.exports, require);
  return moduleShim.exports;
}

function exactArrayBuffer(bytes) {
  return Uint8Array.from(bytes).buffer;
}

function binaryParts(raw) {
  const bytes = Buffer.from(raw);
  const headerLength = bytes.readUInt32LE(4);
  const dataStart = 8 + headerLength;
  return {
    magic: bytes.subarray(0, 4),
    header: JSON.parse(bytes.subarray(8, dataStart).toString("utf8")),
    data: bytes.subarray(dataStart),
  };
}

function rebuildBinary(raw, mutateHeader, { forceHeaderParity = null, transformData = null, trailing = null } = {}) {
  const parts = binaryParts(raw);
  const header = structuredClone(parts.header);
  mutateHeader?.(header);
  let headerBytes = Buffer.from(JSON.stringify(header));
  if (forceHeaderParity === "even" && headerBytes.length % 2 !== 0) {
    headerBytes = Buffer.concat([headerBytes, Buffer.from(" ")]);
  }
  if (forceHeaderParity === "odd" && headerBytes.length % 2 === 0) {
    headerBytes = Buffer.concat([headerBytes, Buffer.from(" ")]);
  }
  const sourceData = transformData ? transformData(Buffer.from(parts.data), header) : Buffer.from(parts.data);
  const suffix = trailing ? Buffer.from(trailing) : Buffer.alloc(0);
  const rebuilt = Buffer.alloc(8 + headerBytes.length + sourceData.length + suffix.length);
  parts.magic.copy(rebuilt, 0);
  rebuilt.writeUInt32LE(headerBytes.length, 4);
  headerBytes.copy(rebuilt, 8);
  sourceData.copy(rebuilt, 8 + headerBytes.length);
  suffix.copy(rebuilt, 8 + headerBytes.length + sourceData.length);
  return rebuilt;
}

function fixtureRaw(schemaVersion = 3) {
  return buildHoverGridBinaryRaw({
    schemaVersion,
    rows: 2,
    cols: 4,
    variables: {
      alpha: {
        scale: 0.1,
        offset: 2,
        missing: -32768,
        values: new Int16Array([-32768, 32767, -32768, 0, 0, 1, -1, 12345]),
      },
      beta: {
        scale: 1,
        offset: -4,
        missing: -32768,
        values: new Int16Array([-12345, -12345, 32767, 32766, -32768, 5, 5, 5]),
      },
    },
  });
}

const EXPECTED_ALPHA = [-32768, 32767, -32768, 0, 0, 1, -1, 12345];
const EXPECTED_BETA = [-12345, -12345, 32767, 32766, -32768, 5, 5, 5];

function assertFixtureValues(payload) {
  assert.deepEqual(Array.from(payload.variables.alpha.values), EXPECTED_ALPHA);
  assert.deepEqual(Array.from(payload.variables.beta.values), EXPECTED_BETA);
}

test("owned canonical v3 parsing reconstructs once and returns views over the transferred response buffer", () => {
  const parser = loadParser();
  const raw = fixtureRaw(3);
  const parts = binaryParts(raw);
  const input = exactArrayBuffer(raw);
  const encodedDataBefore = Uint8Array.from(parts.data);

  const payload = parser.normalizeOwnedBinaryHoverGridPayload(input);

  assert.equal(payload.schemaVersion, 3);
  assert.equal(payload.rows, 2);
  assert.equal(payload.cols, 4);
  assertFixtureValues(payload);
  assert.strictEqual(payload.variables.alpha.values.buffer, input);
  assert.strictEqual(payload.variables.beta.values.buffer, input);
  assert.equal(payload.variables.alpha.values.byteOffset, 8 + raw.readUInt32LE(4));
  assert.equal(
    payload.variables.beta.values.byteOffset,
    8 + raw.readUInt32LE(4) + parts.header.variables.beta.byteOffset,
  );
  assert.notDeepEqual(
    new Uint8Array(input, 8 + raw.readUInt32LE(4), encodedDataBefore.length),
    encodedDataBefore,
    "v3 delta residue must be reconstructed in the exclusively owned buffer",
  );

  payload.variables.alpha.values[0] = 321;
  assert.equal(new DataView(input).getInt16(payload.variables.alpha.values.byteOffset, true), 321);
});

test("owned canonical v4 parsing reconstructs each gradient2d plane in place with one backing owner", () => {
  const parser = loadParser();
  const raw = fixtureRaw(4);
  const parts = binaryParts(raw);
  const input = exactArrayBuffer(raw);
  const encodedDataBefore = Uint8Array.from(parts.data);

  const payload = parser.normalizeOwnedBinaryHoverGridPayload(input);

  assert.equal(payload.schemaVersion, 4);
  assert.equal(parts.header.predictor, "gradient2d");
  assertFixtureValues(payload);
  assert.strictEqual(payload.variables.alpha.values.buffer, input);
  assert.strictEqual(payload.variables.beta.values.buffer, input);
  assert.notDeepEqual(
    new Uint8Array(input, 8 + raw.readUInt32LE(4), encodedDataBefore.length),
    encodedDataBefore,
    "MVH4 predictor residue must be reconstructed in the exclusively owned buffer",
  );
});

test("the generic binary normalizer remains isolated from caller bytes and writes", () => {
  const parser = loadParser();
  const input = exactArrayBuffer(fixtureRaw(3));
  const original = Uint8Array.from(new Uint8Array(input));

  const payload = parser.normalizeBinaryHoverGridPayload(input);

  assertFixtureValues(payload);
  assert.deepEqual(new Uint8Array(input), original, "generic v3 decoding must not reconstruct caller bytes in place");
  assert.notStrictEqual(payload.variables.alpha.values.buffer, input);
  assert.strictEqual(
    payload.variables.alpha.values.buffer,
    payload.variables.beta.values.buffer,
    "the isolated snapshot may still provide zero-copy per-variable views",
  );
  payload.variables.alpha.values[0] = 123;
  assert.deepEqual(new Uint8Array(input), original, "writes through result views must remain isolated from the caller");
});

test("the generic MVH4 normalizer reconstructs exactly without mutating caller-owned residue", () => {
  const parser = loadParser();
  const input = exactArrayBuffer(fixtureRaw(4));
  const original = Uint8Array.from(new Uint8Array(input));

  const payload = parser.normalizeBinaryHoverGridPayload(input);

  assert.equal(payload.schemaVersion, 4);
  assertFixtureValues(payload);
  assert.deepEqual(new Uint8Array(input), original);
  assert.notStrictEqual(payload.variables.alpha.values.buffer, input);
  assert.strictEqual(payload.variables.alpha.values.buffer, payload.variables.beta.values.buffer);
});

test("canonical empty MVH3 and MVH4 preserve positive dimensions while legacy and noncanonical empties fail closed", () => {
  const parser = loadParser();
  const raw4 = buildHoverGridBinaryRaw({
    schemaVersion: 4,
    rows: 2,
    cols: 3,
    variables: {},
  });
  const input4 = exactArrayBuffer(raw4);
  assert.deepEqual(parser.normalizeOwnedBinaryHoverGridPayload(input4), {
    schemaVersion: 4,
    rows: 2,
    cols: 3,
    variables: {},
  });

  const raw3 = buildHoverGridBinaryRaw({
    schemaVersion: 3,
    rows: 2,
    cols: 3,
    variables: {},
  });
  const input3 = exactArrayBuffer(raw3);
  const before3 = Uint8Array.from(new Uint8Array(input3));
  assert.deepEqual(parser.normalizeOwnedBinaryHoverGridPayload(input3), {
    schemaVersion: 3,
    rows: 2,
    cols: 3,
    variables: {},
  });
  assert.deepEqual(new Uint8Array(input3), before3);

  for (const legacySchema of [1, 2]) {
    const legacy = rebuildBinary(raw3, (header) => {
      header.schemaVersion = legacySchema;
    });
    legacy.write("MVHG", 0, "ascii");
    assert.deepEqual(parser.normalizeOwnedBinaryHoverGridPayload(exactArrayBuffer(legacy)), {
      schemaVersion: 1,
      rows: 0,
      cols: 0,
      variables: {},
    });
  }
  const trailing3 = Buffer.concat([raw3, Buffer.from([0, 0])]);
  assert.deepEqual(parser.normalizeOwnedBinaryHoverGridPayload(exactArrayBuffer(trailing3)), {
    schemaVersion: 1,
    rows: 0,
    cols: 0,
    variables: {},
  });
});

test("owned canonical pre-v3 payloads also view the transferred buffer without mutation", () => {
  const parser = loadParser();
  const input = exactArrayBuffer(fixtureRaw(1));
  const original = Uint8Array.from(new Uint8Array(input));

  const payload = parser.normalizeOwnedBinaryHoverGridPayload(input);

  assert.equal(payload.schemaVersion, 1);
  assertFixtureValues(payload);
  assert.strictEqual(payload.variables.alpha.values.buffer, input);
  assert.strictEqual(payload.variables.beta.values.buffer, input);
  assert.deepEqual(new Uint8Array(input), original);
});

test("noncanonical layouts fail closed to copied values while preserving compatible payloads", async (t) => {
  const parser = loadParser();
  const canonical = fixtureRaw(3);
  const cases = [
    {
      name: "numeric-string metadata",
      raw: rebuildBinary(
        canonical,
        (header) => {
          for (const variable of Object.values(header.variables)) {
            variable.byteOffset = String(variable.byteOffset);
            variable.length = String(variable.length);
          }
        },
        { forceHeaderParity: "even" },
      ),
    },
    {
      name: "omitted legacy length",
      raw: rebuildBinary(
        canonical,
        (header) => {
          delete header.variables.alpha.length;
        },
        { forceHeaderParity: "even" },
      ),
    },
    {
      name: "header/data misalignment",
      raw: rebuildBinary(canonical, null, { forceHeaderParity: "odd" }),
    },
    {
      name: "out-of-order descriptors",
      raw: rebuildBinary(
        canonical,
        (header) => {
          header.variables = {
            beta: header.variables.beta,
            alpha: header.variables.alpha,
          };
        },
        { forceHeaderParity: "even" },
      ),
    },
    {
      name: "overlapping descriptor",
      raw: rebuildBinary(
        canonical,
        (header) => {
          header.variables = {
            alias: { ...header.variables.alpha },
            ...header.variables,
          };
        },
        { forceHeaderParity: "even" },
      ),
      assertExtra(payload) {
        assert.deepEqual(Array.from(payload.variables.alias.values), EXPECTED_ALPHA);
      },
    },
    {
      name: "gap between descriptors",
      raw: rebuildBinary(
        canonical,
        (header) => {
          header.variables.beta.byteOffset += 2;
        },
        {
          forceHeaderParity: "even",
          transformData(data, header) {
            const split = header.variables.alpha.length * 2;
            return Buffer.concat([data.subarray(0, split), Buffer.alloc(2), data.subarray(split)]);
          },
        },
      ),
    },
    {
      name: "trailing unreferenced data",
      raw: rebuildBinary(canonical, null, { forceHeaderParity: "even", trailing: [0, 0] }),
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, () => {
      const input = exactArrayBuffer(fixture.raw);
      const payload = parser.normalizeOwnedBinaryHoverGridPayload(input);
      assertFixtureValues(payload);
      fixture.assertExtra?.(payload);
      assert.notStrictEqual(payload.variables.alpha.values.buffer, input);
      assert.notStrictEqual(payload.variables.beta.values.buffer, input);
    });
  }
});

test("unsafe dimensions, products, and malformed containers return an empty payload without allocation or mutation", () => {
  const parser = loadParser();
  const canonical = fixtureRaw(3);
  const unsafe = rebuildBinary(
    canonical,
    (header) => {
      header.rows = Number.MAX_SAFE_INTEGER;
      header.cols = 2;
    },
    { forceHeaderParity: "even" },
  );
  const unsafeInput = exactArrayBuffer(unsafe);
  const before = Uint8Array.from(new Uint8Array(unsafeInput));

  assert.deepEqual(parser.normalizeOwnedBinaryHoverGridPayload(unsafeInput), {
    schemaVersion: 1,
    rows: 0,
    cols: 0,
    variables: {},
  });
  assert.deepEqual(new Uint8Array(unsafeInput), before);
  assert.deepEqual(parser.normalizeOwnedBinaryHoverGridPayload(exactArrayBuffer(Buffer.from("not-hover"))), {
    schemaVersion: 1,
    rows: 0,
    cols: 0,
    variables: {},
  });
});

test("truncated and out-of-bounds binary descriptors fail the entire payload before reconstruction", () => {
  const parser = loadParser();
  const canonical = fixtureRaw(3);
  const dataLength = binaryParts(canonical).data.length;
  const malformedCases = [
    canonical.subarray(0, canonical.length - 4),
    rebuildBinary(
      canonical,
      (header) => {
        header.variables.beta.byteOffset = dataLength;
      },
      { forceHeaderParity: "even" },
    ),
    rebuildBinary(
      canonical,
      (header) => {
        header.variables.beta.length += 1;
      },
      { forceHeaderParity: "even" },
    ),
    rebuildBinary(
      canonical,
      (header) => {
        header.variables.beta.length -= 1;
      },
      { forceHeaderParity: "even" },
    ),
  ];

  for (const malformed of malformedCases) {
    const input = exactArrayBuffer(malformed);
    const before = Uint8Array.from(new Uint8Array(input));
    assert.deepEqual(parser.normalizeOwnedBinaryHoverGridPayload(input), {
      schemaVersion: 1,
      rows: 0,
      cols: 0,
      variables: {},
    });
    assert.deepEqual(new Uint8Array(input), before, "rejected bytes must not be reconstructed in place");
  }
});

test("malformed MVH4 envelopes fail closed before mutating predictor residue", () => {
  const parser = loadParser();
  const canonical = fixtureRaw(4);
  const wrongMagic = rebuildBinary(
    canonical,
    (header) => {
      header.schemaVersion = 4;
    },
    { forceHeaderParity: "even" },
  );
  wrongMagic.write("MVH3", 0, "ascii");
  const malformedCases = [
    rebuildBinary(
      canonical,
      (header) => {
        delete header.predictor;
      },
      { forceHeaderParity: "even" },
    ),
    rebuildBinary(
      canonical,
      (header) => {
        header.predictor = "global1d";
      },
      { forceHeaderParity: "even" },
    ),
    rebuildBinary(
      canonical,
      (header) => {
        header.schemaVersion = 3;
      },
      { forceHeaderParity: "even" },
    ),
    wrongMagic,
    rebuildBinary(
      canonical,
      (header) => {
        header.variables.alpha.scale = "0.1";
      },
      { forceHeaderParity: "even" },
    ),
    rebuildBinary(
      canonical,
      (header) => {
        header.variables.alpha.scale = 0;
      },
      { forceHeaderParity: "even" },
    ),
    rebuildBinary(
      canonical,
      (header) => {
        header.variables = {};
      },
      { forceHeaderParity: "even" },
    ),
    rebuildBinary(
      canonical,
      (header) => {
        header.variables = { "": header.variables.alpha };
      },
      { forceHeaderParity: "even" },
    ),
    rebuildBinary(
      canonical,
      (header) => {
        header.variables.beta.byteOffset += 2;
      },
      {
        forceHeaderParity: "even",
        transformData(data, header) {
          const split = header.variables.alpha.length * 2;
          return Buffer.concat([data.subarray(0, split), Buffer.alloc(2), data.subarray(split)]);
        },
      },
    ),
    rebuildBinary(canonical, null, { forceHeaderParity: "even", trailing: [0, 0] }),
    rebuildBinary(canonical, null, { forceHeaderParity: "odd" }),
    canonical.subarray(0, canonical.length - 2),
  ];

  for (const malformed of malformedCases) {
    const input = exactArrayBuffer(malformed);
    const before = Uint8Array.from(new Uint8Array(input));
    assert.deepEqual(parser.normalizeOwnedBinaryHoverGridPayload(input), {
      schemaVersion: 1,
      rows: 0,
      cols: 0,
      variables: {},
    });
    assert.deepEqual(new Uint8Array(input), before, "rejected MVH4 bytes must remain encoded and untouched");
  }
});

test("fallback decoding rejects descriptor-count allocation amplification before reconstruction", () => {
  const parser = loadParser();
  const canonical = fixtureRaw(3);
  const amplified = rebuildBinary(
    canonical,
    (header) => {
      const aliases = {};
      for (let index = 0; index < 128; index += 1) {
        aliases[`alias${index}`] = { ...header.variables.alpha };
      }
      header.variables = aliases;
    },
    { forceHeaderParity: "even" },
  );
  const input = exactArrayBuffer(amplified);
  const before = Uint8Array.from(new Uint8Array(input));

  assert.deepEqual(parser.normalizeOwnedBinaryHoverGridPayload(input), {
    schemaVersion: 1,
    rows: 0,
    cols: 0,
    variables: {},
  });
  assert.deepEqual(
    new Uint8Array(input),
    before,
    "rejected fallback amplification must not reconstruct attacker-controlled bytes",
  );
});

test("JSON/base64 normalization bounds dimensions and input amplification while preserving valid values", () => {
  const parser = loadParser();
  const values = new Int16Array(EXPECTED_ALPHA);
  const valid = parser.normalizeHoverGridPayload({
    schemaVersion: 1,
    rows: 2,
    cols: 4,
    variables: {
      alpha: {
        scale: 0.1,
        offset: 2,
        missing: -32768,
        data: Buffer.from(values.buffer, values.byteOffset, values.byteLength).toString("base64"),
      },
    },
  });
  assert.equal(valid.rows, 2);
  assert.equal(valid.cols, 4);
  assert.deepEqual(Array.from(valid.variables.alpha.values), EXPECTED_ALPHA);

  const hostileDimensions = parser.normalizeHoverGridPayload({
    schemaVersion: 1,
    rows: 2 ** 32,
    cols: 2 ** 20,
    variables: {
      alpha: { scale: 1, offset: 0, missing: -32768, data: "AAAA" },
    },
  });
  assert.deepEqual(hostileDimensions, {
    schemaVersion: 1,
    rows: 0,
    cols: 0,
    variables: {},
  });

  const shortData = parser.normalizeHoverGridPayload({
    schemaVersion: 1,
    rows: 2,
    cols: 4,
    variables: {
      alpha: {
        scale: 1,
        offset: 0,
        missing: -32768,
        data: Buffer.from(values.buffer, values.byteOffset, values.byteLength / 2).toString("base64"),
      },
    },
  });
  assert.deepEqual(shortData.variables, {});

  const amplifiedInput = parser.normalizeHoverGridPayload({
    schemaVersion: 1,
    rows: 1,
    cols: 1,
    variables: {
      alpha: { scale: 1, offset: 0, missing: -32768, data: "AAAA".repeat(128) },
    },
  });
  assert.deepEqual(amplifiedInput, {
    schemaVersion: 1,
    rows: 0,
    cols: 0,
    variables: {},
  });
});

test("dangerous variable keys are rejected without changing the variables object prototype", () => {
  const parser = loadParser();
  const canonical = fixtureRaw(3);
  const polluted = rebuildBinary(
    canonical,
    (header) => {
      const descriptor = { ...header.variables.alpha };
      Object.defineProperty(header.variables, "__proto__", {
        value: descriptor,
        enumerable: true,
      });
      header.variables.constructor = descriptor;
      header.variables.prototype = descriptor;
    },
    { forceHeaderParity: "even" },
  );
  const binary = parser.normalizeOwnedBinaryHoverGridPayload(exactArrayBuffer(polluted));
  assert.equal(Object.getPrototypeOf(binary.variables), Object.prototype);
  assert.equal(Object.hasOwn(binary.variables, "__proto__"), false);
  assert.equal(Object.hasOwn(binary.variables, "constructor"), false);
  assert.equal(Object.hasOwn(binary.variables, "prototype"), false);
  assertFixtureValues(binary);

  const json = parser.normalizeHoverGridPayload({
    schemaVersion: 1,
    rows: 1,
    cols: 1,
    variables: {
      safe: { scale: 1, offset: 0, missing: -32768, data: "AAA=" },
      constructor: { scale: 1, offset: 0, missing: -32768, data: "AAA=" },
      prototype: { scale: 1, offset: 0, missing: -32768, data: "AAA=" },
    },
  });
  assert.deepEqual(Object.keys(json.variables), ["safe"]);
  assert.equal(Object.getPrototypeOf(json.variables), Object.prototype);
});

test("fallback rejects array variable maps and non-object descriptors without touching owned bytes", () => {
  const parser = loadParser();
  const canonical = fixtureRaw(3);
  const malformedCases = [
    rebuildBinary(
      canonical,
      (header) => {
        header.variables = [header.variables.alpha];
      },
      { forceHeaderParity: "even" },
    ),
    rebuildBinary(
      canonical,
      (header) => {
        header.variables.alpha = "not-a-descriptor";
      },
      { forceHeaderParity: "even" },
    ),
  ];

  for (const malformed of malformedCases) {
    const input = exactArrayBuffer(malformed);
    const before = Uint8Array.from(new Uint8Array(input));
    assert.deepEqual(parser.normalizeOwnedBinaryHoverGridPayload(input), {
      schemaVersion: 1,
      rows: 0,
      cols: 0,
      variables: {},
    });
    assert.deepEqual(new Uint8Array(input), before);
  }
});
