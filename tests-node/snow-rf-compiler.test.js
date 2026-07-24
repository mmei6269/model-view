"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  PLETCHER_RF_FEATURE_KEYS,
  RF_MAX_TRAVERSAL_STEPS,
  SNOW_RF_MAX_NODES_PER_TREE,
  SNOW_RF_MAX_TOTAL_NODES,
  SNOW_RF_MAX_TREE_COUNT,
  compileSnowRfModel,
  compileSnowRfTree,
  normalizeRfTree,
  normalizeSnowRfModel,
  predictRandomForest,
  predictRfTree,
  traverseRfTree,
} = require("../scripts/lib/noaa-beta/snow-rf-compiler");
const selection = require("../scripts/lib/noaa-beta/selection");
const slrMethods = require("../scripts/lib/noaa-beta/slr-methods");

const CURRENT_MODEL_PATH = path.resolve(__dirname, "../tools/noaa-beta/snow-rf/conus-rf.json");

// Intentional compatibility boundary:
// - model-level source/provenance fields belong to the caller or asset loader;
// - custom JSON may use a complete camel-case or complete sklearn snake_case
//   child pair, but never an ambiguous mixture;
// - leaf thresholds are ignored by traversal and may be any finite number;
// - exported legacy normalizer/predictor names remain shared identities.

function leaf(value = 1) {
  return { value };
}

function split(left, right, { feature = 0, threshold = 0, value = 0 } = {}) {
  return { left, right, feature, threshold, value };
}

function treeFromNodes(nodes) {
  return {
    childrenLeft: nodes.map((node) => (Object.hasOwn(node, "left") ? node.left : -1)),
    childrenRight: nodes.map((node) => (Object.hasOwn(node, "right") ? node.right : -1)),
    feature: nodes.map((node) => (Object.hasOwn(node, "left") ? node.feature : -2)),
    threshold: nodes.map((node) => (Object.hasOwn(node, "left") ? node.threshold : -2)),
    value: nodes.map((node) => node.value),
  };
}

function branchTree({ feature = 0, threshold = 0, leftValue = 11, rightValue = 22 } = {}) {
  return treeFromNodes([split(1, 2, { feature, threshold }), leaf(leftValue), leaf(rightValue)]);
}

function snowRfModel(trees = [treeFromNodes([leaf()])]) {
  return {
    featureKeys: [...PLETCHER_RF_FEATURE_KEYS],
    trees,
  };
}

function withoutKey(record, key) {
  const copy = { ...record };
  delete copy[key];
  return copy;
}

function statefulDescriptorArray(array, index, laterValue) {
  const key = String(index);
  const stats = { descriptorReads: 0, valueGets: 0 };
  const proxy = new Proxy(array, {
    get(target, property, receiver) {
      if (property === key) {
        stats.valueGets += 1;
      }
      return Reflect.get(target, property, receiver);
    },
    getOwnPropertyDescriptor(target, property) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
      if (property !== key || !descriptor) {
        return descriptor;
      }
      stats.descriptorReads += 1;
      return {
        ...descriptor,
        value: stats.descriptorReads === 1 ? descriptor.value : laterValue,
      };
    },
  });
  return { proxy, stats };
}

function statefulDescriptorObject(record, key, laterValue) {
  const stats = { descriptorReads: 0, valueGets: 0 };
  const proxy = new Proxy(record, {
    get(target, property, receiver) {
      if (property === key) {
        stats.valueGets += 1;
      }
      return Reflect.get(target, property, receiver);
    },
    getOwnPropertyDescriptor(target, property) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
      if (property !== key || !descriptor) {
        return descriptor;
      }
      stats.descriptorReads += 1;
      return {
        ...descriptor,
        value: stats.descriptorReads === 1 ? descriptor.value : laterValue,
      };
    },
  });
  return { proxy, stats };
}

function trackedOwnKeysArray(length) {
  const stats = { ownKeysReads: 0 };
  const proxy = new Proxy(new Array(length), {
    ownKeys(target) {
      stats.ownKeysReads += 1;
      return Reflect.ownKeys(target);
    },
  });
  return { proxy, stats };
}

function oneReadDescriptorArray(array) {
  const descriptorReads = new Map();
  const expectedKeys = Reflect.ownKeys(array);
  const proxy = new Proxy(array, {
    getOwnPropertyDescriptor(target, property) {
      const reads = (descriptorReads.get(property) || 0) + 1;
      descriptorReads.set(property, reads);
      if (reads > 1) {
        throw new Error(`descriptor ${String(property)} read more than once`);
      }
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
  });
  return {
    proxy,
    assertCapturedOnce() {
      for (const key of expectedKeys) {
        assert.equal(descriptorReads.get(key), 1, `descriptor ${String(key)}`);
      }
      assert.equal(descriptorReads.size, expectedKeys.length);
    },
  };
}

function perfectBinaryTree(nodeCount) {
  assert.ok(nodeCount > 0 && nodeCount % 2 === 1);
  const childrenLeft = new Array(nodeCount);
  const childrenRight = new Array(nodeCount);
  const feature = new Array(nodeCount);
  const threshold = new Array(nodeCount);
  const value = new Array(nodeCount);
  const internalCount = (nodeCount - 1) / 2;
  for (let node = 0; node < nodeCount; node += 1) {
    const internal = node < internalCount;
    childrenLeft[node] = internal ? node * 2 + 1 : -1;
    childrenRight[node] = internal ? node * 2 + 2 : -1;
    feature[node] = internal ? node % PLETCHER_RF_FEATURE_KEYS.length : -2;
    threshold[node] = internal ? node / 10 : -2;
    value[node] = node / nodeCount;
  }
  return { childrenLeft, childrenRight, feature, threshold, value };
}

function nextUp(value) {
  if (Number.isNaN(value) || value === Number.POSITIVE_INFINITY) {
    return value;
  }
  if (Object.is(value, -0) || value === 0) {
    return Number.MIN_VALUE;
  }
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, value);
  let bits = view.getBigUint64(0);
  bits += value > 0 ? 1n : -1n;
  view.setBigUint64(0, bits);
  return view.getFloat64(0);
}

function nextDown(value) {
  return -nextUp(-value);
}

function makeCombTree(depth) {
  const nodes = new Array(depth * 2 + 1);
  const finalLeaf = depth * 2;
  for (let index = 0; index < depth; index += 1) {
    const next = index + 1 < depth ? index + 1 : finalLeaf;
    nodes[index] = split(next, depth + index, { feature: index % PLETCHER_RF_FEATURE_KEYS.length });
    nodes[depth + index] = leaf(index + 1);
  }
  nodes[finalLeaf] = leaf(-1);
  return treeFromNodes(nodes);
}

function referenceTraverse(tree, features) {
  let node = 0;
  for (let depth = 0; depth < RF_MAX_TRAVERSAL_STEPS; depth += 1) {
    const left = tree.childrenLeft[node];
    const right = tree.childrenRight[node];
    if (left < 0 || right < 0) {
      return node;
    }
    const featureValue = features[tree.feature[node]];
    if (!Number.isFinite(featureValue)) {
      return null;
    }
    node = featureValue <= tree.threshold[node] ? left : right;
    if (!Number.isInteger(node) || node < 0 || node >= tree.value.length) {
      return null;
    }
  }
  return null;
}

function referencePredictTree(tree, features) {
  const leafId = referenceTraverse(tree, features);
  return leafId === null ? Number.NaN : tree.value[leafId];
}

function referencePredictForest(raw, features) {
  if (!raw?.trees?.length || !Array.isArray(features)) {
    return Number.NaN;
  }
  let total = 0;
  let count = 0;
  for (const tree of raw.trees) {
    const value = referencePredictTree(tree, features);
    if (Number.isFinite(value)) {
      total += value;
      count += 1;
    }
  }
  return count > 0 ? total / count : Number.NaN;
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function randomTree(random, maxDepth) {
  const nodes = [];
  function addNode(depth) {
    const id = nodes.length;
    nodes.push(null);
    if (depth >= maxDepth || (depth > 0 && random() < 0.3)) {
      nodes[id] = leaf((random() - 0.5) * 100);
      return id;
    }
    const left = addNode(depth + 1);
    const right = addNode(depth + 1);
    nodes[id] = split(left, right, {
      feature: Math.floor(random() * PLETCHER_RF_FEATURE_KEYS.length),
      threshold: (random() - 0.5) * 800,
      value: (random() - 0.5) * 100,
    });
    return id;
  }
  addNode(0);
  return treeFromNodes(nodes);
}

test("canonical feature contract and compatibility exports share one implementation", () => {
  assert.equal(PLETCHER_RF_FEATURE_KEYS.length, 27);
  assert.equal(Object.isFrozen(PLETCHER_RF_FEATURE_KEYS), true);
  assert.equal(selection.PLETCHER_RF_FEATURE_KEYS, PLETCHER_RF_FEATURE_KEYS);
  assert.equal(selection.normalizeRfTree, normalizeRfTree);
  assert.equal(selection.normalizeSnowRfModel, normalizeSnowRfModel);
  assert.equal(slrMethods.predictRandomForest, predictRandomForest);
  assert.equal(slrMethods.predictRfTree, predictRfTree);
  assert.equal(normalizeRfTree, compileSnowRfTree);
  assert.equal(normalizeSnowRfModel, compileSnowRfModel);
});

test("compiler enforces model grammar without owning custom provenance", async (t) => {
  const valid = snowRfModel();
  const reorderedKeys = [...PLETCHER_RF_FEATURE_KEYS];
  [reorderedKeys[0], reorderedKeys[1]] = [reorderedKeys[1], reorderedKeys[0]];
  const sparseTrees = new Array(2);
  sparseTrees[0] = treeFromNodes([leaf()]);
  const cases = [
    ["null", null],
    ["array", []],
    ["scalar", 1],
    ["missing feature keys", withoutKey(valid, "featureKeys")],
    ["missing trees", withoutKey(valid, "trees")],
    ["non-array feature keys", { ...valid, featureKeys: new Uint8Array(27) }],
    ["short feature keys", { ...valid, featureKeys: valid.featureKeys.slice(0, -1) }],
    ["reordered feature keys", { ...valid, featureKeys: reorderedKeys }],
    ["coercible feature key", { ...valid, featureKeys: [0, ...valid.featureKeys.slice(1)] }],
    ["empty trees", { ...valid, trees: [] }],
    ["non-array trees", { ...valid, trees: {} }],
    ["sparse trees", { ...valid, trees: sparseTrees }],
    ["null tree", { ...valid, trees: [null] }],
    ["one malformed tree poisons forest", { ...valid, trees: [treeFromNodes([leaf(1)]), {}] }],
  ];
  for (const [label, raw] of cases) {
    await t.test(label, () => assert.equal(compileSnowRfModel(raw), null));
  }
  assert.ok(compileSnowRfModel(valid));
  assert.ok(
    compileSnowRfModel({
      ...valid,
      kind: "custom-random-forest",
      source: "custom/source",
      sourceCommit: "custom-revision",
      futureProvenance: { owner: "caller" },
    }),
    "source identity and harmless provenance remain the loader's responsibility",
  );
  const accessorProvenance = snowRfModel();
  Object.defineProperty(accessorProvenance, "provenance", {
    enumerable: true,
    get() {
      throw new Error("ignored provenance must not execute");
    },
  });
  assert.ok(compileSnowRfModel(accessorProvenance));
});

test("tree compiler accepts one complete child spelling and rejects ambiguous grammar", async (t) => {
  const camel = branchTree();
  const snake = {
    children_left: camel.childrenLeft.slice(),
    children_right: camel.childrenRight.slice(),
    feature: camel.feature.slice(),
    threshold: camel.threshold.slice(),
    value: camel.value.slice(),
  };
  assert.deepEqual(compileSnowRfTree(snake), compileSnowRfTree(camel));
  assert.ok(compileSnowRfModel(snowRfModel([snake])), "complete snake_case custom forests remain supported");

  const mixed = {
    childrenLeft: camel.childrenLeft.slice(),
    children_right: camel.childrenRight.slice(),
    feature: camel.feature.slice(),
    threshold: camel.threshold.slice(),
    value: camel.value.slice(),
  };
  const both = { ...camel, children_left: camel.childrenLeft.slice(), children_right: camel.childrenRight.slice() };
  const cases = [
    ["mixed camel/snake children", mixed],
    ["both child spellings", both],
    ["unknown property", { ...camel, nodeCount: 3 }],
    ["null tree", null],
    ["array tree", []],
  ];
  for (const key of Object.keys(camel)) {
    cases.push([`missing ${key}`, withoutKey(camel, key)]);
    cases.push([`non-array ${key}`, { ...camel, [key]: 1 }]);
    cases.push([`typed-array ${key}`, { ...camel, [key]: Float64Array.from(camel[key]) }]);
    cases.push([`mismatched ${key}`, { ...camel, [key]: camel[key].slice(0, -1) }]);
  }
  for (const [label, raw] of cases) {
    await t.test(label, () => assert.equal(compileSnowRfTree(raw), null));
  }
});

test("compiler rejects accessor-backed grammar without invoking accessors", async (t) => {
  for (const key of ["featureKeys", "trees"]) {
    await t.test(`top-level ${key} accessor`, () => {
      const raw = snowRfModel();
      const value = raw[key];
      let calls = 0;
      Object.defineProperty(raw, key, {
        configurable: true,
        enumerable: true,
        get() {
          calls += 1;
          return value;
        },
      });
      assert.equal(compileSnowRfModel(raw), null);
      assert.equal(calls, 0);
    });
  }

  for (const field of ["childrenLeft", "childrenRight", "feature", "threshold", "value"]) {
    await t.test(`tree ${field} accessor`, () => {
      const raw = branchTree();
      const value = raw[field];
      let calls = 0;
      Object.defineProperty(raw, field, {
        configurable: true,
        enumerable: true,
        get() {
          calls += 1;
          return value;
        },
      });
      assert.equal(compileSnowRfTree(raw), null);
      assert.equal(calls, 0);
    });
  }

  for (const key of ["featureKeys", "trees"]) {
    await t.test(`${key} array element accessor`, () => {
      const raw = snowRfModel();
      const array = raw[key];
      const value = array[0];
      let calls = 0;
      Object.defineProperty(array, "0", {
        configurable: true,
        enumerable: true,
        get() {
          calls += 1;
          return value;
        },
      });
      assert.equal(compileSnowRfModel(raw), null);
      assert.equal(calls, 0);
    });
  }

  for (const field of ["childrenLeft", "childrenRight", "feature", "threshold", "value"]) {
    await t.test(`${field} array element accessor`, () => {
      const raw = branchTree();
      const value = raw[field][0];
      let calls = 0;
      Object.defineProperty(raw[field], "0", {
        configurable: true,
        enumerable: true,
        get() {
          calls += 1;
          return value;
        },
      });
      assert.equal(compileSnowRfTree(raw), null);
      assert.equal(calls, 0);
    });
  }
});

test("compiler publishes immutable one-read snapshots, never later descriptor or getter values", async (t) => {
  await t.test("every array length and element descriptor is captured exactly once", () => {
    const raw = snowRfModel([branchTree()]);
    const captures = [];
    for (const field of ["childrenLeft", "childrenRight", "feature", "threshold", "value"]) {
      const capture = oneReadDescriptorArray(raw.trees[0][field]);
      raw.trees[0][field] = capture.proxy;
      captures.push(capture);
    }
    const featureKeys = oneReadDescriptorArray(raw.featureKeys);
    const trees = oneReadDescriptorArray(raw.trees);
    raw.featureKeys = featureKeys.proxy;
    raw.trees = trees.proxy;
    assert.ok(compileSnowRfModel(raw));
    featureKeys.assertCapturedOnce();
    trees.assertCapturedOnce();
    for (const capture of captures) {
      capture.assertCapturedOnce();
    }
  });

  await t.test("top-level featureKeys reference", () => {
    const raw = snowRfModel();
    const { proxy, stats } = statefulDescriptorObject(raw, "featureKeys", ["WRONG"]);
    const compiled = compileSnowRfModel(proxy);
    assert.ok(compiled);
    assert.deepEqual(compiled.featureKeys, PLETCHER_RF_FEATURE_KEYS);
    assert.deepEqual(stats, { descriptorReads: 1, valueGets: 0 });
  });

  await t.test("top-level trees reference", () => {
    const raw = snowRfModel([treeFromNodes([leaf(17)])]);
    const { proxy, stats } = statefulDescriptorObject(raw, "trees", new Array(1));
    const compiled = compileSnowRfModel(proxy);
    assert.ok(compiled);
    assert.ok(Object.is(compiled.trees[0].value[0], 17));
    assert.deepEqual(stats, { descriptorReads: 1, valueGets: 0 });
  });

  await t.test("feature key element", () => {
    const raw = snowRfModel();
    const stateful = statefulDescriptorArray(raw.featureKeys, 0, "WRONG");
    raw.featureKeys = stateful.proxy;
    const compiled = compileSnowRfModel(raw);
    assert.ok(compiled);
    assert.equal(compiled.featureKeys[0], PLETCHER_RF_FEATURE_KEYS[0]);
    assert.deepEqual(stateful.stats, { descriptorReads: 1, valueGets: 0 });
  });

  await t.test("tree array element", () => {
    const raw = snowRfModel([treeFromNodes([leaf(23)])]);
    const stateful = statefulDescriptorArray(raw.trees, 0, undefined);
    raw.trees = stateful.proxy;
    const compiled = compileSnowRfModel(raw);
    assert.ok(compiled);
    assert.ok(Object.is(compiled.trees[0].value[0], 23));
    assert.deepEqual(stateful.stats, { descriptorReads: 1, valueGets: 0 });
  });

  const laterValues = {
    childrenLeft: 0x1_0000_0001,
    childrenRight: Number.POSITIVE_INFINITY,
    feature: 0x1_0000_0000,
    threshold: Number.POSITIVE_INFINITY,
    value: Number.NaN,
  };
  for (const field of Object.keys(laterValues)) {
    await t.test(`${field} property reference`, () => {
      const raw = branchTree();
      const published = raw[field][0];
      const later = raw[field].slice();
      later[0] = laterValues[field];
      const stateful = statefulDescriptorObject(raw, field, later);
      const compiled = compileSnowRfTree(stateful.proxy);
      assert.ok(compiled);
      assert.ok(Object.is(compiled[field][0], published));
      assert.deepEqual(stateful.stats, { descriptorReads: 1, valueGets: 0 });
    });
  }

  for (const field of Object.keys(laterValues)) {
    await t.test(`${field} element`, () => {
      const raw = branchTree();
      const published = raw[field][0];
      const stateful = statefulDescriptorArray(raw[field], 0, laterValues[field]);
      raw[field] = stateful.proxy;
      const compiled = compileSnowRfTree(raw);
      assert.ok(compiled);
      assert.ok(Object.is(compiled[field][0], published));
      assert.deepEqual(stateful.stats, { descriptorReads: 1, valueGets: 0 });
    });
  }
});

test("compiler requires dense JSON arrays without symbol or named-property side channels", async (t) => {
  const modelArrayCases = [
    ["featureKeys hole", "featureKeys", (array) => delete array[0]],
    ["featureKeys named property", "featureKeys", (array) => (array.provenance = "extra")],
    ["featureKeys symbol", "featureKeys", (array) => (array[Symbol("extra")] = true)],
    ["trees hole", "trees", (array) => delete array[0]],
    ["trees named property", "trees", (array) => (array.provenance = "extra")],
    ["trees symbol", "trees", (array) => (array[Symbol("extra")] = true)],
  ];
  for (const [label, key, mutate] of modelArrayCases) {
    await t.test(label, () => {
      const raw = snowRfModel();
      mutate(raw[key]);
      assert.equal(compileSnowRfModel(raw), null);
    });
  }

  for (const field of ["childrenLeft", "childrenRight", "feature", "threshold", "value"]) {
    const mutations = [
      ["hole", (array) => delete array[0]],
      ["named property", (array) => (array.provenance = "extra")],
      ["symbol", (array) => (array[Symbol("extra")] = true)],
    ];
    for (const [kind, mutate] of mutations) {
      await t.test(`${field} ${kind}`, () => {
        const raw = branchTree();
        mutate(raw[field]);
        assert.equal(compileSnowRfTree(raw), null);
      });
    }
  }

  await t.test("tree symbol property", () => {
    const raw = branchTree();
    raw[Symbol("extra")] = true;
    assert.equal(compileSnowRfTree(raw), null);
  });

  await t.test("frozen dense JSON arrays remain valid", () => {
    const raw = snowRfModel([branchTree()]);
    raw.featureKeys = Object.freeze(raw.featureKeys);
    raw.trees[0] = Object.fromEntries(
      Object.entries(raw.trees[0]).map(([field, values]) => [field, Object.freeze(values)]),
    );
    raw.trees = Object.freeze(raw.trees);
    assert.ok(compileSnowRfModel(raw));
  });
});

test("tree compiler never coerces, flattens, filters, truncates, or wraps node fields", async (t) => {
  const invalidValues = [
    ["numeric string", "1"],
    ["true", true],
    ["false", false],
    ["null", null],
    ["nested array", [1]],
    ["NaN", Number.NaN],
    ["positive infinity", Number.POSITIVE_INFINITY],
    ["negative infinity", Number.NEGATIVE_INFINITY],
  ];
  for (const field of ["childrenLeft", "childrenRight", "feature", "threshold", "value"]) {
    for (const [label, invalid] of invalidValues) {
      await t.test(`${field} rejects ${label}`, () => {
        const raw = branchTree();
        raw[field][0] = invalid;
        assert.equal(compileSnowRfTree(raw), null);
      });
    }
  }
  const integerCases = [
    ["fractional left child", "childrenLeft", 0, 1.5],
    ["unsafe left child", "childrenLeft", 0, Number.MAX_SAFE_INTEGER + 1],
    ["fractional right child", "childrenRight", 0, 1.5],
    ["unsafe right child", "childrenRight", 0, 0x1_0000_0001],
    ["fractional feature", "feature", 0, 0.5],
    ["unsafe feature", "feature", 0, Number.MAX_SAFE_INTEGER + 1],
    ["negative internal feature", "feature", 0, -1],
    ["feature past canonical roster", "feature", 0, PLETCHER_RF_FEATURE_KEYS.length],
    ["wrong leaf feature sentinel", "feature", 1, -1],
  ];
  for (const [label, field, index, invalid] of integerCases) {
    await t.test(label, () => {
      const raw = branchTree();
      raw[field][index] = invalid;
      assert.equal(compileSnowRfTree(raw), null);
    });
  }
});

test("tree compiler validates every graph invariant before typed conversion", async (t) => {
  const cases = [
    ["empty tree", { childrenLeft: [], childrenRight: [], feature: [], threshold: [], value: [] }],
    ["mixed leaf edges", treeFromNodes([split(-1, 2), leaf(), leaf()])],
    ["negative child other than sentinel", treeFromNodes([split(-2, 2), leaf(), leaf()])],
    ["child equal to node count", treeFromNodes([split(1, 3), leaf(), leaf()])],
    ["duplicate child", treeFromNodes([split(1, 1), leaf()])],
    ["self loop", treeFromNodes([split(0, 1), leaf()])],
    ["root referenced by descendant", treeFromNodes([split(1, 2), split(0, 3), leaf(), leaf()])],
    ["ancestor cycle", treeFromNodes([split(1, 2), split(3, 4), leaf(), split(1, 5), leaf(), leaf()])],
    ["shared-child DAG", treeFromNodes([split(1, 2), split(3, 4), split(3, 5), leaf(), leaf(), leaf()])],
    ["orphan leaf", treeFromNodes([split(1, 2), leaf(), leaf(), leaf()])],
    ["orphan subtree", treeFromNodes([split(1, 2), leaf(), leaf(), split(4, 5), leaf(), leaf()])],
    ["disconnected cycle", treeFromNodes([split(1, 2), leaf(), leaf(), split(4, 5), split(3, 6), leaf(), leaf()])],
    ["leaf depth exceeds traversal guard", makeCombTree(RF_MAX_TRAVERSAL_STEPS)],
  ];
  for (const [label, raw] of cases) {
    await t.test(label, () => assert.equal(compileSnowRfTree(raw), null));
  }

  assert.ok(compileSnowRfTree(treeFromNodes([leaf()])), "root leaf is valid");
  assert.ok(compileSnowRfTree(makeCombTree(RF_MAX_TRAVERSAL_STEPS - 1)), "depth 4095 is valid");
  assert.ok(
    compileSnowRfTree(
      treeFromNodes([split(4, 3), leaf(1), leaf(2), leaf(3), split(1, 2, { feature: 26, threshold: -2 })]),
    ),
    "valid graphs may use backward-numbered children and an internal -2 threshold",
  );
});

test("compiler resource ceilings reject oversized sparse and aggregate inputs before publication", async (t) => {
  assert.deepEqual(
    {
      treeCount: SNOW_RF_MAX_TREE_COUNT,
      nodesPerTree: SNOW_RF_MAX_NODES_PER_TREE,
      totalNodes: SNOW_RF_MAX_TOTAL_NODES,
    },
    {
      treeCount: 512,
      nodesPerTree: 65_536,
      totalNodes: 2_097_152,
    },
  );
  assert.ok(SNOW_RF_MAX_TREE_COUNT > 100);
  assert.ok(SNOW_RF_MAX_NODES_PER_TREE > 7_043);
  assert.ok(SNOW_RF_MAX_TOTAL_NODES > 666_406);

  await t.test("oversized feature-key array stops at its length descriptor", () => {
    const tracked = trackedOwnKeysArray(PLETCHER_RF_FEATURE_KEYS.length + 1);
    assert.equal(compileSnowRfModel({ featureKeys: tracked.proxy, trees: [treeFromNodes([leaf()])] }), null);
    assert.equal(tracked.stats.ownKeysReads, 0);
  });

  await t.test("oversized sparse forest stops at its length descriptor", () => {
    const tracked = trackedOwnKeysArray(SNOW_RF_MAX_TREE_COUNT + 1);
    assert.equal(compileSnowRfModel({ featureKeys: [...PLETCHER_RF_FEATURE_KEYS], trees: tracked.proxy }), null);
    assert.equal(tracked.stats.ownKeysReads, 0);
  });

  await t.test("oversized sparse tree stops at its first field length descriptor", () => {
    const tracked = trackedOwnKeysArray(SNOW_RF_MAX_NODES_PER_TREE + 1);
    assert.equal(
      compileSnowRfTree({
        childrenLeft: tracked.proxy,
        childrenRight: [],
        feature: [],
        threshold: [],
        value: [],
      }),
      null,
    );
    assert.equal(tracked.stats.ownKeysReads, 0);
  });

  await t.test("aggregate forest ceiling stops the first over-budget tree before dense capture", () => {
    const maxFullTreeNodes = SNOW_RF_MAX_NODES_PER_TREE - 1;
    const tree = perfectBinaryTree(maxFullTreeNodes);
    const acceptedTreeCount = Math.floor(SNOW_RF_MAX_TOTAL_NODES / maxFullTreeNodes);
    assert.ok(acceptedTreeCount > 0 && acceptedTreeCount + 1 < SNOW_RF_MAX_TREE_COUNT);
    let finalOwnKeysReads = 0;
    const finalLeft = new Proxy(tree.childrenLeft, {
      ownKeys(target) {
        finalOwnKeysReads += 1;
        return Reflect.ownKeys(target);
      },
    });
    const trees = new Array(acceptedTreeCount).fill(tree);
    trees.push({ ...tree, childrenLeft: finalLeft });
    assert.equal(compileSnowRfModel(snowRfModel(trees)), null);
    assert.equal(finalOwnKeysReads, 0);
  });
});

test("compiled storage preserves finite Float64 edge values and integral feature boundaries", () => {
  const raw = branchTree({
    feature: -0,
    threshold: -0,
    leftValue: -0,
    rightValue: Number.MIN_VALUE,
  });
  raw.value[0] = Number.MAX_VALUE;
  const compiled = compileSnowRfTree(raw);
  assert.ok(compiled);
  assert.ok(compiled.childrenLeft instanceof Int32Array);
  assert.ok(compiled.childrenRight instanceof Int32Array);
  assert.ok(compiled.feature instanceof Int32Array);
  assert.ok(compiled.threshold instanceof Float64Array);
  assert.ok(compiled.value instanceof Float64Array);
  assert.ok(Object.is(compiled.threshold[0], -0));
  assert.ok(Object.is(compiled.value[0], Number.MAX_VALUE));
  assert.ok(Object.is(compiled.value[1], -0));
  assert.ok(Object.is(compiled.value[2], Number.MIN_VALUE));
  assert.equal(compiled.feature[0], 0);
  assert.ok(compileSnowRfTree(branchTree({ feature: 26 })));
  const customLeafThreshold = treeFromNodes([leaf()]);
  customLeafThreshold.threshold[0] = 123.5;
  assert.ok(compileSnowRfTree(customLeafThreshold), "finite leaf thresholds are non-semantic");
  assert.ok(compileSnowRfTree(branchTree({ threshold: Number.MAX_VALUE })));
  assert.ok(compileSnowRfTree(branchTree({ threshold: -Number.MAX_VALUE })));
  for (const value of [-0, 0, -Number.MIN_VALUE, Number.MIN_VALUE, -Number.MAX_VALUE, Number.MAX_VALUE]) {
    const rootLeaf = compileSnowRfTree(treeFromNodes([leaf(value)]));
    assert.equal(traverseRfTree(rootLeaf, []), 0);
    assert.ok(Object.is(predictRfTree(rootLeaf, []), value));
  }
});

test("direct traversal preserves <= split equality and adjacent-Float64 routing", () => {
  const threshold = 264.4902038574219;
  const tree = compileSnowRfTree(branchTree({ feature: 11, threshold }));
  const features = new Array(PLETCHER_RF_FEATURE_KEYS.length).fill(0);
  features[11] = nextDown(threshold);
  assert.equal(traverseRfTree(tree, features), 1);
  assert.ok(Object.is(predictRfTree(tree, features), 11));
  features[11] = threshold;
  assert.equal(traverseRfTree(tree, features), 1);
  assert.ok(Object.is(predictRfTree(tree, features), 11));
  features[11] = nextUp(threshold);
  assert.equal(traverseRfTree(tree, features), 2);
  assert.ok(Object.is(predictRfTree(tree, features), 22));
});

test("traversal handles NaN, infinities, missing values, signed zero, subnormals, and extremes", () => {
  const features = new Array(PLETCHER_RF_FEATURE_KEYS.length).fill(0);
  const zeroTree = compileSnowRfTree(branchTree({ threshold: -0, leftValue: -0, rightValue: Number.MIN_VALUE }));
  for (const value of [-0, 0]) {
    features[0] = value;
    assert.equal(traverseRfTree(zeroTree, features), 1);
    assert.ok(Object.is(predictRfTree(zeroTree, features), -0));
  }

  const subnormalTree = compileSnowRfTree(
    branchTree({ threshold: Number.MIN_VALUE, leftValue: -Number.MIN_VALUE, rightValue: Number.MIN_VALUE }),
  );
  features[0] = nextDown(Number.MIN_VALUE);
  assert.equal(traverseRfTree(subnormalTree, features), 1);
  features[0] = Number.MIN_VALUE;
  assert.equal(traverseRfTree(subnormalTree, features), 1);
  features[0] = nextUp(Number.MIN_VALUE);
  assert.equal(traverseRfTree(subnormalTree, features), 2);

  const positiveExtreme = compileSnowRfTree(branchTree({ threshold: Number.MAX_VALUE }));
  features[0] = nextDown(Number.MAX_VALUE);
  assert.equal(traverseRfTree(positiveExtreme, features), 1);
  features[0] = Number.MAX_VALUE;
  assert.equal(traverseRfTree(positiveExtreme, features), 1);

  const negativeExtreme = compileSnowRfTree(branchTree({ threshold: -Number.MAX_VALUE }));
  features[0] = -Number.MAX_VALUE;
  assert.equal(traverseRfTree(negativeExtreme, features), 1);
  features[0] = nextUp(-Number.MAX_VALUE);
  assert.equal(traverseRfTree(negativeExtreme, features), 2);

  for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, undefined, null, "0"]) {
    features[0] = invalid;
    assert.equal(traverseRfTree(zeroTree, features), null);
    assert.ok(Number.isNaN(predictRfTree(zeroTree, features)));
  }
  const missing = [];
  assert.equal(traverseRfTree(zeroTree, missing), null);
  assert.ok(Number.isNaN(predictRfTree(zeroTree, missing)));

  features.fill(0);
  features[26] = Number.NaN;
  assert.equal(traverseRfTree(zeroTree, features), 1, "an unused invalid feature does not poison the path");
});

test("leaf IDs remain local, exact, and independent of duplicate leaf values", () => {
  const tree = compileSnowRfTree(
    treeFromNodes([
      split(1, 2, { feature: 0 }),
      split(3, 4, { feature: 1 }),
      split(5, 6, { feature: 2 }),
      leaf(10),
      leaf(10),
      leaf(10),
      leaf(10),
    ]),
  );
  const cases = [
    [[-1, -1, 0], 3],
    [[-1, 1, 0], 4],
    [[1, 0, -1], 5],
    [[1, 0, 1], 6],
  ];
  for (const [prefix, leafId] of cases) {
    const features = new Array(PLETCHER_RF_FEATURE_KEYS.length).fill(0);
    features.splice(0, prefix.length, ...prefix);
    assert.equal(traverseRfTree(tree, features), leafId);
    assert.equal(predictRfTree(tree, features), 10);
  }
});

test("forest prediction preserves invalid-tree skipping and exact accumulation order", () => {
  const raw = snowRfModel([branchTree({ feature: 0, leftValue: 1, rightValue: 3 }), treeFromNodes([leaf(7)])]);
  const model = compileSnowRfModel(raw);
  assert.ok(model);
  assert.equal(predictRandomForest(model, [Number.NaN]), 7);
  assert.ok(Number.isNaN(predictRandomForest(compileSnowRfModel(snowRfModel([raw.trees[0]])), [Number.NaN])));
  assert.ok(Number.isNaN(predictRandomForest(model, new Float64Array([0]))));
  assert.ok(Number.isNaN(predictRandomForest(null, [0])));

  const ordered = compileSnowRfModel(
    snowRfModel([treeFromNodes([leaf(Number.MAX_SAFE_INTEGER)]), treeFromNodes([leaf(1)]), treeFromNodes([leaf(-1)])]),
  );
  assert.ok(Object.is(predictRandomForest(ordered, []), (Number.MAX_SAFE_INTEGER + 1 - 1) / 3));
});

test("deterministic random forests retain exact local-reference traversal and predictions", () => {
  const random = seededRandom(0xc0ffee);
  const raw = snowRfModel(Array.from({ length: 32 }, (_, index) => randomTree(random, 2 + (index % 5))));
  const compiled = compileSnowRfModel(raw);
  assert.ok(compiled);
  for (let sampleIndex = 0; sampleIndex < 512; sampleIndex += 1) {
    const features = Array.from({ length: PLETCHER_RF_FEATURE_KEYS.length }, () => (random() - 0.5) * 1000);
    if (sampleIndex % 31 === 0) {
      features[sampleIndex % features.length] = Number.NaN;
    } else if (sampleIndex % 47 === 0) {
      features[sampleIndex % features.length] = Number.POSITIVE_INFINITY;
    }
    assert.ok(
      Object.is(predictRandomForest(compiled, features), referencePredictForest(raw, features)),
      `forest sample ${sampleIndex}`,
    );
    for (let treeIndex = 0; treeIndex < raw.trees.length; treeIndex += 1) {
      assert.equal(
        traverseRfTree(compiled.trees[treeIndex], features),
        referenceTraverse(raw.trees[treeIndex], features),
        `tree ${treeIndex}, sample ${sampleIndex}: leaf`,
      );
      assert.ok(
        Object.is(
          predictRfTree(compiled.trees[treeIndex], features),
          referencePredictTree(raw.trees[treeIndex], features),
        ),
        `tree ${treeIndex}, sample ${sampleIndex}: prediction`,
      );
    }
  }
});

test("current 100-tree artifact compiles with its exact shape and boundary leaf routes", () => {
  const bytes = fs.readFileSync(CURRENT_MODEL_PATH);
  const raw = JSON.parse(bytes);
  const model = compileSnowRfModel(raw);
  assert.ok(model);
  assert.equal(
    crypto.createHash("sha256").update(bytes).digest("hex"),
    "b3bc9395135c6ef79d103e82516b70cdca6c28571807b362d4080de512f6c731",
  );
  assert.equal(bytes.length, 27_054_389);
  assert.equal(model.trees.length, 100);
  assert.deepEqual(model.featureKeys, PLETCHER_RF_FEATURE_KEYS);

  let nodes = 0;
  let leaves = 0;
  let internal = 0;
  let minNodes = Number.POSITIVE_INFINITY;
  let maxNodes = 0;
  let maxDepth = 0;
  for (const tree of model.trees) {
    nodes += tree.value.length;
    minNodes = Math.min(minNodes, tree.value.length);
    maxNodes = Math.max(maxNodes, tree.value.length);
    const stack = [[0, 0]];
    while (stack.length > 0) {
      const [node, depth] = stack.pop();
      if (tree.childrenLeft[node] === -1) {
        leaves += 1;
        maxDepth = Math.max(maxDepth, depth);
      } else {
        internal += 1;
        stack.push([tree.childrenLeft[node], depth + 1], [tree.childrenRight[node], depth + 1]);
      }
    }
  }
  assert.deepEqual(
    { nodes, leaves, internal, minNodes, maxNodes, maxDepth },
    { nodes: 666_406, leaves: 333_253, internal: 333_153, minNodes: 6_149, maxNodes: 7_043, maxDepth: 20 },
  );

  const rootThreshold = raw.trees[0].threshold[0];
  const features = new Array(PLETCHER_RF_FEATURE_KEYS.length).fill(0);
  features[11] = nextDown(rootThreshold);
  assert.equal(traverseRfTree(model.trees[0], features), 16);
  features[11] = rootThreshold;
  assert.equal(traverseRfTree(model.trees[0], features), 16);
  features[11] = nextUp(rootThreshold);
  assert.equal(traverseRfTree(model.trees[0], features), 2950);
});

test("current sklearn samples preserve exact predictions and all local leaf IDs", () => {
  const model = compileSnowRfModel(JSON.parse(fs.readFileSync(CURRENT_MODEL_PATH, "utf8")));
  const samples = [
    {
      features: [
        5, 8, 10, 12, 15, 18, 20, 22, 270, 268, 266, 264, 262, 260, 258, 256, 92, 91, 90, 88, 86, 84, 82, 80, 500, 42,
        -111,
      ],
      expected: 13.019582796042528,
      leafIdsSha256: "060b6ae95562a3e768db9b22d8378b4066f756583fcc4ccfd23ced409bec8cad",
    },
    {
      features: [
        2, 3, 4, 5, 7, 9, 11, 12, 268, 265, 262, 259, 255, 251, 248, 245, 98, 97, 96, 94, 91, 88, 84, 80, 1800, 39.5,
        -106.5,
      ],
      expected: 15.658695999664602,
      leafIdsSha256: "7ecf104cb385c04a298dcbc6f25fb7bf1785171b2d76a33dc35203b968be3bdc",
    },
    {
      features: [
        12, 14, 17, 20, 22, 25, 28, 30, 274, 272, 269, 266, 263, 260, 257, 254, 85, 86, 87, 88, 89, 90, 90, 88, 100, 44,
        -75,
      ],
      expected: 13.260978049978435,
      leafIdsSha256: "05ac13732599db89a1e65e862dc151c6f55106ba15333b74adc87e766a32a1a0",
    },
  ];
  for (const sample of samples) {
    assert.ok(Object.is(predictRandomForest(model, sample.features), sample.expected));
    const leafIds = model.trees.map((tree) => traverseRfTree(tree, sample.features));
    assert.equal(crypto.createHash("sha256").update(JSON.stringify(leafIds)).digest("hex"), sample.leafIdsSha256);
  }
});
