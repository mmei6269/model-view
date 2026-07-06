# Render Control Panel + Point-Sounding Prefetch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an in-app "Render" control panel that triggers selective NOAA builds (pick models/runs, toggle 7 parameter categories, choose simple/full compute tier for severe+winter) plus a point-sounding GRIB prefetch (CLI + UI), so an analyst renders only what they need and hover soundings are instant.

**Architecture:** One additive catalog-metadata layer (`category`/`costTier` per parameter, one source of truth) → a selection filter at the renderer's single product choke point + gating of the renderMode-branched derived builders → new CLI flags + a standalone prefetch script → localhost-only POST action endpoints on the artifact server that spawn the builder as a child process with a job registry → a `RenderMenu` drawer in the React header. Spec: `docs/superpowers/specs/2026-07-03-render-control-panel-design.md`.

**Tech Stack:** Node 22 CJS (catalog/builder/server); React 19 + TypeScript + Vite + Tailwind + Leaflet (UI); node:test + assert (server/catalog tests); Playwright 1.52 (UI tests, fixture cache). No new frameworks.

## Global Constraints

- EXACTNESS: a no-flags / full-selection / all-categories-full-tier build MUST stay byte-identical to today's output. Selection only ever OMITS products; it never approximates. Every renderer-touching task verifies the full-selection default holds byte parity (golden-frame protocol: build 1–2 frames with NO selection flags before/after, `cmp` all artifacts except `*.complete.json` and the additive manifest `renderSelection` field).
- The additive manifest `renderSelection` field is the ONLY permitted default-build manifest change; PNG/hover/synoptic artifact bytes stay identical.
- costTier is an AUTHORED set `FULL_TIER_KEYS` of exactly 6 keys: `snowRfConus`, `snowWesternLinear`, `snowCobb`, `effectiveLayerSupercellCompositeParameter`, `effectiveLayerSignificantTornadoParameter`, `dcape`. `snowKuchera` is `simple` (owner exception — widely used, cheaper than ML/Cobb). The set is the source of truth; the heuristic is documented rationale only. Do NOT implement a pure heuristic (it would wrongly flag Kuchera as full).
- 7 categories: `surface, precip, radar, cloud, severe, winter, upperAir`. Only `severe` and `winter` carry a simple/full tier.
- Defaults: all categories on, both tiers `full` (a default render == today's complete product set).
- Persist the render selection in localStorage, following `config/display.ts`/`config/timezone.ts`.
- PUBLIC-MIRROR: never delete/rename palette/scale exports or generated palette JSONs.
- Server security: bind `127.0.0.1` only; GET routes stay read-only; mutations are POST; spawn with an argv ARRAY (`shell:false`), never a shell string; validate `model`/`run`/`view` with the existing `isSafePathComponent` allowlist and `category`/`tier` against the fixed enums; 400 on bad input, 405 on wrong method. No auto-build.
- Point-sounding prefetch caches RAW selected-GRIB fields only — NEVER precompute parcel diagnostics at build time (plan.md durable decision). Point soundings are not under artifact byte-parity.
- Test conventions: node:test for `scripts/**` + catalog (`node --test tests-node/<file>`); Playwright for `next/src/**`. Prettier (printWidth 120) clean on touched files. Every commit message ends with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Prerequisites once: `npm install`, `npm run install:browsers`.
- Anchor drift: quoted "existing code" is as of branch `app-completion` HEAD at authoring time. Re-locate any anchor semantically if line numbers have shifted; if the CONTENT differs, stop and report BLOCKED. Complete phases in order (later phases consume earlier phases' exports).
- Work on branch `app-completion`.

Phases A→E complete in order. Task ids are `<phase>.<n>` as written.

---


## Phase A: Catalog metadata (foundation, no behavior change)

## Phase A — Catalog metadata (foundation, NO renderer/behavior change)

> **Scope note (read first):** Phase A only stamps two additive fields (`category`, `costTier`) onto each catalog entry and surfaces them in `getNoaaNamParameterMetadata()`. This changes the manifest `parameters` JSON (two new fields per entry, appended — no reordering, no deletions), which is intentional and safe for all existing consumers. **Phase A does NOT touch renderer PNG/artifact output**, so the golden-frame byte-parity protocol does NOT apply here (no PNG changes to cmp). Do not run a full golden-frame build for Phase A. The exactness gate begins at Phase B.

> **Cost-tier design (spec §1.2/§1.3, owner decision 1, locked 2026-07-03 in commit ec2a192):** `costTier` is an **explicit owner-authored set of "full-only" keys**, NOT a pure heuristic. `FULL_TIER_KEYS` contains **exactly 6 keys**: `snowRfConus`, `snowWesternLinear`, `snowCobb`, `effectiveLayerSupercellCompositeParameter`, `effectiveLayerSignificantTornadoParameter`, `dcape`. **`snowKuchera` stays `simple`** even though it has a deep (21-level) profile — the owner keeps Kuchera in the simple winter tier because it is widely used and cheaper than the ML/Cobb products. The heuristic (`artifactRequired` OR deep >6-level profile OR sparse-parcel/DCAPE methodVersion) is the *documented default rationale* for any future product, but the authored set is the source of truth so the Kuchera exception is a one-line omission, not a heuristic fight. Do NOT implement a pure heuristic — it would wrongly flag `snowKuchera` as full and reverse the owner decision.

### Task A.1: Stamp `category` + `costTier` on every catalog entry and surface in metadata
**Files:**
- Modify: `/Users/micha/Development/model-view/scripts/lib/noaa-nam-parameter-catalog.js` — add group constants block after line 18, add `GROUP_TO_CATEGORY` + `FULL_TIER_KEYS` + `deriveCostTier` helpers, edit `freezeEntry` (lines 2102-2104), edit `getNoaaNamParameterMetadata` (lines 1322-1331), extend `module.exports` (lines 2129-2140).
- Test: `/Users/micha/Development/model-view/tests-node/noaa-nam-parameter-catalog-category.test.js` (create)

**Interfaces:**
- Produces (server, CJS): `GROUP_TO_CATEGORY: Readonly<Record<string,string>>` (9 group strings -> 7 category ids), exported from the catalog module. `RENDER_CATEGORY_IDS: readonly string[]` = `["surface","precip","radar","cloud","severe","winter","upperAir"]`, exported. Every frozen catalog entry gains `entry.category: string` (one of the 7) and `entry.costTier: "simple"|"full"`. `getNoaaNamParameterMetadata()[key]` gains `category` and `costTier`. Phase B (`selectionAllows`) and Phase C (CLI validation) consume `RENDER_CATEGORY_IDS` and `entry.category`/`entry.costTier`. Phase A.2 consumes `GROUP_TO_CATEGORY`. `deriveCostTier(entry)` (module-internal helper, not exported) — `"full"` iff `entry.key` is in the authored `FULL_TIER_KEYS` set, else `"simple"`.

- [ ] **Step 1: Write the failing test** — create `/Users/micha/Development/model-view/tests-node/noaa-nam-parameter-catalog-category.test.js`:
```js
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  NOAA_NAM_PARAMETER_CATALOG,
  GROUP_TO_CATEGORY,
  RENDER_CATEGORY_IDS,
  getNoaaNamParameterMetadata,
} = require("../scripts/lib/noaa-nam-parameter-catalog.js");

const VALID_CATEGORIES = new Set(["surface", "precip", "radar", "cloud", "severe", "winter", "upperAir"]);

// Locked owner cuts (spec §1.2, decision 1, commit ec2a192): the authored full-tier set is
// EXACTLY these 6 keys. Severe simple drops effective SCP/STP AND dcape; winter simple drops
// only the three ML/Cobb SLR products (RF, Western-Linear, Cobb) and KEEPS Kuchera. Verified
// against the real catalog on app-completion.
const FULL_TIER_KEYS = [
  "snowRfConus",
  "snowWesternLinear",
  "snowCobb",
  "effectiveLayerSupercellCompositeParameter",
  "effectiveLayerSignificantTornadoParameter",
  "dcape",
];
const SIMPLE_TIER_KEYS = [
  "snowKuchera", // owner exception: deep profile but stays simple (decision 1)
  "bulkShear0to6km",
  "supercellCompositeParameter",
  "significantTornadoParameter",
  "effectiveBulkShear",
  "lapseRate0to3km",
  "snow10to1",
  "wetBulbZeroHeight",
  "surfaceThetaE",
  "surfaceBasedLclHeight",
  "sbcape",
  "srh0to3km",
];

test("RENDER_CATEGORY_IDS is exactly the 7 owner categories", () => {
  assert.deepEqual([...RENDER_CATEGORY_IDS], ["surface", "precip", "radar", "cloud", "severe", "winter", "upperAir"]);
});

test("GROUP_TO_CATEGORY maps every catalog group to a valid category", () => {
  const groups = new Set(NOAA_NAM_PARAMETER_CATALOG.map((entry) => entry.group));
  for (const group of groups) {
    assert.ok(Object.prototype.hasOwnProperty.call(GROUP_TO_CATEGORY, group), `no mapping for group ${group}`);
    assert.ok(VALID_CATEGORIES.has(GROUP_TO_CATEGORY[group]), `group ${group} maps to invalid category ${GROUP_TO_CATEGORY[group]}`);
  }
});

test("every catalog entry gets a valid category from the 7", () => {
  for (const entry of NOAA_NAM_PARAMETER_CATALOG) {
    assert.ok(VALID_CATEGORIES.has(entry.category), `entry ${entry.key} has invalid category ${entry.category}`);
  }
});

test("category is exactly GROUP_TO_CATEGORY of the entry group", () => {
  for (const entry of NOAA_NAM_PARAMETER_CATALOG) {
    assert.equal(entry.category, GROUP_TO_CATEGORY[entry.group], `entry ${entry.key} category mismatch`);
  }
});

test("named full-tier keys are costTier full", () => {
  const byKey = new Map(NOAA_NAM_PARAMETER_CATALOG.map((entry) => [entry.key, entry]));
  for (const key of FULL_TIER_KEYS) {
    const entry = byKey.get(key);
    assert.ok(entry, `expected catalog to contain ${key}`);
    assert.equal(entry.costTier, "full", `${key} should be full tier`);
  }
});

test("named simple-tier keys are costTier simple (incl. the Kuchera exception)", () => {
  const byKey = new Map(NOAA_NAM_PARAMETER_CATALOG.map((entry) => [entry.key, entry]));
  for (const key of SIMPLE_TIER_KEYS) {
    const entry = byKey.get(key);
    assert.ok(entry, `expected catalog to contain ${key}`);
    assert.equal(entry.costTier, "simple", `${key} should be simple tier`);
  }
});

test("snowKuchera is explicitly simple despite its deep profile", () => {
  const kuchera = NOAA_NAM_PARAMETER_CATALOG.find((entry) => entry.key === "snowKuchera");
  assert.ok(kuchera, "expected catalog to contain snowKuchera");
  assert.ok(kuchera.profileLevels && kuchera.profileLevels.length > 6, "guard: Kuchera has a deep profile the bare heuristic would flag");
  assert.equal(kuchera.costTier, "simple", "owner decision 1: Kuchera stays simple");
});

test("exactly the six authored keys are full tier", () => {
  const fullKeys = NOAA_NAM_PARAMETER_CATALOG.filter((entry) => entry.costTier === "full").map((entry) => entry.key).sort();
  assert.deepEqual(fullKeys, [...FULL_TIER_KEYS].sort());
});

test("metadata surfaces category and costTier for every entry", () => {
  const metadata = getNoaaNamParameterMetadata();
  for (const entry of NOAA_NAM_PARAMETER_CATALOG) {
    if (entry.hidden) {
      continue;
    }
    const meta = metadata[entry.key];
    assert.ok(meta, `metadata missing ${entry.key}`);
    assert.equal(meta.category, entry.category, `metadata category mismatch for ${entry.key}`);
    assert.equal(meta.costTier, entry.costTier, `metadata costTier mismatch for ${entry.key}`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails** — `cd /Users/micha/Development/model-view && node --test tests-node/noaa-nam-parameter-catalog-category.test.js`. Expected failure: import throws / `undefined` because `GROUP_TO_CATEGORY` and `RENDER_CATEGORY_IDS` are not exported yet, and `entry.category`/`entry.costTier` are `undefined`.

- [ ] **Step 3: Write minimal implementation** — four edits in `/Users/micha/Development/model-view/scripts/lib/noaa-nam-parameter-catalog.js`.

**Edit 3a — add category mapping + authored cost-tier set + helper.** After the group constant block (immediately after line 18, `const UPPER_AIR_DIAGNOSTIC_GROUP = "Upper Air: Omega / Vorticity";`), insert:
```js

// Render-panel taxonomy: the 9 catalog groups collapse to 7 owner build/compute categories.
// Severe thermo+kinematics merge; the two upper-air groups merge. WIND_GROUP is an alias of
// SURFACE_GROUP so it needs no separate entry.
const RENDER_CATEGORY_IDS = Object.freeze(["surface", "precip", "radar", "cloud", "severe", "winter", "upperAir"]);
const GROUP_TO_CATEGORY = Object.freeze({
  [SURFACE_GROUP]: "surface",
  [PRECIP_GROUP]: "precip",
  [RADAR_GROUP]: "radar",
  [CLOUD_GROUP]: "cloud",
  [SEVERE_THERMO_GROUP]: "severe",
  [SEVERE_KINEMATICS_GROUP]: "severe",
  [WINTER_GROUP]: "winter",
  [UPPER_AIR_GROUP]: "upperAir",
  [UPPER_AIR_DIAGNOSTIC_GROUP]: "upperAir",
});

// costTier gates the two tiered families (severe, winter). It is an AUTHORED owner-decided set
// (spec §1.2/§1.3, owner decision 1) — NOT a pure heuristic — so product calls like "keep
// Kuchera" are explicit one-line entries. "full" marks the six products the "simple" tier omits:
// the three ML/Cobb winter SLR models and the three parcel-integration severe products (effective
// SCP/STP + DCAPE). Everything else — including snowKuchera, which has a deep profile a bare
// heuristic would flag as full — is "simple".
//
// Documented default rationale for any FUTURE product (not applied automatically): a product is a
// full-tier candidate if it needs a downloaded artifact, reads a deep (>6-level) pressure profile,
// or does sparse effective-layer / DCAPE parcel work. New heavy products should be added to
// FULL_TIER_KEYS deliberately (the "exactly the six authored keys are full tier" test tripwires
// any drift), keeping the owner in control of the compute-cost cut.
const FULL_TIER_KEYS = Object.freeze(
  new Set([
    "snowRfConus",
    "snowWesternLinear",
    "snowCobb",
    "effectiveLayerSupercellCompositeParameter",
    "effectiveLayerSignificantTornadoParameter",
    "dcape",
  ]),
);

function deriveCostTier(entry) {
  return FULL_TIER_KEYS.has(entry.key) ? "full" : "simple";
}
```

**Edit 3b — stamp the fields in `freezeEntry`.** Replace (lines 2102-2104):
```js
function freezeEntry(entry) {
  return Object.freeze({
    ...entry,
```
with:
```js
function freezeEntry(entry) {
  return Object.freeze({
    ...entry,
    category: GROUP_TO_CATEGORY[entry.group] || "surface",
    costTier: deriveCostTier(entry),
```
(The `|| "surface"` fallback never triggers for the shipped catalog — every group is mapped — but keeps `freezeEntry` total if a future group is added before its mapping; the A.2 parity test would then fail loudly on the missing mapping.)

**Edit 3c — surface both in metadata.** In `getNoaaNamParameterMetadata` replace the per-entry object literal (lines 1322-1331):
```js
    out[entry.key] = {
      key: entry.key,
      label: entry.label,
      unit: entry.unit,
      group: entry.group,
      thresholdNote: entry.thresholdNote || scale.thresholdNote || null,
      legendTicks: [...(scale.legendTicks || [])],
      legendTickPositions: buildLegendTickPositions(scale),
      legendStops: stops,
    };
```
with:
```js
    out[entry.key] = {
      key: entry.key,
      label: entry.label,
      unit: entry.unit,
      group: entry.group,
      category: entry.category,
      costTier: entry.costTier,
      thresholdNote: entry.thresholdNote || scale.thresholdNote || null,
      legendTicks: [...(scale.legendTicks || [])],
      legendTickPositions: buildLegendTickPositions(scale),
      legendStops: stops,
    };
```

**Edit 3d — export the new symbols.** Replace the `module.exports` block (lines 2129-2140):
```js
module.exports = {
  NOAA_NAM_PARAMETER_CATALOG,
  NOAA_NAM_PARAMETER_ORDER,
  SCALES,
  SNOW_PROFILE_LEVELS,
  EFFECTIVE_LAYER_PROFILE_LEVELS,
  KUCHERA_PROFILE_LEVELS,
  COBB_PROFILE_LEVELS,
  SUPPORT_SELECTORS,
  getNoaaNamParameterMetadata,
  getNoaaNamParameterOrder,
};
```
with:
```js
module.exports = {
  NOAA_NAM_PARAMETER_CATALOG,
  NOAA_NAM_PARAMETER_ORDER,
  SCALES,
  SNOW_PROFILE_LEVELS,
  EFFECTIVE_LAYER_PROFILE_LEVELS,
  KUCHERA_PROFILE_LEVELS,
  COBB_PROFILE_LEVELS,
  SUPPORT_SELECTORS,
  GROUP_TO_CATEGORY,
  RENDER_CATEGORY_IDS,
  getNoaaNamParameterMetadata,
  getNoaaNamParameterOrder,
};
```

- [ ] **Step 4: Run test to verify it passes** — `cd /Users/micha/Development/model-view && node --test tests-node/noaa-nam-parameter-catalog-category.test.js`. Expected: all tests pass (`# fail 0`). In particular `snowKuchera` must resolve `simple` and exactly 6 keys must be `full`. Also run the existing catalog-dependent suite to confirm no regression: `node --test tests-node/noaa-beta.test.js` — expected all pass (the two new metadata fields are additive; no existing assertion reads a fixed key count).

- [ ] **Step 5: Commit** — `cd /Users/micha/Development/model-view && git add scripts/lib/noaa-nam-parameter-catalog.js tests-node/noaa-nam-parameter-catalog-category.test.js && git commit -m "Stamp render category and cost tier on NOAA parameter catalog

Add GROUP_TO_CATEGORY (9 groups -> 7 owner categories) and an authored
FULL_TIER_KEYS costTier set (the 3 ML/Cobb winter SLR models + the 3 severe
parcel-integration products; Kuchera stays simple per owner decision 1).
Surface both additive fields in getNoaaNamParameterMetadata so builder and UI
share one source.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`

---

### Task A.2: Client `GROUP_TO_CATEGORY` mirror + drift-guard parity test

**Decision (lowest-drift option, justified):** The render panel must build its category tree *before any run/manifest is chosen* (the user picks models/categories first), and for parameters that only have `layers.ts` fallbacks. So the client needs its own `GROUP_TO_CATEGORY` keyed by the 9 group strings. We do **not** import the server CJS catalog into the browser bundle — it pulls in `color-maps`/`fs`/JSON-loading deps and would bloat/break the Vite/Next client build. Nor do we deep-mirror per-key `category` (that would be a 79-row table needing constant sync). A group-keyed map is a 9-row table that changes only when a catalog *group* is added/renamed (rare). The parity test guards it by transpiling the tiny client TS module with the already-installed `esbuild` inside a node:test and asserting it equals the server `GROUP_TO_CATEGORY` — one authoritative comparison, no second per-key table. (Note: A.2 mirrors only `GROUP_TO_CATEGORY`/`RENDER_CATEGORY_IDS`, which are tier-independent — the Kuchera cost-tier decision lives entirely server-side and never crosses into this client mirror.)

**Files:**
- Create: `/Users/micha/Development/model-view/next/src/config/renderCategories.ts`
- Test: `/Users/micha/Development/model-view/tests-node/render-category-client-parity.test.js` (create)

**Interfaces:**
- Consumes: `GROUP_TO_CATEGORY`, `RENDER_CATEGORY_IDS` from `scripts/lib/noaa-nam-parameter-catalog.js` (Task A.1).
- Produces (client, TS): `renderCategories.ts` exports `RENDER_CATEGORY_IDS: readonly RenderCategoryId[]`, type `RenderCategoryId = "surface"|"precip"|"radar"|"cloud"|"severe"|"winter"|"upperAir"`, `GROUP_TO_CATEGORY: Readonly<Record<string, RenderCategoryId>>`, and `groupToRenderCategory(group: string | null | undefined): RenderCategoryId | null`. Phase E (`RenderMenu.tsx`, cost-hint) consumes these.

- [ ] **Step 1: Write the failing test** — create `/Users/micha/Development/model-view/tests-node/render-category-client-parity.test.js`:
```js
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const esbuild = require("esbuild");
const {
  GROUP_TO_CATEGORY: SERVER_GROUP_TO_CATEGORY,
  RENDER_CATEGORY_IDS: SERVER_CATEGORY_IDS,
} = require("../scripts/lib/noaa-nam-parameter-catalog.js");

// Transpile the client-side TS mirror with esbuild (already a dependency) and evaluate it in a
// throwaway CJS module context so the node test can read the exact map the browser bundle ships.
function loadClientModule() {
  const source = fs.readFileSync(path.join(__dirname, "..", "next", "src", "config", "renderCategories.ts"), "utf8");
  const { code } = esbuild.transformSync(source, { loader: "ts", format: "cjs" });
  const moduleShim = { exports: {} };
  const fn = new vm.Script(`(function (module, exports, require) { ${code}\n})`).runInThisContext();
  fn(moduleShim, moduleShim.exports, require);
  return moduleShim.exports;
}

test("client GROUP_TO_CATEGORY matches the server catalog exactly", () => {
  const client = loadClientModule();
  assert.deepEqual(client.GROUP_TO_CATEGORY, { ...SERVER_GROUP_TO_CATEGORY });
});

test("client RENDER_CATEGORY_IDS matches the server order", () => {
  const client = loadClientModule();
  assert.deepEqual([...client.RENDER_CATEGORY_IDS], [...SERVER_CATEGORY_IDS]);
});

test("groupToRenderCategory returns the mapped category and null for unknown groups", () => {
  const client = loadClientModule();
  for (const [group, category] of Object.entries(SERVER_GROUP_TO_CATEGORY)) {
    assert.equal(client.groupToRenderCategory(group), category);
  }
  assert.equal(client.groupToRenderCategory("Not A Real Group"), null);
  assert.equal(client.groupToRenderCategory(null), null);
  assert.equal(client.groupToRenderCategory(undefined), null);
});
```

- [ ] **Step 2: Run test to verify it fails** — `cd /Users/micha/Development/model-view && node --test tests-node/render-category-client-parity.test.js`. Expected failure: `ENOENT` reading `next/src/config/renderCategories.ts` (file does not exist yet).

- [ ] **Step 3: Write minimal implementation** — create `/Users/micha/Development/model-view/next/src/config/renderCategories.ts`:
```ts
// Client mirror of the server catalog's render taxonomy (scripts/lib/noaa-nam-parameter-catalog.js:
// GROUP_TO_CATEGORY / RENDER_CATEGORY_IDS). The render panel builds its category tree before any
// manifest is loaded, so it cannot rely on per-parameter metadata alone; it keys off the group
// string. Guarded against drift by tests-node/render-category-client-parity.test.js, which
// transpiles this module and asserts it equals the server map. (Cost-tier / FULL_TIER_KEYS lives
// server-side only and is intentionally NOT mirrored here.)

export type RenderCategoryId = "surface" | "precip" | "radar" | "cloud" | "severe" | "winter" | "upperAir";

export const RENDER_CATEGORY_IDS: readonly RenderCategoryId[] = [
  "surface",
  "precip",
  "radar",
  "cloud",
  "severe",
  "winter",
  "upperAir",
];

export const GROUP_TO_CATEGORY: Readonly<Record<string, RenderCategoryId>> = {
  "Surface & Boundary Layer": "surface",
  Precipitation: "precip",
  Radar: "radar",
  "Clouds & Ceiling": "cloud",
  "Severe: Thermodynamics": "severe",
  "Severe: Kinematics": "severe",
  "Winter / Snow & Ice": "winter",
  "Upper Air: Height / Wind / Temp": "upperAir",
  "Upper Air: Omega / Vorticity": "upperAir",
};

export function groupToRenderCategory(group: string | null | undefined): RenderCategoryId | null {
  if (!group) {
    return null;
  }
  return GROUP_TO_CATEGORY[group] ?? null;
}
```
(Note: `Precipitation` and `Radar` are written as bare identifiers, valid unquoted JS keys; esbuild emits them as quoted keys so the `deepEqual` against the server object — whose keys are the group strings `"Precipitation"`/`"Radar"` — matches. `deepEqual` is order-insensitive for object keys anyway.)

- [ ] **Step 4: Run test to verify it passes** — `cd /Users/micha/Development/model-view && node --test tests-node/render-category-client-parity.test.js`. Expected: all 3 tests pass. Also typecheck the new client file: `cd /Users/micha/Development/model-view/next && npx tsc --noEmit` — expected no new errors from `src/config/renderCategories.ts`.

- [ ] **Step 5: Commit** — `cd /Users/micha/Development/model-view && git add next/src/config/renderCategories.ts tests-node/render-category-client-parity.test.js && git commit -m "Add client render-category mirror with server parity guard

Mirror GROUP_TO_CATEGORY on the client so the render panel can build its
category tree before a manifest loads. A node parity test transpiles the TS
mirror with esbuild and asserts equality with the server catalog map,
guarding the two tables against drift.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`


## Phase B: Builder selectivity

## Phase B — Builder selectivity (backend)

> **Dependency on Phase A (contract).** Phase A (not yet committed on `app-completion`; HEAD is `ec2a192`, which is the design spec + the Kuchera owner-decision doc edit, NOT the catalog change) stamps two frozen properties on every `NOAA_NAM_PARAMETER_CATALOG` entry via `freezeEntry` and exports a group→category map:
> - `entry.category`: one of `"surface" | "precip" | "radar" | "cloud" | "severe" | "winter" | "upperAir"`.
> - `entry.costTier`: `"simple" | "full"`. Per spec §1.3, `costTier === "full"` iff the key is in an **authored** `FULL_TIER_KEYS` set — exactly the 6 keys `snowRfConus`, `snowWesternLinear`, `snowCobb`, `effectiveLayerSupercellCompositeParameter`, `effectiveLayerSignificantTornadoParameter`, `dcape` — else `"simple"`. The set is the source of truth, not a heuristic; `snowKuchera` is deliberately `simple` (owner exception, commit `ec2a192`) even though its deep profile would make a bare heuristic call it `full`.
> - `noaa-nam-parameter-catalog.js` additionally exports `GROUP_TO_CATEGORY` (a plain object mapping the 9 group strings to the 7 category ids) and `RENDER_CATEGORY_IDS` (frozen array of the 7 ids in canonical order: `["surface","precip","radar","cloud","severe","winter","upperAir"]`), and `getNoaaNamParameterMetadata()` surfaces `category`+`costTier` per key. (Verified on disk: today `getNoaaNamParameterMetadata` at catalog line 1314 surfaces only `entry.group`; `freezeEntry` at line 2102 does not stamp category/costTier yet — Phase A must land first or B's tests error at import.)
>
> Phase B consumes `entry.category`, `entry.costTier`, `GROUP_TO_CATEGORY`, and `RENDER_CATEGORY_IDS`. If Phase A named these differently, reconcile the imports in B1 before starting — do not duplicate the group→category table here (spec §1.3: one source of truth).

---

### Task B.1: `selectionAllows` + selection-aware `filterCatalogForRenderMode`

**Files:**
- Modify `/Users/micha/Development/model-view/scripts/lib/noaa-beta/selection.js` (extend `filterCatalogForRenderMode` at lines 134-146; add `selectionAllows`, `normalizeRenderSelection`; export both)
- Test `/Users/micha/Development/model-view/tests-node/render-selection.test.js` (new)

**Interfaces:**
- Consumes (Phase A): `entry.category: string`, `entry.costTier: "simple"|"full"`, `RENDER_CATEGORY_IDS: readonly string[]` from `../noaa-nam-parameter-catalog`.
- Produces:
  - `normalizeRenderSelection(selection): { categories: Record<categoryId, { enabled: boolean, tier: "simple"|"full" }> } | null` — returns `null` for `null`/`undefined`/non-object input (the "no selection = today" sentinel).
  - `selectionAllows(selection, entry): boolean` — `true` when `selection` is nullish; otherwise `entry.category` enabled AND (`entry.costTier === "simple"` OR that category's tier is `"full"`).
  - `filterCatalogForRenderMode(catalog, renderMode, selection?)` — third arg optional; omitted/nullish ⇒ byte-identical to today's 2-arg return.

- [ ] **Step 1: Write the failing test.** Create `/Users/micha/Development/model-view/tests-node/render-selection.test.js`:
```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  NOAA_NAM_PARAMETER_CATALOG,
  RENDER_CATEGORY_IDS,
} = require("../scripts/lib/noaa-nam-parameter-catalog");
const {
  filterCatalogForRenderMode,
  selectionAllows,
  normalizeRenderSelection,
} = require("../scripts/lib/noaa-beta/selection");

// A fully-enabled, full-tier selection: the explicit form of "today".
function fullSelection() {
  const categories = {};
  for (const id of RENDER_CATEGORY_IDS) {
    categories[id] = { enabled: true, tier: "full" };
  }
  return { categories };
}

test("normalizeRenderSelection returns null for the no-selection sentinel", () => {
  assert.equal(normalizeRenderSelection(undefined), null);
  assert.equal(normalizeRenderSelection(null), null);
  assert.equal(normalizeRenderSelection("nope"), null);
});

test("selectionAllows: nullish selection allows every entry", () => {
  for (const entry of NOAA_NAM_PARAMETER_CATALOG) {
    assert.equal(selectionAllows(null, entry), true, `null should allow ${entry.key}`);
    assert.equal(selectionAllows(undefined, entry), true, `undefined should allow ${entry.key}`);
  }
});

test("no selection returns EXACTLY today's per-mode list (byte-identical default guard)", () => {
  for (const mode of ["all", "base", "snow", "snow-delta", "snow-prefix", "runmax-prefix"]) {
    const twoArg = filterCatalogForRenderMode(NOAA_NAM_PARAMETER_CATALOG, mode);
    const threeArgUndefined = filterCatalogForRenderMode(NOAA_NAM_PARAMETER_CATALOG, mode, undefined);
    const threeArgNull = filterCatalogForRenderMode(NOAA_NAM_PARAMETER_CATALOG, mode, null);
    const withFull = filterCatalogForRenderMode(NOAA_NAM_PARAMETER_CATALOG, mode, fullSelection());
    const baseKeys = twoArg.map((e) => e.key);
    assert.deepEqual(threeArgUndefined.map((e) => e.key), baseKeys, `${mode}: undefined must equal 2-arg`);
    assert.deepEqual(threeArgNull.map((e) => e.key), baseKeys, `${mode}: null must equal 2-arg`);
    assert.deepEqual(withFull.map((e) => e.key), baseKeys, `${mode}: all-on/full-tier must equal 2-arg`);
    // Same object identities, in the same order (no re-wrapping of entries).
    assert.deepEqual(threeArgUndefined, twoArg);
  }
});

test("disabling a category omits exactly that category's keys", () => {
  const sel = fullSelection();
  sel.categories.winter = { enabled: false, tier: "full" };
  const filtered = filterCatalogForRenderMode(NOAA_NAM_PARAMETER_CATALOG, "all", sel);
  assert.ok(
    filtered.every((e) => e.category !== "winter"),
    "winter entries must be gone",
  );
  const expected = NOAA_NAM_PARAMETER_CATALOG.filter((e) => e.category !== "winter").map((e) => e.key);
  assert.deepEqual(filtered.map((e) => e.key), expected);
});

test("severe simple tier keeps simple severe, drops full-only severe (dcape, effective-layer SCP/STP)", () => {
  const sel = fullSelection();
  sel.categories.severe = { enabled: true, tier: "simple" };
  const keys = new Set(filterCatalogForRenderMode(NOAA_NAM_PARAMETER_CATALOG, "all", sel).map((e) => e.key));
  for (const dropped of ["dcape", "effectiveLayerSupercellCompositeParameter", "effectiveLayerSignificantTornadoParameter"]) {
    assert.equal(keys.has(dropped), false, `${dropped} must be dropped in severe simple`);
  }
  for (const kept of ["sbcape", "srh0to1km", "bulkShear0to6km", "supercellCompositeParameter", "significantTornadoParameter"]) {
    assert.equal(keys.has(kept), true, `${kept} must be kept in severe simple`);
  }
});

test("winter simple tier drops only the 3 authored full-only snow keys, keeps Kuchera + cheap winter keys", () => {
  const sel = fullSelection();
  sel.categories.winter = { enabled: true, tier: "simple" };
  const keys = new Set(filterCatalogForRenderMode(NOAA_NAM_PARAMETER_CATALOG, "all", sel).map((e) => e.key));
  // Owner-authored FULL_TIER_KEYS winter set (spec §1.2/§1.3, commit ec2a192): 3 keys, NOT snowKuchera.
  for (const dropped of ["snowRfConus", "snowWesternLinear", "snowCobb"]) {
    assert.equal(keys.has(dropped), false, `${dropped} must be dropped in winter simple`);
  }
  // snowKuchera is the explicit owner exception: kept in simple despite its deep profile.
  for (const kept of ["snowKuchera", "snow10to1", "framFlatIce", "framRadialIce", "freezingRainLiquidTotal", "snowHrrrAsnow"]) {
    assert.equal(keys.has(kept), true, `${kept} must be kept in winter simple`);
  }
});

test("mode split composes with selection: base + winter-off still excludes winter", () => {
  const sel = fullSelection();
  sel.categories.winter = { enabled: false, tier: "full" };
  const filtered = filterCatalogForRenderMode(NOAA_NAM_PARAMETER_CATALOG, "base", sel);
  // base already drops snowfallDerived; winter-off additionally removes other winter (freezing rain) entries.
  assert.ok(filtered.every((e) => e.kind !== "snowfallDerived"));
  assert.ok(filtered.every((e) => e.category !== "winter"));
});
```

- [ ] **Step 2: Run test to verify it fails.**
```
node --test tests-node/render-selection.test.js
```
Expected: fails at import/first assertion — `selectionAllows` and `normalizeRenderSelection` are `undefined` (not yet exported), so `TypeError: selectionAllows is not a function` / the 3-arg call ignores the selection. (Also fails if Phase A `entry.category`/`entry.costTier`/`RENDER_CATEGORY_IDS` are missing — that surfaces the Phase A dependency early. If Phase A mis-stamps `snowKuchera` as `full` or `dcape` as `simple`, the tier tests fail — a useful cross-phase guard.)

- [ ] **Step 3: Write minimal implementation.**

First extend the catalog import at the top of `selection.js` (line 6). Replace:
```js
const { NOAA_NAM_PARAMETER_CATALOG, SNOW_PROFILE_LEVELS, SUPPORT_SELECTORS } = require("../noaa-nam-parameter-catalog");
```
with:
```js
const {
  NOAA_NAM_PARAMETER_CATALOG,
  RENDER_CATEGORY_IDS,
  SNOW_PROFILE_LEVELS,
  SUPPORT_SELECTORS,
} = require("../noaa-nam-parameter-catalog");
```

Then replace the whole `filterCatalogForRenderMode` function (lines 134-146):
```js
function filterCatalogForRenderMode(catalog, renderMode) {
  const list = Array.isArray(catalog) ? catalog : NOAA_NAM_PARAMETER_CATALOG;
  if (renderMode === "base") {
    return list.filter((entry) => entry.kind !== "snowfallDerived");
  }
  if (renderMode === "runmax-prefix") {
    return list.filter((entry) => Boolean(RUN_MAX_ACCUMULATION_SOURCES[entry.key]));
  }
  if (renderMode === "snow" || renderMode === "snow-delta" || renderMode === "snow-prefix") {
    return list.filter((entry) => entry.kind === "snowfallDerived");
  }
  return list;
}
```
with:
```js
// A nullish selection is the "render everything at full tier" sentinel: the
// filter must return exactly the pre-selection per-mode list so a no-flags
// build stays byte-identical to today (spec exactness constraint).
function normalizeRenderSelection(selection) {
  if (!selection || typeof selection !== "object" || !selection.categories || typeof selection.categories !== "object") {
    return null;
  }
  const categories = {};
  for (const id of RENDER_CATEGORY_IDS) {
    const raw = selection.categories[id];
    if (raw === true) {
      categories[id] = { enabled: true, tier: "full" };
    } else if (raw === false) {
      categories[id] = { enabled: false, tier: "full" };
    } else if (raw == null) {
      categories[id] = { enabled: true, tier: "full" };
    } else if (typeof raw === "object") {
      const tier = raw.tier === "simple" ? "simple" : "full";
      categories[id] = { enabled: raw.enabled !== false, tier };
    } else {
      categories[id] = { enabled: true, tier: "full" };
    }
  }
  return { categories };
}

function selectionAllows(selection, entry) {
  const normalized = selection && selection.categories ? normalizeRenderSelection(selection) : null;
  if (!normalized) {
    return true;
  }
  const category = normalized.categories[entry?.category];
  if (!category || !category.enabled) {
    return false;
  }
  if (entry?.costTier === "simple") {
    return true;
  }
  return category.tier === "full";
}

function filterCatalogForRenderMode(catalog, renderMode, selection) {
  const list = Array.isArray(catalog) ? catalog : NOAA_NAM_PARAMETER_CATALOG;
  let modeList;
  if (renderMode === "base") {
    modeList = list.filter((entry) => entry.kind !== "snowfallDerived");
  } else if (renderMode === "runmax-prefix") {
    modeList = list.filter((entry) => Boolean(RUN_MAX_ACCUMULATION_SOURCES[entry.key]));
  } else if (renderMode === "snow" || renderMode === "snow-delta" || renderMode === "snow-prefix") {
    modeList = list.filter((entry) => entry.kind === "snowfallDerived");
  } else {
    modeList = list;
  }
  const normalizedSelection = normalizeRenderSelection(selection);
  if (!normalizedSelection) {
    // Preserve object identity + order of the pre-selection path exactly.
    return modeList;
  }
  return modeList.filter((entry) => selectionAllows(normalizedSelection, entry));
}
```
> Note: when no selection is supplied `filterCatalogForRenderMode` returns the exact `modeList` (same `.filter` result / same entry object identities) as the old 2-arg code — required by the byte-identical default guard. `selectionAllows` is idempotent under re-normalization (`selectionAllows(normalizedSelection, entry)` re-normalizes a normalized object to the same shape), so calling it with an already-normalized selection is safe.

Add both new functions to the `module.exports` object (block starts at line 812), keeping alphabetical order. `filterCatalogForRenderMode` is already exported at line 830; leave it. Insert `normalizeRenderSelection,` after `normalizeRfTree,` (line 848) and `selectionAllows,` after `selectNoaaNamParameterRecords,` (line 859).

- [ ] **Step 4: Run test to verify it passes.**
```
node --test tests-node/render-selection.test.js
```
Expected: all tests pass (`# pass 8`, `# fail 0`).

- [ ] **Step 5: Commit.**
```
git add scripts/lib/noaa-beta/selection.js tests-node/render-selection.test.js && git commit -m "Add selection-aware catalog filter (selectionAllows + filterCatalogForRenderMode selection arg)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task B.2: Gate the renderMode-branched winter derived builders on the surviving catalog subset

**Files:**
- Modify `/Users/micha/Development/model-view/scripts/lib/noaa-beta-renderer.js`:
  - `renderNoaaNamBetaFrame` wrapper (signature line 219-220, forwarding body 221-239) — accept + forward `renderSelection` and `renderMode`
  - `renderNoaaGribFrame` signature (`renderMode = "all"` at line 260) — accept `renderSelection = null`
  - `selectedCatalog` build (line 302) — pass `renderSelection`
  - winter/freezing-rain builder branches (lines 508-591) — guard on the surviving categories
  - export a testable predicate `_testCatalogCategorySet`
- Test `/Users/micha/Development/model-view/tests-node/render-selection.test.js` (append; the pure-predicate part). Builder non-invocation is asserted structurally (see Step 1 rationale).

**Interfaces:**
- Consumes (B.1): `filterCatalogForRenderMode(catalog, renderMode, selection)`, `normalizeRenderSelection`.
- Consumes (Phase A): `entry.category`.
- Produces:
  - `renderNoaaGribFrame`/`renderNoaaNamBetaFrame` new option `renderSelection` (nullish ⇒ today's behavior); wrapper now also forwards `renderMode` (previously dropped).
  - Exported `_testCatalogCategorySet(catalog): Set<string>` — the set of `entry.category` values present in a filtered catalog; the renderer uses this to decide whether to run each winter builder.

**Why B.1 already covers severe + `buildDerivedParameterGrids`:** `buildProfileDerivedGrids` (`scripts/lib/noaa-beta/severe.js:181`) gates ALL expensive parcel compute on `available.has(...)` for `dcape`/`effectiveLayerSupercellCompositeParameter`/`effectiveLayerSignificantTornadoParameter` (severe.js:184-189, early-return line 190-192); `buildDerivedParameterGrids` (renderer.js:1095) derives `available` from `selection.availableParameters` (line 1099) and every emission is gated (`addComputedGrid`/`addGrid`, renderer.js:1106/1116). Because B.1 removes those keys from the filtered `selectedCatalog`, `selectNoaaNamParameterRecords` never lists them in `availableParameters`, so both compute and output skip with **no renderer edit**. B.2's job is only the winter builders that run by `renderMode` branch regardless of the catalog.

- [ ] **Step 1: Write the failing test.** Append to `/Users/micha/Development/model-view/tests-node/render-selection.test.js`:
```js
const {
  filterCatalogForRenderMode: filterCatalogFromRenderer,
  _testCatalogCategorySet,
  _testBuildDerivedParameterGrids,
} = require("../scripts/lib/noaa-beta-renderer");

test("renderer re-exports the selection-aware filter (same choke point)", () => {
  const sel = { categories: {} };
  for (const id of RENDER_CATEGORY_IDS) sel.categories[id] = { enabled: true, tier: "full" };
  sel.categories.winter = { enabled: false, tier: "full" };
  const rendererKeys = filterCatalogFromRenderer(NOAA_NAM_PARAMETER_CATALOG, "all", sel).map((e) => e.key);
  const selectionKeys = filterCatalogForRenderMode(NOAA_NAM_PARAMETER_CATALOG, "all", sel).map((e) => e.key);
  assert.deepEqual(rendererKeys, selectionKeys);
});

test("_testCatalogCategorySet reports which winter builders may run", () => {
  const full = _testCatalogCategorySet(filterCatalogForRenderMode(NOAA_NAM_PARAMETER_CATALOG, "base"));
  assert.equal(full.has("winter"), true, "default base build includes winter (freezing rain) entries");

  const sel = { categories: {} };
  for (const id of RENDER_CATEGORY_IDS) sel.categories[id] = { enabled: true, tier: "full" };
  sel.categories.winter = { enabled: false, tier: "full" };
  const winterOff = _testCatalogCategorySet(filterCatalogForRenderMode(NOAA_NAM_PARAMETER_CATALOG, "base", sel));
  assert.equal(winterOff.has("winter"), false, "winter-off subset drops the winter category → builders gated off");
});

test("severe simple: dcape + effective-layer keys absent from derived output (compute gated by availableParameters)", () => {
  // Simulate the selection that renders after filtering: build a decoded/selection
  // where the heavy keys are NOT in availableParameters, and confirm the derived
  // builder never emits them. (Full end-to-end is covered by the byte-parity step.)
  const decoded = { gust: new Float32Array(4) };
  const selection = { availableParameters: ["gust"] }; // dcape / effective-layer intentionally excluded
  const out = _testBuildDerivedParameterGrids({
    decoded,
    selection,
    bounds: { north: 50, south: 20, west: -130, east: -60 },
    width: 2,
    height: 2,
  });
  assert.equal("dcape" in out, false);
  assert.equal("effectiveLayerSupercellCompositeParameter" in out, false);
  assert.equal("effectiveLayerSignificantTornadoParameter" in out, false);
});
```
> Note: `_testBuildDerivedParameterGrids` (= `buildDerivedParameterGrids`, renderer.js:1095) destructures `{ decoded, selection, bounds, width, height, profile }` and does NOT take a `modelKey` param, so it is omitted here (an extra property would be harmless but is dropped to match the real signature).

- [ ] **Step 2: Run test to verify it fails.**
```
node --test tests-node/render-selection.test.js
```
Expected: the `_testCatalogCategorySet` import is `undefined` → `TypeError: _testCatalogCategorySet is not a function`. (The `_testBuildDerivedParameterGrids` case should already pass since gating exists — it is a regression guard; the two new-export cases fail.)

- [ ] **Step 3: Write minimal implementation.** Edit `scripts/lib/noaa-beta-renderer.js`.

(a) Add a small pure helper near the top-level function definitions. Immediately BEFORE `async function renderNoaaGribFrame({` (line 242), insert:
```js
function catalogCategorySet(catalog) {
  const set = new Set();
  for (const entry of Array.isArray(catalog) ? catalog : []) {
    if (entry && entry.category) {
      set.add(entry.category);
    }
  }
  return set;
}

```

(b) Thread `renderMode` + `renderSelection` through the public wrapper. Replace the wrapper signature (lines 219-220):
```js
  hoverGridFormat = latestMetadata?.hoverGridFormat || "binary",
}) {
  return renderNoaaGribFrame({
```
with:
```js
  hoverGridFormat = latestMetadata?.hoverGridFormat || "binary",
  renderMode,
  renderSelection = null,
}) {
  return renderNoaaGribFrame({
```
and in that wrapper's forwarded call, replace the closing lines (238-239):
```js
    hoverGridFormat,
  });
}
```
with:
```js
    hoverGridFormat,
    renderMode,
    renderSelection,
  });
}
```
> The wrapper previously did not forward `renderMode`. Leaving `renderMode` undefined in the wrapper params (no default) forwards `undefined`, which `renderNoaaGribFrame` defaults to `"all"` — identical to today.

(c) Accept `renderSelection` on `renderNoaaGribFrame`. Replace lines 260-261:
```js
  renderMode = "all",
}) {
```
with:
```js
  renderMode = "all",
  renderSelection = null,
}) {
```

(d) Pass `renderSelection` into the choke-point filter. Replace line 302:
```js
  const selectedCatalog = filterCatalogForRenderMode(NOAA_NAM_PARAMETER_CATALOG, renderMode);
```
with:
```js
  const selectedCatalog = filterCatalogForRenderMode(NOAA_NAM_PARAMETER_CATALOG, renderMode, renderSelection);
  const selectedCategories = catalogCategorySet(selectedCatalog);
```

(e) Gate the winter builders. Replace lines 508-591:
```js
    } else if (renderMode === "base") {
      const snowSelection = selectSnowfallDerivedParameterRecords(records, {
        modelKey: resolvedModelKey,
        targetHour: hour,
      });
      const [freezingRain] = await Promise.all([
        buildFreezingRainAccumulationGrids({
          modelKey: resolvedModelKey,
          modelConfig,
          baseUrl: noaaBaseUrl || noaa.baseUrl || modelConfig.baseUrl,
          date,
          cycle,
          targetHour: hour,
          currentRecords: records,
          latestMetadata,
          rawCacheDir,
          tempDir,
          wgrib2Path,
          bounds: view.bounds,
          width,
          height,
          rangeFetchConcurrency,
          rangeFetchLimiter,
          decodeConcurrency,
          decoded,
          selection,
          profile: renderProfile,
          decodeSession,
          profileDecodeUnion: true,
        }),
        buildSnowfallDeltaOnlyGrids({
          modelKey: resolvedModelKey,
          modelConfig,
          baseUrl: noaaBaseUrl || noaa.baseUrl || modelConfig.baseUrl,
          date,
          cycle,
          targetHour: hour,
          currentRecords: records,
          latestMetadata,
          rawCacheDir,
          tempDir,
          wgrib2Path,
          bounds: view.bounds,
          width,
          height,
          rangeFetchConcurrency,
          rangeFetchLimiter,
          decodeConcurrency,
          decoded,
          selection: snowSelection,
          profile: renderProfile,
          decodeSession,
          profileDecodeUnion: true,
        }),
      ]);
      Object.assign(decoded, freezingRain);
    } else {
      Object.assign(
        decoded,
        await buildWinterDerivedInputGrids({
          modelKey: resolvedModelKey,
          modelConfig,
          baseUrl: noaaBaseUrl || noaa.baseUrl || modelConfig.baseUrl,
          date,
          cycle,
          targetHour: hour,
          currentRecords: records,
          latestMetadata,
          rawCacheDir,
          tempDir,
          wgrib2Path,
          bounds: view.bounds,
          width,
          height,
          rangeFetchConcurrency,
          rangeFetchLimiter,
          decodeConcurrency,
          decoded,
          selection,
          profile: renderProfile,
          decodeSession,
        }),
      );
    }
```
with:
```js
    } else if (renderMode === "base") {
      // Freezing-rain + snow-delta inputs are winter-category compute. When the
      // render selection excludes winter, skip them so no winter bytes are
      // fetched/decoded; with no selection selectedCategories always holds
      // "winter" here (base mode keeps every non-snowfallDerived winter entry:
      // wetBulbZeroHeight/freezingRainLiquidTotal/snowDepth/snowWaterEq/
      // framFlatIce/framRadialIce/snowHrrrAsnow), preserving today's behavior.
      if (selectedCategories.has("winter")) {
        const snowSelection = selectSnowfallDerivedParameterRecords(records, {
          modelKey: resolvedModelKey,
          targetHour: hour,
        });
        const [freezingRain] = await Promise.all([
          buildFreezingRainAccumulationGrids({
            modelKey: resolvedModelKey,
            modelConfig,
            baseUrl: noaaBaseUrl || noaa.baseUrl || modelConfig.baseUrl,
            date,
            cycle,
            targetHour: hour,
            currentRecords: records,
            latestMetadata,
            rawCacheDir,
            tempDir,
            wgrib2Path,
            bounds: view.bounds,
            width,
            height,
            rangeFetchConcurrency,
            rangeFetchLimiter,
            decodeConcurrency,
            decoded,
            selection,
            profile: renderProfile,
            decodeSession,
            profileDecodeUnion: true,
          }),
          buildSnowfallDeltaOnlyGrids({
            modelKey: resolvedModelKey,
            modelConfig,
            baseUrl: noaaBaseUrl || noaa.baseUrl || modelConfig.baseUrl,
            date,
            cycle,
            targetHour: hour,
            currentRecords: records,
            latestMetadata,
            rawCacheDir,
            tempDir,
            wgrib2Path,
            bounds: view.bounds,
            width,
            height,
            rangeFetchConcurrency,
            rangeFetchLimiter,
            decodeConcurrency,
            decoded,
            selection: snowSelection,
            profile: renderProfile,
            decodeSession,
            profileDecodeUnion: true,
          }),
        ]);
        Object.assign(decoded, freezingRain);
      }
    } else if (selectedCategories.has("winter")) {
      Object.assign(
        decoded,
        await buildWinterDerivedInputGrids({
          modelKey: resolvedModelKey,
          modelConfig,
          baseUrl: noaaBaseUrl || noaa.baseUrl || modelConfig.baseUrl,
          date,
          cycle,
          targetHour: hour,
          currentRecords: records,
          latestMetadata,
          rawCacheDir,
          tempDir,
          wgrib2Path,
          bounds: view.bounds,
          width,
          height,
          rangeFetchConcurrency,
          rangeFetchLimiter,
          decodeConcurrency,
          decoded,
          selection,
          profile: renderProfile,
          decodeSession,
        }),
      );
    }
```
> `buildDerivedParameterGrids` (line 595) is untouched: it already gates emission on `selection.availableParameters`, which the filtered `selectedCatalog` drives — so severe-tier dcape/effective-layer skipping and any winter freezing-rain output (`freezingRainLiquidTotal`, `framFlatIce`, `framRadialIce` — all `category === "winter"`) are already excluded from output when winter is off, and the winter builder gate above additionally skips the winter *input decode*.

(f) Export the test helper. In the `module.exports` object, next to `_testFilterCatalogForRenderMode: filterCatalogForRenderMode,` (line 1908), add:
```js
  _testCatalogCategorySet: catalogCategorySet,
```

- [ ] **Step 4: Run test to verify it passes, then hold byte parity.**
```
node --test tests-node/render-selection.test.js
node --test tests-node/noaa-beta.test.js
```
Expected: both green (the noaa-beta suite exercises `_testBuildDerivedParameterGrids`/`_testFilterCatalogForRenderMode` and must be unaffected).

**Byte-parity (renderer-touching — full-selection default MUST stay byte-identical):**
```
# Reconciliation: this task adds NO manifest field. renderSelection is nullish on
# every default (no-flags) call path (frame-queue passes no renderSelection, so the
# renderer default null holds), so filterCatalogForRenderMode returns the identical
# per-mode list and every winter builder still runs (selectedCategories always
# contains "winter" for base/else in the default case). Expect ZERO artifact diffs.

export MODELVIEW_PNG_DEFLATE_BACKEND=zlib   # same on both sides (see MEMORY libdeflate note)
# 1) Snapshot golden frames from the PRE-change tree:
git stash
npm run noaa:build:test -- --frames=4 --models=hrrr,nam3km
cp -R output/noaa-beta-cache/artifacts/tiles /private/tmp/claude-501/-Users-micha-Development-model-view/78037a7e-c26e-4910-851d-cea9461c9826/scratchpad/golden-before
git stash pop
# 2) Re-render the SAME frames with the change in place:
npm run noaa:build:test -- --frames=4 --models=hrrr,nam3km
# 3) cmp every artifact except *.complete.json:
BEFORE=/private/tmp/claude-501/-Users-micha-Development-model-view/78037a7e-c26e-4910-851d-cea9461c9826/scratchpad/golden-before
find output/noaa-beta-cache/artifacts/tiles -type f ! -name '*.complete.json' | while read -r f; do
  rel="${f#output/noaa-beta-cache/artifacts/tiles/}"
  cmp -s "$f" "$BEFORE/$rel" || echo "DIFF: $rel"
done
```
Expected: no `DIFF:` lines (PNG/hover/synoptic artifacts byte-identical). If NOAA runs advanced between snapshots and the run id shifts, regenerate the "before" set by rebuilding the same run from the prior commit (`git stash`/checkout) per the renderer-optimization-protocol.

- [ ] **Step 5: Commit.**
```
git add scripts/lib/noaa-beta-renderer.js tests-node/render-selection.test.js && git commit -m "Gate winter derived builders on the selection-filtered catalog subset

Severe-tier dcape/effective-layer skipping falls out of the catalog filter
(buildProfileDerivedGrids already gates parcel compute on availableParameters);
this adds the winter builder gate the catalog filter alone cannot reach. No-flags
default stays byte-identical (renderSelection nullish keeps every builder running).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task B.3: Additive manifest `renderSelection` field

**Files:**
- Modify `/Users/micha/Development/model-view/scripts/lib/modelview-runtime.js` (`buildManifestTemplate` signature line 64-78 + returned object line 114-127)
- Modify `/Users/micha/Development/model-view/scripts/lib/local-artifact-runtime.js` (template call site line 471-485 — pass `renderSelection` through)
- Test `/Users/micha/Development/model-view/tests-node/manifest-render-selection.test.js` (new)

**Interfaces:**
- Consumes (B.1): `normalizeRenderSelection`, `RENDER_CATEGORY_IDS` (for the parity assertion in the test).
- Produces:
  - `buildManifestTemplate({ ..., renderSelection = null })` — when a normalized selection is supplied, the returned manifest gains `renderSelection: { categories: Record<categoryId,{enabled,tier}>, builtAt: <ISO string> }`. When nullish, the manifest OMITS the `renderSelection` key entirely (so today's default manifest is byte-identical to before this task except that no field is added at all on the no-selection path).
  - Consumers reading a manifest may treat a missing `renderSelection` as "full render" (all categories, full tier) — recorded here for Phase D/E.

> **Exactness reconciliation (critical):** `renderSelection` is written **only when a selection is actually supplied** (i.e. a partial/tiered render). A no-flags/full-selection default build passes `renderSelection = null`, so `buildManifestTemplate` does NOT add the key and the default manifest is **byte-identical to today** (no additive field at all). Partial builds gain the field. (`mergeManifestWithTemplate` spreads `{...template}`, so the key's presence/absence follows the template.)

- [ ] **Step 1: Write the failing test.** Create `/Users/micha/Development/model-view/tests-node/manifest-render-selection.test.js`:
```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildManifestTemplate } = require("../scripts/lib/modelview-runtime");
const { RENDER_CATEGORY_IDS } = require("../scripts/lib/noaa-nam-parameter-catalog");

const BASE = {
  modelKey: "hrrr",
  viewKey: "conus",
  runId: "2026070300",
  referenceTime: "2026-07-03T00:00:00Z",
  validTimes: ["2026-07-03T00:00:00Z", "2026-07-03T01:00:00Z"],
  renderWidth: 100,
  renderHeight: 100,
};

test("no renderSelection: manifest omits the field (byte-identical default)", () => {
  const manifest = buildManifestTemplate({ ...BASE });
  assert.equal("renderSelection" in manifest, false);
});

test("null renderSelection is treated as no selection (field omitted)", () => {
  const manifest = buildManifestTemplate({ ...BASE, renderSelection: null });
  assert.equal("renderSelection" in manifest, false);
});

test("partial selection records categories + builtAt", () => {
  const categories = {};
  for (const id of RENDER_CATEGORY_IDS) categories[id] = { enabled: true, tier: "full" };
  categories.winter = { enabled: false, tier: "full" };
  categories.severe = { enabled: true, tier: "simple" };
  const before = Date.now();
  const manifest = buildManifestTemplate({ ...BASE, renderSelection: { categories } });
  assert.ok(manifest.renderSelection, "renderSelection present");
  assert.equal(manifest.renderSelection.categories.winter.enabled, false);
  assert.equal(manifest.renderSelection.categories.severe.tier, "simple");
  assert.equal(manifest.renderSelection.categories.surface.enabled, true);
  const builtAt = Date.parse(manifest.renderSelection.builtAt);
  assert.ok(Number.isFinite(builtAt) && builtAt >= before, "builtAt is a fresh ISO timestamp");
  // Every canonical category id is recorded (normalized), not just the ones passed.
  for (const id of RENDER_CATEGORY_IDS) {
    assert.ok(manifest.renderSelection.categories[id], `category ${id} recorded`);
  }
});

test("full-selection manifest equals default manifest except for the additive renderSelection field", () => {
  const categories = {};
  for (const id of RENDER_CATEGORY_IDS) categories[id] = { enabled: true, tier: "full" };
  const withSel = buildManifestTemplate({ ...BASE, renderSelection: { categories } });
  const withoutSel = buildManifestTemplate({ ...BASE });
  const { renderSelection, generatedAt: g1, ...withSelRest } = withSel;
  const { generatedAt: g2, ...withoutSelRest } = withoutSel;
  assert.ok(renderSelection, "full selection still records the field");
  assert.deepEqual(withSelRest, withoutSelRest, "only renderSelection (+ generatedAt clock) differs");
});
```

- [ ] **Step 2: Run test to verify it fails.**
```
node --test tests-node/manifest-render-selection.test.js
```
Expected: `partial selection records categories + builtAt` and the full-selection test fail — `manifest.renderSelection` is `undefined` (`buildManifestTemplate` ignores the option). The two "omitted" tests pass already (guarding the exactness invariant).

- [ ] **Step 3: Write minimal implementation.**

In `scripts/lib/modelview-runtime.js`, add the import for the normalizer near the top require block (e.g. after line 6, the `SYNOPTIC_STYLE` require):
```js
const { normalizeRenderSelection } = require("./noaa-beta/selection");
```
> Guard against a circular require: `selection.js` requires `../noaa-nam-parameter-catalog` (verified on disk, not `modelview-runtime`), so this edge is acyclic. If a cycle surfaces at load, inline a local copy of `normalizeRenderSelection` in modelview-runtime instead and add a parity test — but the direct require is preferred (one source of truth).

Extend the `buildManifestTemplate` destructured params (lines 77-78):
```js
  hoverGridFormat = null,
}) {
```
→
```js
  hoverGridFormat = null,
  renderSelection = null,
}) {
```

Extend the returned object (lines 114-127). Replace:
```js
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    model: modelKey,
    run: runId,
    view: viewKey,
    generatedAt: new Date().toISOString(),
    source: LOCAL_SOURCE_NAME,
    referenceTime,
    openDataModel: model.openDataModel,
    parameters: normalizeParameterMetadata(parameters),
    parameterOrder: normalizeParameterOrder(parameterOrder, parameterKeys),
    hourStatus,
    frames: manifestFrames,
  };
```
with:
```js
  const normalizedSelection = normalizeRenderSelection(renderSelection);
  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    model: modelKey,
    run: runId,
    view: viewKey,
    generatedAt: new Date().toISOString(),
    source: LOCAL_SOURCE_NAME,
    referenceTime,
    openDataModel: model.openDataModel,
    parameters: normalizeParameterMetadata(parameters),
    parameterOrder: normalizeParameterOrder(parameterOrder, parameterKeys),
    hourStatus,
    frames: manifestFrames,
  };
  // Additive: only stamp renderSelection for selective builds so a no-flags
  // default manifest is byte-identical to today (no new key at all).
  if (normalizedSelection) {
    manifest.renderSelection = {
      categories: normalizedSelection.categories,
      builtAt: new Date().toISOString(),
    };
  }
  return manifest;
```

In `scripts/lib/local-artifact-runtime.js`, thread `renderSelection` into the template call (lines 483-485). Replace:
```js
      parameterOrder: latestMetadata.parameterOrder || latestMetadata.parameterKeys || null,
      hoverGridFormat: latestMetadata.hoverGridFormat || null,
    });
```
with:
```js
      parameterOrder: latestMetadata.parameterOrder || latestMetadata.parameterKeys || null,
      hoverGridFormat: latestMetadata.hoverGridFormat || null,
      renderSelection: latestMetadata.renderSelection || null,
    });
```
> `latestMetadata.renderSelection` is `undefined` on the default path today (the builder does not set it yet — Phase C wires the CLI selection into `latestMetadata`), so this passes `null` and the manifest omits the field, preserving byte-identical default output. Phase C will populate `latestMetadata.renderSelection` from the parsed CLI flags.

- [ ] **Step 4: Run test to verify it passes, then hold manifest parity.**
```
node --test tests-node/manifest-render-selection.test.js
node --test tests-node/noaa-beta.test.js tests-node/manifest-merge.test.js
```
Expected: all green.

**Manifest byte-parity (default build must be unchanged):**
```
export MODELVIEW_PNG_DEFLATE_BACKEND=zlib
git stash
npm run noaa:build:test -- --frames=2 --models=hrrr
# Save the default manifest (find it under output/noaa-beta-cache; the manifest json for the built run/view)
find output/noaa-beta-cache -name '*.json' -path '*hrrr*conus*' ! -name '*.complete.json' -print
cp <that-manifest-path> /private/tmp/claude-501/-Users-micha-Development-model-view/78037a7e-c26e-4910-851d-cea9461c9826/scratchpad/manifest-before.json   # substitute the real path printed above
git stash pop
npm run noaa:build:test -- --frames=2 --models=hrrr
# Compare: default (no-flags) build must NOT gain renderSelection.
node -e "const b=require('/private/tmp/claude-501/-Users-micha-Development-model-view/78037a7e-c26e-4910-851d-cea9461c9826/scratchpad/manifest-before.json'); const a=require('<that-manifest-path>'); const {generatedAt:_1,...br}=b; const {generatedAt:_2,...ar}=a; const assert=require('assert'); assert(!('renderSelection' in ar), 'default manifest must NOT have renderSelection'); assert.deepStrictEqual(ar, br); console.log('default manifest byte-identical (modulo generatedAt clock)');"
```
Expected: prints "default manifest byte-identical (modulo generatedAt clock)"; no `renderSelection` on the default build. For a partial build the field appears only when Phase C sets `latestMetadata.renderSelection`.

- [ ] **Step 5: Commit.**
```
git add scripts/lib/modelview-runtime.js scripts/lib/local-artifact-runtime.js tests-node/manifest-render-selection.test.js && git commit -m "Add additive manifest renderSelection field for selective builds

Written only when a selection is supplied, so no-flags default manifests stay
byte-identical (no new key). Records categories + builtAt so the UI can tell an
intentionally-omitted category from a data-gated one.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

**Phase B superset / `--force` reuse note (for Phase C/D — no code here):** Re-render coherence (spec §2.4): when a new selection's resolved layer set differs from an existing partial run's manifest `renderSelection` (e.g. simple→full or enabling a previously-off category on the same run), the render endpoint (Phase D) must pass `--force` to the builder so already-present frames re-render with the wider set — `mergeManifestWithTemplate` unions frames by hour and would otherwise keep stale narrower frames. Conversely, a strict superset render of the same run with `--force` reproduces (for the overlapping categories) byte-identical artifacts because skipping only omits products. Compare the requested normalized `categories` against `existingManifest.renderSelection?.categories` (absent ⇒ treat existing as full render); force when the request would ADD any category/tier the stored manifest lacks.


## Phase C: CLI flags + point-sounding prefetch

## Phase C — CLI

Depends on **Phase A** (catalog stamps `category` + `costTier`, surfaced via `getNoaaNamParameterMetadata()`) and **Phase B**, which produced in `scripts/lib/noaa-beta/selection.js`:
- `filterCatalogForRenderMode(catalog, renderMode, selection)` — third arg is the §1.4 selection object or `null` (null ⇒ today's behavior, no omission).
- `selectionAllows(selection, entry)` → boolean — an entry renders iff its category is enabled AND (`entry.costTier === "simple"` OR the category's tier is `"full"`); non-tiered categories treat tier as `"full"`; `selection == null` ⇒ always true.
- The plumbing that threads a `renderSelection` object from `main()` through the runtime/worker to that filter call.

C1 owns turning CLI flags into that selection object, validating it, and handing it to the existing plumbing. C2 adds the point-sounding prefetch CLI. Point soundings are computed on demand and are NOT under artifact byte-parity, but C2 MUST honor the plan.md durable decision: **cache raw fields only, never parcel diagnostics** (it reuses `buildNoaaPointSounding`, which already warms only the raw `selected-grib` cache).

---

### Task C.1: Parse + validate `--categories` / `--severe-tier` / `--winter-tier` into the render selection and thread it into the build

**Files:**
- Create: `/Users/micha/Development/model-view/scripts/lib/noaa-build/render-selection-args.js`
- Modify: `/Users/micha/Development/model-view/scripts/build-noaa-beta-artifacts.js` (parseArgs at line 749; main at line 55; exports at line 780)
- Test: `/Users/micha/Development/model-view/tests-node/render-selection-args.test.js`

**Interfaces:**
- Consumes (Phase B, `scripts/lib/noaa-beta/selection.js`): `filterCatalogForRenderMode(catalog, renderMode, selection)`, `selectionAllows(selection, entry)`.
- Consumes (Phase A, `scripts/lib/noaa-nam-parameter-catalog.js`): `NOAA_NAM_PARAMETER_CATALOG` entries each carry `key`, `category`, `costTier`.
- Produces:
  - `RENDER_CATEGORY_IDS` : `string[]` = `["surface","precip","radar","cloud","severe","winter","upperAir"]` (the 7 merged categories, §1.1).
  - `TIERED_CATEGORY_IDS` : `Set<string>` = `new Set(["severe","winter"])`.
  - `parseRenderSelectionFromArgs(args, { models, view, run })` → `renderSelection | null`. `args` is the flat object from `parseArgs`. Returns `null` when none of `--categories`/`--severe-tier`/`--winter-tier` are present (today's all/full behavior). Otherwise returns the §1.4 shape:
    `{ models, view, run, categories: { surface: bool, precip: bool, radar: bool, cloud: bool, upperAir: bool, severe: { enabled: bool, tier: "simple"|"full" }, winter: { enabled: bool, tier: "simple"|"full" } } }`.
    Throws `Error` (→ non-zero exit in main) on an unknown category id or an invalid tier value.
  - `resolveRenderSelectionKeys(selection, catalog = NOAA_NAM_PARAMETER_CATALOG)` → `string[]` of catalog keys that survive `selectionAllows` (sorted), for tests/logging.

- [ ] **Step 1: Write the failing test**
  Create `/Users/micha/Development/model-view/tests-node/render-selection-args.test.js`:
  ```js
  "use strict";

  const assert = require("node:assert/strict");
  const test = require("node:test");
  const {
    RENDER_CATEGORY_IDS,
    TIERED_CATEGORY_IDS,
    parseRenderSelectionFromArgs,
    resolveRenderSelectionKeys,
  } = require("../scripts/lib/noaa-build/render-selection-args");
  const { NOAA_NAM_PARAMETER_CATALOG } = require("../scripts/lib/noaa-nam-parameter-catalog");

  const CONTEXT = { models: ["nam3km"], view: "conus", run: "latest" };

  test("no selection flags returns null (today's all/full behavior)", () => {
    assert.equal(parseRenderSelectionFromArgs({}, CONTEXT), null);
    assert.equal(parseRenderSelectionFromArgs({ force: true, view: "conus" }, CONTEXT), null);
  });

  test("exposes the 7 merged categories and the two tiered ones", () => {
    assert.deepEqual(RENDER_CATEGORY_IDS, [
      "surface",
      "precip",
      "radar",
      "cloud",
      "severe",
      "winter",
      "upperAir",
    ]);
    assert.equal(TIERED_CATEGORY_IDS.has("severe"), true);
    assert.equal(TIERED_CATEGORY_IDS.has("winter"), true);
    assert.equal(TIERED_CATEGORY_IDS.has("surface"), false);
  });

  test("an unknown --categories token throws (non-zero exit in main)", () => {
    assert.throws(
      () => parseRenderSelectionFromArgs({ categories: "surface,bogus" }, CONTEXT),
      /unknown render category 'bogus'/i,
    );
  });

  test("an invalid --severe-tier throws", () => {
    assert.throws(
      () => parseRenderSelectionFromArgs({ categories: "severe", "severe-tier": "cheap" }, CONTEXT),
      /invalid severe tier 'cheap'/i,
    );
  });

  test("--categories allowlists the named categories; omitted categories are off", () => {
    const selection = parseRenderSelectionFromArgs(
      { categories: "surface,precip,severe", "severe-tier": "simple" },
      CONTEXT,
    );
    assert.deepEqual(selection.models, ["nam3km"]);
    assert.equal(selection.view, "conus");
    assert.equal(selection.run, "latest");
    assert.deepEqual(selection.categories, {
      surface: true,
      precip: true,
      radar: false,
      cloud: false,
      upperAir: false,
      severe: { enabled: true, tier: "simple" },
      winter: { enabled: false, tier: "full" },
    });
  });

  test("tiers default to full when the flag is omitted", () => {
    const selection = parseRenderSelectionFromArgs({ categories: "severe,winter" }, CONTEXT);
    assert.equal(selection.categories.severe.tier, "full");
    assert.equal(selection.categories.winter.tier, "full");
  });

  test("resolveRenderSelectionKeys drops severe full-only keys when severe tier is simple", () => {
    const selection = parseRenderSelectionFromArgs(
      { categories: "severe", "severe-tier": "simple" },
      CONTEXT,
    );
    const keys = resolveRenderSelectionKeys(selection, NOAA_NAM_PARAMETER_CATALOG);
    // simple severe drops the effective-layer composites and DCAPE (owner decision 1)
    assert.equal(keys.includes("dcape"), false);
    assert.equal(keys.includes("effectiveLayerSupercellCompositeParameter"), false);
    assert.equal(keys.includes("effectiveLayerSignificantTornadoParameter"), false);
    // but keeps the cheap direct/composite severe fields
    assert.equal(keys.includes("supercellCompositeParameter"), true);
    assert.equal(keys.includes("bulkShear0to6km"), true);
    // and omits an off category entirely
    assert.equal(
      keys.some((key) => {
        const entry = NOAA_NAM_PARAMETER_CATALOG.find((candidate) => candidate.key === key);
        return entry && entry.category === "winter";
      }),
      false,
    );
  });

  test("full severe tier keeps the heavy keys", () => {
    const selection = parseRenderSelectionFromArgs(
      { categories: "severe", "severe-tier": "full" },
      CONTEXT,
    );
    const keys = resolveRenderSelectionKeys(selection, NOAA_NAM_PARAMETER_CATALOG);
    assert.equal(keys.includes("dcape"), true);
    assert.equal(keys.includes("effectiveLayerSupercellCompositeParameter"), true);
  });
  ```

- [ ] **Step 2: Run test to verify it fails**
  `node --test tests-node/render-selection-args.test.js`
  Expected: `Cannot find module '../scripts/lib/noaa-build/render-selection-args'` (module does not exist yet).

- [ ] **Step 3: Write minimal implementation**
  Create `/Users/micha/Development/model-view/scripts/lib/noaa-build/render-selection-args.js`:
  ```js
  "use strict";

  const { NOAA_NAM_PARAMETER_CATALOG } = require("../noaa-nam-parameter-catalog");
  const { selectionAllows } = require("../noaa-beta/selection");

  // The 7 merged render categories (design §1.1), in panel display order.
  const RENDER_CATEGORY_IDS = ["surface", "precip", "radar", "cloud", "severe", "winter", "upperAir"];
  // Only these two categories accept a simple/full compute tier (design §1.2).
  const TIERED_CATEGORY_IDS = new Set(["severe", "winter"]);
  const RENDER_TIERS = new Set(["simple", "full"]);

  function parseCategoryList(raw) {
    const tokens = String(raw || "")
      .split(",")
      .map((token) => token.trim())
      .filter(Boolean);
    const seen = new Set();
    for (const token of tokens) {
      if (!RENDER_CATEGORY_IDS.includes(token)) {
        throw new Error(
          `unknown render category '${token}'. Allowed: ${RENDER_CATEGORY_IDS.join(", ")}.`,
        );
      }
      seen.add(token);
    }
    return seen;
  }

  function parseTier(raw, categoryId) {
    if (raw === undefined || raw === null || raw === "") {
      return "full";
    }
    const tier = String(raw).trim().toLowerCase();
    if (!RENDER_TIERS.has(tier)) {
      throw new Error(`invalid ${categoryId} tier '${raw}'. Allowed: simple, full.`);
    }
    return tier;
  }

  function parseRenderSelectionFromArgs(args, { models, view, run } = {}) {
    const source = args || {};
    const hasCategories = source.categories !== undefined;
    const hasSevereTier = source["severe-tier"] !== undefined;
    const hasWinterTier = source["winter-tier"] !== undefined;
    if (!hasCategories && !hasSevereTier && !hasWinterTier) {
      return null;
    }
    // When any selection flag is present, an absent --categories means "all on".
    const enabled = hasCategories ? parseCategoryList(source.categories) : new Set(RENDER_CATEGORY_IDS);
    const severeTier = parseTier(source["severe-tier"], "severe");
    const winterTier = parseTier(source["winter-tier"], "winter");
    return {
      models: Array.isArray(models) ? models : [],
      view: view || null,
      run: run || null,
      categories: {
        surface: enabled.has("surface"),
        precip: enabled.has("precip"),
        radar: enabled.has("radar"),
        cloud: enabled.has("cloud"),
        upperAir: enabled.has("upperAir"),
        severe: { enabled: enabled.has("severe"), tier: severeTier },
        winter: { enabled: enabled.has("winter"), tier: winterTier },
      },
    };
  }

  function resolveRenderSelectionKeys(selection, catalog = NOAA_NAM_PARAMETER_CATALOG) {
    const list = Array.isArray(catalog) ? catalog : NOAA_NAM_PARAMETER_CATALOG;
    return list
      .filter((entry) => selectionAllows(selection, entry))
      .map((entry) => entry.key)
      .sort();
  }

  module.exports = {
    RENDER_CATEGORY_IDS,
    TIERED_CATEGORY_IDS,
    parseRenderSelectionFromArgs,
    resolveRenderSelectionKeys,
  };
  ```

  Then wire it into `main()`. In `/Users/micha/Development/model-view/scripts/build-noaa-beta-artifacts.js`, add the require next to the existing run-selection-adjacent requires. Replace this existing line (line 47):
  ```js
  const { loadDotEnv, resolveCacheRootEnv } = require("./lib/env-config");
  ```
  with:
  ```js
  const { loadDotEnv, resolveCacheRootEnv } = require("./lib/env-config");
  const { parseRenderSelectionFromArgs } = require("./lib/noaa-build/render-selection-args");
  ```

  In `main()`, build the selection right after `viewKey` is validated. Replace this existing block (lines 59-62):
  ```js
  const viewKey = String(args.view || DEFAULT_VIEW_KEY).trim() || DEFAULT_VIEW_KEY;
  if (!VIEW_CONFIG[viewKey]) {
    throw new Error(`Unsupported view '${viewKey}'. Supported: ${Object.keys(VIEW_CONFIG).join(", ")}`);
  }
  ```
  with:
  ```js
  const viewKey = String(args.view || DEFAULT_VIEW_KEY).trim() || DEFAULT_VIEW_KEY;
  if (!VIEW_CONFIG[viewKey]) {
    throw new Error(`Unsupported view '${viewKey}'. Supported: ${Object.keys(VIEW_CONFIG).join(", ")}`);
  }
  // Selective render scope (design §1.4). null ⇒ all categories/full tier (today's byte-identical output).
  const renderSelection = parseRenderSelectionFromArgs(args, {
    models,
    view: viewKey,
    run: args.run || "latest",
  });
  if (renderSelection) {
    const enabledCategories = Object.entries(renderSelection.categories)
      .filter(([, value]) => (typeof value === "object" ? value.enabled : value))
      .map(([id, value]) => (typeof value === "object" ? `${id}:${value.tier}` : id));
    console.log(`[noaa-beta] render selection categories=${enabledCategories.join(",") || "(none)"}`);
  }
  ```

  Thread `renderSelection` into both build-dispatch option objects so Phase B's runtime/worker plumbing receives it. In the global-frame-queue call, replace the existing options object header at lines 254-256:
  ```js
      results = await buildLatestStatesWithGlobalFrameQueue(runtime, models, viewKey, {
        frameConcurrency: globalFrameConcurrency,
        frameRetries,
  ```
  with:
  ```js
      results = await buildLatestStatesWithGlobalFrameQueue(runtime, models, viewKey, {
        renderSelection,
        frameConcurrency: globalFrameConcurrency,
        frameRetries,
  ```
  In the per-model fallback, replace the existing options object header at lines 280-283:
  ```js
        const [summary] = await buildLatestStatesWithGlobalFrameQueue(runtime, [modelKey], viewKey, {
          frameConcurrency,
          frameRetries,
          retryDelayMs,
  ```
  with:
  ```js
        const [summary] = await buildLatestStatesWithGlobalFrameQueue(runtime, [modelKey], viewKey, {
          renderSelection,
          frameConcurrency,
          frameRetries,
          retryDelayMs,
  ```

  Export `parseArgs` so tests and Phase D can reuse the flag parser. In the `module.exports` block (line 780), add `parseArgs` alphabetically near the other parse* exports. Replace this existing line:
  ```js
    parseHours,
    parseReflectivityGates,
  ```
  with:
  ```js
    parseArgs,
    parseHours,
    parseReflectivityGates,
  ```

  (Constraint note for the implementer: `renderSelection` is `null` on a no-flags build, so `buildLatestStatesWithGlobalFrameQueue` and the downstream `filterCatalogForRenderMode(catalog, renderMode, null)` behave exactly as today — this preserves the full-selection byte-parity guarantee. Phase B's parity test already covers the null path; C1 only ADDS the non-null path.)

- [ ] **Step 4: Run test to verify it passes**
  `node --test tests-node/render-selection-args.test.js`
  Expected: all tests pass (8 pass, 0 fail). Also run `node -e "require('./scripts/build-noaa-beta-artifacts.js')"` to confirm the modified builder still loads (no syntax/require error) and `node --test tests-node/noaa-beta.test.js` to confirm no regression in the builder-adjacent suite.

- [ ] **Step 5: Commit**
  `git add scripts/lib/noaa-build/render-selection-args.js scripts/build-noaa-beta-artifacts.js tests-node/render-selection-args.test.js && git commit -m "$(printf 'Parse and validate render-selection CLI flags\n\nAdd --categories/--severe-tier/--winter-tier to the NOAA builder: parse\ninto the §1.4 selection object, validate against the fixed 7-category\nand simple/full enums (non-zero exit on unknown values), and thread the\nselection through to the render dispatch. No flags yields a null\nselection so the default build stays byte-identical to today.\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"`

---

### Task C.2: Point-sounding prefetch core + CLI wrapper + npm script

**Files:**
- Create: `/Users/micha/Development/model-view/scripts/lib/noaa-build/prefetch-soundings.js` (core: `planPrefetchTasks`, `warmFrameSounding`, `runSoundingPrefetch`)
- Create: `/Users/micha/Development/model-view/scripts/prefetch-point-soundings.js` (CLI wrapper)
- Modify: `/Users/micha/Development/model-view/package.json` (scripts block — add `noaa:prefetch-soundings`)
- Test: `/Users/micha/Development/model-view/tests-node/prefetch-soundings.test.js`

**Interfaces:**
- Consumes:
  - `buildNoaaPointSounding({ modelKey, runId, hour, lat, lon, rawCacheDir, wgrib2Path, rangeFetchLimiter, ... })` from `scripts/lib/noaa-beta/point-sounding.js` (async; warms the `selected-grib` raw cache; computes on demand but persists **only raw fields**).
  - `LocalArtifactRuntime` from `scripts/lib/local-artifact-runtime.js` — methods `readLatestPointerFromDisk(model, view)`, `listRunManifests(model, view)`, `readManifestFromDisk(model, runId, view)`.
  - `AsyncSemaphore` from `scripts/lib/local-artifact-concurrency.js`.
  - `resolveModels` from `scripts/lib/noaa-build/run-resolution.js`.
  - `resolveCacheRootEnv`, `loadDotEnv` from `scripts/lib/env-config.js`.
- Produces:
  - `planPrefetchTasks({ runtime, models, view, runsMode, runIds, hours })` → `Promise<Array<{ modelKey, runId, hour, lat, lon }>>`. Enumerates **loaded** frames only (`manifest.hourStatus[String(hour)] === "loaded"`); picks an in-bounds domain-center from each frame's `bounds` (`lat=(north+south)/2`, `lon=(west+east)/2`); one task per `(modelKey, runId, hour)`.
  - `warmFrameSounding(task, { rawCacheDir, wgrib2Path, rangeFetchLimiter, buildSounding? })` → `Promise<{ modelKey, runId, hour, status: "warmed"|"alreadyCached"|"failed", bytes, error? }>`. Idempotent: re-warming a fully-cached frame issues zero network calls and reports `alreadyCached`.
  - `runSoundingPrefetch(options)` → `Promise<{ tasks, warmed, alreadyCached, failed, bytes }>` (summary for CLI + server).

- [ ] **Step 1: Write the failing test**
  Create `/Users/micha/Development/model-view/tests-node/prefetch-soundings.test.js`. Uses the on-disk nam3km cache as a real fixture — NO live NOAA fetch.
  ```js
  "use strict";

  const assert = require("node:assert/strict");
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const test = require("node:test");

  const { LocalArtifactRuntime } = require("../scripts/lib/local-artifact-runtime");
  const { AsyncSemaphore } = require("../scripts/lib/local-artifact-concurrency");
  const {
    planPrefetchTasks,
    warmFrameSounding,
  } = require("../scripts/lib/noaa-build/prefetch-soundings");

  const REPO_ROOT = path.resolve(__dirname, "..");
  const FIXTURE_CACHE_ROOT = path.join(REPO_ROOT, "output/noaa-beta-cache");
  const FIXTURE_MANIFEST = path.join(
    FIXTURE_CACHE_ROOT,
    "artifacts/manifests/nam3km/20260702-1200Z--conus.json",
  );
  const WGRIB2_PATH = path.join(REPO_ROOT, "output/noaa-beta-tools/bin/wgrib2");

  function makeRuntime() {
    return new LocalArtifactRuntime({
      cacheRoot: FIXTURE_CACHE_ROOT,
      artifactPrefix: "tiles",
      sourceName: "noaa-beta",
    });
  }

  test("planPrefetchTasks enumerates only loaded hours with in-bounds domain centers", async (t) => {
    if (!fs.existsSync(FIXTURE_MANIFEST)) {
      t.skip("nam3km selected-grib-v2 fixture manifest not present");
      return;
    }
    const runtime = makeRuntime();
    await runtime.init();
    const manifest = JSON.parse(fs.readFileSync(FIXTURE_MANIFEST, "utf8"));
    const loadedHours = Object.entries(manifest.hourStatus || {})
      .filter(([, status]) => status === "loaded")
      .map(([hour]) => Number(hour))
      .sort((a, b) => a - b);

    const tasks = await planPrefetchTasks({
      runtime,
      models: ["nam3km"],
      view: "conus",
      runsMode: "all",
    });
    const nam3kmTasks = tasks.filter((task) => task.modelKey === "nam3km" && task.runId === "20260702-1200Z");
    assert.deepEqual(
      nam3kmTasks.map((task) => task.hour).sort((a, b) => a - b),
      loadedHours,
      "one task per loaded hour",
    );
    // Each center sits inside its frame bounds.
    const frameByHour = new Map(manifest.frames.map((frame) => [Number(frame.hour), frame]));
    for (const task of nam3kmTasks) {
      const bounds = frameByHour.get(task.hour).bounds;
      assert.ok(task.lat <= bounds.north && task.lat >= bounds.south, "lat in bounds");
      assert.ok(task.lon >= bounds.west && task.lon <= bounds.east, "lon in bounds");
    }
  });

  test("planPrefetchTasks --runs=latest uses readLatestPointerFromDisk", async (t) => {
    if (!fs.existsSync(FIXTURE_MANIFEST)) {
      t.skip("nam3km selected-grib-v2 fixture manifest not present");
      return;
    }
    const runtime = makeRuntime();
    await runtime.init();
    const latest = await runtime.readLatestPointerFromDisk("nam3km", "conus");
    const tasks = await planPrefetchTasks({
      runtime,
      models: ["nam3km"],
      view: "conus",
      runsMode: "latest",
    });
    assert.ok(tasks.length > 0, "latest run has loaded frames to prefetch");
    for (const task of tasks) {
      assert.equal(task.runId, latest.run, "only the latest run is planned");
    }
  });

  test("warmFrameSounding on an already-cached frame issues ZERO network calls", async (t) => {
    if (!fs.existsSync(FIXTURE_MANIFEST)) {
      t.skip("nam3km selected-grib-v2 fixture manifest not present");
      return;
    }
    if (!fs.existsSync(WGRIB2_PATH)) {
      t.skip("wgrib2 binary not present; warmFrameSounding requires it to extract the point");
      return;
    }
    const runtime = makeRuntime();
    await runtime.init();
    const [task] = await planPrefetchTasks({
      runtime,
      models: ["nam3km"],
      view: "conus",
      runsMode: "latest",
    });
    assert.ok(task, "at least one loaded nam3km frame to warm");

    // First warm populates the raw caches (idx, content-length, selected-grib).
    // Requires the on-disk selected-grib-v2/idx fixtures for this frame — network-free
    // only if those are present; otherwise this call would fetch, so guard on it.
    const rawCacheDir = path.join(FIXTURE_CACHE_ROOT, "raw-noaa");
    const first = await warmFrameSounding(task, {
      rawCacheDir,
      wgrib2Path: WGRIB2_PATH,
      rangeFetchLimiter: new AsyncSemaphore(1),
    });
    if (first.status === "failed") {
      t.skip(`frame not fully cached in fixture (${first.error}); cannot assert idempotent no-network path`);
      return;
    }

    // Second warm must be network-free: any global.fetch or limiter use throws.
    const originalFetch = global.fetch;
    let fetchCalls = 0;
    global.fetch = async (...fetchArgs) => {
      fetchCalls += 1;
      throw new Error(`unexpected network fetch during cached warm: ${fetchArgs[0]}`);
    };
    const throwingLimiter = {
      run() {
        throw new Error("unexpected range fetch during cached warm");
      },
    };
    try {
      const second = await warmFrameSounding(task, {
        rawCacheDir,
        wgrib2Path: WGRIB2_PATH,
        rangeFetchLimiter: throwingLimiter,
      });
      assert.equal(second.status, "alreadyCached", "cached frame reports alreadyCached");
      assert.equal(fetchCalls, 0, "no network fetch on a cached frame");
    } finally {
      global.fetch = originalFetch;
    }
  });

  test("warmFrameSounding never persists parcel diagnostics (raw-only cache)", async (t) => {
    // The prefetch core must not write any parcel-diagnostic artifact: it only calls
    // buildNoaaPointSounding, which warms the raw selected-grib cache. Assert via an
    // injected buildSounding spy that no diagnostics-bearing cache write is requested.
    let capturedOptions = null;
    const fakeTask = { modelKey: "nam3km", runId: "20260702-1200Z", hour: 0, lat: 37, lon: -96 };
    const result = await warmFrameSounding(fakeTask, {
      rawCacheDir: "/tmp/does-not-matter",
      wgrib2Path: "/bin/false",
      buildSounding: async (options) => {
        capturedOptions = options;
        // Mimic buildNoaaPointSounding: returns a payload, warms raw cache only.
        return { renderProfile: { selectedGribCacheHit: false, selectedBytes: 1234 } };
      },
    });
    assert.equal(result.status, "warmed");
    assert.equal(result.bytes, 1234);
    // No parcel/diagnostic flag is passed down; buildNoaaPointSounding computes on demand.
    assert.equal("persistParcelDiagnostics" in capturedOptions, false);
    assert.equal("precomputeDiagnostics" in capturedOptions, false);
    assert.equal(capturedOptions.modelKey, "nam3km");
    assert.equal(capturedOptions.runId, "20260702-1200Z");
    assert.equal(capturedOptions.hour, 0);
  });
  ```

- [ ] **Step 2: Run test to verify it fails**
  `node --test tests-node/prefetch-soundings.test.js`
  Expected: `Cannot find module '../scripts/lib/noaa-build/prefetch-soundings'`.

- [ ] **Step 3: Write minimal implementation**
  Create `/Users/micha/Development/model-view/scripts/lib/noaa-build/prefetch-soundings.js`:
  ```js
  "use strict";

  const { buildNoaaPointSounding } = require("../noaa-beta/point-sounding");

  function domainCenterFromBounds(bounds) {
    if (!bounds || typeof bounds !== "object") {
      return null;
    }
    const north = Number(bounds.north);
    const south = Number(bounds.south);
    const west = Number(bounds.west);
    const east = Number(bounds.east);
    if (![north, south, west, east].every(Number.isFinite)) {
      return null;
    }
    return { lat: (north + south) / 2, lon: (west + east) / 2 };
  }

  async function resolveRunIdsForModel(runtime, modelKey, view, runsMode, explicitRunIds) {
    if (Array.isArray(explicitRunIds) && explicitRunIds.length > 0) {
      return explicitRunIds;
    }
    if (runsMode === "latest") {
      const pointer = await runtime.readLatestPointerFromDisk(modelKey, view);
      return pointer && pointer.run ? [pointer.run] : [];
    }
    // runsMode === "all"
    const runs = await runtime.listRunManifests(modelKey, view);
    return runs.map((run) => run.run).filter(Boolean);
  }

  async function planPrefetchTasks({ runtime, models, view, runsMode = "latest", runIds = null, hours = null }) {
    const hourFilter = Array.isArray(hours) && hours.length > 0 ? new Set(hours.map((hour) => Number(hour))) : null;
    const tasks = [];
    for (const modelKey of models) {
      const resolvedRunIds = await resolveRunIdsForModel(runtime, modelKey, view, runsMode, runIds);
      for (const runId of resolvedRunIds) {
        const manifest = await runtime.readManifestFromDisk(modelKey, runId, view);
        if (!manifest || !Array.isArray(manifest.frames)) {
          continue;
        }
        const hourStatus = manifest.hourStatus && typeof manifest.hourStatus === "object" ? manifest.hourStatus : {};
        for (const frame of manifest.frames) {
          const hour = Number(frame.hour);
          if (!Number.isFinite(hour)) {
            continue;
          }
          if (hourStatus[String(hour)] !== "loaded") {
            continue; // only prefetch frames whose raw data is actually on disk
          }
          if (hourFilter && !hourFilter.has(hour)) {
            continue;
          }
          const center = domainCenterFromBounds(frame.bounds);
          if (!center) {
            continue;
          }
          tasks.push({ modelKey, runId, hour, lat: center.lat, lon: center.lon });
        }
      }
    }
    return tasks;
  }

  async function warmFrameSounding(task, { rawCacheDir, wgrib2Path, rangeFetchLimiter = null, buildSounding = buildNoaaPointSounding } = {}) {
    const base = { modelKey: task.modelKey, runId: task.runId, hour: task.hour };
    try {
      const payload = await buildSounding({
        modelKey: task.modelKey,
        runId: task.runId,
        hour: task.hour,
        lat: task.lat,
        lon: task.lon,
        rawCacheDir,
        wgrib2Path,
        rangeFetchLimiter,
      });
      const profile = payload && payload.renderProfile ? payload.renderProfile : {};
      const cacheHit = Boolean(profile.selectedGribCacheHit);
      const bytes = Number(profile.selectedBytes) || 0;
      return { ...base, status: cacheHit ? "alreadyCached" : "warmed", bytes };
    } catch (error) {
      return { ...base, status: "failed", bytes: 0, error: error && error.message ? error.message : String(error) };
    }
  }

  async function runSoundingPrefetch({
    runtime,
    models,
    view,
    runsMode = "latest",
    runIds = null,
    hours = null,
    rawCacheDir,
    wgrib2Path,
    rangeFetchLimiter,
    concurrency = 1,
    onProgress = null,
  }) {
    const tasks = await planPrefetchTasks({ runtime, models, view, runsMode, runIds, hours });
    const summary = { tasks: tasks.length, warmed: 0, alreadyCached: 0, failed: 0, bytes: 0 };
    let index = 0;
    const runNext = async () => {
      while (index < tasks.length) {
        const current = index;
        index += 1;
        const result = await warmFrameSounding(tasks[current], { rawCacheDir, wgrib2Path, rangeFetchLimiter });
        if (result.status === "warmed") {
          summary.warmed += 1;
        } else if (result.status === "alreadyCached") {
          summary.alreadyCached += 1;
        } else {
          summary.failed += 1;
        }
        summary.bytes += Number(result.bytes) || 0;
        if (typeof onProgress === "function") {
          onProgress(result, summary);
        }
      }
    };
    const lanes = Math.max(1, Math.min(Number(concurrency) || 1, tasks.length || 1));
    await Promise.all(Array.from({ length: lanes }, runNext));
    return summary;
  }

  module.exports = {
    domainCenterFromBounds,
    planPrefetchTasks,
    warmFrameSounding,
    runSoundingPrefetch,
  };
  ```

  Create `/Users/micha/Development/model-view/scripts/prefetch-point-soundings.js` (CLI wrapper, mirroring the runtime construction in build-noaa-beta-artifacts.js):
  ```js
  #!/usr/bin/env node

  "use strict";

  const fs = require("fs");
  const path = require("path");
  const { AsyncSemaphore } = require("./lib/local-artifact-concurrency");
  const { LocalArtifactRuntime } = require("./lib/local-artifact-runtime");
  const { NOAA_BETA_SOURCE_NAME } = require("./lib/noaa-beta-renderer");
  const { DEFAULT_ARTIFACT_PREFIX, DEFAULT_VIEW_KEY, VIEW_CONFIG } = require("./lib/modelview-runtime");
  const { resolveModels } = require("./lib/noaa-build/run-resolution");
  const { loadDotEnv, resolveCacheRootEnv } = require("./lib/env-config");
  const { runSoundingPrefetch } = require("./lib/noaa-build/prefetch-soundings");
  const { parseArgs } = require("./build-noaa-beta-artifacts");

  const ROOT_DIR = path.resolve(__dirname, "..");
  const DEFAULT_CACHE_ROOT = path.join(ROOT_DIR, "output/noaa-beta-cache");
  const DEFAULT_LOCAL_WGRIB2_PATH = path.join(ROOT_DIR, "output/noaa-beta-tools/bin/wgrib2");
  const DEFAULT_MODELS = "nam3km,hrrr";

  function defaultWgrib2Path() {
    return fs.existsSync(DEFAULT_LOCAL_WGRIB2_PATH) ? DEFAULT_LOCAL_WGRIB2_PATH : "wgrib2";
  }

  function parseRunsMode(raw) {
    const value = String(raw || "latest").trim().toLowerCase();
    if (value === "latest" || value === "all") {
      return { runsMode: value, runIds: null };
    }
    const runIds = value
      .split(",")
      .map((token) => token.trim())
      .filter(Boolean);
    if (runIds.length === 0) {
      throw new Error("--runs must be 'latest', 'all', or a comma list of run ids (YYYYMMDD-HHMMZ).");
    }
    return { runsMode: "list", runIds };
  }

  function parseHoursArg(raw) {
    if (raw === undefined || raw === null || raw === "") {
      return null;
    }
    const hours = String(raw)
      .split(",")
      .map((token) => Number(token.trim()))
      .filter((hour) => Number.isFinite(hour) && hour >= 0)
      .map((hour) => Math.round(hour));
    return hours.length > 0 ? Array.from(new Set(hours)) : null;
  }

  async function main() {
    loadDotEnv(path.join(ROOT_DIR, ".env"));
    const args = parseArgs(process.argv.slice(2));
    const models = resolveModels(args.models || args.model || DEFAULT_MODELS);
    const view = String(args.view || DEFAULT_VIEW_KEY).trim() || DEFAULT_VIEW_KEY;
    if (!VIEW_CONFIG[view]) {
      throw new Error(`Unsupported view '${view}'. Supported: ${Object.keys(VIEW_CONFIG).join(", ")}`);
    }
    const { runsMode, runIds } = parseRunsMode(args.runs);
    const hours = parseHoursArg(args.hours);
    const cacheRoot = path.resolve(String(args["cache-root"] || resolveCacheRootEnv() || DEFAULT_CACHE_ROOT));
    const artifactPrefix = String(args["artifact-prefix"] || process.env.MODELVIEW_ARTIFACT_PREFIX || DEFAULT_ARTIFACT_PREFIX).trim();
    const rawCacheDir = path.join(cacheRoot, "raw-noaa");
    const wgrib2Path = String(args.wgrib2 || process.env.WGRIB2 || defaultWgrib2Path()).trim() || "wgrib2";
    const concurrency = Math.max(1, Math.round(Number(args["concurrency"]) || 4));
    const rangeFetchLimiter = new AsyncSemaphore(
      Math.max(1, Math.round(Number(args["range-concurrency"]) || 4)),
    );

    const runtime = new LocalArtifactRuntime({ cacheRoot, artifactPrefix, sourceName: NOAA_BETA_SOURCE_NAME });
    await runtime.init();
    console.log(
      `[noaa-sounding-prefetch] models=${models.join(",")} view=${view} runs=${runsMode}${runIds ? `(${runIds.join(",")})` : ""} cache=${cacheRoot}`,
    );
    const summary = await runSoundingPrefetch({
      runtime,
      models,
      view,
      runsMode,
      runIds,
      hours,
      rawCacheDir,
      wgrib2Path,
      rangeFetchLimiter,
      concurrency,
      onProgress: (result) => {
        const label = `${result.modelKey}/${result.runId} F${String(result.hour).padStart(3, "0")}`;
        if (result.status === "failed") {
          console.warn(`[noaa-sounding-prefetch] ${label} failed: ${result.error}`);
        } else {
          console.log(`[noaa-sounding-prefetch] ${label} ${result.status}`);
        }
      },
    });
    console.log(
      `[noaa-sounding-prefetch] done tasks=${summary.tasks} warmed=${summary.warmed} cached=${summary.alreadyCached} failed=${summary.failed} bytes=${summary.bytes}`,
    );
    if (summary.failed > 0) {
      process.exitCode = 1;
    }
  }

  if (require.main === module) {
    main().catch((error) => {
      console.error(error && error.stack ? error.stack : error);
      process.exit(1);
    });
  }

  module.exports = { parseRunsMode, parseHoursArg };
  ```

  Add the npm script. In `/Users/micha/Development/model-view/package.json`, in the `scripts` block, add after the `"noaa:build:test"` line. Replace this existing line:
  ```json
      "noaa:build:test": "node scripts/build-noaa-beta-test-render.js",
  ```
  with:
  ```json
      "noaa:build:test": "node scripts/build-noaa-beta-test-render.js",
      "noaa:prefetch-soundings": "node scripts/prefetch-point-soundings.js",
  ```
  (Verify the exact surrounding text of the `noaa:build:test` line in package.json before editing; match its indentation and trailing comma.)

  **Honesty note for the implementer (state in the PR / task log):** `warmFrameSounding` requires the `wgrib2` binary (`output/noaa-beta-tools/bin/wgrib2` or `$WGRIB2`) to extract the point value — the "zero network on cached frame" test `t.skip`s when wgrib2 is absent, and also skips if the fixture frame is not fully raw-cached (idx + content-length + selected-grib all present), because in that case the first warm would legitimately fetch. The idempotency claim is: given a fully-cached frame, a second warm makes zero `global.fetch` calls and never touches the `rangeFetchLimiter`. The prefetch core caches **raw fields only** — it calls `buildNoaaPointSounding` with no diagnostics-persistence flag, so parcel diagnostics are recomputed on demand (plan.md durable decision), asserted by the `buildSounding` spy test.

- [ ] **Step 4: Run test to verify it passes**
  `node --test tests-node/prefetch-soundings.test.js`
  Expected: all tests pass; the wgrib2/network-dependent assertions run when the fixture + binary are present, otherwise `t.skip` with a stated reason (test run still green). Also run `node -e "require('./scripts/prefetch-point-soundings.js')"` and `node -e "require('./scripts/lib/noaa-build/prefetch-soundings.js')"` to confirm both load, and `node -e "const p=require('./package.json'); if(!p.scripts['noaa:prefetch-soundings']) throw new Error('missing script'); console.log('ok')"`.

- [ ] **Step 5: Commit**
  `git add scripts/lib/noaa-build/prefetch-soundings.js scripts/prefetch-point-soundings.js package.json tests-node/prefetch-soundings.test.js && git commit -m "$(printf 'Add point-sounding GRIB prefetch (core + CLI)\n\nEnumerate loaded frames from on-disk manifests, pick each frame domain\ncenter, and warm buildNoaaPointSounding once per (model,run,hour) behind\na shared AsyncSemaphore rangeFetchLimiter. Idempotent: a fully-cached\nframe reports alreadyCached with zero network calls. Caches raw fields\nonly (no parcel diagnostics). Wire the noaa:prefetch-soundings script.\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"`


## Phase D: Server action layer (localhost-only)

## Phase D — Server action layer

Extends `scripts/lib/local-artifact-server.js` with an `/actions/*` branch inside `handleRequest` (before the 404 fallthrough at line 64), an in-memory job registry, and child-process tracking so the existing SIGINT/SIGTERM shutdown kills builds. GET routes are read-only; mutations are POST only. All path-like inputs pass `isSafePathComponent`; `model`/`view`/`category`/`tier` pass enum allowlists. Spawns use an argv array (`shell:false`). Tests spin an ephemeral server and stub the child spawn and upstream probes — no real build, no live NOAA.

**Shared design note for the implementer (applies to D1–D3):**
- `createLocalArtifactServer(options={})` gets two new injectable options with production defaults so tests can stub without hitting NOAA or spawning real builds:
  - `options.probeUpstreamRuns` — async `({modelKey, viewKey}) => Array<{date, cycle, runId}>`; default probes NOAA via `buildRecentCycleCandidates` + `noaaForecastHourExists`.
  - `options.spawnBuildProcess` — `(scriptPath, argv, spawnOptions) => ChildProcess-like`; default is `child_process.spawn(process.execPath, [scriptPath, ...argv], spawnOptions)`.
- A single `JobRegistry` instance is created inside `createLocalArtifactServer` and passed to `handleRequest` (thread it through the closure). It owns the `Map<jobId, job>` and the set of live children.

---

### Task D.1: `/actions/available-runs` GET route (built + upstream-probed runs, cached)
**Files:**
- Modify `scripts/lib/local-artifact-server.js` (add route dispatch in `handleRequest` before line 64; add `handleAvailableRunsRequest`, `parseModelsParam`, enum allowlist constants, `probeUpstreamRuns` default + injection in `createLocalArtifactServer`)
- Test `tests-node/local-artifact-actions.test.js` (new)

**Interfaces:**
- Consumes: `runtime.listRunManifests(modelKey, viewKey)` → `Array<{run, frameCount, loadedFrameCount, complete, latest, ...}>`; `isSafePathComponent(value)`; `sendJsonError(res, status, message)`; `buildRecentCycleCandidates(modelKey)` and `noaaForecastHourExists({modelKey, noaaBaseUrl, run, hour})` from `./noaa-build/run-resolution`; `resolveNoaaBaseUrls(args, models)`.
- Produces: `createLocalArtifactServer({..., probeUpstreamRuns})` option (async `({modelKey, viewKey}) => Array<{date, cycle, runId}>`); route `GET /actions/available-runs?models=a,b&view=conus` → `200 { view, runs: { <model>: { built: [...], upstream: [...] } } }`; module now exports `{ createLocalArtifactServer, ACTION_MODEL_KEYS, ACTION_VIEW_KEYS, ACTION_CATEGORY_IDS, ACTION_TIERS }` for reuse by D2/D3 and the parity test.

- [ ] **Step 1: Write the failing test** — create `tests-node/local-artifact-actions.test.js`:
```js
"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { createLocalArtifactServer } = require("../scripts/lib/local-artifact-server");

function request(port, method, rawPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: rawPath,
        method,
        headers: payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {},
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

async function withServer(options, run) {
  const cacheRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "modelview-actions-"));
  const { runtime, server } = createLocalArtifactServer({ cacheRoot, ...options });
  await runtime.init();
  await new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    await run({ runtime, cacheRoot, port: server.address().port });
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
    await fs.promises.rm(cacheRoot, { recursive: true, force: true });
  }
}

test("available-runs returns built runs and probed upstream runs without touching NOAA", async () => {
  let probeCalls = 0;
  const stubProbe = async ({ modelKey }) => {
    probeCalls += 1;
    return [{ date: "20260703", cycle: "12", runId: "20260703-1200Z" }];
  };
  await withServer({ probeUpstreamRuns: stubProbe }, async ({ runtime, port }) => {
    const runId = "20260703-0600Z";
    const manifestPath = runtime.getManifestStoragePath("hrrr", runId, runtime.defaultViewKey);
    await fs.promises.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.promises.writeFile(
      manifestPath,
      JSON.stringify({ model: "hrrr", run: runId, view: runtime.defaultViewKey, frames: [], hourStatus: {} }),
    );

    const res = await request(port, "GET", "/actions/available-runs?models=hrrr&view=conus");
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.view, "conus");
    assert.ok(Array.isArray(body.runs.hrrr.built), "built runs is an array");
    assert.equal(body.runs.hrrr.built[0].run, runId, "built run surfaced from listRunManifests");
    assert.equal(body.runs.hrrr.upstream[0].runId, "20260703-1200Z", "upstream run surfaced from the probe stub");
    assert.equal(probeCalls, 1, "upstream probe invoked exactly once for the one model");
  });
});

test("available-runs rejects an unknown model with 400 and does not probe", async () => {
  let probeCalls = 0;
  await withServer(
    { probeUpstreamRuns: async () => { probeCalls += 1; return []; } },
    async ({ port }) => {
      const res = await request(port, "GET", "/actions/available-runs?models=badmodel&view=conus");
      assert.equal(res.status, 400, "unknown model is rejected");
      assert.equal(probeCalls, 0, "no upstream probe for a rejected request");
    },
  );
});

test("available-runs rejects an unknown view with 400", async () => {
  await withServer({ probeUpstreamRuns: async () => [] }, async ({ port }) => {
    const res = await request(port, "GET", "/actions/available-runs?models=hrrr&view=mars");
    assert.equal(res.status, 400, "unknown view is rejected");
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `node --test tests-node/local-artifact-actions.test.js`. Expected failure: the three tests fail because `/actions/available-runs` returns `404 Not Found` (route absent), so `res.status` is 404 not 200/400 and `JSON.parse` on `"Not Found"` throws.

- [ ] **Step 3: Write minimal implementation** in `scripts/lib/local-artifact-server.js`.

  (a) Extend the requires at the top (after line 8, `const { buildNoaaPointSounding } = require("./noaa-beta-renderer");`), adding:
```js
const {
  buildRecentCycleCandidates,
  noaaForecastHourExists,
  resolveNoaaBaseUrls,
} = require("./noaa-build/run-resolution");
```

  (b) After the `isSafePathComponent` definition (line 35), add the enum allowlists and the upstream-probe default:
```js
// Enum allowlists for the /actions/* control surface. The server spawns
// processes, so every model/view/category/tier is validated against a fixed
// set before it can reach a path builder or a spawn argv (spec §3.3).
const ACTION_MODEL_KEYS = Object.freeze(["gfs", "nam", "nam3km", "hrrr"]);
const ACTION_VIEW_KEYS = Object.freeze(["conus", "na"]);
const ACTION_CATEGORY_IDS = Object.freeze([
  "surface",
  "precip",
  "radar",
  "cloud",
  "severe",
  "winter",
  "upperAir",
]);
const ACTION_TIERS = Object.freeze(["simple", "full"]);

function isAllowedModel(modelKey) {
  return ACTION_MODEL_KEYS.includes(modelKey);
}

function isAllowedView(viewKey) {
  return ACTION_VIEW_KEYS.includes(viewKey);
}

// Default upstream probe: for each candidate cycle, HEAD-probe f000 and keep the
// runs NOAA has published. Injected via createLocalArtifactServer so tests never
// hit live NOAA.
async function probeUpstreamRunsDefault({ modelKey, viewKey }) {
  void viewKey;
  const noaaBaseUrl = resolveNoaaBaseUrls({}, [modelKey])[modelKey];
  const candidates = buildRecentCycleCandidates(modelKey).slice(0, 8);
  const runs = [];
  for (const candidate of candidates) {
    const available = await noaaForecastHourExists({ modelKey, noaaBaseUrl, run: candidate, hour: 0 });
    if (available) {
      runs.push({ date: candidate.date, cycle: candidate.cycle, runId: `${candidate.date}-${candidate.cycle}00Z` });
    }
  }
  return runs;
}
```

  (c) In `createLocalArtifactServer`, capture the injectable probe and pass an actions context into the closure. Replace the current function head (lines 10-24):
```js
function createLocalArtifactServer(options = {}) {
  const runtime = options.runtime || new LocalArtifactRuntime(options);
  const server = http.createServer((req, res) => {
    void handleRequest(runtime, req, res).catch((error) => {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify({
          error: String(error && error.message ? error.message : error),
        }),
      );
    });
  });
  return { runtime, server };
}
```
  with:
```js
function createLocalArtifactServer(options = {}) {
  const runtime = options.runtime || new LocalArtifactRuntime(options);
  const actions = {
    probeUpstreamRuns:
      typeof options.probeUpstreamRuns === "function" ? options.probeUpstreamRuns : probeUpstreamRunsDefault,
    upstreamRunCache: new Map(),
  };
  const server = http.createServer((req, res) => {
    void handleRequest(runtime, req, res, actions).catch((error) => {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify({
          error: String(error && error.message ? error.message : error),
        }),
      );
    });
  });
  return { runtime, server, actions };
}
```

  (d) Update the `handleRequest` signature and add the `/actions/` dispatch before the 404. Replace the signature line (line 37) `async function handleRequest(runtime, req, res) {` with `async function handleRequest(runtime, req, res, actions) {`, and insert this block immediately before the `res.statusCode = 404;` fallthrough (currently line 64):
```js
  if (requestPath === "/actions/available-runs") {
    await handleAvailableRunsRequest(runtime, req, requestUrl, res, actions);
    return;
  }
```

  (e) Add the handler + helpers near the other `handle*Request` functions (e.g. after `handlePointSoundingRequest` ends at line 179):
```js
function parseModelsParam(rawValue) {
  return String(rawValue || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

async function handleAvailableRunsRequest(runtime, req, requestUrl, res, actions) {
  if (req.method !== "GET") {
    sendJsonError(res, 405, "available-runs only accepts GET.");
    return;
  }
  const models = parseModelsParam(requestUrl.searchParams.get("models"));
  const viewKey = String(requestUrl.searchParams.get("view") || runtime.defaultViewKey).trim() || runtime.defaultViewKey;
  if (models.length === 0) {
    sendJsonError(res, 400, "available-runs requires at least one model (?models=hrrr,nam3km).");
    return;
  }
  if (!isAllowedView(viewKey) || !isSafePathComponent(viewKey)) {
    sendJsonError(res, 400, `Unsupported view '${viewKey}'.`);
    return;
  }
  for (const modelKey of models) {
    if (!isAllowedModel(modelKey) || !isSafePathComponent(modelKey)) {
      sendJsonError(res, 400, `Unsupported model '${modelKey}'.`);
      return;
    }
  }
  const runs = {};
  for (const modelKey of models) {
    const built = await runtime.listRunManifests(modelKey, viewKey);
    const upstream = await getCachedUpstreamRuns(actions, modelKey, viewKey);
    runs[modelKey] = { built, upstream };
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify({ view: viewKey, runs }));
}

const UPSTREAM_RUN_CACHE_TTL_MS = 60_000;

async function getCachedUpstreamRuns(actions, modelKey, viewKey) {
  const cacheKey = `${modelKey}|${viewKey}`;
  const cached = actions.upstreamRunCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < UPSTREAM_RUN_CACHE_TTL_MS) {
    return cached.runs;
  }
  const runs = await actions.probeUpstreamRuns({ modelKey, viewKey });
  actions.upstreamRunCache.set(cacheKey, { fetchedAt: Date.now(), runs });
  return runs;
}
```

  (f) Extend the module exports (lines 289-291):
```js
module.exports = {
  createLocalArtifactServer,
  ACTION_MODEL_KEYS,
  ACTION_VIEW_KEYS,
  ACTION_CATEGORY_IDS,
  ACTION_TIERS,
};
```

- [ ] **Step 4: Run test to verify it passes** — `node --test tests-node/local-artifact-actions.test.js`. Expected: all three tests pass (built run surfaced, upstream stub surfaced, bad model/view → 400, probe not called on rejection).

- [ ] **Step 5: Commit** — `git add scripts/lib/local-artifact-server.js tests-node/local-artifact-actions.test.js && git commit -m "Add /actions/available-runs route with enum-validated models/view and cached upstream probe

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`

---

### Task D.2: `POST /actions/render` — selection validation, job registry, argv spawn, shutdown kill
**Files:**
- Modify `scripts/lib/local-artifact-server.js` (add `JobRegistry` class, `readJsonBody`, `validateRenderSelection`, `buildBuilderArgv`, `handleRenderRequest`; wire registry into `createLocalArtifactServer` + `handleRequest`; scrape builder stdout)
- Modify `scripts/local-data-server.js` (kill tracked jobs on SIGINT/SIGTERM)
- Test `tests-node/local-artifact-actions.test.js` (append)

**Interfaces:**
- Consumes: `ACTION_MODEL_KEYS/ACTION_VIEW_KEYS/ACTION_CATEGORY_IDS/ACTION_TIERS` (D1); `isSafePathComponent`; `sendJsonError`; the §1.4 selection wire contract; the builder script `scripts/build-noaa-beta-artifacts.js` and its stdout log format (`[noaa-beta] <model>/<run> F### complete|reused|error ...` + final `results:[{model,run,built,reused,failed,frameCount}]` JSON).
- Produces: `createLocalArtifactServer({..., spawnBuildProcess})` option (`(scriptPath, argv, spawnOptions) => childLike` where childLike has `pid`, `stdout`/`stderr` streams, `on("exit", cb)`, `kill(sig)`); `actions.jobs` = `JobRegistry` instance with methods `startJob(...)`, `getJob(jobId)`, `listJobs()`, `hasRunningJob(model, run, view)`, `killAll(signal)`; `POST /actions/render` → `200 { jobId }` or `400`/`409`; `buildBuilderArgv(selection)` → `string[]` (exact flag order below); `validateRenderSelection(selection)` → `{ ok:true, normalized } | { ok:false, error }`.

- [ ] **Step 1: Write the failing test** — append to `tests-node/local-artifact-actions.test.js`:
```js
function makeSpawnStub() {
  const calls = [];
  const children = [];
  const spawnBuildProcess = (scriptPath, argv, spawnOptions) => {
    const listeners = { exit: [] };
    const child = {
      pid: 4242 + children.length,
      killed: false,
      stdout: { on() {} },
      stderr: { on() {} },
      on(event, cb) {
        (listeners[event] = listeners[event] || []).push(cb);
      },
      kill() {
        this.killed = true;
        for (const cb of listeners.exit) {
          cb(0, "SIGTERM");
        }
      },
      _emitExit(code) {
        for (const cb of listeners.exit) {
          cb(code, null);
        }
      },
    };
    calls.push({ scriptPath, argv, spawnOptions });
    children.push(child);
    return child;
  };
  return { spawnBuildProcess, calls, children };
}

const VALID_RENDER_BODY = {
  models: ["hrrr"],
  view: "conus",
  run: "latest",
  categories: {
    surface: true,
    precip: true,
    radar: false,
    cloud: true,
    severe: { enabled: true, tier: "simple" },
    winter: { enabled: false, tier: "full" },
    upperAir: true,
  },
};

test("render spawns the builder with an argv array and returns a jobId", async () => {
  const spawn = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ port }) => {
    const res = await request(port, "POST", "/actions/render", VALID_RENDER_BODY);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.jobId, "a jobId is returned");
    assert.equal(spawn.calls.length, 1, "exactly one build spawned");
    const { scriptPath, argv } = spawn.calls[0];
    assert.ok(scriptPath.endsWith("build-noaa-beta-artifacts.js"), "spawns the builder script");
    assert.ok(Array.isArray(argv), "argv is an array (shell:false)");
    assert.ok(argv.includes("--models=hrrr"), "models flag marshalled");
    assert.ok(argv.includes("--view=conus"), "view flag marshalled");
    assert.ok(argv.includes("--categories=surface,precip,cloud,severe,upperAir"), "enabled categories marshalled");
    assert.ok(argv.includes("--severe-tier=simple"), "severe tier marshalled");
    assert.ok(argv.includes("--winter-tier=full"), "winter tier marshalled even though winter is disabled");
    assert.ok(!argv.some((a) => /[;&|`$]/.test(a)), "no shell metacharacters reach argv");
  });
});

test("render rejects an unknown tier with 400 and does not spawn", async () => {
  const spawn = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ port }) => {
    const bad = JSON.parse(JSON.stringify(VALID_RENDER_BODY));
    bad.categories.severe.tier = "turbo";
    const res = await request(port, "POST", "/actions/render", bad);
    assert.equal(res.status, 400, "bad tier rejected");
    assert.equal(spawn.calls.length, 0, "no build spawned on a rejected selection");
  });
});

test("render rejects an unknown model with 400 and does not spawn", async () => {
  const spawn = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ port }) => {
    const bad = JSON.parse(JSON.stringify(VALID_RENDER_BODY));
    bad.models = ["hrrr", "badmodel"];
    const res = await request(port, "POST", "/actions/render", bad);
    assert.equal(res.status, 400, "bad model rejected");
    assert.equal(spawn.calls.length, 0, "no build spawned");
  });
});

test("render rejects a duplicate (model,run,view) job with 409 while running", async () => {
  const spawn = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ port }) => {
    const first = await request(port, "POST", "/actions/render", VALID_RENDER_BODY);
    assert.equal(first.status, 200, "first render accepted");
    const second = await request(port, "POST", "/actions/render", VALID_RENDER_BODY);
    assert.equal(second.status, 409, "duplicate running job rejected");
    assert.equal(spawn.calls.length, 1, "duplicate did not spawn a second build");
  });
});

test("render only accepts POST", async () => {
  const spawn = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ port }) => {
    const res = await request(port, "GET", "/actions/render");
    assert.equal(res.status, 405, "GET on the mutation route is rejected");
    assert.equal(spawn.calls.length, 0, "no spawn on a wrong-method request");
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `node --test tests-node/local-artifact-actions.test.js`. Expected: the five new tests fail — `/actions/render` returns `404` so status assertions (200/400/409/405) fail and `JSON.parse(res.body)` throws on `"Not Found"`.

- [ ] **Step 3: Write minimal implementation** in `scripts/lib/local-artifact-server.js`.

  (a) Add `const { spawn } = require("child_process");` to the requires (after line 5, next to the existing `const path = require("path");`), and resolve the builder script path near the top-level constants (after `SAFE_PATH_COMPONENT`, line 31):
```js
const BUILDER_SCRIPT_PATH = path.resolve(__dirname, "..", "build-noaa-beta-artifacts.js");
```

  (b) Add the `JobRegistry` class and selection/argv helpers (place after the `getCachedUpstreamRuns` helper from D1):
```js
let JOB_SEQUENCE = 0;

function nextJobId() {
  JOB_SEQUENCE += 1;
  return `job-${Date.now().toString(36)}-${JOB_SEQUENCE.toString(36)}`;
}

// Owns the in-memory job map and the set of live children so the process
// shutdown can kill every build (no zombies). One running job per
// (model, run, view) at a time.
class JobRegistry {
  constructor(spawnBuildProcess) {
    this.spawnBuildProcess =
      typeof spawnBuildProcess === "function"
        ? spawnBuildProcess
        : (scriptPath, argv, spawnOptions) => spawn(process.execPath, [scriptPath, ...argv], spawnOptions);
    this.jobs = new Map();
    this.children = new Set();
  }

  runningKey(model, run, view) {
    return `${model}|${run}|${view}`;
  }

  hasRunningJob(model, run, view) {
    const key = this.runningKey(model, run, view);
    for (const job of this.jobs.values()) {
      if (job.status === "running" && this.runningKey(job.model, job.run, job.view) === key) {
        return true;
      }
    }
    return false;
  }

  startJob({ scriptPath, argv, model, run, view, kind }) {
    const jobId = nextJobId();
    const job = {
      jobId,
      kind: kind || "render",
      status: "running",
      model,
      run,
      view,
      pid: null,
      built: 0,
      reused: 0,
      failed: 0,
      total: 0,
      log: [],
      error: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
    };
    this.jobs.set(jobId, job);
    const child = this.spawnBuildProcess(scriptPath, argv, {
      cwd: path.resolve(__dirname, "..", ".."),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    job.pid = child.pid || null;
    this.children.add(child);
    const onLine = (line) => this.applyLogLine(job, line);
    attachLineReader(child.stdout, onLine);
    attachLineReader(child.stderr, onLine);
    child.on("exit", (code) => {
      this.children.delete(child);
      job.endedAt = new Date().toISOString();
      if (job.status === "running") {
        job.status = Number(code) === 0 ? "done" : "failed";
        if (Number(code) !== 0 && !job.error) {
          job.error = `Builder exited with code ${code}.`;
        }
      }
    });
    return job;
  }

  // Scrape the builder's progress lines and final JSON summary. Frame lines drive
  // built/reused/failed counters; the final summary (results[]) is authoritative.
  applyLogLine(job, line) {
    const text = String(line || "").trim();
    if (!text) {
      return;
    }
    if (job.log.length < 500) {
      job.log.push(text);
    }
    if (/\bcomplete\b/.test(text) && /\bF\d{3}\b/.test(text)) {
      job.built += 1;
    } else if (/\breused\b/.test(text) && /\bF\d{3}\b/.test(text)) {
      job.reused += 1;
    } else if (/\berror\b/.test(text) && /\bF\d{3}\b/.test(text)) {
      job.failed += 1;
    }
    const summary = tryParseBuilderSummary(job._summaryBuffer, text);
    if (summary && Array.isArray(summary.results)) {
      job._summaryBuffer = null;
      const match = summary.results.find((entry) => String(entry.model) === job.model) || summary.results[0];
      if (match) {
        job.built = Number(match.built) || job.built;
        job.reused = Number(match.reused) || job.reused;
        job.failed = Number(match.failed) || job.failed;
        job.total = Number(match.frameCount) || job.total;
        if (String(summary.results[0]?.run || "").trim() && job.run === "latest") {
          job.run = String(match.run || job.run);
        }
      }
    } else if (text.startsWith("{") || (job._summaryBuffer !== undefined && job._summaryBuffer !== null)) {
      job._summaryBuffer = (job._summaryBuffer || "") + text + "\n";
    }
  }

  getJob(jobId) {
    return this.jobs.get(jobId) || null;
  }

  listJobs() {
    return Array.from(this.jobs.values()).map((job) => publicJobView(job));
  }

  killAll(signal = "SIGTERM") {
    for (const child of this.children) {
      try {
        child.kill(signal);
      } catch {
        // best-effort: a child that already exited is fine.
      }
    }
  }
}

// The final builder summary is a multi-line pretty-printed JSON block. Accumulate
// candidate lines and parse when the buffer forms valid JSON with a results array.
function tryParseBuilderSummary(buffer, line) {
  const candidate = (buffer || "") + line + "\n";
  const start = candidate.indexOf("{");
  if (start < 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(candidate.slice(start));
    return parsed && Array.isArray(parsed.results) ? parsed : null;
  } catch {
    return null;
  }
}

function attachLineReader(stream, onLine) {
  if (!stream || typeof stream.on !== "function") {
    return;
  }
  let buffered = "";
  stream.on("data", (chunk) => {
    buffered += chunk.toString("utf8");
    let index = buffered.indexOf("\n");
    while (index >= 0) {
      onLine(buffered.slice(0, index));
      buffered = buffered.slice(index + 1);
      index = buffered.indexOf("\n");
    }
  });
  stream.on("end", () => {
    if (buffered) {
      onLine(buffered);
    }
  });
}

function publicJobView(job) {
  return {
    jobId: job.jobId,
    kind: job.kind,
    status: job.status,
    model: job.model,
    run: job.run,
    view: job.view,
    pid: job.pid,
    built: job.built,
    reused: job.reused,
    failed: job.failed,
    total: job.total,
    error: job.error,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
  };
}

async function readJsonBody(req, maxBytes = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("Request body too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error(`Invalid JSON body: ${error.message}`));
      }
    });
    req.on("error", reject);
  });
}

function fail(message) {
  return { ok: false, error: message };
}

// Validate the §1.4 selection wire contract against the enum allowlists. Rejects
// unknown models/view/categories/tiers so nothing outside the allowlist reaches
// a spawn argv or a path builder.
function validateRenderSelection(selection) {
  if (!selection || typeof selection !== "object") {
    return fail("A render selection object is required.");
  }
  const models = Array.isArray(selection.models)
    ? selection.models.map((value) => String(value || "").trim().toLowerCase())
    : [];
  if (models.length === 0) {
    return fail("At least one model is required.");
  }
  for (const modelKey of models) {
    if (!isAllowedModel(modelKey) || !isSafePathComponent(modelKey)) {
      return fail(`Unsupported model '${modelKey}'.`);
    }
  }
  const viewKey = String(selection.view || "conus").trim();
  if (!isAllowedView(viewKey) || !isSafePathComponent(viewKey)) {
    return fail(`Unsupported view '${viewKey}'.`);
  }
  const run = String(selection.run || "latest").trim();
  if (run !== "latest" && !isSafePathComponent(run)) {
    return fail(`Unsupported run '${run}'.`);
  }
  const categoriesInput = selection.categories && typeof selection.categories === "object" ? selection.categories : {};
  const enabledCategories = [];
  const tiers = { severe: "full", winter: "full" };
  for (const key of Object.keys(categoriesInput)) {
    if (!ACTION_CATEGORY_IDS.includes(key)) {
      return fail(`Unknown category '${key}'.`);
    }
  }
  for (const categoryId of ACTION_CATEGORY_IDS) {
    const value = categoriesInput[categoryId];
    if (value === undefined) {
      continue;
    }
    if (categoryId === "severe" || categoryId === "winter") {
      if (!value || typeof value !== "object") {
        return fail(`Category '${categoryId}' requires an { enabled, tier } object.`);
      }
      const tier = String(value.tier || "full").trim();
      if (!ACTION_TIERS.includes(tier)) {
        return fail(`Unsupported tier '${tier}' for '${categoryId}'.`);
      }
      tiers[categoryId] = tier;
      if (value.enabled === true) {
        enabledCategories.push(categoryId);
      }
    } else {
      if (typeof value !== "boolean") {
        return fail(`Category '${categoryId}' must be a boolean.`);
      }
      if (value === true) {
        enabledCategories.push(categoryId);
      }
    }
  }
  return {
    ok: true,
    normalized: {
      models,
      view: viewKey,
      run,
      categories: enabledCategories,
      severeTier: tiers.severe,
      winterTier: tiers.winter,
    },
  };
}

// Marshal a validated selection into builder CLI flags (array form, shell:false).
// Category order follows ACTION_CATEGORY_IDS so the flag is stable/testable.
function buildBuilderArgv(normalized) {
  const argv = [`--models=${normalized.models.join(",")}`, `--view=${normalized.view}`];
  const orderedCategories = ACTION_CATEGORY_IDS.filter((id) => normalized.categories.includes(id));
  argv.push(`--categories=${orderedCategories.join(",")}`);
  argv.push(`--severe-tier=${normalized.severeTier}`);
  argv.push(`--winter-tier=${normalized.winterTier}`);
  if (normalized.run && normalized.run !== "latest") {
    argv.push(`--run=${normalized.run}`);
  }
  return argv;
}

async function handleRenderRequest(runtime, req, res, actions) {
  if (req.method !== "POST") {
    sendJsonError(res, 405, "render only accepts POST.");
    return;
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJsonError(res, 400, String(error && error.message ? error.message : error));
    return;
  }
  const result = validateRenderSelection(body);
  if (!result.ok) {
    sendJsonError(res, 400, result.error);
    return;
  }
  const { normalized } = result;
  const runKey = normalized.run || "latest";
  for (const modelKey of normalized.models) {
    if (actions.jobs.hasRunningJob(modelKey, runKey, normalized.view)) {
      sendJsonError(res, 409, `A render for ${modelKey}/${runKey}/${normalized.view} is already running.`);
      return;
    }
  }
  const argv = buildBuilderArgv(normalized);
  const job = actions.jobs.startJob({
    scriptPath: BUILDER_SCRIPT_PATH,
    argv,
    model: normalized.models[0],
    run: runKey,
    view: normalized.view,
    kind: "render",
  });
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify({ jobId: job.jobId }));
}
```

  (c) In `createLocalArtifactServer`, add the registry to the `actions` object. Replace the `const actions = { ... };` block introduced in D1 with:
```js
  const actions = {
    probeUpstreamRuns:
      typeof options.probeUpstreamRuns === "function" ? options.probeUpstreamRuns : probeUpstreamRunsDefault,
    upstreamRunCache: new Map(),
    jobs: new JobRegistry(options.spawnBuildProcess),
  };
```

  (d) In `handleRequest`, add the render dispatch next to the available-runs branch (before the 404):
```js
  if (requestPath === "/actions/render") {
    await handleRenderRequest(runtime, req, res, actions);
    return;
  }
```

  (e) Export the registry hook so the server process can kill children on shutdown. Update the module exports:
```js
module.exports = {
  createLocalArtifactServer,
  ACTION_MODEL_KEYS,
  ACTION_VIEW_KEYS,
  ACTION_CATEGORY_IDS,
  ACTION_TIERS,
};
```
  (no change needed if D1 already added these; `actions.jobs` is reachable via the returned `actions`.)

  (f) In `scripts/local-data-server.js`, kill tracked jobs on shutdown. Replace the destructure at line 23 and the `shutdown` at lines 42-47. Change:
```js
  const { runtime, server } = createLocalArtifactServer({
    cacheRoot,
    artifactPrefix,
    reflectivityGates,
  });
```
  to:
```js
  const { runtime, server, actions } = createLocalArtifactServer({
    cacheRoot,
    artifactPrefix,
    reflectivityGates,
  });
```
  and change:
```js
  const shutdown = async () => {
    await new Promise((resolve) => server.close(() => resolve()));
    process.exit(0);
  };
```
  to:
```js
  const shutdown = async () => {
    actions.jobs.killAll("SIGTERM");
    await new Promise((resolve) => server.close(() => resolve()));
    process.exit(0);
  };
```

- [ ] **Step 4: Run test to verify it passes** — `node --test tests-node/local-artifact-actions.test.js`. Expected: all D1 + D2 tests pass (argv array with `--models=hrrr`/`--view=conus`/`--categories=surface,precip,cloud,severe,upperAir`/`--severe-tier=simple`/`--winter-tier=full`, no shell metachars; bad tier/model → 400 no spawn; duplicate → 409; GET → 405).

- [ ] **Step 5: Commit** — `git add scripts/lib/local-artifact-server.js scripts/local-data-server.js tests-node/local-artifact-actions.test.js && git commit -m "Add POST /actions/render with validated selection, argv-array spawn, job registry, and shutdown kill

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`

---

### Task D.3: `POST /actions/prefetch-soundings`, `GET /actions/status/:jobId`, `GET /actions/jobs`
**Files:**
- Modify `scripts/lib/local-artifact-server.js` (add `handlePrefetchSoundingsRequest`, `handleStatusRequest`, `handleJobsRequest`; on-disk marker fallback via `runtime.getFrameMarkerPath` + `readManifestFromDisk`; dispatch in `handleRequest`; resolve prefetch script path)
- Test `tests-node/local-artifact-actions.test.js` (append)

**Interfaces:**
- Consumes: `JobRegistry` (D2) `startJob`/`getJob`/`listJobs`; `publicJobView`; `isSafePathComponent`; `sendJsonError`; the Phase C script `scripts/prefetch-point-soundings.js` (spawned via `process.execPath`, argv array); `runtime.getFrameMarkerPath(model, run, view, hour)` and `runtime.readManifestFromDisk(model, run, view)` for the on-disk marker fallback.
- Produces: `POST /actions/prefetch-soundings` (body `{model, run, view, hours?}`) → `200 { jobId }`; `GET /actions/status/:jobId` → `200 { ...publicJobView, markerCount, markerTotal }` or `404`; `GET /actions/jobs` → `200 { jobs: [...] }`.

- [ ] **Step 1: Write the failing test** — append to `tests-node/local-artifact-actions.test.js`:
```js
const PREFETCH_BODY = { model: "hrrr", run: "20260703-0600Z", view: "conus", hours: [0, 3] };

test("prefetch-soundings spawns the prefetch script with an argv array", async () => {
  const spawn = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ port }) => {
    const res = await request(port, "POST", "/actions/prefetch-soundings", PREFETCH_BODY);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.jobId, "prefetch returns a jobId");
    assert.equal(spawn.calls.length, 1, "one prefetch spawned");
    const { scriptPath, argv } = spawn.calls[0];
    assert.ok(scriptPath.endsWith("prefetch-point-soundings.js"), "spawns the prefetch script");
    assert.ok(Array.isArray(argv), "argv is an array");
    assert.ok(argv.includes("--models=hrrr"), "model marshalled");
    assert.ok(argv.includes("--view=conus"), "view marshalled");
    assert.ok(argv.includes("--runs=20260703-0600Z"), "run marshalled");
  });
});

test("prefetch-soundings rejects a bad model with 400 and does not spawn", async () => {
  const spawn = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ port }) => {
    const res = await request(port, "POST", "/actions/prefetch-soundings", { ...PREFETCH_BODY, model: "nope" });
    assert.equal(res.status, 400);
    assert.equal(spawn.calls.length, 0, "no spawn on a rejected prefetch");
  });
});

test("status reflects a job's scraped progress and on-disk marker count", async () => {
  const spawn = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ runtime, port }) => {
    // A run manifest with two frames so markerTotal resolves from the build's frames.
    const run = "20260703-0600Z";
    const manifestPath = runtime.getManifestStoragePath("hrrr", run, runtime.defaultViewKey);
    await fs.promises.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.promises.writeFile(
      manifestPath,
      JSON.stringify({
        model: "hrrr",
        run,
        view: runtime.defaultViewKey,
        frames: [{ hour: 0 }, { hour: 3 }],
        hourStatus: {},
      }),
    );
    // Drop one .complete.json marker so markerCount === 1.
    const markerPath = runtime.getFrameMarkerPath("hrrr", run, runtime.defaultViewKey, 0);
    await fs.promises.mkdir(path.dirname(markerPath), { recursive: true });
    await fs.promises.writeFile(markerPath, JSON.stringify({ hour: 0 }));

    const started = await request(port, "POST", "/actions/render", {
      models: ["hrrr"],
      view: "conus",
      run,
      categories: { surface: true },
    });
    const { jobId } = JSON.parse(started.body);
    // Simulate scraped stdout progress on the running job's child.
    spawn.children[0].stdout && spawn.children[0].stdout.on; // stub streams no-op; emit via applyLogLine path not available, so assert marker fallback only.

    const res = await request(port, "GET", `/actions/status/${jobId}`);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.jobId, jobId);
    assert.equal(body.markerTotal, 2, "denominator is the build's resolved frame count");
    assert.equal(body.markerCount, 1, "one on-disk .complete.json marker counted");
  });
});

test("status returns 404 for an unknown jobId", async () => {
  await withServer({ spawnBuildProcess: makeSpawnStub().spawnBuildProcess }, async ({ port }) => {
    const res = await request(port, "GET", "/actions/status/job-does-not-exist");
    assert.equal(res.status, 404);
  });
});

test("jobs lists active and recent jobs", async () => {
  const spawn = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ port }) => {
    await request(port, "POST", "/actions/render", {
      models: ["hrrr"],
      view: "conus",
      run: "latest",
      categories: { surface: true },
    });
    const res = await request(port, "GET", "/actions/jobs");
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body.jobs), "jobs is an array");
    assert.equal(body.jobs.length, 1, "the started job is listed");
    assert.equal(body.jobs[0].model, "hrrr");
  });
});

test("status and jobs are GET-only; prefetch is POST-only", async () => {
  const spawn = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ port }) => {
    const postStatus = await request(port, "POST", "/actions/status/anything", {});
    assert.equal(postStatus.status, 405, "status rejects POST");
    const postJobs = await request(port, "POST", "/actions/jobs", {});
    assert.equal(postJobs.status, 405, "jobs rejects POST");
    const getPrefetch = await request(port, "GET", "/actions/prefetch-soundings");
    assert.equal(getPrefetch.status, 405, "prefetch rejects GET");
    assert.equal(spawn.calls.length, 0, "no spawns from wrong-method requests");
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `node --test tests-node/local-artifact-actions.test.js`. Expected: the new tests fail — `/actions/prefetch-soundings`, `/actions/status/:jobId`, `/actions/jobs` all return `404` (routes absent).

- [ ] **Step 3: Write minimal implementation** in `scripts/lib/local-artifact-server.js`.

  (a) Add the prefetch script path constant next to `BUILDER_SCRIPT_PATH`:
```js
const PREFETCH_SOUNDINGS_SCRIPT_PATH = path.resolve(__dirname, "..", "prefetch-point-soundings.js");
```

  (b) Add the three handlers + the marker-count helper (after `handleRenderRequest`):
```js
async function handlePrefetchSoundingsRequest(runtime, req, res, actions) {
  if (req.method !== "POST") {
    sendJsonError(res, 405, "prefetch-soundings only accepts POST.");
    return;
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJsonError(res, 400, String(error && error.message ? error.message : error));
    return;
  }
  const modelKey = String(body.model || "").trim().toLowerCase();
  const viewKey = String(body.view || runtime.defaultViewKey).trim();
  const run = String(body.run || "latest").trim();
  if (!isAllowedModel(modelKey) || !isSafePathComponent(modelKey)) {
    sendJsonError(res, 400, `Unsupported model '${modelKey}'.`);
    return;
  }
  if (!isAllowedView(viewKey) || !isSafePathComponent(viewKey)) {
    sendJsonError(res, 400, `Unsupported view '${viewKey}'.`);
    return;
  }
  if (run !== "latest" && !isSafePathComponent(run)) {
    sendJsonError(res, 400, `Unsupported run '${run}'.`);
    return;
  }
  const hours = Array.isArray(body.hours)
    ? body.hours.map((value) => Math.round(Number(value))).filter((value) => Number.isFinite(value) && value >= 0)
    : [];
  if (actions.jobs.hasRunningJob(modelKey, run, viewKey)) {
    sendJsonError(res, 409, `A prefetch for ${modelKey}/${run}/${viewKey} is already running.`);
    return;
  }
  const argv = [`--models=${modelKey}`, `--view=${viewKey}`, `--runs=${run}`];
  if (hours.length > 0) {
    argv.push(`--hours=${hours.join(",")}`);
  }
  const job = actions.jobs.startJob({
    scriptPath: PREFETCH_SOUNDINGS_SCRIPT_PATH,
    argv,
    model: modelKey,
    run,
    view: viewKey,
    kind: "prefetch-soundings",
  });
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify({ jobId: job.jobId }));
}

// On-disk marker fallback: count .complete.json markers for the job's run.
// Denominator is the build's resolved frame count (manifest.frames), NOT any
// union-merged manifest length (spec §3.2).
async function countCompleteMarkers(runtime, job) {
  if (!job || job.run === "latest" || !isSafePathComponent(job.model) || !isSafePathComponent(job.view)) {
    return { markerCount: job?.built || 0, markerTotal: job?.total || 0 };
  }
  const manifest = await runtime.readManifestFromDisk(job.model, job.run, job.view);
  const frames = Array.isArray(manifest?.frames) ? manifest.frames : [];
  const markerTotal = frames.length || job.total || 0;
  let markerCount = 0;
  for (const frame of frames) {
    const hour = Number(frame.hour);
    if (!Number.isFinite(hour)) {
      continue;
    }
    if (await pathExists(runtime.getFrameMarkerPath(job.model, job.run, job.view, hour))) {
      markerCount += 1;
    }
  }
  return { markerCount, markerTotal };
}

async function handleStatusRequest(runtime, req, res, actions, jobId) {
  if (req.method !== "GET") {
    sendJsonError(res, 405, "status only accepts GET.");
    return;
  }
  const job = actions.jobs.getJob(jobId);
  if (!job) {
    sendJsonError(res, 404, `No job '${jobId}'.`);
    return;
  }
  const { markerCount, markerTotal } = await countCompleteMarkers(runtime, job);
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify({ ...publicJobView(job), markerCount, markerTotal }));
}

function handleJobsRequest(req, res, actions) {
  if (req.method !== "GET") {
    sendJsonError(res, 405, "jobs only accepts GET.");
    return;
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify({ jobs: actions.jobs.listJobs() }));
}
```

  (c) Add the dispatch branches in `handleRequest` (before the 404, alongside the D1/D2 branches). The status route carries a `:jobId` segment, so match it with a prefix test:
```js
  if (requestPath === "/actions/prefetch-soundings") {
    await handlePrefetchSoundingsRequest(runtime, req, res, actions);
    return;
  }
  if (requestPath === "/actions/jobs") {
    handleJobsRequest(req, res, actions);
    return;
  }
  if (requestPath.startsWith("/actions/status/")) {
    const jobId = requestPath.slice("/actions/status/".length);
    await handleStatusRequest(runtime, req, res, actions, jobId);
    return;
  }
```

- [ ] **Step 4: Run test to verify it passes** — `node --test tests-node/local-artifact-actions.test.js`. Expected: all D1+D2+D3 tests pass (prefetch spawns `prefetch-point-soundings.js` with argv; bad model → 400 no spawn; status reports `markerTotal=2`/`markerCount=1` from the build's frames; unknown jobId → 404; jobs lists the started job; wrong methods → 405).

- [ ] **Step 5: Commit** — `git add scripts/lib/local-artifact-server.js tests-node/local-artifact-actions.test.js && git commit -m "Add prefetch-soundings, status/:jobId, and jobs action routes with on-disk marker fallback

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`

---

### Task D.4: Full node-suite regression + read-only/localhost invariants
**Files:** Test-only run (no new files). Confirms no route change broke the existing server suite and that GET routes never spawn.
**Interfaces:** Consumes everything from D1–D3.

- [ ] **Step 1: Write the failing test** — append one invariant test to `tests-node/local-artifact-actions.test.js` proving GET `/actions/available-runs` and `/actions/jobs` never invoke `spawnBuildProcess`:
```js
test("read-only GET routes never spawn a child process", async () => {
  const spawn = makeSpawnStub();
  await withServer(
    { spawnBuildProcess: spawn.spawnBuildProcess, probeUpstreamRuns: async () => [] },
    async ({ port }) => {
      await request(port, "GET", "/actions/available-runs?models=hrrr&view=conus");
      await request(port, "GET", "/actions/jobs");
      await request(port, "GET", "/actions/status/whatever");
      assert.equal(spawn.calls.length, 0, "no GET route spawned a process");
    },
  );
});
```

- [ ] **Step 2: Run test to verify it fails** — `node --test tests-node/local-artifact-actions.test.js`. Expected: this passes immediately if D1–D3 are correct (GET routes are read-only by construction); if it fails, a GET path is spawning and must be fixed. (This is a guard test; a red here signals a real regression.)

- [ ] **Step 3: Run the full node suite (regression)** — `node --test tests-node/` and confirm the pre-existing `tests-node/local-artifact-server.test.js` (traversal/manifest/sounding tests) still pass unchanged — the new `/actions/*` branch was inserted before the 404 and did not touch the `/manifests/`, `/soundings/`, or asset branches.

- [ ] **Step 4: Verify pass** — Expected: the entire `tests-node/` suite is green.

- [ ] **Step 5: Commit** — `git add tests-node/local-artifact-actions.test.js && git commit -m "Guard: /actions GET routes stay read-only (never spawn)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`


## Phase E: UI render control panel

## Phase E — UI control panel

Depends on Phase A (catalog `category`/`costTier` metadata + client parity) and Phase D (`/actions/*` endpoints). Where Phase A/D internal names are not yet frozen, these tasks define self-contained client constants (`RENDER_CATEGORIES`) and consume the wire contracts from spec §1.4 / §3.1, which the Phase A2 parity test and Phase D tests guard.

Dev routing note (verified `artifact-url.ts:27-33` — `getCandidateArtifactBaseUrls()[0]` is `/__cf` in DEV, and `getArtifactBaseUrl()` returns it): in the vite dev server the artifact server is reached via the `/__cf` proxy, so all `/actions/*` calls are made against `` `${getArtifactBaseUrl()}/actions/...` `` which resolves to `/__cf/actions/...`. Playwright mocks therefore intercept `**/__cf/actions/**`.

---

### Task E.1: Render selection model + persistence (`config/render.ts`)

**Files:**
- Create `/Users/micha/Development/model-view/next/src/config/render.ts`
- Create `/Users/micha/Development/model-view/tests-node/render-selection-config.test.js`

**Interfaces:**
- Consumes: nothing (leaf module). Mirrors the server wire contract from spec §1.4.
- Produces:
  - `RENDER_STORAGE_KEY = "modelview.render.v1"`
  - `type RenderCategoryId = "surface" | "precip" | "radar" | "cloud" | "severe" | "winter" | "upperAir"`
  - `type RenderTier = "simple" | "full"`
  - `interface RenderCategoryDescriptor { id: RenderCategoryId; label: string; count: number; tiered: boolean; fullAdds?: string }`
  - `RENDER_CATEGORIES: readonly RenderCategoryDescriptor[]` (7, in panel order)
  - `interface RenderCategoryState { enabled: boolean; tier: RenderTier }`
  - `interface RenderSelection { models: ModelKey[]; view: ViewKey; run: "latest" | string; runMode: "latest" | "pick"; categories: Record<RenderCategoryId, RenderCategoryState> }`
  - `DEFAULT_RENDER_SELECTION: RenderSelection` (all categories enabled, both tiers `full`, models `["hrrr","nam3km"]`, view `"conus"`, runMode `"latest"`, run `"latest"`)
  - `cloneRenderSelection(sel): RenderSelection`
  - `normalizeRenderSelection(candidate: unknown): RenderSelection`
  - `serializeRenderSelectionWire(sel): { models; view; run; categories }` — the §1.4 POST body (non-tiered categories serialize to a bare boolean; tiered ones to `{enabled, tier}`)
  - `loadStoredRenderSelection(): RenderSelection`
  - `storeRenderSelection(sel): void`

- [ ] **Step 1: Write the failing test**

Create `/Users/micha/Development/model-view/tests-node/render-selection-config.test.js`. `tests-node` runs raw CJS via `node --test` and cannot import the `.ts` config, so this test does NOT exercise the `.ts` module directly; it pins the *category taxonomy* + *cost tiers* against the server catalog (mirrored from spec §1.1/§1.2) so the client stays coherent with Phase A1's stamps:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { getNoaaNamParameterMetadata } = require("../scripts/lib/noaa-nam-parameter-catalog");

// The 7 render categories the UI exposes, mirrored from spec §1.1. This test
// guards that the client taxonomy stays coherent with the server catalog's
// per-entry `category` stamp (added in Phase A1). If A1 renamed a category or
// re-binned a group, this fails loudly.
const CLIENT_CATEGORY_IDS = ["surface", "precip", "radar", "cloud", "severe", "winter", "upperAir"];

test("every non-hidden catalog entry maps to one of the 7 client categories", () => {
  const metadata = getNoaaNamParameterMetadata();
  const seen = new Set();
  for (const entry of Object.values(metadata)) {
    assert.ok(entry.category, `entry ${entry.key} is missing a category stamp`);
    assert.ok(
      CLIENT_CATEGORY_IDS.includes(entry.category),
      `entry ${entry.key} has unknown category ${entry.category}`,
    );
    seen.add(entry.category);
  }
  // Non-tiered families that must always be present.
  for (const id of ["surface", "precip", "radar", "cloud", "severe", "winter", "upperAir"]) {
    assert.ok(seen.has(id), `no catalog entry mapped to category ${id}`);
  }
});

test("named heavy keys carry costTier full and named cheap keys carry costTier simple", () => {
  const metadata = getNoaaNamParameterMetadata();
  const heavy = [
    "effectiveLayerSupercellCompositeParameter",
    "effectiveLayerSignificantTornadoParameter",
    "dcape",
    "snowRfConus",
    "snowWesternLinear",
    "snowCobb",
    "snowKuchera",
  ];
  const cheap = [
    "sbcape",
    "srh0to1km",
    "bulkShear0to6km",
    "supercellCompositeParameter",
    "snow10to1",
    "snowDepth",
    "wetBulbZeroHeight",
  ];
  for (const key of heavy) {
    assert.equal(metadata[key]?.costTier, "full", `${key} should be full-tier`);
  }
  for (const key of cheap) {
    assert.equal(metadata[key]?.costTier, "simple", `${key} should be simple-tier`);
  }
});
```

Note: all 14 heavy/cheap keys and `getNoaaNamParameterMetadata()` were verified to exist in `scripts/lib/noaa-nam-parameter-catalog.js` (metadata builder at line 1314). `category`/`costTier` are NOT emitted yet — Phase A1 adds them, so this test fails-first as designed.

- [ ] **Step 2: Run test to verify it fails**

```
node --test tests-node/render-selection-config.test.js
```
Expected: FAIL — `entry ... is missing a category stamp` / `metadata[key]?.costTier` is `undefined` because Phase A1's `category`/`costTier` stamps are a prerequisite. (If Phase A already landed, this passes immediately, which is acceptable — it is a drift guard, not a behavior change. If it fails because A has not landed, stop and land Phase A first; do not weaken the assertions.)

- [ ] **Step 3: Write minimal implementation**

Create `/Users/micha/Development/model-view/next/src/config/render.ts`:

```ts
import { MODEL_KEYS } from "./constants";
import type { ModelKey, ViewKey } from "../types";

export const RENDER_STORAGE_KEY = "modelview.render.v1";

export type RenderCategoryId = "surface" | "precip" | "radar" | "cloud" | "severe" | "winter" | "upperAir";
export type RenderTier = "simple" | "full";

export interface RenderCategoryDescriptor {
  id: RenderCategoryId;
  label: string;
  count: number;
  tiered: boolean;
  fullAdds?: string;
}

// Taxonomy mirrors spec §1.1. Counts are the catalog group sizes at authoring
// time; they are cosmetic (shown in the panel) and guarded for coherence by the
// Phase A2 parity test, not load-bearing for resolution.
export const RENDER_CATEGORIES: readonly RenderCategoryDescriptor[] = [
  { id: "surface", label: "Surface", count: 10, tiered: false },
  { id: "precip", label: "Precip", count: 7, tiered: false },
  { id: "radar", label: "Radar", count: 3, tiered: false },
  { id: "cloud", label: "Clouds", count: 2, tiered: false },
  { id: "upperAir", label: "Upper Air", count: 24, tiered: false },
  {
    id: "severe",
    label: "Severe",
    count: 21,
    tiered: true,
    fullAdds: "Effective SCP/STP, DCAPE (heavy)",
  },
  {
    id: "winter",
    label: "Winter",
    count: 12,
    tiered: true,
    fullAdds: "Snow RF, Western, Cobb, Kuchera",
  },
];

const RENDER_CATEGORY_IDS = RENDER_CATEGORIES.map((category) => category.id);
const TIERED_CATEGORY_IDS = new Set<RenderCategoryId>(
  RENDER_CATEGORIES.filter((category) => category.tiered).map((category) => category.id),
);

export interface RenderCategoryState {
  enabled: boolean;
  tier: RenderTier;
}

export interface RenderSelection {
  models: ModelKey[];
  view: ViewKey;
  // Concrete run id (e.g. "20260703-1200Z") when runMode === "pick"; "latest" otherwise.
  run: string;
  runMode: "latest" | "pick";
  categories: Record<RenderCategoryId, RenderCategoryState>;
}

function buildDefaultCategories(): Record<RenderCategoryId, RenderCategoryState> {
  const out = {} as Record<RenderCategoryId, RenderCategoryState>;
  for (const id of RENDER_CATEGORY_IDS) {
    out[id] = { enabled: true, tier: "full" };
  }
  return out;
}

export const DEFAULT_RENDER_SELECTION: RenderSelection = {
  models: ["hrrr", "nam3km"],
  view: "conus",
  run: "latest",
  runMode: "latest",
  categories: buildDefaultCategories(),
};

export function cloneRenderSelection(selection: RenderSelection): RenderSelection {
  const categories = {} as Record<RenderCategoryId, RenderCategoryState>;
  for (const id of RENDER_CATEGORY_IDS) {
    categories[id] = { ...selection.categories[id] };
  }
  return {
    models: [...selection.models],
    view: selection.view,
    run: selection.run,
    runMode: selection.runMode,
    categories,
  };
}

function normalizeModels(candidate: unknown): ModelKey[] {
  const raw = Array.isArray(candidate) ? candidate : [];
  const out: ModelKey[] = [];
  for (const value of raw) {
    if (typeof value === "string" && (MODEL_KEYS as string[]).includes(value) && !out.includes(value as ModelKey)) {
      out.push(value as ModelKey);
    }
  }
  return out.length > 0 ? out : [...DEFAULT_RENDER_SELECTION.models];
}

function normalizeTier(value: unknown): RenderTier {
  return value === "simple" ? "simple" : "full";
}

export function normalizeRenderSelection(candidate: unknown): RenderSelection {
  const fallback = DEFAULT_RENDER_SELECTION;
  if (!candidate || typeof candidate !== "object") {
    return cloneRenderSelection(fallback);
  }
  const raw = candidate as Partial<RenderSelection>;
  const rawCategories =
    raw.categories && typeof raw.categories === "object" ? (raw.categories as Record<string, unknown>) : {};
  const categories = {} as Record<RenderCategoryId, RenderCategoryState>;
  for (const id of RENDER_CATEGORY_IDS) {
    const entry = rawCategories[id];
    if (entry && typeof entry === "object") {
      const state = entry as Partial<RenderCategoryState>;
      categories[id] = {
        enabled: typeof state.enabled === "boolean" ? state.enabled : true,
        tier: TIERED_CATEGORY_IDS.has(id) ? normalizeTier(state.tier) : "full",
      };
    } else if (typeof entry === "boolean") {
      // Accept the compact wire form (bare boolean) on the way in.
      categories[id] = { enabled: entry, tier: "full" };
    } else {
      categories[id] = { enabled: true, tier: "full" };
    }
  }
  const runMode = raw.runMode === "pick" ? "pick" : "latest";
  const run = typeof raw.run === "string" && raw.run.trim() ? raw.run.trim() : "latest";
  return {
    models: normalizeModels(raw.models),
    view: raw.view === "na" ? "na" : "conus",
    run: runMode === "latest" ? "latest" : run,
    runMode,
    categories,
  };
}

// The POST body for /actions/render (spec §1.4): tiered categories keep
// {enabled, tier}; non-tiered ones collapse to a bare boolean so the server's
// resolver treats their tier as "full" implicitly.
export function serializeRenderSelectionWire(selection: RenderSelection): {
  models: ModelKey[];
  view: ViewKey;
  run: string;
  categories: Record<string, boolean | { enabled: boolean; tier: RenderTier }>;
} {
  const categories: Record<string, boolean | { enabled: boolean; tier: RenderTier }> = {};
  for (const id of RENDER_CATEGORY_IDS) {
    const state = selection.categories[id];
    categories[id] = TIERED_CATEGORY_IDS.has(id) ? { enabled: state.enabled, tier: state.tier } : state.enabled;
  }
  return {
    models: [...selection.models],
    view: selection.view,
    run: selection.runMode === "latest" ? "latest" : selection.run,
    categories,
  };
}

export function loadStoredRenderSelection(): RenderSelection {
  if (typeof window === "undefined") {
    return cloneRenderSelection(DEFAULT_RENDER_SELECTION);
  }
  try {
    const stored = window.localStorage.getItem(RENDER_STORAGE_KEY);
    return stored ? normalizeRenderSelection(JSON.parse(stored)) : cloneRenderSelection(DEFAULT_RENDER_SELECTION);
  } catch {
    return cloneRenderSelection(DEFAULT_RENDER_SELECTION);
  }
}

export function storeRenderSelection(selection: RenderSelection): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(RENDER_STORAGE_KEY, JSON.stringify(normalizeRenderSelection(selection)));
  } catch {
    // Ignore private-mode and quota failures; render selection should never block the app.
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```
node --test tests-node/render-selection-config.test.js
npx tsc --noEmit
```
Expected: node test PASSES (given Phase A1 landed); typecheck clean (root `tsconfig.json` includes `next/src`, target ES2022). This is a renderer-agnostic, additive module — no byte-parity concern.

- [ ] **Step 5: Commit**

```
git add next/src/config/render.ts tests-node/render-selection-config.test.js
git commit -m "$(cat <<'EOF'
Add render-selection config model + persistence (Phase E1)

Self-contained RenderSelection type, 7-category taxonomy, localStorage
persistence (modelview.render.v1) mirroring config/display.ts, and the
§1.4 wire serializer. Node test guards the client taxonomy + named
heavy/cheap cost tiers against the server catalog.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task E.2: `RenderMenu.tsx` drawer + `RenderButton` in `AppHeader` + `App.tsx` wiring

**Files:**
- Create `/Users/micha/Development/model-view/next/src/components/RenderMenu.tsx`
- Modify `/Users/micha/Development/model-view/next/src/components/AppHeader.tsx` (props interface lines 8-35; destructure lines 37-64; DisplayMenu block lines 99-104)
- Modify `/Users/micha/Development/model-view/next/src/App.tsx` (imports line 6; state line 27; persistence effect lines 73-75; AppHeader mount lines 138-165)
- Create `/Users/micha/Development/model-view/tests-react/render-menu.spec.js`

**Interfaces:**
- Consumes (from E.1): `RENDER_CATEGORIES`, `RenderSelection`, `RenderCategoryId`, `RenderTier`, `DEFAULT_RENDER_SELECTION`, `cloneRenderSelection`, `loadStoredRenderSelection`, `storeRenderSelection`, `RENDER_STORAGE_KEY`, `RenderCategoryDescriptor`; from `constants.ts`: `MODEL_KEYS`, `MODEL_CONFIG`, `VIEW_KEYS`, `VIEW_CONFIG`.
- Produces:
  - `RenderMenu` component with props `interface RenderMenuProps { selection: RenderSelection; open: boolean; onOpenChange: (open: boolean) => void; onChange: (selection: RenderSelection) => void; onReset: () => void; onSubmit: () => void; onPrefetchSoundings: () => void; job: RenderJobView | null; canSubmit: boolean }` (the `job`, `onSubmit`, `onPrefetchSoundings`, `canSubmit` props are consumed here but only exercised in E.3; E.2 passes `job={null}` and no-op handlers)
  - `type RenderJobView = { status: "queued" | "running" | "done" | "failed"; built: number; reused: number; failed: number; total: number; error?: string | null }`
  - Added `AppHeaderProps` fields: `renderSelection: RenderSelection; renderMenuOpen: boolean; renderJob: RenderJobView | null; canSubmitRender: boolean; onChangeRenderSelection: (selection: RenderSelection) => void; onChangeRenderMenuOpen: (open: boolean) => void; onResetRenderSelection: () => void; onSubmitRender: () => void; onPrefetchSoundings: () => void`
  - App state: `renderMenuOpen` (useState false), `renderSelection` (useState from `loadStoredRenderSelection`), persisted via a `useEffect`.

- [ ] **Step 1: Write the failing test**

Create `/Users/micha/Development/model-view/tests-react/render-menu.spec.js`. NOTE two correctness details baked into the assertions:
  1. Model labels come from `MODEL_CONFIG[k].label`: gfs `"GFS"`, nam `"NAM"`, nam3km `"NAM 3km"` (with a space), hrrr `"HRRR"`. The nam3km locator MUST be `{ name: "NAM 3km" }`.
  2. `drawer.getByRole("checkbox")` matches BOTH the 4 model checkboxes AND the 7 category checkboxes. Default models are `["hrrr","nam3km"]`, so the GFS/NAM model checkboxes are UNCHECKED — do NOT assert "every checkbox is checked". The "all categories enabled" check iterates the 7 category aria-labels only.

```js
const { test, expect } = require("@playwright/test");

const CATEGORY_LABELS = [
  "Surface (10)",
  "Precip (7)",
  "Radar (3)",
  "Clouds (2)",
  "Upper Air (24)",
  "Severe (21)",
  "Winter (12)",
];

async function openRenderMenu(page) {
  await page.getByRole("button", { name: "Render", exact: true }).click();
}

test("render menu opens from the header and shows the 7 categories with full-tier defaults", async ({ page }) => {
  await page.goto("/");
  await openRenderMenu(page);

  const drawer = page.getByRole("dialog", { name: "Render" });
  await expect(drawer).toBeVisible();

  for (const label of ["Surface", "Precip", "Radar", "Clouds", "Upper Air", "Severe", "Winter"]) {
    await expect(drawer.getByText(label, { exact: false }).first()).toBeVisible();
  }

  // All 7 category checkboxes default to enabled (scoped by their aria-labels so
  // the unchecked GFS/NAM model checkboxes are not swept in).
  for (const label of CATEGORY_LABELS) {
    await expect(drawer.getByRole("checkbox", { name: label })).toBeChecked();
  }

  // Tier radios exist ONLY on Severe + Winter, and default to Full.
  await expect(drawer.getByRole("radio", { name: "Severe Full" })).toBeChecked();
  await expect(drawer.getByRole("radio", { name: "Winter Full" })).toBeChecked();
  await expect(drawer.getByRole("radio", { name: "Surface Full" })).toHaveCount(0);
});

test("toggling a category persists to localStorage across reload", async ({ page }) => {
  await page.goto("/");
  await openRenderMenu(page);
  const drawer = page.getByRole("dialog", { name: "Render" });

  const radarCheckbox = drawer.getByRole("checkbox", { name: "Radar (3)" });
  await radarCheckbox.focus();
  await page.keyboard.press("Space");
  await expect(radarCheckbox).not.toBeChecked();

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const raw = localStorage.getItem("modelview.render.v1");
        return raw ? JSON.parse(raw).categories.radar.enabled : null;
      }),
    )
    .toBe(false);

  await page.reload();
  await openRenderMenu(page);
  await expect(
    page.getByRole("dialog", { name: "Render" }).getByRole("checkbox", { name: "Radar (3)" }),
  ).not.toBeChecked();
});

test("severe tier toggle persists and reset restores all-on full defaults", async ({ page }) => {
  await page.goto("/");
  await openRenderMenu(page);
  const drawer = page.getByRole("dialog", { name: "Render" });

  await drawer.getByRole("radio", { name: "Severe Simple" }).check();
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const raw = localStorage.getItem("modelview.render.v1");
        return raw ? JSON.parse(raw).categories.severe.tier : null;
      }),
    )
    .toBe("simple");

  await drawer.getByRole("button", { name: "Reset" }).click();
  await expect(drawer.getByRole("radio", { name: "Severe Full" })).toBeChecked();
  await expect(drawer.getByRole("checkbox", { name: "Radar (3)" })).toBeChecked();
});

test("HRRR-only products grey out Winter full-tier note when no CAM model is selected", async ({ page }) => {
  await page.goto("/");
  await openRenderMenu(page);
  const drawer = page.getByRole("dialog", { name: "Render" });

  // Deselect every CAM (hrrr, nam3km) so only non-CAM models remain selected.
  await drawer.getByRole("checkbox", { name: "HRRR" }).uncheck();
  await drawer.getByRole("checkbox", { name: "NAM 3km" }).uncheck();
  // Ensure at least one model stays selected.
  await drawer.getByRole("checkbox", { name: "GFS" }).check();

  // The CAM-only Winter sub-note becomes greyed (data-cam-only marker).
  await expect(drawer.locator("[data-cam-only='true']").first()).toBeVisible();
});
```

- [ ] **Step 2: Run test to verify it fails**

```
npx playwright test -c playwright.react.config.js tests-react/render-menu.spec.js --workers=1 --reporter=line
```
Expected: FAIL — `getByRole("button", { name: "Render" })` never appears (no Render button in the header yet), so `openRenderMenu` times out.

- [ ] **Step 3: Write minimal implementation**

Create `/Users/micha/Development/model-view/next/src/components/RenderMenu.tsx`:

```tsx
import { MODEL_CONFIG, MODEL_KEYS, VIEW_CONFIG, VIEW_KEYS } from "../config/constants";
import {
  RENDER_CATEGORIES,
  type RenderCategoryDescriptor,
  type RenderCategoryId,
  type RenderSelection,
  type RenderTier,
} from "../config/render";
import type { ModelKey, ViewKey } from "../types";

export type RenderJobView = {
  status: "queued" | "running" | "done" | "failed";
  built: number;
  reused: number;
  failed: number;
  total: number;
  error?: string | null;
};

interface RenderMenuProps {
  selection: RenderSelection;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (selection: RenderSelection) => void;
  onReset: () => void;
  onSubmit: () => void;
  onPrefetchSoundings: () => void;
  job: RenderJobView | null;
  canSubmit: boolean;
}

// HRRR/NAM3km are the convection-allowing models; several full-tier winter
// products (Western Linear, HRRR ASNOW) exist only for them. When the selection
// has no CAM, those sub-notes grey out (spec §4.5).
const CAM_MODELS: ModelKey[] = ["hrrr", "nam3km"];

function estimateCost(selection: RenderSelection): "Light" | "Moderate" | "Heavy" {
  // Coarse per-product weight × models × frames proxy (spec §4.3). Heavy full
  // tiers dominate; no fake seconds.
  let weight = 0;
  for (const category of RENDER_CATEGORIES) {
    const state = selection.categories[category.id];
    if (!state.enabled) {
      continue;
    }
    if (category.tiered) {
      weight += state.tier === "full" ? 3 : 1;
    } else {
      weight += category.id === "upperAir" ? 1.5 : 0.6;
    }
  }
  const frameProxy = selection.models.reduce((sum, model) => {
    const config = MODEL_CONFIG[model];
    const step = config.frameStepHours || 1;
    return sum + Math.round(config.maxHour / step) + 1;
  }, 0);
  const score = weight * Math.max(1, frameProxy);
  if (score < 120) {
    return "Light";
  }
  if (score < 320) {
    return "Moderate";
  }
  return "Heavy";
}

function costBadgeClass(cost: "Light" | "Moderate" | "Heavy"): string {
  if (cost === "Light") {
    return "bg-emerald-500/15 text-emerald-300";
  }
  if (cost === "Moderate") {
    return "bg-amber-500/15 text-amber-300";
  }
  return "bg-rose-500/15 text-rose-300";
}

export default function RenderMenu({
  selection,
  open,
  onOpenChange,
  onChange,
  onReset,
  onSubmit,
  onPrefetchSoundings,
  job,
  canSubmit,
}: RenderMenuProps) {
  const hasCam = selection.models.some((model) => CAM_MODELS.includes(model));

  const toggleModel = (model: ModelKey, checked: boolean) => {
    const next = checked
      ? Array.from(new Set([...selection.models, model]))
      : selection.models.filter((value) => value !== model);
    onChange({ ...selection, models: next });
  };
  const setView = (view: ViewKey) => onChange({ ...selection, view });
  const setRunMode = (runMode: "latest" | "pick") =>
    onChange({ ...selection, runMode, run: runMode === "latest" ? "latest" : selection.run });
  const toggleCategory = (id: RenderCategoryId, enabled: boolean) =>
    onChange({
      ...selection,
      categories: { ...selection.categories, [id]: { ...selection.categories[id], enabled } },
    });
  const setCategoryTier = (id: RenderCategoryId, tier: RenderTier) =>
    onChange({
      ...selection,
      categories: { ...selection.categories, [id]: { ...selection.categories[id], tier } },
    });

  const cost = estimateCost(selection);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        className={`rounded-lg border px-2.5 py-1.5 text-xs font-medium active:scale-95 ${
          open
            ? "border-cyan-400/30 bg-cyan-500/20 text-cyan-300"
            : "border-white/[0.06] bg-white/[0.04] text-slate-400 hover:bg-white/[0.08]"
        }`}
        aria-expanded={open}
      >
        Render
      </button>
      {open ? (
        <>
          <div className="fixed inset-0 z-40" onClick={() => onOpenChange(false)} />
          <div
            role="dialog"
            aria-label="Render"
            className="absolute right-0 top-full z-50 mt-2 w-[min(24rem,calc(100vw-1rem))] rounded-lg border border-white/[0.08] bg-slate-950/90 p-3 shadow-2xl shadow-slate-950/60 backdrop-blur-xl"
          >
            <div className="grid gap-3">
              <section className="grid gap-2 border-b border-white/[0.06] pb-3">
                <span className="text-[10px] font-medium uppercase tracking-widest text-slate-400">Models</span>
                <div className="flex flex-wrap gap-2">
                  {MODEL_KEYS.map((model) => (
                    <MenuCheckbox
                      key={model}
                      label={MODEL_CONFIG[model].label}
                      checked={selection.models.includes(model)}
                      onChange={(checked) => toggleModel(model, checked)}
                    />
                  ))}
                </div>
              </section>

              <section className="grid gap-2 border-b border-white/[0.06] pb-3">
                <MenuSelect
                  label="View"
                  value={selection.view}
                  onChange={(value) => setView(value as ViewKey)}
                  options={VIEW_KEYS.map((key) => ({ value: key, label: VIEW_CONFIG[key].label }))}
                />
                <div className="flex items-center gap-4 text-xs">
                  <span className="text-[11px] text-slate-400">Run</span>
                  <label className="flex items-center gap-1.5">
                    <input
                      type="radio"
                      name="render-run-mode"
                      checked={selection.runMode === "latest"}
                      onChange={() => setRunMode("latest")}
                      className="accent-cyan-400"
                    />
                    <span className="text-[11px] text-slate-300">Latest available</span>
                  </label>
                  <label className="flex items-center gap-1.5">
                    <input
                      type="radio"
                      name="render-run-mode"
                      checked={selection.runMode === "pick"}
                      onChange={() => setRunMode("pick")}
                      className="accent-cyan-400"
                    />
                    <span className="text-[11px] text-slate-300">Pick from list</span>
                  </label>
                </div>
              </section>

              <section className="grid gap-2 border-b border-white/[0.06] pb-3">
                <span className="text-[10px] font-medium uppercase tracking-widest text-slate-400">Categories</span>
                {RENDER_CATEGORIES.map((category) => (
                  <CategoryRow
                    key={category.id}
                    category={category}
                    enabled={selection.categories[category.id].enabled}
                    tier={selection.categories[category.id].tier}
                    hasCam={hasCam}
                    onToggle={(checked) => toggleCategory(category.id, checked)}
                    onTier={(tier) => setCategoryTier(category.id, tier)}
                  />
                ))}
              </section>

              <div className="flex items-center justify-between gap-2">
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${costBadgeClass(cost)}`}>
                  ● {cost}
                </span>
                <span className="text-[11px] text-slate-500">
                  {selection.models.length} model{selection.models.length === 1 ? "" : "s"}
                </span>
                <button
                  type="button"
                  onClick={onReset}
                  className="rounded-md border border-white/[0.06] bg-white/[0.04] px-2 py-1 text-[11px] text-slate-300 hover:bg-white/[0.08] active:scale-95"
                >
                  Reset
                </button>
              </div>

              <section className="grid gap-2 border-t border-white/[0.06] pt-3">
                <span className="text-[10px] font-medium uppercase tracking-widest text-slate-400">Soundings</span>
                <button
                  type="button"
                  onClick={onPrefetchSoundings}
                  className="rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-white/[0.08] active:scale-95"
                >
                  Prefetch soundings for run
                </button>
              </section>

              <div className="flex items-center justify-end gap-2 border-t border-white/[0.06] pt-3">
                <button
                  type="button"
                  onClick={() => onOpenChange(false)}
                  className="rounded-lg border border-white/[0.06] bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-slate-400 hover:bg-white/[0.08] active:scale-95"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={onSubmit}
                  disabled={!canSubmit || selection.models.length === 0}
                  className="rounded-lg border border-cyan-400/40 bg-cyan-500/10 px-3 py-1.5 text-xs font-medium text-cyan-300 hover:bg-cyan-500/20 active:scale-95 disabled:opacity-40"
                >
                  ▶ Render
                </button>
              </div>

              {job ? <JobProgress job={job} /> : null}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

function CategoryRow({
  category,
  enabled,
  tier,
  hasCam,
  onToggle,
  onTier,
}: {
  category: RenderCategoryDescriptor;
  enabled: boolean;
  tier: RenderTier;
  hasCam: boolean;
  onToggle: (checked: boolean) => void;
  onTier: (tier: RenderTier) => void;
}) {
  // Winter's full tier includes CAM-only products (Western Linear, HRRR ASNOW),
  // so its sub-note greys when no CAM is selected.
  const camOnly = category.id === "winter" && !hasCam;
  return (
    <div className="grid gap-1">
      <div className="flex items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => onToggle(event.target.checked)}
            className="h-4 w-4 accent-cyan-400"
            aria-label={`${category.label} (${category.count})`}
          />
          <span className="text-[11px] text-slate-300">
            {category.label} ({category.count})
          </span>
        </label>
        {category.tiered ? (
          <div className="flex items-center gap-2">
            <TierRadio label={`${category.label} Simple`} checked={tier === "simple"} onChange={() => onTier("simple")} />
            <TierRadio label={`${category.label} Full`} checked={tier === "full"} onChange={() => onTier("full")} />
          </div>
        ) : null}
      </div>
      {category.tiered && category.fullAdds ? (
        <span
          className={`pl-6 text-[10px] ${camOnly ? "text-slate-600" : "text-slate-500"}`}
          data-cam-only={camOnly ? "true" : "false"}
        >
          └ Full adds: {category.fullAdds}
        </span>
      ) : null}
    </div>
  );
}

function TierRadio({ label, checked, onChange }: { label: string; checked: boolean; onChange: () => void }) {
  return (
    <label className="flex items-center gap-1 text-[11px] text-slate-400">
      <input type="radio" checked={checked} onChange={onChange} className="accent-cyan-400" aria-label={label} />
      <span>{label.split(" ").at(-1)}</span>
    </label>
  );
}

function JobProgress({ job }: { job: RenderJobView }) {
  const pct = job.total > 0 ? Math.min(100, Math.round(((job.built + job.reused) / job.total) * 100)) : 0;
  return (
    <div className="grid gap-1 border-t border-white/[0.06] pt-3" role="status" aria-label="Render job">
      <div className="h-2 w-full overflow-hidden rounded-full bg-white/[0.06]">
        <div className="h-full rounded-full bg-cyan-400/70 transition-all" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[11px] tabular-nums text-slate-400">
        {job.status === "failed"
          ? `failed: ${job.error || "unknown error"}`
          : `${job.built + job.reused}/${job.total} · built ${job.built} · reused ${job.reused} · fail ${job.failed}`}
      </span>
    </div>
  );
}

function MenuSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3 text-xs">
      <span className="text-[11px] text-slate-400">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 rounded-lg border border-white/[0.08] bg-slate-950/80 px-2 text-xs text-slate-100 outline-none hover:border-white/20 focus:border-cyan-300/60 focus:ring-2 focus:ring-cyan-300/20"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} className="bg-slate-950">
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function MenuCheckbox({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-1.5 rounded-lg border border-white/[0.06] bg-white/[0.04] px-2 py-1 text-xs">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="h-4 w-4 accent-cyan-400"
        aria-label={label}
      />
      <span className="text-[11px] text-slate-300">{label}</span>
    </label>
  );
}
```

Verified against constants.ts:5-8 — labels are gfs `"GFS"`, nam `"NAM"`, nam3km `"NAM 3km"`, hrrr `"HRRR"`; `MODEL_CONFIG[k].maxHour`/`frameStepHours` exist (gfs step 3). `DisplayMenu`'s `MenuSelect`/`MenuCheckbox`/`MenuSlider` are LOCAL (not exported) so RenderMenu re-declares its own — no public-surface churn.

Now modify `/Users/micha/Development/model-view/next/src/components/AppHeader.tsx`.

Replace line 2 (`import DisplayMenu from "./DisplayMenu";`) with:
```tsx
import DisplayMenu from "./DisplayMenu";
import RenderMenu, { type RenderJobView } from "./RenderMenu";
```

Replace line 4 (`import type { MapDisplaySettings } from "../config/display";`) with:
```tsx
import type { MapDisplaySettings } from "../config/display";
import type { RenderSelection } from "../config/render";
```

Extend `AppHeaderProps`. Replace lines 32-35:
```tsx
  onToggleLinkViewports: () => void;
  onToggleSettings: () => void;
  onToggleThickness: () => void;
}
```
with:
```tsx
  onToggleLinkViewports: () => void;
  onToggleSettings: () => void;
  onToggleThickness: () => void;
  renderSelection: RenderSelection;
  renderMenuOpen: boolean;
  renderJob: RenderJobView | null;
  canSubmitRender: boolean;
  onChangeRenderSelection: (selection: RenderSelection) => void;
  onChangeRenderMenuOpen: (open: boolean) => void;
  onResetRenderSelection: () => void;
  onSubmitRender: () => void;
  onPrefetchSoundings: () => void;
}
```

Add the new params to the destructure. Replace lines 61-64:
```tsx
  onToggleLinkViewports,
  onToggleSettings,
  onToggleThickness,
}: AppHeaderProps) {
```
with:
```tsx
  onToggleLinkViewports,
  onToggleSettings,
  onToggleThickness,
  renderSelection,
  renderMenuOpen,
  renderJob,
  canSubmitRender,
  onChangeRenderSelection,
  onChangeRenderMenuOpen,
  onResetRenderSelection,
  onSubmitRender,
  onPrefetchSoundings,
}: AppHeaderProps) {
```

Mount the RenderMenu in the button cluster. Replace the `<DisplayMenu ... />` block (lines 99-104):
```tsx
          <DisplayMenu
            display={display}
            open={displayMenuOpen}
            onOpenChange={onChangeDisplayMenuOpen}
            onChange={onChangeDisplay}
          />
```
with:
```tsx
          <DisplayMenu
            display={display}
            open={displayMenuOpen}
            onOpenChange={onChangeDisplayMenuOpen}
            onChange={onChangeDisplay}
          />
          <RenderMenu
            selection={renderSelection}
            open={renderMenuOpen}
            onOpenChange={onChangeRenderMenuOpen}
            onChange={onChangeRenderSelection}
            onReset={onResetRenderSelection}
            onSubmit={onSubmitRender}
            onPrefetchSoundings={onPrefetchSoundings}
            job={renderJob}
            canSubmit={canSubmitRender}
          />
```

Now modify `/Users/micha/Development/model-view/next/src/App.tsx`.

Replace line 6:
```tsx
import { loadStoredDisplaySettings, storeDisplaySettings } from "./config/display";
```
with:
```tsx
import { loadStoredDisplaySettings, storeDisplaySettings } from "./config/display";
import {
  cloneRenderSelection,
  DEFAULT_RENDER_SELECTION,
  loadStoredRenderSelection,
  storeRenderSelection,
  type RenderSelection,
} from "./config/render";
```

Replace line 27:
```tsx
  const [displayMenuOpen, setDisplayMenuOpen] = useState(false);
```
with:
```tsx
  const [displayMenuOpen, setDisplayMenuOpen] = useState(false);
  const [renderMenuOpen, setRenderMenuOpen] = useState(false);
  const [renderSelection, setRenderSelection] = useState<RenderSelection>(loadStoredRenderSelection);
```

Replace the display persistence effect (lines 73-75):
```tsx
  useEffect(() => {
    storeDisplaySettings(display);
  }, [display]);
```
with:
```tsx
  useEffect(() => {
    storeDisplaySettings(display);
  }, [display]);

  useEffect(() => {
    storeRenderSelection(renderSelection);
  }, [renderSelection]);

  const resetRenderSelection = useCallback(() => {
    setRenderSelection(cloneRenderSelection(DEFAULT_RENDER_SELECTION));
  }, []);
```
(`useCallback` is already imported at App.tsx:1.)

Pass props to AppHeader. Replace the AppHeader closing (lines 160-165):
```tsx
        onToggleCenters={() => setShowCenters((value) => !value)}
        onToggleIsobars={() => setShowIsobars((value) => !value)}
        onToggleLinkViewports={() => setLinkViewports((value) => !value)}
        onToggleSettings={() => setSettingsOpen((open) => !open)}
        onToggleThickness={() => setShowThickness((value) => !value)}
      />
```
with:
```tsx
        onToggleCenters={() => setShowCenters((value) => !value)}
        onToggleIsobars={() => setShowIsobars((value) => !value)}
        onToggleLinkViewports={() => setLinkViewports((value) => !value)}
        onToggleSettings={() => setSettingsOpen((open) => !open)}
        onToggleThickness={() => setShowThickness((value) => !value)}
        renderSelection={renderSelection}
        renderMenuOpen={renderMenuOpen}
        renderJob={null}
        canSubmitRender={true}
        onChangeRenderSelection={setRenderSelection}
        onChangeRenderMenuOpen={setRenderMenuOpen}
        onResetRenderSelection={resetRenderSelection}
        onSubmitRender={() => {}}
        onPrefetchSoundings={() => {}}
      />
```
(E.2 wires `renderJob={null}` and no-op submit/prefetch; E.3 replaces those with the real hooks.)

- [ ] **Step 4: Run test to verify it passes**

```
npx playwright test -c playwright.react.config.js tests-react/render-menu.spec.js --workers=1 --reporter=line
npx tsc --noEmit
npx eslint next/src/components/RenderMenu.tsx next/src/components/AppHeader.tsx next/src/App.tsx next/src/config/render.ts
npx prettier --check next/src/components/RenderMenu.tsx next/src/App.tsx next/src/components/AppHeader.tsx
```
Expected: all 4 render-menu specs PASS; typecheck/lint/format clean. This change touches only the React UI (no renderer/build code), so no byte-parity check is required.

- [ ] **Step 5: Commit**

```
git add next/src/components/RenderMenu.tsx next/src/components/AppHeader.tsx next/src/App.tsx tests-react/render-menu.spec.js
git commit -m "$(cat <<'EOF'
Add RenderMenu drawer + header button + App wiring (Phase E2)

Right-side glass drawer modeled on DisplayMenu: model multi-select, view,
run mode, 7 category checkboxes, severe/winter simple|full tier radios,
Light/Moderate/Heavy cost badge, CAM-only greying, reset-to-default.
Selection persists via config/render localStorage. Submit/prefetch are
no-ops here; wired in E3. Playwright covers open, 7 categories, tier
radios only on severe+winter, persistence across reload, reset, greying.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task E.3: `useRenderActions` hook + actions-client + submit/poll/refresh + sounding prefetch

**Files:**
- Create `/Users/micha/Development/model-view/next/src/core/actions-client.ts`
- Create `/Users/micha/Development/model-view/next/src/hooks/useRenderActions.ts`
- Modify `/Users/micha/Development/model-view/next/src/App.tsx` (wire the hook + replace the E.2 no-ops)
- Create `/Users/micha/Development/model-view/tests-react/render-actions.spec.js`

**Interfaces:**
- Consumes (from E.1): `RenderSelection`, `serializeRenderSelectionWire`; (from E.2): `RenderJobView`; (from artifact-client/url, all verified): `getArtifactBaseUrl`, `appendQueryParams`, `fetchModelManifestWithOptions`, `fetchModelRunsWithOptions`; from Phase D endpoints: `POST /actions/render`, `POST /actions/prefetch-soundings`, `GET /actions/status/:jobId`, `GET /actions/available-runs`.
- Produces:
  - `actions-client.ts`: `postRenderAction(selection): Promise<{ jobId: string }>`, `postPrefetchSoundingsAction({ model, run, view }): Promise<{ jobId: string }>`, `fetchJobStatus(jobId): Promise<RenderJobView & { jobId: string }>`, `fetchAvailableRuns(models, view): Promise<AvailableRunsResult>`, `type AvailableRunsResult = { built: string[]; upstream: string[] }`.
  - `useRenderActions.ts`: `useRenderActions(selection): { job: RenderJobView | null; submitRender: () => void; prefetchSoundings: () => void; canSubmit: boolean }` — POSTs, polls status ~2s, and on `done` force-refreshes runs + manifests.

- [ ] **Step 1: Write the failing test**

Create `/Users/micha/Development/model-view/tests-react/render-actions.spec.js`:

```js
const { test, expect } = require("@playwright/test");

async function openRenderMenu(page) {
  await page.getByRole("button", { name: "Render", exact: true }).click();
  return page.getByRole("dialog", { name: "Render" });
}

test("submitting posts the selection, renders progress, and force-refreshes manifests on done", async ({ page }) => {
  const postedBodies = [];
  let statusCalls = 0;
  let forcedManifestFetches = 0;

  await page.route("**/__cf/actions/render**", async (route) => {
    postedBodies.push(JSON.parse(route.request().postData() || "{}"));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jobId: "job-1" }) });
  });
  await page.route("**/__cf/actions/status/job-1**", async (route) => {
    statusCalls += 1;
    const done = statusCalls >= 2;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        jobId: "job-1",
        status: done ? "done" : "running",
        built: done ? 10 : 4,
        reused: 0,
        failed: 0,
        total: 10,
      }),
    });
  });
  // A force-refresh manifest fetch for a "latest" run hits the latest.json pointer
  // first; counting that fetch is enough to prove the refresh fired.
  await page.route("**/__cf/manifests/hrrr/latest.json**", async (route) => {
    forcedManifestFetches += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        model: "hrrr",
        run: "20260703-1200Z",
        view: "conus",
        generatedAt: "2026-07-03T12:10:00Z",
        manifestKey: "manifests/hrrr/render-done.json",
        frameCount: 1,
      }),
    });
  });

  await page.goto("/");
  const drawer = await openRenderMenu(page);
  await drawer.getByRole("button", { name: "▶ Render" }).click();

  await expect.poll(() => postedBodies.length).toBe(1);
  expect(postedBodies[0].categories.severe).toEqual({ enabled: true, tier: "full" });
  expect(postedBodies[0].categories.radar).toBe(true);
  expect(Array.isArray(postedBodies[0].models)).toBeTruthy();

  // Progress bar renders from the mocked status.
  await expect(drawer.getByRole("status", { name: "Render job" })).toBeVisible();

  // On done, a force-refresh manifest fetch fires for a selected model.
  await expect.poll(() => forcedManifestFetches, { timeout: 8_000 }).toBeGreaterThan(0);
});

test("prefetch soundings posts {model,run,view}, shows progress, and needs no manifest refresh", async ({ page }) => {
  const prefetchBodies = [];
  let statusCalls = 0;
  let manifestFetches = 0;

  await page.route("**/__cf/actions/prefetch-soundings**", async (route) => {
    prefetchBodies.push(JSON.parse(route.request().postData() || "{}"));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jobId: "snd-1" }) });
  });
  await page.route("**/__cf/actions/status/snd-1**", async (route) => {
    statusCalls += 1;
    const done = statusCalls >= 2;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        jobId: "snd-1",
        status: done ? "done" : "running",
        built: done ? 5 : 2,
        reused: 0,
        failed: 0,
        total: 5,
      }),
    });
  });
  await page.route("**/__cf/manifests/**", async (route) => {
    manifestFetches += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        model: "hrrr",
        run: "20260703-1200Z",
        view: "conus",
        generatedAt: "2026-07-03T12:10:00Z",
        manifestKey: "manifests/hrrr/latest.json",
        frameCount: 1,
      }),
    });
  });

  await page.goto("/");
  const drawer = await openRenderMenu(page);
  const manifestBaseline = manifestFetches;

  await drawer.getByRole("button", { name: "Prefetch soundings for run" }).click();

  await expect.poll(() => prefetchBodies.length).toBe(1);
  expect(typeof prefetchBodies[0].model).toBe("string");
  expect(typeof prefetchBodies[0].run).toBe("string");
  expect(typeof prefetchBodies[0].view).toBe("string");

  await expect(drawer.getByRole("status", { name: "Render job" })).toBeVisible();
  await expect.poll(() => statusCalls, { timeout: 8_000 }).toBeGreaterThanOrEqual(2);

  // Completion does not trigger extra manifest refreshes beyond ordinary panel polling.
  await page.waitForTimeout(500);
  expect(manifestFetches - manifestBaseline).toBeLessThanOrEqual(2);
});
```

- [ ] **Step 2: Run test to verify it fails**

```
npx playwright test -c playwright.react.config.js tests-react/render-actions.spec.js --workers=1 --reporter=line
```
Expected: FAIL — clicking `▶ Render` does nothing (App wires a no-op `onSubmitRender` in E.2), so `postedBodies` stays empty and the poll times out.

- [ ] **Step 3: Write minimal implementation**

Create `/Users/micha/Development/model-view/next/src/core/actions-client.ts`:

```ts
import type { RenderJobView } from "../components/RenderMenu";
import { serializeRenderSelectionWire, type RenderSelection } from "../config/render";
import type { ModelKey, ViewKey } from "../types";
import { appendQueryParams, getArtifactBaseUrl } from "./artifact-url";

export type AvailableRunsResult = { built: string[]; upstream: string[] };

function actionsUrl(path: string): string {
  return `${getArtifactBaseUrl()}/actions/${path.replace(/^\/+/, "")}`;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    let reason = "";
    try {
      const payload = (await response.json()) as { error?: string };
      reason = payload.error ? `: ${payload.error}` : "";
    } catch {
      reason = "";
    }
    throw new Error(`Action request failed (${response.status})${reason}`);
  }
  return (await response.json()) as T;
}

export async function postRenderAction(selection: RenderSelection): Promise<{ jobId: string }> {
  return postJson<{ jobId: string }>(actionsUrl("render"), serializeRenderSelectionWire(selection));
}

export async function postPrefetchSoundingsAction(body: {
  model: ModelKey;
  run: string;
  view: ViewKey;
}): Promise<{ jobId: string }> {
  return postJson<{ jobId: string }>(actionsUrl("prefetch-soundings"), body);
}

export async function fetchJobStatus(jobId: string): Promise<RenderJobView & { jobId: string }> {
  const url = appendQueryParams(actionsUrl(`status/${encodeURIComponent(jobId)}`), { t: String(Date.now()) });
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Job status request failed (${response.status})`);
  }
  const payload = (await response.json()) as Partial<RenderJobView> & { jobId?: string };
  return {
    jobId: String(payload.jobId || jobId),
    status: (payload.status as RenderJobView["status"]) || "running",
    built: Number(payload.built) || 0,
    reused: Number(payload.reused) || 0,
    failed: Number(payload.failed) || 0,
    total: Number(payload.total) || 0,
    error: payload.error ?? null,
  };
}

export async function fetchAvailableRuns(models: ModelKey[], view: ViewKey): Promise<AvailableRunsResult> {
  const url = appendQueryParams(actionsUrl("available-runs"), {
    models: models.join(","),
    view,
    t: String(Date.now()),
  });
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Available runs request failed (${response.status})`);
  }
  const payload = (await response.json()) as { built?: string[]; upstream?: string[] };
  return {
    built: Array.isArray(payload.built) ? payload.built.map(String) : [],
    upstream: Array.isArray(payload.upstream) ? payload.upstream.map(String) : [],
  };
}
```

Create `/Users/micha/Development/model-view/next/src/hooks/useRenderActions.ts`.

CRITICAL — the poll effect is keyed on a `jobEpoch` counter, NOT on `busy`. A `setBusy((v)=>v)` "nudge" does NOT re-run the effect: React bails out on an Object.is-identical state value, so `busy` never changes and the effect (which returned early on its first run because `jobIdRef` was still null) would never re-subscribe and polling would never start. Incrementing a dedicated `jobEpoch` in `startJob` after `jobIdRef.current` is assigned is what actually re-triggers the effect.

```ts
import { useCallback, useEffect, useRef, useState } from "react";
import type { RenderJobView } from "../components/RenderMenu";
import type { RenderSelection } from "../config/render";
import { fetchJobStatus, postPrefetchSoundingsAction, postRenderAction } from "../core/actions-client";
import { fetchModelManifestWithOptions, fetchModelRunsWithOptions } from "../core/artifact-client";

const JOB_POLL_MS = 2_000;

type JobKind = "render" | "prefetch";

interface RenderActions {
  job: RenderJobView | null;
  submitRender: () => void;
  prefetchSoundings: () => void;
  canSubmit: boolean;
}

export function useRenderActions(selection: RenderSelection): RenderActions {
  const [job, setJob] = useState<RenderJobView | null>(null);
  const [busy, setBusy] = useState(false);
  // Bumped once per launched job to force the poll effect to (re)subscribe after
  // jobIdRef is assigned. A same-value setBusy nudge would be dropped by React.
  const [jobEpoch, setJobEpoch] = useState(0);
  const jobIdRef = useRef<string | null>(null);
  const jobKindRef = useRef<JobKind>("render");
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  useEffect(() => {
    if (!jobIdRef.current) {
      return;
    }
    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    const poll = async () => {
      const activeJobId = jobIdRef.current;
      if (!activeJobId) {
        return;
      }
      try {
        const status = await fetchJobStatus(activeJobId);
        if (cancelled) {
          return;
        }
        setJob(status);
        if (status.status === "done" || status.status === "failed") {
          if (intervalId) {
            clearInterval(intervalId);
            intervalId = null;
          }
          jobIdRef.current = null;
          setBusy(false);
          // Render jobs write artifacts; force fresh runs + manifests so the
          // panels pick them up immediately. Prefetch jobs warm the sounding
          // byte-range cache only (served live), so no manifest refresh.
          if (status.status === "done" && jobKindRef.current === "render") {
            const { models, view } = selectionRef.current;
            await Promise.all(
              models.flatMap((model) => [
                fetchModelRunsWithOptions(model, view, { forceRefresh: true }).catch(() => undefined),
                fetchModelManifestWithOptions(model, view, { forceRefresh: true }).catch(() => undefined),
              ]),
            );
          }
        }
      } catch {
        // Transient poll failures are non-fatal; keep polling until terminal.
      }
    };

    void poll();
    intervalId = setInterval(() => {
      void poll();
    }, JOB_POLL_MS);

    return () => {
      cancelled = true;
      if (intervalId) {
        clearInterval(intervalId);
      }
    };
    // Re-run whenever a new job starts (jobEpoch increments after jobIdRef set).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobEpoch]);

  const startJob = useCallback(async (kind: JobKind, launch: () => Promise<{ jobId: string }>) => {
    setJob({ status: "queued", built: 0, reused: 0, failed: 0, total: 0, error: null });
    setBusy(true);
    jobKindRef.current = kind;
    try {
      const { jobId } = await launch();
      jobIdRef.current = jobId;
      setJobEpoch((epoch) => epoch + 1);
    } catch (error) {
      jobIdRef.current = null;
      setBusy(false);
      setJob({
        status: "failed",
        built: 0,
        reused: 0,
        failed: 0,
        total: 0,
        error: String(error instanceof Error ? error.message : error),
      });
    }
  }, []);

  const submitRender = useCallback(() => {
    if (busy) {
      return;
    }
    void startJob("render", () => postRenderAction(selectionRef.current));
  }, [busy, startJob]);

  const prefetchSoundings = useCallback(() => {
    if (busy) {
      return;
    }
    const { models, view, runMode, run } = selectionRef.current;
    const model = models[0];
    if (!model) {
      return;
    }
    void startJob("prefetch", () =>
      postPrefetchSoundingsAction({ model, run: runMode === "latest" ? "latest" : run, view }),
    );
  }, [busy, startJob]);

  return { job, submitRender, prefetchSoundings, canSubmit: !busy };
}
```

Wire it in `/Users/micha/Development/model-view/next/src/App.tsx`.

Add the hook import immediately after the `} from "./config/render";` import block:
```tsx
import { useRenderActions } from "./hooks/useRenderActions";
```

Replace the render state block added in E.2:
```tsx
  const [renderMenuOpen, setRenderMenuOpen] = useState(false);
  const [renderSelection, setRenderSelection] = useState<RenderSelection>(loadStoredRenderSelection);
```
with:
```tsx
  const [renderMenuOpen, setRenderMenuOpen] = useState(false);
  const [renderSelection, setRenderSelection] = useState<RenderSelection>(loadStoredRenderSelection);
  const {
    job: renderJob,
    submitRender,
    prefetchSoundings,
    canSubmit: canSubmitRender,
  } = useRenderActions(renderSelection);
```

Replace the AppHeader render-job/no-op props added in E.2:
```tsx
        renderSelection={renderSelection}
        renderMenuOpen={renderMenuOpen}
        renderJob={null}
        canSubmitRender={true}
        onChangeRenderSelection={setRenderSelection}
        onChangeRenderMenuOpen={setRenderMenuOpen}
        onResetRenderSelection={resetRenderSelection}
        onSubmitRender={() => {}}
        onPrefetchSoundings={() => {}}
      />
```
with:
```tsx
        renderSelection={renderSelection}
        renderMenuOpen={renderMenuOpen}
        renderJob={renderJob}
        canSubmitRender={canSubmitRender}
        onChangeRenderSelection={setRenderSelection}
        onChangeRenderMenuOpen={setRenderMenuOpen}
        onResetRenderSelection={resetRenderSelection}
        onSubmitRender={submitRender}
        onPrefetchSoundings={prefetchSoundings}
      />
```

- [ ] **Step 4: Run test to verify it passes**

```
npx playwright test -c playwright.react.config.js tests-react/render-actions.spec.js --workers=1 --reporter=line
npx tsc --noEmit
npx eslint next/src/core/actions-client.ts next/src/hooks/useRenderActions.ts next/src/App.tsx
npx prettier --check next/src/core/actions-client.ts next/src/hooks/useRenderActions.ts next/src/App.tsx
```
Expected: both render-actions specs PASS; typecheck/lint/format clean. Also re-run E.2's spec to confirm no regression: `npx playwright test -c playwright.react.config.js tests-react/render-menu.spec.js --workers=1 --reporter=line`. UI/hook only — no renderer/build code touched, so no byte-parity check.

- [ ] **Step 5: Commit**

```
git add next/src/core/actions-client.ts next/src/hooks/useRenderActions.ts next/src/App.tsx tests-react/render-actions.spec.js
git commit -m "$(cat <<'EOF'
Wire render/prefetch actions to /actions/* endpoints (Phase E3)

actions-client POSTs the §1.4 selection to /actions/render and
{model,run,view} to /actions/prefetch-soundings, polls
/actions/status/:jobId ~2s (poll effect keyed on a jobEpoch counter so it
re-subscribes after the async launch resolves). useRenderActions surfaces
job progress; on a render done it force-refreshes runs + manifests so new
artifacts appear. Prefetch completes without a manifest refresh (soundings
served live). Playwright (mocked routes) covers submit payload, progress,
forced refresh, and the sounding-prefetch payload/progress path.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

**Deferred to a later phase (not blocking E):** `useAvailableRuns(models, view)` polling of `/actions/available-runs` and the "Pick from list" run dropdown UI. E.1's `RenderSelection.runMode`/`run` already model the selection, and E.3's `fetchAvailableRuns` provides the client call, but rendering the concrete run picker (populating the list, wiring `runMode==="pick"`) depends on Phase D1's available-runs response shape being finalized. Implement it as a follow-up task E.4 once D1 lands: add a `useAvailableRuns` hook (copy the `useModelRuns` interval pattern at `useModelRuns.ts:22-63`, polling `fetchAvailableRuns`), and a `<select>` in `RenderMenu` shown only when `runMode==="pick"`. This is called out here so the implementer does not assume E is complete without the picker; the locked owner decisions and the E1-E3 tests do not require it for the default "latest" flow.

OPEN ITEMS (confirm when Phase D lands, adjust client if the shapes differ): (a) `GET /actions/available-runs` keys `built`/`upstream` (spec §3.1); (b) status payload field names `built`/`reused`/`failed`/`total` (spec §3.2).
