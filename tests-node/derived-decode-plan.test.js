"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  applyDerivedDecodePlan,
  buildDerivedDecodePlan,
  expectedProfileGridNamesForSelection,
} = require("../scripts/lib/noaa-beta/derived-decode-plan");
const {
  selectionDecodeDependencyIdentity,
  selectNoaaNamParameterRecords,
} = require("../scripts/lib/noaa-beta/selection");

function gribRecord(record, param, level) {
  return {
    record: String(record),
    offset: record * 100,
    param,
    level,
    forecast: "anl",
    extra: "",
    line: `${record}:${record * 100}:d=2026072300:${param}:${level}:anl:`,
  };
}

function directScalar(key, inputKey, param, level) {
  return {
    key,
    kind: "scalar",
    inputKey,
    selector: { param, level },
    required: false,
  };
}

function profileDerived(key, profileVariables, profileLevels) {
  return {
    key,
    kind: "derivedScalar",
    inputKey: key,
    profileVariables,
    profileLevels,
    completeProfileRequired: true,
    surfaceHeightRequired: false,
    sourceSelectors: [],
    anySourceKeyGroups: [],
    required: false,
  };
}

function restoredGrids(names) {
  return Object.fromEntries(names.map((name, index) => [name, new Float32Array([index + 1])]));
}

function ownerTokens(selection, key) {
  const record = selection.decodeDependencies.records.find((candidate) => candidate.key === key);
  return (record?.owners || []).map((owner) => `${owner.product}:${owner.role}`);
}

function pressureProfileFixture() {
  const records = [];
  let ordinal = 1;
  for (const level of [925, 850, 700, 500]) {
    records.push(gribRecord(ordinal++, "TMP", `${level} mb`));
    records.push(gribRecord(ordinal++, "HGT", `${level} mb`));
  }
  const catalog = [
    directScalar("temperature700", "temp700", "TMP", "700 mb"),
    directScalar("temperature850", "temp850", "TMP", "850 mb"),
    directScalar("temperature500", "temp500", "TMP", "500 mb"),
    profileDerived("dcape", ["TMP", "HGT"], [925, 850, 700, 500]),
  ];
  return { records, catalog };
}

test("profile cache plan retains direct 700/850/500 aliases and omits profile-only 925 inputs", () => {
  const { records, catalog } = pressureProfileFixture();
  const selection = selectNoaaNamParameterRecords(records, { catalog });
  const plan = buildDerivedDecodePlan({
    selection,
    restoredGrids: restoredGrids(["dcape"]),
    cellCount: 1,
  });

  assert.equal(plan.valid, true);
  assert.deepEqual(plan.expectedProfileGridNames, ["dcape"]);
  assert.ok(plan.omittedDecodeKeys.includes("profileTmp925"));
  assert.ok(plan.omittedDecodeKeys.includes("profileHgt925"));
  for (const key of ["temp700", "temp850", "temp500"]) {
    assert.ok(plan.retainedDecodeKeys.includes(key), `${key} remains directly rendered`);
    assert.ok(ownerTokens(selection, key).includes("dcape:profile"), `${key} accumulates profile ownership`);
    assert.ok(
      ownerTokens(selection, key).some((token) => token.endsWith(":direct")),
      `${key} keeps direct ownership`,
    );
  }
  const applied = applyDerivedDecodePlan(selection, plan);
  assert.equal(applied.records.profileTmp925, undefined);
  assert.equal(applied.records.profileHgt925, undefined);
  assert.equal(applied.records.temp700, selection.records.temp700);
});

test("synthetic direct 925-mb layer keeps profile height for the implicit terrain mask", () => {
  const temperature925 = gribRecord(1, "TMP", "925 mb");
  const height925 = gribRecord(2, "HGT", "925 mb");
  const selection = selectNoaaNamParameterRecords([temperature925, height925], {
    catalog: [
      directScalar("syntheticTemperature925", "visibleTemperature925", "TMP", "925 mb"),
      profileDerived("dcape", ["TMP", "HGT"], [925]),
    ],
  });
  const plan = buildDerivedDecodePlan({
    selection,
    restoredGrids: restoredGrids(["dcape"]),
    cellCount: 1,
  });

  assert.equal(plan.valid, true);
  assert.ok(ownerTokens(selection, "profileHgt925").includes("syntheticTemperature925:support"));
  assert.ok(plan.retainedDecodeKeys.includes("profileHgt925"));
  assert.ok(plan.retainedDecodeKeys.includes("profileTmp925"));
  assert.ok(plan.retainedDecodeKeys.includes("visibleTemperature925"));
  assert.deepEqual(plan.omittedDecodeKeys, []);
});

test("derived pressure source selectors retain every implicit terrain-mask height grid", () => {
  const records = [];
  let ordinal = 1;
  for (const level of [850, 700]) {
    for (const variable of ["TMP", "HGT", "UGRD", "VGRD"]) {
      records.push(gribRecord(ordinal++, variable, `${level} mb`));
    }
  }
  const selection = selectNoaaNamParameterRecords(records, {
    catalog: [
      {
        ...profileDerived("lapseRate0to3km", ["TMP", "HGT"], [850, 700]),
        sourceSelectors: [],
      },
      {
        key: "frontogenesis850",
        kind: "derivedScalar",
        inputKey: "frontogenesis850",
        profileVariables: [],
        profileLevels: [],
        completeProfileRequired: false,
        surfaceHeightRequired: false,
        sourceSelectors: [
          { key: "temp850", selector: { param: "TMP", level: "850 mb" } },
          { key: "windU850", selector: { param: "UGRD", level: "850 mb" } },
          { key: "windV850", selector: { param: "VGRD", level: "850 mb" } },
          { key: "temp700", selector: { param: "TMP", level: "700 mb" } },
          { key: "windU700", selector: { param: "UGRD", level: "700 mb" } },
          { key: "windV700", selector: { param: "VGRD", level: "700 mb" } },
        ],
        anySourceKeyGroups: [],
        required: false,
      },
    ],
  });
  const plan = buildDerivedDecodePlan({
    selection,
    restoredGrids: restoredGrids(["lapseRate0to3km"]),
    cellCount: 1,
  });

  assert.equal(plan.valid, true);
  for (const level of [850, 700]) {
    const heightKey = `profileHgt${level}`;
    assert.ok(ownerTokens(selection, heightKey).includes("frontogenesis850:support"));
    assert.ok(plan.retainedDecodeKeys.includes(heightKey));
    assert.equal(plan.omittedDecodeKeys.includes(heightKey), false);
  }
});

test("source and global support ownership remain live while satisfied profile-only inputs can be omitted", () => {
  const selection = selectNoaaNamParameterRecords(
    [gribRecord(1, "TMP", "2 m above ground"), gribRecord(2, "TMP", "925 mb"), gribRecord(3, "HGT", "500 mb")],
    {
      catalog: [
        {
          ...profileDerived("dcape", ["TMP"], [925]),
          sourceSelectors: [
            {
              key: "temperature2m",
              selector: { param: "TMP", level: "2 m above ground" },
            },
          ],
        },
      ],
    },
  );
  const plan = buildDerivedDecodePlan({
    selection,
    restoredGrids: restoredGrids(["dcape"]),
    cellCount: 1,
  });

  assert.equal(plan.valid, true);
  assert.deepEqual(ownerTokens(selection, "temperature2m"), ["dcape:source"]);
  assert.deepEqual(ownerTokens(selection, "height500"), ["$selection-support:support"]);
  assert.ok(plan.retainedDecodeKeys.includes("temperature2m"));
  assert.ok(plan.retainedDecodeKeys.includes("height500"));
  assert.ok(plan.omittedDecodeKeys.includes("profileTmp925"));
});

test("non-sidecar winter profile owners are valid and always retain their shared raw rows", () => {
  const temperature925 = gribRecord(1, "TMP", "925 mb");
  const selection = selectNoaaNamParameterRecords([temperature925], {
    catalog: [profileDerived("dcape", ["TMP"], [925]), profileDerived("snowKuchera", ["TMP"], [925])],
  });
  const plan = buildDerivedDecodePlan({
    selection,
    restoredGrids: restoredGrids(["dcape"]),
    cellCount: 1,
  });

  assert.equal(plan.valid, true);
  assert.deepEqual(plan.expectedProfileGridNames, ["dcape"]);
  assert.deepEqual(ownerTokens(selection, "profileTmp925"), ["dcape:profile", "snowKuchera:profile"]);
  assert.ok(plan.retainedDecodeKeys.includes("profileTmp925"));
  assert.equal(plan.omittedDecodeKeys.includes("profileTmp925"), false);
});

test("unavailable staged catalog entries leave neither selected records nor dependency edges", () => {
  const selection = selectNoaaNamParameterRecords([gribRecord(1, "TMP", "925 mb")], {
    catalog: [profileDerived("dcape", ["TMP", "HGT"], [925])],
  });

  assert.deepEqual(selection.availableParameters, []);
  assert.equal(selection.records.profileTmp925, undefined);
  assert.equal(
    selection.decodeDependencies.records.some((record) => record.key === "profileTmp925"),
    false,
  );
});

test("expected restored roster uses emitted grid names and requires every satisfier", () => {
  const temperature925 = gribRecord(1, "TMP", "925 mb");
  const selection = selectNoaaNamParameterRecords([temperature925], {
    catalog: [
      profileDerived("supercellCompositeParameter", ["TMP"], [925]),
      profileDerived("significantTornadoParameter", ["TMP"], [925]),
    ],
  });

  assert.deepEqual(expectedProfileGridNamesForSelection(selection), ["bulkShear0to6km", "effectiveBulkShear"]);
  const partial = buildDerivedDecodePlan({
    selection,
    restoredGrids: restoredGrids(["effectiveBulkShear"]),
    cellCount: 1,
  });
  assert.equal(partial.valid, false);
  assert.equal(partial.failClosedReason, "restored-grid-roster-mismatch");
  assert.deepEqual(partial.omittedDecodeKeys, []);

  const wrongCellCount = buildDerivedDecodePlan({
    selection,
    restoredGrids: {
      bulkShear0to6km: new Float32Array(2),
      effectiveBulkShear: new Float32Array(2),
    },
    cellCount: 1,
  });
  assert.equal(wrongCellCount.valid, false);
  assert.equal(wrongCellCount.failClosedReason, "missing-restored-grids");
  assert.equal(
    buildDerivedDecodePlan({
      selection,
      restoredGrids: restoredGrids(["bulkShear0to6km", "effectiveBulkShear"]),
    }).failClosedReason,
    "invalid-cell-count",
  );

  const complete = buildDerivedDecodePlan({
    selection,
    restoredGrids: restoredGrids(["bulkShear0to6km", "effectiveBulkShear"]),
    cellCount: 1,
  });
  assert.equal(complete.valid, true);
  assert.deepEqual(complete.omittedDecodeKeys, ["profileTmp925"]);
  assert.equal(applyDerivedDecodePlan(selection, { ...complete, cellCount: 2 }, 1), selection);
});

test("stale plans and tampered dependency identity fail closed", () => {
  const { records, catalog } = pressureProfileFixture();
  const selection = selectNoaaNamParameterRecords(records, { catalog });
  const plan = buildDerivedDecodePlan({
    selection,
    restoredGrids: restoredGrids(["dcape"]),
    cellCount: 1,
  });
  const stalePlan = { ...plan, identity: "0".repeat(64) };
  assert.equal(applyDerivedDecodePlan(selection, stalePlan), selection);

  const tampered = {
    ...selection,
    decodeDependencies: {
      ...selection.decodeDependencies,
      records: selection.decodeDependencies.records.map((record) =>
        record.key === "profileTmp925"
          ? {
              ...record,
              owners: [{ product: "dcape", role: "mystery" }],
            }
          : record,
      ),
    },
  };
  tampered.decodeDependencies.selectionIdentity = selectionDecodeDependencyIdentity(tampered);
  const rejected = buildDerivedDecodePlan({
    selection: tampered,
    restoredGrids: restoredGrids(["dcape"]),
    cellCount: 1,
  });
  assert.equal(rejected.valid, false);
  assert.equal(rejected.failClosedReason, "unknown-dependency-role");
  assert.deepEqual(rejected.omittedDecodeKeys, []);

  const unknownProduct = {
    ...selection,
    decodeDependencies: {
      ...selection.decodeDependencies,
      records: selection.decodeDependencies.records.map((record) =>
        record.key === "profileTmp925"
          ? {
              ...record,
              owners: [{ product: "futureUnknownProduct", role: "profile" }],
            }
          : record,
      ),
    },
  };
  unknownProduct.decodeDependencies.selectionIdentity = selectionDecodeDependencyIdentity(unknownProduct);
  const unknownProductPlan = buildDerivedDecodePlan({
    selection: unknownProduct,
    restoredGrids: restoredGrids(["dcape"]),
    cellCount: 1,
  });
  assert.equal(unknownProductPlan.valid, false);
  assert.equal(unknownProductPlan.failClosedReason, "unknown-dependency-product");

  const missingIdentity = {
    ...selection,
    decodeDependencies: {
      ...selection.decodeDependencies,
      selectionIdentity: null,
    },
  };
  assert.equal(
    buildDerivedDecodePlan({
      selection: missingIdentity,
      restoredGrids: restoredGrids(["dcape"]),
      cellCount: 1,
    }).valid,
    false,
  );
});

test("selection identity and sorted dependency output are deterministic across record order", () => {
  const { records, catalog } = pressureProfileFixture();
  const forward = selectNoaaNamParameterRecords(records, { catalog });
  const reverse = selectNoaaNamParameterRecords([...records].reverse(), { catalog });

  assert.equal(forward.decodeDependencies.selectionIdentity, reverse.decodeDependencies.selectionIdentity);
  assert.deepEqual(forward.decodeDependencies, reverse.decodeDependencies);
  assert.deepEqual(
    forward.decodeDependencies.records.map((record) => record.key),
    [...forward.decodeDependencies.records.map((record) => record.key)].sort(),
  );
});

test("post-selection byte-range repair does not invalidate immutable decode dependency identity", () => {
  const { records, catalog } = pressureProfileFixture();
  const selection = selectNoaaNamParameterRecords(records, { catalog });
  const identity = selection.decodeDependencies.selectionIdentity;
  for (const selectedRecord of Object.values(selection.records)) {
    selectedRecord.rangeHeader = `bytes=${selectedRecord.offset}-${selectedRecord.offset + 999}`;
    selectedRecord.endExclusive = selectedRecord.offset + 1000;
    selectedRecord.byteLength = 1000;
  }

  assert.equal(selectionDecodeDependencyIdentity(selection), identity);
  const plan = buildDerivedDecodePlan({
    selection,
    restoredGrids: restoredGrids(["dcape"]),
    cellCount: 1,
  });
  assert.equal(plan.valid, true);
  assert.ok(plan.omittedDecodeKeys.includes("profileTmp925"));
});
