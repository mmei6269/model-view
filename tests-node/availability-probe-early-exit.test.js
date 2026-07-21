"use strict";

// Tests for the roster-ordered early-exit availability probe (backlog #38).
// The pre-change implementation HEAD-probed the ENTIRE requested roster at
// 16-wide concurrency and only then kept the contiguous published prefix, so a
// mid-publication latest-run build wasted one probe per unpublished tail hour
// per model. The probe now consumes verdicts in roster order and stops at the
// first miss, with a small bounded lookahead keeping a few HEAD requests in
// flight. These tests pin (a) the probe sequence (stop at first miss, bounded
// lookahead) and (b) result identity with the probe-everything implementation
// for every publication pattern (prefixes, gaps mid-roster, fully published,
// empty roster, first-hour-missing).

const assert = require("node:assert/strict");
const test = require("node:test");

const { AVAILABILITY_PROBE_LOOKAHEAD, resolveAvailableNoaaHours } = require("../scripts/lib/noaa-build/run-resolution");
const { filterNoaaForecastHoursForCycle } = require("../scripts/lib/noaa-beta/model-config");

const RUN = { date: "20260718", cycle: "06" };

// Mirrors the pre-change resolveAvailableNoaaHours: probe every requested
// hour, then keep the contiguous available prefix in roster order.
async function referenceProbeEverything({ modelKey, run, hours, availableFn }) {
  const requestedHours = filterNoaaForecastHoursForCycle(modelKey, run?.cycle, hours);
  const checks = [];
  for (const hour of requestedHours) {
    checks.push({ hour, available: await availableFn(hour) });
  }
  const availableHours = [];
  for (const check of checks) {
    if (!check.available) {
      break;
    }
    availableHours.push(check.hour);
  }
  if (availableHours.length === 0) {
    throw new Error(`No available NOAA ${modelKey} forecast hours for ${run.date} ${run.cycle}Z.`);
  }
  return availableHours;
}

// Stubs global.fetch; records the probed hours in launch order. availableFn
// maps hour -> publication verdict. The ListObjectsV2 fast path is answered
// unsupported so this suite keeps pinning the ordered-HEAD fallback.
function stubFetch(t, availableFn) {
  const originalFetch = global.fetch;
  const probedHours = [];
  global.fetch = async (url, options) => {
    if (options?.method === "GET" && new URL(String(url)).searchParams.get("list-type") === "2") {
      return { ok: false, status: 404 };
    }
    assert.equal(options?.method, "HEAD");
    const hour = Number(String(url).match(/wrfprsf(\d+)\.grib2\.idx$/)?.[1]);
    assert.ok(Number.isInteger(hour), `unexpected probe url ${url}`);
    probedHours.push(hour);
    return { ok: Boolean(availableFn(hour)) };
  };
  t.after(() => {
    global.fetch = originalFetch;
  });
  return probedHours;
}

test("probes in roster order and stops at the first unpublished hour with a bounded lookahead", async (t) => {
  const hours = Array.from({ length: 10 }, (_, index) => index);
  const missIndex = 3;
  const probedHours = stubFetch(t, (hour) => hour < missIndex);

  const available = await resolveAvailableNoaaHours({ modelKey: "hrrr", run: RUN, hours, missConfirmDelayMs: 0 });

  assert.deepEqual(available, [0, 1, 2]);
  // The miss plus at most LOOKAHEAD - 1 in-flight extras: hours past the
  // lookahead window beyond the first miss are never probed. The boundary miss
  // is then re-probed once by the miss-confirm guard (appended last).
  assert.deepEqual(probedHours, [...hours.slice(0, missIndex + AVAILABILITY_PROBE_LOOKAHEAD), missIndex]);
  assert.ok(!probedHours.includes(7), "hours past the first miss + lookahead are never probed");
});

test("a gap mid-roster keeps the contiguous prefix, not the later published hours", async (t) => {
  const hours = Array.from({ length: 10 }, (_, index) => index);
  const probedHours = stubFetch(t, (hour) => hour !== 3);
  const log = t.mock.method(console, "log", () => {});

  const available = await resolveAvailableNoaaHours({ modelKey: "hrrr", run: RUN, hours, missConfirmDelayMs: 0 });

  assert.deepEqual(available, [0, 1, 2], "published hours after the gap are NOT kept");
  assert.deepEqual(probedHours, [...hours.slice(0, 3 + AVAILABILITY_PROBE_LOOKAHEAD), 3]);
  const message = String(log.mock.calls[0]?.arguments[0] || "");
  assert.match(message, /capped at F002/);
  assert.match(message, /F003 is not published yet/);
});

test("a fully published roster probes every hour exactly once", async (t) => {
  const hours = Array.from({ length: 10 }, (_, index) => index);
  const probedHours = stubFetch(t, () => true);

  const available = await resolveAvailableNoaaHours({ modelKey: "hrrr", run: RUN, hours });

  assert.deepEqual(available, hours);
  assert.deepEqual(probedHours, hours);
});

test("a first-hour miss throws and probes no further than the lookahead plus the confirm", async (t) => {
  const hours = Array.from({ length: 10 }, (_, index) => index);
  const probedHours = stubFetch(t, () => false);

  await assert.rejects(resolveAvailableNoaaHours({ modelKey: "hrrr", run: RUN, hours, missConfirmDelayMs: 0 }), {
    message: /No available NOAA hrrr forecast hours for 20260718 06Z\./,
  });
  assert.deepEqual(probedHours, [...hours.slice(0, AVAILABILITY_PROBE_LOOKAHEAD), 0]);
});

test("a transient boundary miss is confirmed and does not truncate the prefix", async (t) => {
  const hours = Array.from({ length: 10 }, (_, index) => index);
  let missRemaining = 1;
  const probedHours = stubFetch(t, (hour) => {
    if (hour === 3 && missRemaining > 0) {
      missRemaining -= 1;
      return false; // one transient 404 at F003 (NOMADS hiccup / posting race)
    }
    return true;
  });

  const available = await resolveAvailableNoaaHours({ modelKey: "hrrr", run: RUN, hours, missConfirmDelayMs: 0 });

  assert.deepEqual(available, hours, "the confirmed-transient miss does not truncate");
  assert.deepEqual(
    probedHours.filter((hour) => hour === 3).length,
    2,
    "the boundary hour is probed exactly twice (in-flight + confirm)",
  );
});

test("a transient first-hour miss is confirmed before throwing", async (t) => {
  const hours = Array.from({ length: 10 }, (_, index) => index);
  let firstProbed = false;
  stubFetch(t, (hour) => {
    if (hour === 0 && !firstProbed) {
      firstProbed = true;
      return false;
    }
    return true;
  });

  const available = await resolveAvailableNoaaHours({ modelKey: "hrrr", run: RUN, hours, missConfirmDelayMs: 0 });
  assert.deepEqual(available, hours);
});

test("out-of-order posting still yields the strict sequential prefix", async (t) => {
  // The 20260719 nam3km case: F013 missing while F014+ are already posted. A
  // prefix-assuming probe (the old binary search) read full horizon here.
  const hours = Array.from({ length: 10 }, (_, index) => index);
  stubFetch(t, (hour) => hour !== 3);

  const available = await resolveAvailableNoaaHours({ modelKey: "hrrr", run: RUN, hours, missConfirmDelayMs: 0 });
  assert.deepEqual(available, [0, 1, 2], "later published hours never extend past the gap");
});

test("an empty roster throws without probing", async (t) => {
  const probedHours = stubFetch(t, () => true);

  await assert.rejects(
    resolveAvailableNoaaHours({ modelKey: "hrrr", run: RUN, hours: [] }),
    /No available NOAA hrrr forecast hours for 20260718 06Z\./,
  );
  assert.deepEqual(probedHours, []);
});

test("the cycle horizon filter applies before probing", async (t) => {
  // HRRR cycle 05 is an off-cycle (standard 18 h horizon): requested hours
  // past F018 are filtered out before any probe is launched.
  const probedHours = stubFetch(t, () => true);

  const available = await resolveAvailableNoaaHours({
    modelKey: "hrrr",
    run: { date: "20260718", cycle: "05" },
    hours: [15, 16, 17, 18, 19, 20],
  });

  assert.deepEqual(available, [15, 16, 17, 18]);
  assert.deepEqual(probedHours, [15, 16, 17, 18]);
});

test("results are identical to the probe-everything implementation for every publication pattern", async (t) => {
  const hours = Array.from({ length: 12 }, (_, index) => index);
  const patterns = [];
  // Every published-prefix length, including 0 (all missing) and 12 (full).
  for (let prefix = 0; prefix <= hours.length; prefix += 1) {
    patterns.push(new Set(hours.slice(0, prefix)));
  }
  // Gaps mid-roster: miss at 3 with later hours published, miss at 0 with the
  // rest published, alternating publication, and an isolated last-hour miss.
  patterns.push(new Set(hours.filter((hour) => hour !== 3)));
  patterns.push(new Set(hours.filter((hour) => hour !== 0)));
  patterns.push(new Set(hours.filter((hour) => hour % 2 === 0)));
  patterns.push(new Set(hours.slice(0, -1)));

  for (const published of patterns) {
    const availableFn = (hour) => published.has(hour);
    stubFetch(t, availableFn);
    const expected = await referenceProbeEverything({ modelKey: "hrrr", run: RUN, hours, availableFn }).then(
      (value) => ({ value }),
      (error) => ({ error: error.message }),
    );
    const actual = await resolveAvailableNoaaHours({ modelKey: "hrrr", run: RUN, hours }).then(
      (value) => ({ value }),
      (error) => ({ error: error.message }),
    );
    assert.deepEqual(actual, expected, `mismatch for published=${[...published].join(",")}`);
  }
});

// Shared stub for the ListObjectsV2 fast-path tests: answers the listing
// with keys for `listedHours` (derived exactly like production strips the
// base path) and HEAD probes via headAvailableFn, recording probed hours.
function stubListingFetch(t, { listedHours, headAvailableFn }) {
  const { buildNoaaGribUrl, getNoaaGribModelConfig } = require("../scripts/lib/noaa-beta/model-config");
  const relativeIdxKey = (hour) => {
    const basePath = new URL(getNoaaGribModelConfig("hrrr").baseUrl).pathname.replace(/\/+$/, "");
    let objectPath = new URL(`${buildNoaaGribUrl({ modelKey: "hrrr", date: RUN.date, cycle: RUN.cycle, hour })}.idx`)
      .pathname;
    if (basePath && basePath !== "/" && (objectPath === basePath || objectPath.startsWith(`${basePath}/`))) {
      objectPath = objectPath.slice(basePath.length);
    }
    return objectPath.replace(/^\/+/, "");
  };
  const requests = { listings: 0, headHours: [] };
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    if (options?.method === "GET" && new URL(String(url)).searchParams.get("list-type") === "2") {
      requests.listings += 1;
      const xml = [
        "<ListBucketResult>",
        "<IsTruncated>false</IsTruncated>",
        ...listedHours.map((hour) => `<Contents><Key>${encodeURIComponent(relativeIdxKey(hour))}</Key></Contents>`),
        "</ListBucketResult>",
      ].join("");
      return { ok: true, status: 200, text: async () => xml };
    }
    const hour = Number(String(url).match(/wrfprsf(\d+)\.grib2\.idx$/)?.[1]);
    assert.ok(Number.isInteger(hour), `unexpected probe url ${url}`);
    requests.headHours.push(hour);
    return { ok: Boolean(headAvailableFn(hour)) };
  };
  t.after(() => {
    global.fetch = originalFetch;
  });
  return requests;
}

test("a supported object listing resolves the strict prefix with zero per-hour probes", async (t) => {
  const hours = Array.from({ length: 10 }, (_, index) => index);
  const requests = stubListingFetch(t, {
    listedHours: hours.filter((hour) => hour !== 4),
    headAvailableFn: (hour) => hour !== 4, // the gap is real, not replica lag
  });
  t.mock.method(console, "log", () => {});

  const available = await resolveAvailableNoaaHours({ modelKey: "hrrr", run: RUN, hours, missConfirmDelayMs: 0 });

  assert.deepEqual(available, [0, 1, 2, 3], "the strict prefix stops at the listing gap");
  // A capped listing earns the boundary confirm (probe + miss re-probe,
  // mirroring the ordered path's transient guard); never one HEAD per hour.
  assert.equal(requests.listings, 1);
  assert.deepEqual(requests.headHours, [4, 4], "only the boundary hour is confirmed");
});

test("a stale listing keeps its confirmed prefix and probes on from the boundary", async (t) => {
  // Lagging listing replica: the ListBucketResult caps the prefix at F002,
  // but the boundary HEAD says F002 exists. Keys PRESENT in a listing are
  // reliable (append-only bucket), so the ordered probe continues from the
  // boundary instead of re-probing the proven F000/F001.
  const hours = Array.from({ length: 10 }, (_, index) => index);
  const requests = stubListingFetch(t, {
    listedHours: [0, 1],
    headAvailableFn: () => true,
  });

  const available = await resolveAvailableNoaaHours({ modelKey: "hrrr", run: RUN, hours, missConfirmDelayMs: 0 });

  assert.deepEqual(available, hours, "the full published roster is recovered");
  assert.equal(requests.listings, 1);
  assert.ok(
    !requests.headHours.includes(0) && !requests.headHours.includes(1),
    "listing-proven hours are not re-probed",
  );
  assert.deepEqual(
    [...new Set(requests.headHours)].sort((a, b) => a - b),
    hours.slice(2),
    "the ordered probe covers exactly the unproven tail",
  );
});

test("a transient boundary miss after a capped listing is re-confirmed, not trusted", async (t) => {
  // The listing omits F004+ (replica lag) AND the first boundary HEAD on
  // F004 transiently fails: the miss re-probe must rescue the run instead
  // of silently truncating the build at the stale cap.
  const hours = Array.from({ length: 10 }, (_, index) => index);
  let boundaryMissRemaining = 1;
  const requests = stubListingFetch(t, {
    listedHours: [0, 1, 2, 3],
    headAvailableFn: (hour) => {
      if (hour === 4 && boundaryMissRemaining > 0) {
        boundaryMissRemaining -= 1;
        return false;
      }
      return true;
    },
  });

  const available = await resolveAvailableNoaaHours({ modelKey: "hrrr", run: RUN, hours, missConfirmDelayMs: 0 });

  assert.deepEqual(available, hours, "the re-confirmed boundary rescues the full roster");
  assert.equal(requests.headHours.filter((hour) => hour === 4).length >= 2, true, "the boundary miss was re-probed");
});

test("the lookahead option widens the in-flight probe window", async (t) => {
  const hours = Array.from({ length: 20 }, (_, index) => index);
  const missIndex = 3;
  const probedHours = stubFetch(t, (hour) => hour < missIndex);
  t.mock.method(console, "log", () => {});

  const available = await resolveAvailableNoaaHours({
    modelKey: "hrrr",
    run: RUN,
    hours,
    lookahead: 7,
    missConfirmDelayMs: 0,
  });

  assert.deepEqual(available, [0, 1, 2]);
  // Initial window of 7, one further launch per consumed hour before the
  // miss, then the confirm re-probe of the boundary.
  assert.deepEqual(probedHours, [...hours.slice(0, missIndex + 7), missIndex]);
});
