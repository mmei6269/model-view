"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  DEFAULT_BINARY_PATH,
  DEFAULT_MANIFEST_PATH,
  DEFAULT_SOURCE_PATH,
  SNOW_RF_ASSET_MATERIALIZATION_PHASES,
  SNOW_RF_ASSET_ORACLES,
  SNOW_RF_SOURCE_IDENTITY,
} = require("../scripts/lib/noaa-beta/snow-rf-asset");
const { predictRandomForest } = require("../scripts/lib/noaa-beta/snow-rf-compiler");
const {
  SNOW_RF_ASSET_ENV,
  SNOW_RF_CUSTOM_PATH_ENV,
  SNOW_RF_LOAD_FAILURE_CACHE,
  SNOW_RF_LOAD_STATE_CACHE,
  _resetSnowRfLoaderForTest,
  loadSnowRfState,
  resolveSnowRfAssetMode,
  resolveSnowRfLoadConfiguration,
  snowArtifactCacheIdentity,
} = require("../scripts/lib/noaa-beta/selection");

const COMMON_PHASES = Object.freeze(["identityOnlySourceCaptureNs", "modelSourceCaptureNs"]);
const JSON_PHASES = Object.freeze(["jsonParseNs", "strictCompileNs", "graphValidateNs"]);
const TYPED_READ_PHASES = Object.freeze(["manifestReadNs", "manifestParseNs", "binaryReadNs"]);
const TYPED_ATTEMPT_PHASES = Object.freeze([...TYPED_READ_PHASES, ...SNOW_RF_ASSET_MATERIALIZATION_PHASES]);
const SOURCE_NESTED_PHASES = Object.freeze(["sourceReadNs", "sourceHashNs"]);
const MEMORY_FIELDS = Object.freeze(["rss", "heapTotal", "heapUsed", "external", "arrayBuffers"]);
const ENVIRONMENT_KEYS = Object.freeze([SNOW_RF_ASSET_ENV, SNOW_RF_CUSTOM_PATH_ENV]);

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function makeTempDirectory(t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function copySource(t) {
  const directory = makeTempDirectory(t, "snow-rf-loader-source-");
  const sourcePath = path.join(directory, "conus-rf.json");
  fs.copyFileSync(DEFAULT_SOURCE_PATH, sourcePath);
  return { directory, sourcePath };
}

function preserveEnvironment(t) {
  const snapshot = new Map(
    ENVIRONMENT_KEYS.map((key) => [
      key,
      Object.hasOwn(process.env, key) ? { present: true, value: process.env[key] } : { present: false },
    ]),
  );
  t.after(() => {
    for (const [key, previous] of snapshot) {
      if (previous.present) {
        process.env[key] = previous.value;
      } else {
        delete process.env[key];
      }
    }
  });
}

function withTypedAssetPhaseFailure(t, phaseName, action) {
  const directory = makeTempDirectory(t, `snow-rf-${phaseName}-`);
  let manifestPath = DEFAULT_MANIFEST_PATH;
  let binaryPath = DEFAULT_BINARY_PATH;
  let restore = () => {};

  if (phaseName === "manifestReadNs") {
    manifestPath = path.join(directory, "missing-manifest.json");
  } else if (phaseName === "manifestParseNs") {
    manifestPath = path.join(directory, "malformed-manifest.json");
    fs.writeFileSync(manifestPath, "{");
  } else if (phaseName === "binaryReadNs") {
    binaryPath = path.join(directory, "missing-binary.bin");
  } else if (phaseName === "manifestValidateNs") {
    manifestPath = path.join(directory, "invalid-manifest.json");
    const manifest = JSON.parse(fs.readFileSync(DEFAULT_MANIFEST_PATH, "utf8"));
    manifest.schemaVersion += 1;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  } else if (phaseName === "binaryHashValidateNs") {
    binaryPath = path.join(directory, "invalid-binary.bin");
    fs.copyFileSync(DEFAULT_BINARY_PATH, binaryPath);
    const descriptor = fs.openSync(binaryPath, "r+");
    try {
      const byte = Buffer.alloc(1);
      assert.equal(fs.readSync(descriptor, byte, 0, 1, 0), 1);
      byte[0] ^= 0xff;
      assert.equal(fs.writeSync(descriptor, byte, 0, 1, 0), 1);
    } finally {
      fs.closeSync(descriptor);
    }
  } else if (phaseName === "ownerAllocateCopyNs") {
    const NativeArrayBuffer = global.ArrayBuffer;
    global.ArrayBuffer = new Proxy(NativeArrayBuffer, {
      construct(target, args) {
        if (args[0] === SNOW_RF_ASSET_ORACLES.binaryBytes) {
          throw new Error("injected owner allocation failure");
        }
        return Reflect.construct(target, args, target);
      },
    });
    restore = () => {
      global.ArrayBuffer = NativeArrayBuffer;
    };
  } else if (phaseName === "layoutMaterializeNs") {
    const NativeInt32Array = global.Int32Array;
    global.Int32Array = new Proxy(NativeInt32Array, {
      construct(target, args) {
        if (args[0]?.byteLength === SNOW_RF_ASSET_ORACLES.binaryBytes) {
          throw new Error("injected layout materialization failure");
        }
        return Reflect.construct(target, args, target);
      },
    });
    restore = () => {
      global.Int32Array = NativeInt32Array;
    };
  } else if (phaseName === "graphValidateNs") {
    const NativeArrayBuffer = global.ArrayBuffer;
    const nativeIsView = NativeArrayBuffer.isView;
    global.ArrayBuffer = new Proxy(NativeArrayBuffer, {
      get(target, property) {
        if (property === "isView") {
          return (value) => {
            const prototype = value && typeof value === "object" ? Object.getPrototypeOf(value) : null;
            if (
              (prototype === Int32Array.prototype || prototype === Float64Array.prototype) &&
              value.buffer?.byteLength === SNOW_RF_ASSET_ORACLES.binaryBytes
            ) {
              return false;
            }
            return nativeIsView(value);
          };
        }
        return Reflect.get(target, property, target);
      },
    });
    restore = () => {
      global.ArrayBuffer = NativeArrayBuffer;
    };
  } else {
    throw new Error(`Unknown injected Snow-RF phase ${phaseName}.`);
  }

  try {
    return action({ manifestPath, binaryPath });
  } finally {
    restore();
  }
}

function expectedFailureReasonCode(phaseName) {
  if (phaseName === "manifestReadNs" || phaseName === "binaryReadNs") {
    return "asset-read-failed";
  }
  if (phaseName === "manifestParseNs") {
    return "manifest-json-invalid";
  }
  return "asset-validation-failed";
}

function assertCanonicalNs(value, label) {
  assert.equal(typeof value, "string", label);
  assert.match(value, /^(0|[1-9][0-9]*)$/, label);
  return BigInt(value);
}

function assertDenseArray(value, label) {
  assert.equal(Array.isArray(value), true, label);
  assert.deepEqual(
    Object.keys(value),
    Array.from({ length: value.length }, (_, index) => String(index)),
    label,
  );
}

function assertLoaderTiming(timing, expectedPhaseNames) {
  assert.equal(Object.isFrozen(timing), true);
  assert.deepEqual(Object.keys(timing).sort(), ["loader", "loaderTotalNs", "memorySnapshots", "phases"]);
  assert.deepEqual(Object.keys(timing.loader).sort(), ["endNs", "startNs"]);
  assertDenseArray(timing.phases, "timing.phases");
  assertDenseArray(timing.memorySnapshots, "timing.memorySnapshots");
  assert.deepEqual(
    timing.phases.map((phase) => phase.name),
    expectedPhaseNames,
  );
  assert.equal(timing.memorySnapshots.length, expectedPhaseNames.length + 1);

  const loaderStartNs = assertCanonicalNs(timing.loader.startNs, "loader.startNs");
  const loaderEndNs = assertCanonicalNs(timing.loader.endNs, "loader.endNs");
  assert.equal(assertCanonicalNs(timing.loaderTotalNs, "loaderTotalNs"), loaderEndNs - loaderStartNs);
  assert.equal(timing.memorySnapshots[0].label, "before");
  assert.ok(
    assertCanonicalNs(timing.memorySnapshots[0].captureNs, "before.captureNs") <= loaderStartNs,
    "before capture must precede loader.startNs",
  );

  let cursor = loaderStartNs;
  let durationTotal = 0n;
  for (let index = 0; index < timing.phases.length; index += 1) {
    const phase = timing.phases[index];
    assert.equal(Object.isFrozen(phase), true);
    assert.deepEqual(Object.keys(phase).sort(), ["durationNs", "endNs", "name", "nestedPhases", "startNs"]);
    assertDenseArray(phase.nestedPhases, `${phase.name}.nestedPhases`);
    assert.equal(Object.isFrozen(phase.nestedPhases), true);
    const startNs = assertCanonicalNs(phase.startNs, `${phase.name}.startNs`);
    const endNs = assertCanonicalNs(phase.endNs, `${phase.name}.endNs`);
    const durationNs = assertCanonicalNs(phase.durationNs, `${phase.name}.durationNs`);
    assert.equal(startNs, cursor, `${phase.name} must start at the prior shared boundary`);
    assert.equal(durationNs, endNs - startNs);
    const expectedNested = index < COMMON_PHASES.length ? SOURCE_NESTED_PHASES : [];
    assert.deepEqual(
      phase.nestedPhases.map((nested) => nested.name),
      expectedNested,
    );
    let nestedCursor = startNs;
    for (const nested of phase.nestedPhases) {
      assert.deepEqual(Object.keys(nested).sort(), ["durationNs", "endNs", "name", "startNs"]);
      const nestedStartNs = assertCanonicalNs(nested.startNs, `${phase.name}.${nested.name}.startNs`);
      const nestedEndNs = assertCanonicalNs(nested.endNs, `${phase.name}.${nested.name}.endNs`);
      const nestedDurationNs = assertCanonicalNs(nested.durationNs, `${phase.name}.${nested.name}.durationNs`);
      assert.ok(nestedStartNs >= startNs);
      assert.ok(nestedStartNs >= nestedCursor, "source read must end no later than source hash starts");
      assert.ok(nestedEndNs <= endNs);
      assert.equal(nestedDurationNs, nestedEndNs - nestedStartNs);
      nestedCursor = nestedEndNs;
    }

    const memory = timing.memorySnapshots[index + 1];
    assert.equal(memory.label, `after:${phase.name}`);
    assert.deepEqual(Object.keys(memory).sort(), ["captureNs", "label", ...MEMORY_FIELDS].sort());
    const captureNs = assertCanonicalNs(memory.captureNs, `${memory.label}.captureNs`);
    assert.ok(captureNs >= startNs);
    assert.ok(captureNs <= endNs, `${memory.label} must be captured before the shared end boundary`);
    for (const field of MEMORY_FIELDS) {
      assert.equal(Number.isSafeInteger(memory[field]) && memory[field] >= 0, true, `${memory.label}.${field}`);
    }
    durationTotal += durationNs;
    cursor = endNs;
  }
  assert.equal(cursor, loaderEndNs);
  assert.equal(durationTotal, loaderEndNs - loaderStartNs);
}

function assertNoSourceBytesRetained(state) {
  assert.deepEqual(Object.keys(state).sort(), ["model", "sourceIdentity", "treatmentState"]);
  assert.equal(state.treatmentState.model, state.model);
  assert.equal(Object.hasOwn(state, "bytes"), false);
  assert.equal(Object.hasOwn(state.treatmentState, "bytes"), false);
  const metadata = {
    configuration: state.treatmentState.configuration,
    identity: state.treatmentState.identity,
    sourceIdentity: state.sourceIdentity,
    status: state.treatmentState.status,
    timing: state.treatmentState.timing,
  };
  const pending = [metadata];
  while (pending.length > 0) {
    const value = pending.pop();
    assert.equal(Buffer.isBuffer(value), false, "published loader metadata must not retain a source Buffer");
    if (value && typeof value === "object") {
      pending.push(...Object.values(value));
    }
  }
}

test.beforeEach(() => {
  _resetSnowRfLoaderForTest();
});

test.afterEach(() => {
  _resetSnowRfLoaderForTest();
});

test("mode parsing and frozen configuration preserve the exact custom-path matrix", () => {
  const warnings = [];
  for (const value of [undefined, null, ""]) {
    assert.equal(resolveSnowRfAssetMode(value, { warn: (message) => warnings.push(message) }), "auto");
  }
  assert.equal(resolveSnowRfAssetMode(" AUTO ", { warn: (message) => warnings.push(message) }), "auto");
  assert.equal(resolveSnowRfAssetMode("Off", { warn: (message) => warnings.push(message) }), "off");
  assert.equal(resolveSnowRfAssetMode(" REQUIRED ", { warn: (message) => warnings.push(message) }), "required");
  assert.equal(resolveSnowRfAssetMode("invalid", { warn: (message) => warnings.push(message) }), "off");
  assert.equal(resolveSnowRfAssetMode("still-invalid", { warn: (message) => warnings.push(message) }), "off");
  assert.equal(warnings.length, 1);

  const whitespace = resolveSnowRfLoadConfiguration({
    mode: "auto",
    customPath: " ",
    warn: () => {},
  });
  assert.equal(Object.isFrozen(whitespace), true);
  assert.equal(whitespace.customPathPresent, true);
  assert.equal(whitespace.sourceKind, "custom");
  assert.equal(whitespace.sourcePath, path.resolve(" "));

  const explicitlyBundledPath = resolveSnowRfLoadConfiguration({
    mode: "auto",
    customPath: DEFAULT_SOURCE_PATH,
    warn: () => {},
  });
  assert.equal(explicitlyBundledPath.customPathPresent, true);
  assert.equal(explicitlyBundledPath.sourceKind, "custom");
  assert.equal(explicitlyBundledPath.sourcePath, DEFAULT_SOURCE_PATH);

  const bundled = resolveSnowRfLoadConfiguration({
    mode: "required",
    customPath: "",
    warn: () => {},
  });
  assert.equal(bundled.customPathPresent, false);
  assert.equal(bundled.sourceKind, "bundled");
  assert.equal(bundled.sourcePath, DEFAULT_SOURCE_PATH);
});

test("production environment configuration latches once and later mutation cannot select another source or mode", (t) => {
  preserveEnvironment(t);
  process.env[SNOW_RF_ASSET_ENV] = "off";
  delete process.env[SNOW_RF_CUSTOM_PATH_ENV];
  const warnings = [];
  const first = loadSnowRfState("conus", { warn: (message) => warnings.push(message) });
  assert.ok(first);
  assert.equal(first.treatmentState.configuration.configurationOrigin, "startup-env");
  assert.equal(first.treatmentState.configuration.resolvedMode, "off");

  process.env[SNOW_RF_ASSET_ENV] = "required";
  process.env[SNOW_RF_CUSTOM_PATH_ENV] = path.join(os.tmpdir(), "must-not-be-selected.json");
  const second = loadSnowRfState("conus", { warn: (message) => warnings.push(message) });
  assert.equal(second, first);
  assert.equal(snowArtifactCacheIdentity(SNOW_RF_SOURCE_IDENTITY.artifactRequired), first.sourceIdentity);
  assert.equal(SNOW_RF_LOAD_STATE_CACHE.size, 1);
  assert.equal(SNOW_RF_LOAD_FAILURE_CACHE.size, 0);
  assert.deepEqual(warnings, []);
});

test("official A/B loads publish exact timing, raw asset identity, source-only signature identity, and prediction parity", () => {
  const requiredOptions = { mode: "required", customPath: null, warn: () => {} };
  const typed = loadSnowRfState("conus", requiredOptions);
  assert.ok(typed);
  assert.equal(typed.treatmentState.status.effectiveMode, "typed-asset");
  assert.equal(typed.treatmentState.status.fallbackUsed, false);
  assert.equal(typed.treatmentState.status.fallbackReasonCode, null);
  assert.equal(typed.treatmentState.configuration.configurationOrigin, "explicit-override");
  assertLoaderTiming(typed.treatmentState.timing, [
    ...COMMON_PHASES,
    ...TYPED_READ_PHASES,
    ...SNOW_RF_ASSET_MATERIALIZATION_PHASES,
  ]);

  const manifestBytes = fs.readFileSync(DEFAULT_MANIFEST_PATH);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  assert.deepEqual(typed.treatmentState.identity.asset, {
    binary: {
      bytes: fs.statSync(DEFAULT_BINARY_PATH).size,
      sha256: sha256(fs.readFileSync(DEFAULT_BINARY_PATH)),
    },
    manifest: {
      bytes: manifestBytes.byteLength,
      closureSha256: manifest.compiler.closure.sha256,
      compilerId: manifest.compiler.id,
      endian: manifest.endian,
      format: manifest.format,
      schemaVersion: manifest.schemaVersion,
      sha256: sha256(manifestBytes),
    },
  });
  assert.equal(typed.treatmentState.identity.asset.binary.bytes, SNOW_RF_ASSET_ORACLES.binaryBytes);
  assert.equal(typed.treatmentState.identity.asset.binary.sha256, SNOW_RF_ASSET_ORACLES.binarySha256);

  assert.deepEqual(Object.keys(typed.sourceIdentity), ["artifactRequired", "sha256", "bytes"]);
  assert.equal(
    JSON.stringify(typed.sourceIdentity),
    `{"artifactRequired":"${SNOW_RF_SOURCE_IDENTITY.artifactRequired}",` +
      `"sha256":"${SNOW_RF_SOURCE_IDENTITY.sha256}","bytes":${SNOW_RF_SOURCE_IDENTITY.bytes}}`,
  );
  const signatureIdentity = snowArtifactCacheIdentity(SNOW_RF_SOURCE_IDENTITY.artifactRequired, requiredOptions);
  assert.equal(signatureIdentity, typed.sourceIdentity);
  assert.deepEqual(Object.keys(signatureIdentity), ["artifactRequired", "sha256", "bytes"]);
  assert.equal(Object.hasOwn(signatureIdentity, "asset"), false);
  assert.equal(Object.hasOwn(signatureIdentity, "binary"), false);
  assertNoSourceBytesRetained(typed);

  const json = loadSnowRfState("conus", { mode: "off", customPath: null, warn: () => {} });
  assert.ok(json);
  assert.equal(json.treatmentState.status.effectiveMode, "json");
  assert.equal(json.treatmentState.identity.asset, null);
  assert.equal(Object.hasOwn(json.treatmentState.identity, "asset"), true);
  assert.equal(Object.hasOwn(json.treatmentState.identity, "binarySha256"), false);
  assert.equal(Object.hasOwn(json.treatmentState.identity, "binaryBytes"), false);
  assertLoaderTiming(json.treatmentState.timing, [...COMMON_PHASES, ...JSON_PHASES]);
  assertNoSourceBytesRetained(json);

  const featureVectors = [
    Array.from({ length: 27 }, () => 0),
    Array.from({ length: 27 }, (_, index) => index * 0.5 - 6),
    Array.from({ length: 27 }, (_, index) => (index % 2 === 0 ? 280 + index : 0.25 * index)),
  ];
  for (const features of featureVectors) {
    assert.ok(Object.is(predictRandomForest(typed.model, features), predictRandomForest(json.model, features)));
  }
});

test("auto mode records the attempted asset prefix, warns once, and falls back to the complete JSON model", () => {
  const warnings = [];
  const missingManifest = path.join(os.tmpdir(), `snow-rf-missing-${process.pid}-${Date.now()}.json`);
  const options = {
    mode: "auto",
    customPath: null,
    manifestPath: missingManifest,
    binaryPath: DEFAULT_BINARY_PATH,
    warn: (message) => warnings.push(message),
  };
  const state = loadSnowRfState("conus", options);
  assert.ok(state);
  assert.equal(state.treatmentState.status.effectiveMode, "json");
  assert.equal(state.treatmentState.status.fallbackUsed, true);
  assert.equal(state.treatmentState.status.fallbackReasonCode, "asset-read-failed");
  assert.equal(state.treatmentState.identity.asset, null);
  assertLoaderTiming(state.treatmentState.timing, [...COMMON_PHASES, "manifestReadNs", ...JSON_PHASES]);
  assert.match(warnings[0], /typed-asset validation failed/);
  assert.equal(warnings.length, 1);
  assert.equal(loadSnowRfState("conus", options), state);
  assert.equal(warnings.length, 1);
});

test("required missing and malformed assets fail closed without state or failure-cache publication", async (t) => {
  const directory = makeTempDirectory(t, "snow-rf-required-failure-");
  const malformedManifest = path.join(directory, "malformed.json");
  fs.writeFileSync(malformedManifest, "{");
  for (const [label, manifestPath, reasonCode] of [
    ["missing", path.join(directory, "missing.json"), "asset-read-failed"],
    ["malformed", malformedManifest, "manifest-json-invalid"],
  ]) {
    await t.test(label, () => {
      _resetSnowRfLoaderForTest();
      assert.throws(
        () =>
          loadSnowRfState("conus", {
            mode: "required",
            customPath: null,
            manifestPath,
            binaryPath: DEFAULT_BINARY_PATH,
            warn: () => {},
          }),
        (error) =>
          error?.code === "ERR_NOAA_SNOW_RF_REQUIRED" &&
          error?.reasonCode === reasonCode &&
          /Strict Snow-RF typed-asset loading failed/.test(error.message),
      );
      assert.equal(SNOW_RF_LOAD_STATE_CACHE.size, 0);
      assert.equal(SNOW_RF_LOAD_FAILURE_CACHE.size, 0);
    });
  }
});

test("unknown mode isolates to JSON/off and emits only one warning", () => {
  const warnings = [];
  const options = {
    mode: "definitely-not-a-mode",
    customPath: null,
    warn: (message) => warnings.push(message),
  };
  const state = loadSnowRfState("conus", options);
  assert.ok(state);
  assert.equal(state.treatmentState.configuration.requestedMode, "definitely-not-a-mode");
  assert.equal(state.treatmentState.configuration.resolvedMode, "off");
  assert.equal(state.treatmentState.status.effectiveMode, "json");
  assert.equal(state.treatmentState.status.fallbackUsed, false);
  assert.equal(state.treatmentState.identity.asset, null);
  assert.equal(loadSnowRfState("conus", options), state);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /must be 'auto', 'off', or 'required'/);
});

test("custom auto/off are JSON-only, an explicit bundled path remains custom, and required conflicts before I/O", () => {
  for (const mode of ["auto", "off"]) {
    const state = loadSnowRfState("conus", {
      mode,
      customPath: DEFAULT_SOURCE_PATH,
      manifestPath: path.join(os.tmpdir(), "must-not-read-manifest.json"),
      binaryPath: path.join(os.tmpdir(), "must-not-read-binary.bin"),
      useCache: false,
      warn: () => {},
    });
    assert.ok(state);
    assert.equal(state.treatmentState.configuration.sourceKind, "custom");
    assert.equal(state.treatmentState.configuration.customPathPresent, true);
    assert.equal(state.treatmentState.status.effectiveMode, "json");
    assert.equal(state.treatmentState.status.fallbackUsed, false);
    assert.equal(state.treatmentState.identity.asset, null);
    assertLoaderTiming(state.treatmentState.timing, [...COMMON_PHASES, ...JSON_PHASES]);
  }

  let openCalls = 0;
  const originalOpenSync = fs.openSync;
  fs.openSync = function patchedOpenSync(...args) {
    openCalls += 1;
    return originalOpenSync.apply(this, args);
  };
  try {
    assert.throws(
      () =>
        loadSnowRfState("conus", {
          mode: "required",
          customPath: DEFAULT_SOURCE_PATH,
          manifestPath: DEFAULT_MANIFEST_PATH,
          binaryPath: DEFAULT_BINARY_PATH,
          warn: () => {},
        }),
      (error) => error?.code === "ERR_NOAA_SNOW_RF_REQUIRED" && error?.reasonCode === "custom-path-conflict",
    );
  } finally {
    fs.openSync = originalOpenSync;
  }
  assert.equal(openCalls, 0);
  assert.equal(SNOW_RF_LOAD_STATE_CACHE.size, 0);
  assert.equal(SNOW_RF_LOAD_FAILURE_CACHE.size, 0);
});

test("path replacement after both source captures cannot change the modeled or published bytes", (t) => {
  const { directory, sourcePath } = copySource(t);
  const invalidReplacement = path.join(directory, "replacement.json");
  fs.writeFileSync(invalidReplacement, "{");
  const originalCloseSync = fs.closeSync;
  let closeCalls = 0;
  fs.closeSync = function patchedCloseSync(descriptor) {
    const result = originalCloseSync.call(this, descriptor);
    closeCalls += 1;
    if (closeCalls === 2) {
      fs.renameSync(invalidReplacement, sourcePath);
    }
    return result;
  };
  const options = {
    mode: "off",
    customPath: sourcePath,
    warn: () => {},
  };
  let state;
  try {
    state = loadSnowRfState("conus", options);
  } finally {
    fs.closeSync = originalCloseSync;
  }
  assert.ok(state);
  assert.deepEqual(state.sourceIdentity, SNOW_RF_SOURCE_IDENTITY);
  assert.equal(state.treatmentState.status.effectiveMode, "json");
  assert.throws(() => JSON.parse(fs.readFileSync(sourcePath, "utf8")));

  let unexpectedOpen = false;
  const originalOpenSync = fs.openSync;
  fs.openSync = function rejectUnexpectedOpen() {
    unexpectedOpen = true;
    throw new Error("cached artifact identity unexpectedly reopened the replaced path");
  };
  try {
    assert.equal(snowArtifactCacheIdentity(SNOW_RF_SOURCE_IDENTITY.artifactRequired, options), state.sourceIdentity);
  } finally {
    fs.openSync = originalOpenSync;
  }
  assert.equal(unexpectedOpen, false);
});

test("source replacement between captures fails the identity gate and publishes no partial state", (t) => {
  const { directory, sourcePath } = copySource(t);
  const replacement = path.join(directory, "replacement.json");
  fs.copyFileSync(DEFAULT_SOURCE_PATH, replacement);
  fs.appendFileSync(replacement, "\n");
  const warnings = [];
  const originalCloseSync = fs.closeSync;
  let closeCalls = 0;
  fs.closeSync = function patchedCloseSync(descriptor) {
    const result = originalCloseSync.call(this, descriptor);
    closeCalls += 1;
    if (closeCalls === 1) {
      fs.renameSync(replacement, sourcePath);
    }
    return result;
  };
  let state;
  try {
    state = loadSnowRfState("conus", {
      mode: "off",
      customPath: sourcePath,
      warn: (message) => warnings.push(message),
    });
  } finally {
    fs.closeSync = originalCloseSync;
  }
  assert.equal(state, null);
  assert.equal(SNOW_RF_LOAD_STATE_CACHE.size, 0);
  assert.equal(SNOW_RF_LOAD_FAILURE_CACHE.size, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /captures do not match/);
});

test("invalid custom JSON is failure-cached once and does not reopen the path", (t) => {
  const directory = makeTempDirectory(t, "snow-rf-invalid-custom-");
  const sourcePath = path.join(directory, "invalid.json");
  fs.writeFileSync(sourcePath, "{");
  const warnings = [];
  const originalOpenSync = fs.openSync;
  let openCalls = 0;
  fs.openSync = function patchedOpenSync(...args) {
    openCalls += 1;
    return originalOpenSync.apply(this, args);
  };
  const options = {
    mode: "auto",
    customPath: sourcePath,
    warn: (message) => warnings.push(message),
  };
  try {
    assert.equal(loadSnowRfState("conus", options), null);
    assert.equal(openCalls, 2);
    assert.equal(loadSnowRfState("conus", options), null);
    assert.equal(openCalls, 2);
  } finally {
    fs.openSync = originalOpenSync;
  }
  assert.equal(SNOW_RF_LOAD_STATE_CACHE.size, 0);
  assert.equal(SNOW_RF_LOAD_FAILURE_CACHE.size, 1);
  assert.equal(warnings.length, 1);
});
