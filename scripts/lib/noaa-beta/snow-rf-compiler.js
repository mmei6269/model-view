"use strict";

const SNOW_RF_COMPILER_ID = "modelview-strict-snow-rf-compiler-v1";

const PLETCHER_RF_FEATURE_KEYS = Object.freeze([
  "SPD03K",
  "SPD06K",
  "SPD09K",
  "SPD12K",
  "SPD15K",
  "SPD18K",
  "SPD21K",
  "SPD24K",
  "T03K",
  "T06K",
  "T09K",
  "T12K",
  "T15K",
  "T18K",
  "T21K",
  "T24K",
  "R03K",
  "R06K",
  "R09K",
  "R12K",
  "R15K",
  "R18K",
  "R21K",
  "R24K",
  "elev",
  "lat",
  "lon",
]);

const RF_LEAF_CHILD = -1;

const RF_LEAF_FEATURE = -2;

const SNOW_RF_TREE_KEYS = Object.freeze(["childrenLeft", "childrenRight", "feature", "threshold", "value"]);

const SNOW_RF_TREE_SNAKE_KEYS = Object.freeze(["children_left", "children_right", "feature", "threshold", "value"]);

// Preserve the historical traversal guard. Strict compilation rejects a
// graph with a reachable internal node at the final guarded step, so every
// accepted tree has a defined prediction for every finite used feature.
const RF_MAX_TRAVERSAL_STEPS = 4096;

// Resource ceilings are deliberately generous relative to the bundled
// 100-tree / 7,043-max-node / 666,406-total-node model, while bounding a
// malformed or unreviewed custom JSON artifact before dense snapshots and
// typed publication can consume unbounded memory.
const SNOW_RF_MAX_TREE_COUNT = 512;

const SNOW_RF_MAX_NODES_PER_TREE = 65_536;

const SNOW_RF_MAX_TOTAL_NODES = 2_097_152;

function compileSnowRfModel(raw) {
  try {
    const input = snapshotModelInput(raw);
    if (!input) {
      return null;
    }
    const featureKeys = snapshotDenseJsonArray(input.featureKeys, PLETCHER_RF_FEATURE_KEYS.length);
    if (!featureKeys || !hasCanonicalFeatureKeys(featureKeys)) {
      return null;
    }
    const rawTrees = snapshotDenseJsonArray(input.trees, SNOW_RF_MAX_TREE_COUNT);
    if (!rawTrees || rawTrees.length === 0) {
      return null;
    }
    const treeSnapshots = new Array(rawTrees.length);
    let totalNodes = 0;
    for (let index = 0; index < rawTrees.length; index += 1) {
      const remainingNodes = SNOW_RF_MAX_TOTAL_NODES - totalNodes;
      const tree = snapshotSnowRfTree(rawTrees[index], Math.min(SNOW_RF_MAX_NODES_PER_TREE, remainingNodes));
      if (!tree) {
        return null;
      }
      totalNodes += tree.childrenLeft.length;
      treeSnapshots[index] = tree;
    }
    const trees = new Array(treeSnapshots.length);
    for (let index = 0; index < treeSnapshots.length; index += 1) {
      trees[index] = materializeSnowRfTree(treeSnapshots[index]);
    }
    return {
      featureKeys: Array.from(PLETCHER_RF_FEATURE_KEYS),
      trees,
    };
  } catch {
    return null;
  }
}

function compileSnowRfTree(raw) {
  try {
    const snapshot = snapshotSnowRfTree(raw, SNOW_RF_MAX_NODES_PER_TREE);
    return snapshot ? materializeSnowRfTree(snapshot) : null;
  } catch {
    return null;
  }
}

function inspectCompiledSnowRfModel(model) {
  try {
    const input = snapshotModelInput(model);
    if (!input) {
      return null;
    }
    const featureKeys = snapshotDenseJsonArray(input.featureKeys, PLETCHER_RF_FEATURE_KEYS.length);
    if (!featureKeys || !hasCanonicalFeatureKeys(featureKeys)) {
      return null;
    }
    const rawTrees = snapshotDenseJsonArray(input.trees, SNOW_RF_MAX_TREE_COUNT);
    if (!rawTrees || rawTrees.length === 0) {
      return null;
    }
    let nodeCount = 0;
    let internalNodeCount = 0;
    let leafCount = 0;
    let maxDepth = 0;
    for (const rawTree of rawTrees) {
      const tree = snapshotCompiledTreeReferences(rawTree);
      if (!tree || !hasExactCompiledTreeTypes(tree)) {
        return null;
      }
      const metrics = inspectTreeArrays(tree);
      if (!metrics) {
        return null;
      }
      nodeCount += metrics.nodeCount;
      if (nodeCount > SNOW_RF_MAX_TOTAL_NODES) {
        return null;
      }
      internalNodeCount += metrics.internalNodeCount;
      leafCount += metrics.leafCount;
      maxDepth = Math.max(maxDepth, metrics.maxDepth);
    }
    return Object.freeze({
      featureCount: featureKeys.length,
      treeCount: rawTrees.length,
      nodeCount,
      internalNodeCount,
      leafCount,
      maxDepth,
    });
  } catch {
    return null;
  }
}

function snapshotModelInput(raw) {
  if (!isRecord(raw)) {
    return null;
  }
  const featureKeys = ownDataDescriptor(raw, "featureKeys");
  const trees = ownDataDescriptor(raw, "trees");
  if (!featureKeys || !trees) {
    return null;
  }
  return Object.freeze({
    featureKeys: featureKeys.value,
    trees: trees.value,
  });
}

function snapshotSnowRfTree(raw, nodeLimit) {
  const references = snapshotTreeArrayReferences(raw);
  if (!references) {
    return null;
  }
  const childrenLeft = snapshotDenseJsonArray(references.childrenLeft, nodeLimit);
  if (!childrenLeft || childrenLeft.length === 0) {
    return null;
  }
  const nodeCount = childrenLeft.length;
  const childrenRight = snapshotDenseJsonArray(references.childrenRight, nodeCount);
  const feature = snapshotDenseJsonArray(references.feature, nodeCount);
  const threshold = snapshotDenseJsonArray(references.threshold, nodeCount);
  const value = snapshotDenseJsonArray(references.value, nodeCount);
  if (!childrenRight || !feature || !threshold || !value) {
    return null;
  }
  const arrays = Object.freeze({ childrenLeft, childrenRight, feature, threshold, value });
  return validateTreeArrays(arrays) ? arrays : null;
}

function materializeSnowRfTree(arrays) {
  return {
    childrenLeft: Int32Array.from(arrays.childrenLeft),
    childrenRight: Int32Array.from(arrays.childrenRight),
    feature: Int32Array.from(arrays.feature),
    threshold: Float64Array.from(arrays.threshold),
    value: Float64Array.from(arrays.value),
  };
}

function snapshotCompiledTreeReferences(raw) {
  if (!isRecord(raw) || !hasExactOwnKeys(Reflect.ownKeys(raw), SNOW_RF_TREE_KEYS)) {
    return null;
  }
  const childrenLeft = ownDataDescriptor(raw, "childrenLeft");
  const childrenRight = ownDataDescriptor(raw, "childrenRight");
  const feature = ownDataDescriptor(raw, "feature");
  const threshold = ownDataDescriptor(raw, "threshold");
  const value = ownDataDescriptor(raw, "value");
  if (!childrenLeft || !childrenRight || !feature || !threshold || !value) {
    return null;
  }
  return Object.freeze({
    childrenLeft: childrenLeft.value,
    childrenRight: childrenRight.value,
    feature: feature.value,
    threshold: threshold.value,
    value: value.value,
  });
}

function hasExactCompiledTreeTypes(tree) {
  return (
    isExactTypedArray(tree.childrenLeft, Int32Array) &&
    isExactTypedArray(tree.childrenRight, Int32Array) &&
    isExactTypedArray(tree.feature, Int32Array) &&
    isExactTypedArray(tree.threshold, Float64Array) &&
    isExactTypedArray(tree.value, Float64Array)
  );
}

function isExactTypedArray(value, TypedArray) {
  return ArrayBuffer.isView(value) && Object.getPrototypeOf(value) === TypedArray.prototype;
}

function snapshotTreeArrayReferences(raw) {
  if (!isRecord(raw)) {
    return null;
  }
  const ownKeys = Reflect.ownKeys(raw);
  const camelCase = hasExactOwnKeys(ownKeys, SNOW_RF_TREE_KEYS);
  const snakeCase = hasExactOwnKeys(ownKeys, SNOW_RF_TREE_SNAKE_KEYS);
  if (!camelCase && !snakeCase) {
    return null;
  }
  const childrenLeft = ownDataDescriptor(raw, camelCase ? "childrenLeft" : "children_left");
  const childrenRight = ownDataDescriptor(raw, camelCase ? "childrenRight" : "children_right");
  const feature = ownDataDescriptor(raw, "feature");
  const threshold = ownDataDescriptor(raw, "threshold");
  const value = ownDataDescriptor(raw, "value");
  if (!childrenLeft || !childrenRight || !feature || !threshold || !value) {
    return null;
  }
  return Object.freeze({
    childrenLeft: childrenLeft.value,
    childrenRight: childrenRight.value,
    feature: feature.value,
    threshold: threshold.value,
    value: value.value,
  });
}

function snapshotDenseJsonArray(raw, maxLength) {
  if (!Array.isArray(raw)) {
    return null;
  }
  const lengthDescriptor = ownDataDescriptor(raw, "length");
  if (
    !lengthDescriptor ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    lengthDescriptor.value > maxLength
  ) {
    return null;
  }
  const length = lengthDescriptor.value;
  const ownKeys = Reflect.ownKeys(raw);
  if (!hasExactDenseArrayKeys(ownKeys, length)) {
    return null;
  }
  const snapshot = new Array(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = ownDataDescriptor(raw, String(index));
    if (!descriptor) {
      return null;
    }
    snapshot[index] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

function hasExactDenseArrayKeys(ownKeys, length) {
  if (ownKeys.length !== length + 1) {
    return false;
  }
  let sawLength = false;
  let indexCount = 0;
  for (const key of ownKeys) {
    if (key === "length") {
      sawLength = true;
      continue;
    }
    if (typeof key !== "string") {
      return false;
    }
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index < 0 || index >= length || String(index) !== key) {
      return false;
    }
    indexCount += 1;
  }
  return sawLength && indexCount === length;
}

function ownDataDescriptor(record, key) {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && Object.hasOwn(descriptor, "value") ? descriptor : null;
}

function validateTreeArrays(arrays) {
  return inspectTreeArrays(arrays) !== null;
}

function inspectTreeArrays(arrays) {
  const nodeCount = arrays.childrenLeft.length;
  if (
    nodeCount === 0 ||
    nodeCount > SNOW_RF_MAX_NODES_PER_TREE ||
    arrays.childrenRight.length !== nodeCount ||
    arrays.feature.length !== nodeCount ||
    arrays.threshold.length !== nodeCount ||
    arrays.value.length !== nodeCount
  ) {
    return null;
  }
  const parentCounts = new Uint8Array(nodeCount);
  let leafCount = 0;
  for (let node = 0; node < nodeCount; node += 1) {
    if (!validateNode(arrays, node, nodeCount, parentCounts)) {
      return null;
    }
    if (arrays.childrenLeft[node] === RF_LEAF_CHILD) {
      leafCount += 1;
    }
  }
  if (parentCounts[0] !== 0) {
    return null;
  }
  for (let node = 1; node < nodeCount; node += 1) {
    if (parentCounts[node] !== 1) {
      return null;
    }
  }
  const maxEdgeDepth = inspectReachableTraversalDepth(arrays.childrenLeft, arrays.childrenRight);
  if (maxEdgeDepth === null) {
    return null;
  }
  return Object.freeze({
    nodeCount,
    internalNodeCount: nodeCount - leafCount,
    leafCount,
    maxDepth: maxEdgeDepth + 1,
  });
}

function validateNode(arrays, node, nodeCount, parentCounts) {
  const left = arrays.childrenLeft[node];
  const right = arrays.childrenRight[node];
  const feature = arrays.feature[node];
  const threshold = arrays.threshold[node];
  const value = arrays.value[node];
  if (
    !Number.isSafeInteger(left) ||
    !Number.isSafeInteger(right) ||
    !Number.isSafeInteger(feature) ||
    !Number.isFinite(threshold) ||
    !Number.isFinite(value)
  ) {
    return false;
  }
  const leftIsLeaf = left === RF_LEAF_CHILD;
  const rightIsLeaf = right === RF_LEAF_CHILD;
  if (leftIsLeaf || rightIsLeaf) {
    return leftIsLeaf && rightIsLeaf && feature === RF_LEAF_FEATURE;
  }
  if (
    left < 0 ||
    right < 0 ||
    left >= nodeCount ||
    right >= nodeCount ||
    left === node ||
    right === node ||
    left === right ||
    feature < 0 ||
    feature >= PLETCHER_RF_FEATURE_KEYS.length
  ) {
    return false;
  }
  parentCounts[left] += 1;
  parentCounts[right] += 1;
  return parentCounts[left] === 1 && parentCounts[right] === 1;
}

function inspectReachableTraversalDepth(childrenLeft, childrenRight) {
  const nodeCount = childrenLeft.length;
  const visited = new Uint8Array(nodeCount);
  const nodeStack = [0];
  const depthStack = [0];
  let visitedCount = 0;
  let maxDepth = 0;
  while (nodeStack.length > 0) {
    const node = nodeStack.pop();
    const depth = depthStack.pop();
    if (visited[node] !== 0) {
      return null;
    }
    visited[node] = 1;
    visitedCount += 1;
    maxDepth = Math.max(maxDepth, depth);
    if (childrenLeft[node] === RF_LEAF_CHILD) {
      continue;
    }
    if (depth >= RF_MAX_TRAVERSAL_STEPS - 1) {
      return null;
    }
    nodeStack.push(childrenRight[node], childrenLeft[node]);
    depthStack.push(depth + 1, depth + 1);
  }
  return visitedCount === nodeCount ? maxDepth : null;
}

function hasCanonicalFeatureKeys(featureKeys) {
  if (!Array.isArray(featureKeys) || featureKeys.length !== PLETCHER_RF_FEATURE_KEYS.length) {
    return false;
  }
  for (let index = 0; index < PLETCHER_RF_FEATURE_KEYS.length; index += 1) {
    if (featureKeys[index] !== PLETCHER_RF_FEATURE_KEYS[index]) {
      return false;
    }
  }
  return true;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactOwnKeys(ownKeys, expectedKeys) {
  if (ownKeys.length !== expectedKeys.length || ownKeys.some((key) => typeof key !== "string")) {
    return false;
  }
  const keys = ownKeys.slice().sort();
  for (let index = 0; index < expectedKeys.length; index += 1) {
    if (keys[index] !== expectedKeys[index]) {
      return false;
    }
  }
  return true;
}

function predictRandomForest(model, features) {
  if (!model?.trees?.length || !Array.isArray(features)) {
    return Number.NaN;
  }
  let total = 0;
  let count = 0;
  for (const tree of model.trees) {
    const value = predictRfTree(tree, features);
    if (Number.isFinite(value)) {
      total += value;
      count += 1;
    }
  }
  return count > 0 ? total / count : Number.NaN;
}

function predictRfTree(tree, features) {
  const leafId = traverseRfTree(tree, features);
  return leafId === null ? Number.NaN : tree.value[leafId];
}

function traverseRfTree(tree, features) {
  let node = 0;
  for (let depth = 0; depth < RF_MAX_TRAVERSAL_STEPS; depth += 1) {
    const left = tree.childrenLeft[node];
    const right = tree.childrenRight[node];
    if (left < 0 || right < 0) {
      return node;
    }
    const featureIndex = tree.feature[node];
    const featureValue = features[featureIndex];
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

const normalizeSnowRfModel = compileSnowRfModel;

const normalizeRfTree = compileSnowRfTree;

module.exports = {
  PLETCHER_RF_FEATURE_KEYS,
  RF_LEAF_CHILD,
  RF_LEAF_FEATURE,
  RF_MAX_TRAVERSAL_STEPS,
  SNOW_RF_COMPILER_ID,
  SNOW_RF_MAX_NODES_PER_TREE,
  SNOW_RF_MAX_TOTAL_NODES,
  SNOW_RF_MAX_TREE_COUNT,
  compileSnowRfModel,
  compileSnowRfTree,
  inspectCompiledSnowRfModel,
  normalizeRfTree,
  normalizeSnowRfModel,
  predictRandomForest,
  predictRfTree,
  traverseRfTree,
};
