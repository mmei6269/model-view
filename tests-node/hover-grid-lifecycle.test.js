"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const esbuild = require("esbuild");

const EMPTY_HOVER = { byLayer: {}, pressureHpa: null };

async function loadHook() {
  const entry = path.join(__dirname, "..", "next", "src", "components", "map-panel", "use-hover-grid.ts");
  const virtualModules = {
    react: `
      const runtime = () => globalThis.__hoverHookRuntime;
      export const useEffect = (effect, dependencies) => runtime().useEffect(effect, dependencies);
      export const useRef = (initialValue) => runtime().useRef(initialValue);
      export const useState = (initialValue) => runtime().useState(initialValue);
    `,
    "artifact-client": `
      const mocks = () => globalThis.__hoverArtifactMocks;
      export const fetchHoverGridPayload = (frame, options) => mocks().fetch(frame, options);
      export const getCachedHoverGridPayload = (requestKey) => mocks().getCached(requestKey);
      export const resolveHoverGridRequestUrls = (frame) => mocks().resolveUrls(frame);
    `,
    "hover-utils": `
      export const EMPTY_HOVER = { byLayer: {}, pressureHpa: null };
      export const sampleHoverValuesAtPoint = (args) => globalThis.__hoverArtifactMocks.sample(args);
    `,
  };
  const { outputFiles } = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: "cjs",
    platform: "node",
    write: false,
    logLevel: "silent",
    plugins: [
      {
        name: "hover-hook-test-doubles",
        setup(build) {
          build.onResolve({ filter: /^react$/ }, () => ({ path: "react", namespace: "hover-test" }));
          build.onResolve({ filter: /core\/artifact-client$/ }, () => ({
            path: "artifact-client",
            namespace: "hover-test",
          }));
          build.onResolve({ filter: /\.\/hover-utils$/ }, () => ({
            path: "hover-utils",
            namespace: "hover-test",
          }));
          build.onLoad({ filter: /.*/, namespace: "hover-test" }, ({ path: modulePath }) => ({
            contents: virtualModules[modulePath],
            loader: "js",
          }));
        },
      },
    ],
  });
  const moduleShim = { exports: {} };
  const fn = new vm.Script(`(function (module, exports, require) { ${outputFiles[0].text}\n})`).runInThisContext();
  fn(moduleShim, moduleShim.exports, require);
  return moduleShim.exports.useHoverGrid;
}

class HookRuntime {
  constructor(hook) {
    this.hook = hook;
    this.states = [];
    this.stateInitialized = [];
    this.stateSetters = [];
    this.refs = [];
    this.effects = [];
    this.pendingEffects = [];
    this.dirty = false;
  }

  useState(initialValue) {
    const index = this.stateCursor++;
    if (!this.stateInitialized[index]) {
      this.states[index] = typeof initialValue === "function" ? initialValue() : initialValue;
      this.stateInitialized[index] = true;
      this.stateSetters[index] = (nextValue) => {
        this.states[index] = typeof nextValue === "function" ? nextValue(this.states[index]) : nextValue;
        this.dirty = true;
      };
    }
    return [this.states[index], this.stateSetters[index]];
  }

  useRef(initialValue) {
    const index = this.refCursor++;
    if (!this.refs[index]) {
      this.refs[index] = { current: initialValue };
    }
    return this.refs[index];
  }

  useEffect(effect, dependencies) {
    const index = this.effectCursor++;
    const previous = this.effects[index];
    const changed =
      !previous ||
      !dependencies ||
      !previous.dependencies ||
      dependencies.length !== previous.dependencies.length ||
      dependencies.some((value, dependencyIndex) => !Object.is(value, previous.dependencies[dependencyIndex]));
    if (changed) {
      this.pendingEffects.push({ effect, dependencies, index });
    }
  }

  render(props) {
    this.stateCursor = 0;
    this.refCursor = 0;
    this.effectCursor = 0;
    this.pendingEffects = [];
    this.dirty = false;
    globalThis.__hoverHookRuntime = this;
    return this.hook(props);
  }

  flushEffects() {
    const pending = this.pendingEffects;
    this.pendingEffects = [];
    for (const entry of pending) {
      this.effects[entry.index]?.cleanup?.();
      const cleanup = entry.effect();
      this.effects[entry.index] = {
        cleanup: typeof cleanup === "function" ? cleanup : null,
        dependencies: entry.dependencies,
      };
    }
  }

  settle(props) {
    let result = this.render(props);
    this.flushEffects();
    for (let pass = 0; this.dirty && pass < 10; pass += 1) {
      result = this.render(props);
      this.flushEffects();
    }
    assert.equal(this.dirty, false, "hook state did not settle");
    return result;
  }

  unmount() {
    for (const effect of this.effects) {
      effect?.cleanup?.();
    }
  }
}

class FakeWindowTimers {
  constructor() {
    this.now = 0;
    this.nextId = 1;
    this.tasks = new Map();
  }

  setTimeout(callback, delay) {
    const id = this.nextId++;
    this.tasks.set(id, { callback, at: this.now + Number(delay || 0) });
    return id;
  }

  clearTimeout(id) {
    this.tasks.delete(id);
  }

  advance(milliseconds) {
    const target = this.now + milliseconds;
    while (true) {
      const next = [...this.tasks.entries()]
        .filter(([, task]) => task.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!next) break;
      const [id, task] = next;
      this.tasks.delete(id);
      this.now = task.at;
      task.callback();
    }
    this.now = target;
  }
}

function makeFrame(id, overrides = {}) {
  return {
    id,
    hour: 0,
    validHourKey: "2026-07-11T00:00:00.000Z",
    referenceTime: "2026-07-11T00:00:00.000Z",
    bounds: { north: 53, south: 21, west: -129, east: -63 },
    rows: 2,
    cols: 2,
    layers: {},
    ...overrides,
  };
}

async function makeHarness() {
  const timers = new FakeWindowTimers();
  const cache = new Map();
  const fetches = [];
  globalThis.window = timers;
  globalThis.__hoverArtifactMocks = {
    resolveUrls: (frame) => (frame ? [`hover/${frame.id}.bin`] : []),
    getCached: (requestKey) => cache.get(requestKey) || null,
    fetch: (frame, options) => {
      fetches.push({ frame, signal: options?.signal });
      return Promise.resolve({ id: frame.id, value: frame.id });
    },
    sample: ({ hoverGrid }) => ({
      byLayer: { temperature: { value: hoverGrid.value } },
      pressureHpa: 1000,
    }),
  };
  const hook = await loadHook();
  const runtime = new HookRuntime(hook);
  const hoverAbortRef = { current: null };
  const hoverGridKeyRef = { current: "" };
  const props = (frame, hoverLatLng) => ({
    activeLayers: new Set(["temperature"]),
    frame,
    hoverAbortRef,
    hoverGridKeyRef,
    hoverLatLng,
  });
  return { cache, fetches, props, runtime, timers };
}

test("hover samples are identity-gated before frame-change effects can clear state", async () => {
  const harness = await makeHarness();
  const original = makeFrame("same-key");
  harness.cache.set("hover/same-key.bin", { id: "same-key", value: "old-run" });
  const cursor = { lat: 40, lon: -100 };
  const originalResult = harness.runtime.settle(harness.props(original, cursor));
  assert.equal(originalResult.hoverValues.byLayer.temperature.value, "old-run");

  const newIdentity = makeFrame("same-key", {
    hour: 1,
    referenceTime: "2026-07-11T01:00:00.000Z",
    validHourKey: "2026-07-11T02:00:00.000Z",
  });
  const beforeEffects = harness.runtime.render(harness.props(newIdentity, cursor));
  assert.deepEqual(beforeEffects.hoverValues, EMPTY_HOVER);
  harness.runtime.unmount();
});

test("a retained pointer waits 750 ms on a cache-miss frame and prior payload state is released", async () => {
  const harness = await makeHarness();
  const cursor = { lat: 40, lon: -100 };
  const first = makeFrame("first");
  const oldPayload = { id: "first", value: "first" };
  harness.cache.set("hover/first.bin", oldPayload);
  harness.runtime.settle(harness.props(first, cursor));
  assert.equal(harness.runtime.states[2].payload, oldPayload);

  const second = makeFrame("second", { hour: 1, validHourKey: "2026-07-11T01:00:00.000Z" });
  harness.runtime.render(harness.props(second, cursor));
  harness.runtime.flushEffects();
  assert.equal(harness.runtime.states[2].requestKey, "hover/second.bin");
  assert.equal(harness.runtime.states[2].payload, null, "old decoded grid must not remain pinned in hook state");
  assert.equal(harness.fetches.length, 0, "retained hover is not a pointer-entry bypass");

  harness.timers.advance(749);
  assert.equal(harness.fetches.length, 0);
  harness.timers.advance(1);
  assert.equal(harness.fetches.length, 1);
  assert.equal(harness.fetches[0].frame, second);
  harness.runtime.unmount();
});

test("a real pointer-entry transition bypasses selected-frame idle warmup", async () => {
  const harness = await makeHarness();
  const frame = makeFrame("entry");
  const idleProps = harness.props(frame, null);
  harness.runtime.settle(idleProps);
  harness.timers.advance(400);
  assert.equal(harness.fetches.length, 0);

  const activeProps = harness.props(frame, { lat: 40, lon: -100 });
  harness.runtime.render(activeProps);
  harness.runtime.flushEffects();
  assert.equal(harness.fetches.length, 1, "pointer entry starts the fetch immediately");
  harness.timers.advance(1000);
  assert.equal(harness.fetches.length, 1, "entry cancels the pending idle timer");
  harness.runtime.unmount();
});

test("a delayed stale hover promise cannot publish values after a frame switch", async () => {
  const harness = await makeHarness();
  let resolveFirst;
  globalThis.__hoverArtifactMocks.fetch = (frame, options) => {
    harness.fetches.push({ frame, signal: options?.signal });
    return new Promise((resolve) => {
      resolveFirst = resolve;
    });
  };
  const cursor = { lat: 40, lon: -100 };
  const first = makeFrame("delayed-first");
  harness.runtime.settle(harness.props(first, cursor));
  assert.equal(harness.fetches.length, 1);

  const second = makeFrame("delayed-second", { hour: 1, validHourKey: "2026-07-11T01:00:00.000Z" });
  harness.runtime.render(harness.props(second, cursor));
  harness.runtime.flushEffects();
  assert.equal(harness.fetches[0].signal.aborted, true, "frame switch aborts the stale consumer");

  resolveFirst({ id: "delayed-first", value: "stale-value" });
  await Promise.resolve();
  await Promise.resolve();
  const result = harness.runtime.settle(harness.props(second, cursor));
  assert.deepEqual(result.hoverValues, EMPTY_HOVER);
  harness.runtime.unmount();
});
