"use strict";

const {
  CAM_DCAPE_21_LEVEL_PROTOTYPE_KEY,
  EFFECTIVE_STP_100MB_REDUCED_PROTOTYPE_KEY,
} = require("../noaa-nam-parameter-catalog");
const {
  SELECTION_DECODE_DEPENDENCY_ROLES,
  SELECTION_DECODE_DEPENDENCY_SCHEMA_VERSION,
  SELECTION_SUPPORT_PRODUCT,
  selectionDecodeDependencyIdentity,
} = require("./selection");

const DERIVED_DECODE_PLAN_SCHEMA_VERSION = "noaa-derived-decode-plan-v2";

// These are output-grid contracts, not aliases for availability names.
// Legacy SCP and fixed-layer STP consume the effective/bulk shear grid that
// buildProfileDerivedGrids emits for them; a strict restored roster must use
// those actual names.
const PROFILE_PRODUCT_RESTORED_GRIDS = Object.freeze({
  lapseRate0to3km: Object.freeze(["lapseRate0to3km"]),
  supercellCompositeParameter: Object.freeze(["effectiveBulkShear"]),
  effectiveLayerSupercellCompositeParameter: Object.freeze(["effectiveLayerSupercellCompositeParameter"]),
  effectiveLayerSignificantTornadoParameter: Object.freeze(["effectiveLayerSignificantTornadoParameter"]),
  bulkShear0to6km: Object.freeze(["bulkShear0to6km"]),
  significantTornadoParameter: Object.freeze(["bulkShear0to6km"]),
  effectiveBulkShear: Object.freeze(["effectiveBulkShear"]),
  dcape: Object.freeze(["dcape"]),
  [EFFECTIVE_STP_100MB_REDUCED_PROTOTYPE_KEY]: Object.freeze([EFFECTIVE_STP_100MB_REDUCED_PROTOTYPE_KEY]),
  [CAM_DCAPE_21_LEVEL_PROTOTYPE_KEY]: Object.freeze([CAM_DCAPE_21_LEVEL_PROTOTYPE_KEY]),
});

const VALID_DEPENDENCY_ROLES = new Set(SELECTION_DECODE_DEPENDENCY_ROLES);

function expectedProfileGridNamesForSelection(selection) {
  const validation = validateSelectionDecodeDependencies(selection);
  return validation.ok ? validation.expectedProfileGridNames : null;
}

function buildDerivedDecodePlan({ selection, restoredGrids, cellCount } = {}) {
  const selectedKeys = Object.keys(selection?.records || {}).sort();
  const expectedCellCount = Number(cellCount);
  if (!Number.isSafeInteger(expectedCellCount) || expectedCellCount <= 0) {
    return failClosedPlan({
      selection,
      selectedKeys,
      reason: "invalid-cell-count",
    });
  }
  const validation = validateSelectionDecodeDependencies(selection);
  if (!validation.ok) {
    return failClosedPlan({
      selection,
      selectedKeys,
      reason: validation.reason,
    });
  }
  const restoredGridNames = restoredGridNameRoster(restoredGrids, expectedCellCount);
  if (!restoredGridNames) {
    return failClosedPlan({
      selection,
      selectedKeys,
      expectedProfileGridNames: validation.expectedProfileGridNames,
      reason: "missing-restored-grids",
    });
  }
  if (!sameStringArray(restoredGridNames, validation.expectedProfileGridNames)) {
    return failClosedPlan({
      selection,
      selectedKeys,
      expectedProfileGridNames: validation.expectedProfileGridNames,
      restoredGridNames,
      reason: "restored-grid-roster-mismatch",
    });
  }
  if (restoredGridNames.length === 0) {
    return failClosedPlan({
      selection,
      selectedKeys,
      expectedProfileGridNames: validation.expectedProfileGridNames,
      restoredGridNames,
      reason: "empty-profile-grid-roster",
    });
  }

  const { omittedDecodeKeys, retainedDecodeKeys } = computeDecodeKeyRosters(
    selection,
    validation.records,
    new Set(restoredGridNames),
  );
  return {
    schemaVersion: DERIVED_DECODE_PLAN_SCHEMA_VERSION,
    identity: validation.identity,
    valid: true,
    expectedProfileGridNames: validation.expectedProfileGridNames,
    restoredGridNames,
    omittedDecodeKeys,
    retainedDecodeKeys,
    cellCount: expectedCellCount,
  };
}

function applyDerivedDecodePlan(selection, plan, cellCount = null) {
  const validation = validateSelectionDecodeDependencies(selection);
  const expectedCellCount = cellCount === null ? Number(plan?.cellCount) : Number(cellCount);
  if (
    !validation.ok ||
    plan?.schemaVersion !== DERIVED_DECODE_PLAN_SCHEMA_VERSION ||
    plan?.identity !== validation.identity ||
    plan?.valid !== true ||
    !Number.isSafeInteger(expectedCellCount) ||
    expectedCellCount <= 0 ||
    plan?.cellCount !== expectedCellCount ||
    !sameStringArray(plan.expectedProfileGridNames, validation.expectedProfileGridNames) ||
    !sameStringArray(plan.restoredGridNames, validation.expectedProfileGridNames)
  ) {
    return selection;
  }
  const expectedRosters = computeDecodeKeyRosters(
    selection,
    validation.records,
    new Set(validation.expectedProfileGridNames),
  );
  if (
    !sameStringArray(plan.omittedDecodeKeys, expectedRosters.omittedDecodeKeys) ||
    !sameStringArray(plan.retainedDecodeKeys, expectedRosters.retainedDecodeKeys)
  ) {
    return selection;
  }
  const records = {};
  for (const key of expectedRosters.retainedDecodeKeys) {
    records[key] = selection.records[key];
  }
  return {
    ...selection,
    records,
    appliedDerivedDecodePlan: {
      schemaVersion: plan.schemaVersion,
      identity: plan.identity,
      omittedDecodeKeys: [...plan.omittedDecodeKeys],
    },
  };
}

function validateSelectionDecodeDependencies(selection) {
  const graph = selection?.decodeDependencies;
  const header = validateSelectionDependencyHeader(selection, graph);
  if (!header.ok) {
    return header;
  }

  const productSet = new Set(header.availableProducts);
  const records = new Map();
  const profileProducts = new Set();
  for (const record of graph.records) {
    const ownerValidation = validateSelectionDependencyOwners(record, productSet, profileProducts);
    if (!ownerValidation.ok) {
      return ownerValidation;
    }
    records.set(record.key, record);
  }

  const expectedProfileGridNames = Array.from(profileProducts)
    .flatMap((product) => PROFILE_PRODUCT_RESTORED_GRIDS[product])
    .filter((name, index, values) => values.indexOf(name) === index)
    .sort();
  return {
    ok: true,
    identity: graph.selectionIdentity,
    records,
    expectedProfileGridNames,
  };
}

function validateSelectionDependencyHeader(selection, graph) {
  if (!selection || !graph) {
    return { ok: false, reason: "missing-selection-dependencies" };
  }
  if (graph.schemaVersion !== SELECTION_DECODE_DEPENDENCY_SCHEMA_VERSION) {
    return { ok: false, reason: "selection-dependency-schema-mismatch" };
  }
  const identity = selectionDecodeDependencyIdentity(selection);
  if (
    typeof graph.selectionIdentity !== "string" ||
    !/^[a-f0-9]{64}$/.test(graph.selectionIdentity) ||
    identity !== graph.selectionIdentity
  ) {
    return { ok: false, reason: "selection-identity-mismatch" };
  }
  const availableProducts = Array.from(new Set((selection.availableParameters || []).map(String))).sort();
  if (!sameStringArray(graph.products, availableProducts)) {
    return { ok: false, reason: "selection-product-roster-mismatch" };
  }
  const selectedKeys = Object.keys(selection.records || {}).sort();
  if (
    !Array.isArray(graph.records) ||
    !sameStringArray(
      graph.records.map((record) => record?.key),
      selectedKeys,
    )
  ) {
    return { ok: false, reason: "selection-record-roster-mismatch" };
  }
  return { ok: true, availableProducts };
}

function validateSelectionDependencyOwners(record, productSet, profileProducts) {
  if (!Array.isArray(record.owners) || record.owners.length === 0) {
    return { ok: false, reason: "unowned-selection-record" };
  }
  const ownerTokens = [];
  for (const owner of record.owners) {
    const product = String(owner?.product || "");
    const role = String(owner?.role || "");
    const ownerError = validateSelectionDependencyOwner(product, role, productSet);
    if (ownerError) {
      return { ok: false, reason: ownerError };
    }
    if (role === "profile") {
      // Profile rows owned by winter/lazy products are legitimate but cannot
      // be satisfied by the severe/profile sidecar. Only explicitly mapped
      // products contribute restored outputs; all other profile owners stay
      // live in computeDecodeKeyRosters.
      if (PROFILE_PRODUCT_RESTORED_GRIDS[product]) {
        profileProducts.add(product);
      }
    }
    ownerTokens.push(`${product}\u0000${role}`);
  }
  const sortedOwnerTokens = [...ownerTokens].sort();
  if (new Set(sortedOwnerTokens).size !== sortedOwnerTokens.length) {
    return { ok: false, reason: "duplicate-dependency-owner" };
  }
  const actualOwnerTokens = record.owners.map((owner) => `${owner.product}\u0000${owner.role}`);
  return sameStringArray(actualOwnerTokens, sortedOwnerTokens)
    ? { ok: true }
    : { ok: false, reason: "nondeterministic-dependency-order" };
}

function validateSelectionDependencyOwner(product, role, productSet) {
  if (!VALID_DEPENDENCY_ROLES.has(role)) {
    return "unknown-dependency-role";
  }
  if (!product || (product !== SELECTION_SUPPORT_PRODUCT && !productSet.has(product))) {
    return "unknown-dependency-product";
  }
  if (product === SELECTION_SUPPORT_PRODUCT && role !== "support") {
    return "invalid-selection-support-role";
  }
  return null;
}

function computeDecodeKeyRosters(selection, dependencyRecords, restoredGridNames) {
  const selectedKeys = Object.keys(selection?.records || {}).sort();
  const omitted = new Set();
  const retained = new Set();
  for (const key of selectedKeys) {
    const owners = dependencyRecords.get(key)?.owners || [];
    const exclusivelySatisfiedProfile =
      owners.length > 0 &&
      owners.every(
        (owner) =>
          owner.role === "profile" &&
          PROFILE_PRODUCT_RESTORED_GRIDS[owner.product]?.every((gridName) => restoredGridNames.has(gridName)),
      );
    (exclusivelySatisfiedProfile ? omitted : retained).add(key);
  }

  // A packed grid can be addressed by more than one decode key. If any alias
  // remains live, retaining every alias for that physical record guarantees
  // the sparse-read layer cannot accidentally mark its shared pack entry as
  // unreadable while another direct/support consumer still needs it.
  const aliasesByRecord = new Map();
  for (const key of selectedKeys) {
    const recordIdentity = selectedRecordIdentity(selection.records[key]);
    const aliases = aliasesByRecord.get(recordIdentity) || [];
    aliases.push(key);
    aliasesByRecord.set(recordIdentity, aliases);
  }
  for (const aliases of aliasesByRecord.values()) {
    if (!aliases.some((key) => retained.has(key))) {
      continue;
    }
    for (const key of aliases) {
      omitted.delete(key);
      retained.add(key);
    }
  }

  return {
    omittedDecodeKeys: [...omitted].sort(),
    retainedDecodeKeys: [...retained].sort(),
  };
}

function selectedRecordIdentity(record) {
  return [
    record?.record || "",
    record?.offset || "",
    record?.param || "",
    record?.level || "",
    record?.forecast || "",
    record?.extra || "",
  ].join("\u0000");
}

function restoredGridNameRoster(restoredGrids, expectedCellCount) {
  if (!restoredGrids || typeof restoredGrids !== "object" || Array.isArray(restoredGrids)) {
    return null;
  }
  const names = Object.keys(restoredGrids).sort();
  for (const name of names) {
    const grid = restoredGrids[name];
    if (!(grid instanceof Float32Array) || grid.length !== expectedCellCount) {
      return null;
    }
  }
  return names;
}

function failClosedPlan({
  selection,
  selectedKeys,
  expectedProfileGridNames = [],
  restoredGridNames = [],
  cellCount = null,
  reason,
}) {
  return {
    schemaVersion: DERIVED_DECODE_PLAN_SCHEMA_VERSION,
    identity: selection?.decodeDependencies?.selectionIdentity || null,
    valid: false,
    failClosedReason: reason,
    expectedProfileGridNames: [...expectedProfileGridNames],
    restoredGridNames: [...restoredGridNames],
    omittedDecodeKeys: [],
    retainedDecodeKeys: [...selectedKeys],
    cellCount: Number.isSafeInteger(cellCount) && cellCount > 0 ? cellCount : null,
  };
}

function sameStringArray(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => typeof value === "string" && value === right[index]);
}

module.exports = {
  DERIVED_DECODE_PLAN_SCHEMA_VERSION,
  PROFILE_PRODUCT_RESTORED_GRIDS,
  applyDerivedDecodePlan,
  buildDerivedDecodePlan,
  expectedProfileGridNamesForSelection,
};
