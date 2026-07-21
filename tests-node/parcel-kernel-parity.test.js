"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

process.env.MODELVIEW_PARCEL_KERNEL = "wasm";

const { getParcelKernel } = require("../scripts/lib/noaa-beta/parcel-kernel");
const severe = require("../scripts/lib/noaa-beta/severe");

// Deterministic PRNG so failures reproduce.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildRandomProfile(rand) {
  // Surface row plus 4-20 ascending levels with occasional NaN holes,
  // spanning stable through strongly convective regimes.
  const rowCount = 5 + Math.floor(rand() * 16);
  const rows = [];
  let height = 0;
  let pressure = 950 + rand() * 90;
  let temp = 270 + rand() * 40;
  for (let index = 0; index < rowCount; index += 1) {
    const dewSpread = rand() * 25;
    rows.push({
      height,
      pressure,
      temp,
      dewpoint: rand() < 0.05 ? Number.NaN : temp - dewSpread,
    });
    height += 50 + rand() * 900;
    pressure -= 5 + rand() * 60;
    temp -= rand() * 9 - 0.5;
    if (pressure <= 110) {
      break;
    }
  }
  return rows;
}

function fillScratch(target, rows) {
  for (let index = 0; index < rows.length; index += 1) {
    target.heights[index] = rows[index].height;
    target.pressure[index] = rows[index].pressure;
    target.temp[index] = rows[index].temp;
    target.dewpoint[index] = rows[index].dewpoint;
    if (target.u) {
      target.u[index] = 0;
      target.v[index] = 0;
    }
  }
}

function assertClose(actual, expected, tolerance, label) {
  if (Number.isNaN(expected)) {
    assert.ok(Number.isNaN(actual), `${label}: expected NaN, got ${actual}`);
    return;
  }
  const scale = Math.max(1, Math.abs(expected));
  assert.ok(
    Math.abs(actual - expected) <= tolerance * scale,
    `${label}: ${actual} vs ${expected} (tolerance ${tolerance})`,
  );
}

test("wasm origin scan matches the JS effective-layer search within documented tolerance", () => {
  const kernel = getParcelKernel();
  assert.ok(kernel, "tracked parcel-kernel.wasm must load for scalar WASM parity coverage");
  const rand = mulberry32(0x5eed);
  const jsScratch = severe.createEffectiveDiagnosticsScratch(24, { useKernel: false });
  assert.equal(jsScratch.kernel, undefined, "reference scratch must stay on the JS path");
  let layered = 0;
  let nulls = 0;
  const trials = 20000;
  // The only numeric difference between the two paths is NativeMath (musl)
  // vs V8 ieee754 exp/log/pow, each correctly rounded to <=1 ulp; parcel
  // integrations amplify that to at most ~1e-9 relative in CAPE/CIN and
  // interpolated heights on random profiles. The tolerance below is ~1000x
  // that amplification and still ~6 orders of magnitude below any
  // rendered-value quantization (PNG color steps, hover Int16 scales).
  const tolerance = 1e-6;
  for (let trial = 0; trial < trials; trial += 1) {
    const rows = buildRandomProfile(rand);
    fillScratch(jsScratch, rows);
    const expected = severe.calculateEffectiveParcelLayerFromRows(jsScratch, rows.length);

    fillScratch(kernel.views, rows);
    const found = kernel.runOriginScan(rows.length, 300, 25, 4000, 100, -250);
    if (!expected) {
      nulls += 1;
      assert.equal(found, 0, `trial ${trial}: kernel found a layer where JS returned null`);
      continue;
    }
    layered += 1;
    assert.equal(found, 1, `trial ${trial}: kernel missed a layer JS found`);
    const out = kernel.views.out;
    assertClose(out[1], expected.baseAglM, tolerance, `trial ${trial} baseAglM`);
    assertClose(out[2], expected.topAglM, tolerance, `trial ${trial} topAglM`);
    assertClose(out[3], expected.muCapeJkg, tolerance, `trial ${trial} muCapeJkg`);
    assertClose(out[4], expected.muCinJkg, tolerance, `trial ${trial} muCinJkg`);
    assertClose(out[5], expected.muElAglM, tolerance, `trial ${trial} muElAglM`);
  }
  assert.ok(layered > 500, `expected a substantial layered sample, got ${layered}`);
  assert.ok(nulls > 500, `expected a substantial null sample, got ${nulls}`);
});

test("wasm segment preparation matches the JS preparation on random profiles", () => {
  const kernel = getParcelKernel();
  assert.ok(kernel, "tracked parcel-kernel.wasm must load for scalar WASM parity coverage");
  const rand = mulberry32(0xace5);
  const jsScratch = severe.createEffectiveDiagnosticsScratch(24, { useKernel: false });
  for (let trial = 0; trial < 4000; trial += 1) {
    const rows = buildRandomProfile(rand);
    fillScratch(jsScratch, rows);
    severe.prepareEffectiveParcelSegments(jsScratch, rows.length);

    fillScratch(kernel.views, rows);
    kernel.runOriginScan(rows.length, 300, 25, 4000, 100, -250);
    for (let row = 1; row < rows.length; row += 1) {
      assert.equal(
        kernel.views.segmentValid[row],
        jsScratch.segmentValid[row],
        `trial ${trial} row ${row} segmentValid`,
      );
      if (jsScratch.segmentValid[row]) {
        assertClose(kernel.views.segmentDz[row], jsScratch.segmentDz[row], 1e-12, `trial ${trial} row ${row} dz`);
        assertClose(
          kernel.views.segmentMidPressure[row],
          jsScratch.segmentMidPressure[row],
          1e-12,
          `trial ${trial} row ${row} midPressure`,
        );
        assertClose(
          kernel.views.segmentEnvVirtualTemp[row],
          jsScratch.segmentEnvVirtualTemp[row],
          1e-12,
          `trial ${trial} row ${row} envVirtualTemp`,
        );
      }
    }
  }
});
