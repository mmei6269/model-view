"use strict";

// A catalog entry that is model-inapplicable (its `models` list excludes the
// build's model) is definitionally not produced for that model — it must land
// in missingOptionalParameters, never in missingRequired, which hard-fails
// the build with an error naming records that were never expected.

const assert = require("node:assert/strict");
const test = require("node:test");
const { selectNoaaNamParameterRecords } = require("../scripts/lib/noaa-beta/selection");

const REQUIRED_RESTRICTED_ENTRY = {
  key: "hrrrOnlyRequired",
  label: "HRRR-only required probe",
  required: true,
  models: ["hrrr"],
  selector: { param: "REFC", level: "entire atmosphere" },
};

test("a required, model-inapplicable entry is not counted as missing required", () => {
  const selection = selectNoaaNamParameterRecords([], {
    catalog: [REQUIRED_RESTRICTED_ENTRY],
    modelKey: "gfs",
  });
  assert.deepEqual(
    selection.missingRequired.filter((key) => key === "hrrrOnlyRequired"),
    [],
    "inapplicable entries must not hard-fail excluded models",
  );
  assert.ok(selection.missingOptionalParameters.includes("hrrrOnlyRequired"));
});

test("a required, applicable entry with absent records still fails closed (engagement control)", () => {
  const selection = selectNoaaNamParameterRecords([], {
    catalog: [REQUIRED_RESTRICTED_ENTRY],
    modelKey: "hrrr",
  });
  assert.ok(
    selection.missingRequired.includes("hrrrOnlyRequired"),
    "applicable-but-absent required entries must stay fatal",
  );
});
