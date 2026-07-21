"use strict";

// Backlog #40: buildPrecipIntervalSumPlan (accumulation.js) is the
// last-resort precipitation planner behind the exact-interval and
// cumulative-difference plans. The pre-fix greedy longest-interval-first
// cover dead-ended into [] (product omitted, never wrong bytes) even when a
// valid cover existed — proven on hours [0,3,5,6] with intervals
// [0,3],[0,5],[3,6], where the greedy pick [0,5] strands cursor 5 while
// [0,3]+[3,6] covers [0,6]. The fix is a DFS with bounded backtracking that
// tries candidates at each cursor in the greedy's exact order (longest
// endHour first, ties keep input order), so:
//   1. whenever the old greedy succeeded, the plan is IDENTICAL (same picks,
//      same order — plan choice drives float summation order, hence bytes);
//   2. a cover is now found whenever one exists;
//   3. failure still returns [] (fail-closed omission semantics unchanged).
// These tests pin all three properties, including a fuzz against a
// brute-force cover-existence oracle with the pre-fix greedy (copied below
// verbatim as referenceGreedyCover) as the identity oracle.

const assert = require("node:assert/strict");
const test = require("node:test");
const { buildPrecipIntervalSumPlan, getPrecipIntervalsForHour } = require("../scripts/lib/noaa-beta/accumulation");
const { parseNoaaIdx } = require("../scripts/lib/noaa-beta/idx-source");

// Verbatim copy of the pre-fix greedy loop in buildPrecipIntervalSumPlan:
// the identity oracle for every input the greedy already solved.
function referenceGreedyCover(usable, startHour, endHour) {
  const terms = [];
  let cursor = startHour;
  while (cursor < endHour) {
    const candidates = usable
      .filter((interval) => interval.startHour === cursor && interval.endHour > cursor)
      .sort((left, right) => right.endHour - left.endHour);
    const selected = candidates[0] || null;
    if (!selected) {
      return [];
    }
    terms.push(selected);
    cursor = selected.endHour;
  }
  return cursor === endHour ? terms : [];
}

// Brute-force cover-existence oracle (exhaustive memoized search): the
// ground truth for "a cover exists", independent of any picking order.
function oracleCoverExists(usable, startHour, endHour) {
  const byStart = new Map();
  for (const interval of usable) {
    const list = byStart.get(interval.startHour);
    if (list) {
      list.push(interval);
    } else {
      byStart.set(interval.startHour, [interval]);
    }
  }
  const memo = new Map();
  function canCover(cursor) {
    if (cursor === endHour) {
      return true;
    }
    if (memo.has(cursor)) {
      return memo.get(cursor);
    }
    const exists = (byStart.get(cursor) || []).some((interval) => canCover(interval.endHour));
    memo.set(cursor, exists);
    return exists;
  }
  return canCover(startHour);
}

// Mirrors the interval collection inside buildPrecipIntervalSumPlan so the
// oracles see exactly the `usable` list the planner sees.
async function usableIntervals(context, startHour, endHour) {
  const hours = context.availableHours.filter((hour) => hour > startHour && hour <= endHour);
  const intervals = [];
  for (const hour of hours) {
    intervals.push(...(await getPrecipIntervalsForHour(context, hour)));
  }
  return intervals.filter((interval) => {
    return interval.startHour >= startHour && interval.endHour <= endHour && interval.endHour > interval.startHour;
  });
}

function contextFromRecords(recordsByHour, availableHours) {
  return {
    availableHours,
    availableHourSet: new Set(availableHours),
    recordsByHour,
    intervalsByHour: new Map(),
    intervalSumPlanCache: new Map(),
  };
}

// Direct interval injection (no .idx parsing) for the synthetic/fuzz cases.
// Each interval is published at its endHour, matching how real accumulation
// records arrive; every available hour gets an entry (empty lists allowed).
function contextFromIntervals(availableHours, intervals) {
  const intervalsByHour = new Map(availableHours.map((hour) => [hour, []]));
  for (const interval of intervals) {
    intervalsByHour.get(interval.hour).push(interval);
  }
  return {
    availableHours,
    availableHourSet: new Set(availableHours),
    recordsByHour: new Map(),
    intervalsByHour,
    intervalSumPlanCache: new Map(),
  };
}

function interval(hour, startHour, endHour, tag = null) {
  return { hour, record: { tag: tag || `${startHour}-${endHour}@${hour}` }, startHour, endHour };
}

function planKeys(plan) {
  return plan.map((entry) => entry.record.tag || `${entry.startHour}-${entry.endHour}@${entry.hour}`);
}

function apcpRecordLine(recordNumber, windowText) {
  return `${recordNumber}:0:d=2026042512:APCP:surface:${windowText}:`;
}

test("precip interval sum plan backtracks out of the proven greedy dead end", async () => {
  // The backlog-#40 counterexample: hours [0,3,5,6] with intervals
  // [0,3],[0,5],[3,6]. Greedy picks [0,5] at cursor 0 and strands cursor 5;
  // [0,3]+[3,6] is the only cover of [0,6].
  const recordsByHour = new Map([
    [0, []],
    [3, parseNoaaIdx(apcpRecordLine(1, "0-3 hour acc fcst"), 100)],
    [5, parseNoaaIdx(apcpRecordLine(1, "0-5 hour acc fcst"), 100)],
    [6, parseNoaaIdx(apcpRecordLine(1, "3-6 hour acc fcst"), 100)],
  ]);
  const context = contextFromRecords(recordsByHour, [0, 3, 5, 6]);

  const usable = await usableIntervals(context, 0, 6);
  assert.deepEqual(
    planKeys(referenceGreedyCover(usable, 0, 6)),
    [],
    "sanity: the pre-fix greedy really dead-ends on this input",
  );
  assert.equal(oracleCoverExists(usable, 0, 6), true, "sanity: a cover exists");

  const plan = await buildPrecipIntervalSumPlan(context, 0, 6);
  assert.deepEqual(planKeys(plan), ["0-3@3", "3-6@6"], "backtracking must find the only cover");
});

test("precip interval sum plan is byte-identical to the greedy on every greedy-solvable case", async () => {
  const cases = [
    {
      name: "single exact interval",
      hours: [0, 6],
      intervals: [interval(6, 0, 6)],
      endHour: 6,
    },
    {
      name: "NAM-style publication-cadence chain",
      hours: [0, 12, 24, 36, 39],
      intervals: [interval(12, 0, 12), interval(24, 12, 24), interval(36, 24, 36), interval(39, 36, 39)],
      endHour: 39,
    },
    {
      name: "redundant long interval wins over the two-hop chain",
      hours: [0, 3, 6],
      intervals: [interval(3, 0, 3), interval(6, 0, 6), interval(6, 3, 6)],
      endHour: 6,
    },
    {
      name: "same-hour tie keeps publication order",
      hours: [0, 3, 6],
      intervals: [interval(3, 0, 3, "first-0-3@3"), interval(3, 0, 3, "second-0-3@3"), interval(6, 3, 6)],
      endHour: 6,
    },
    {
      name: "same-window tie across hours keeps ascending-hour order",
      hours: [0, 2, 3, 5],
      intervals: [interval(2, 0, 2), interval(3, 0, 2), interval(5, 2, 5)],
      endHour: 5,
    },
    {
      name: "backtracking counterexample (greedy fails; cover exists)",
      hours: [0, 3, 5, 6],
      intervals: [interval(3, 0, 3), interval(5, 0, 5), interval(6, 3, 6)],
      endHour: 6,
    },
    {
      name: "gap means no cover (fail-closed [] preserved)",
      hours: [0, 3, 4, 6],
      intervals: [interval(3, 0, 3), interval(6, 4, 6)],
      endHour: 6,
    },
    {
      name: "interval overshooting endHour is unusable",
      hours: [0, 3, 8],
      intervals: [interval(3, 0, 3), interval(8, 3, 8)],
      endHour: 6,
    },
  ];

  for (const { name, hours, intervals, endHour } of cases) {
    const context = contextFromIntervals(hours, intervals);
    const usable = await usableIntervals(context, 0, endHour);
    const expected = referenceGreedyCover(usable, 0, endHour);
    const plan = await buildPrecipIntervalSumPlan(context, 0, endHour);
    if (expected.length > 0) {
      assert.deepEqual(planKeys(plan), planKeys(expected), `${name}: plan must equal the greedy plan`);
    } else {
      // The greedy failed: either no cover exists (both return []) or the
      // backtracker found one (fix); the oracle decides which is legal.
      const exists = oracleCoverExists(usable, 0, endHour);
      assert.equal(plan.length > 0, exists, `${name}: cover found iff one exists`);
    }
    // Spot-check the exact successful picks for the identity cases.
    if (name === "NAM-style publication-cadence chain") {
      assert.deepEqual(planKeys(plan), ["0-12@12", "12-24@24", "24-36@36", "36-39@39"]);
    }
    if (name === "redundant long interval wins over the two-hop chain") {
      assert.deepEqual(planKeys(plan), ["0-6@6"]);
    }
    if (name === "same-hour tie keeps publication order") {
      assert.deepEqual(planKeys(plan), ["first-0-3@3", "3-6@6"]);
    }
    if (name === "same-window tie across hours keeps ascending-hour order") {
      assert.deepEqual(planKeys(plan), ["0-2@2", "2-5@5"]);
    }
    if (name === "backtracking counterexample (greedy fails; cover exists)") {
      assert.deepEqual(planKeys(plan), ["0-3@3", "3-6@6"]);
    }
  }
});

test("precip interval sum plan is deterministic across repeated and cached calls", async () => {
  const hours = [0, 2, 3, 4, 5, 6, 7, 9];
  const intervals = [
    interval(3, 0, 3),
    interval(5, 0, 5),
    interval(2, 0, 2),
    interval(6, 3, 6),
    interval(9, 5, 9),
    interval(4, 2, 4),
    interval(7, 4, 7),
    interval(9, 6, 9),
    interval(9, 7, 9),
  ];
  const expected = planKeys(await buildPrecipIntervalSumPlan(contextFromIntervals(hours, intervals), 0, 9));
  assert.ok(expected.length > 0, "fixture must be coverable");
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const plan = await buildPrecipIntervalSumPlan(contextFromIntervals(hours, intervals), 0, 9);
    assert.deepEqual(planKeys(plan), expected, `attempt ${attempt} must match`);
  }
  // The plan cache returns the memoized array on repeat calls, as before.
  const cached = contextFromIntervals(hours, intervals);
  const first = await buildPrecipIntervalSumPlan(cached, 0, 9);
  const second = await buildPrecipIntervalSumPlan(cached, 0, 9);
  assert.equal(second, first, "cached plan must be the same array reference");
  assert.deepEqual(planKeys(second), expected);
});

test("precip interval sum plan keeps NaN and empty-range semantics", async () => {
  const context = contextFromIntervals([0, 3, 6], [interval(3, 0, 3), interval(6, 3, 6)]);
  assert.deepEqual(await buildPrecipIntervalSumPlan(context, Number.NaN, 6), []);
  assert.deepEqual(await buildPrecipIntervalSumPlan(context, 0, Number.NaN), []);
  assert.deepEqual(await buildPrecipIntervalSumPlan(context, Number.NaN, Number.NaN), []);
  assert.deepEqual(await buildPrecipIntervalSumPlan(context, 3, 3), []);
  assert.deepEqual(await buildPrecipIntervalSumPlan(context, 6, 3), []);
  // No published hours inside the window: fail-closed [] as before.
  assert.deepEqual(await buildPrecipIntervalSumPlan(contextFromIntervals([0, 9], []), 1, 5), []);
});

function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

test("fuzz: cover found iff the brute-force oracle finds one; greedy-solvable plans stay identical", async () => {
  const random = mulberry32(0x40c04a);
  const trials = 3000;
  let greedySolved = 0;
  let backtracked = 0;
  let uncovered = 0;
  for (let trial = 0; trial < trials; trial += 1) {
    const endHour = 1 + Math.floor(random() * 8); // 1..8
    const intervalCount = Math.floor(random() * 7); // 0..6
    const intervals = [];
    for (let index = 0; index < intervalCount; index += 1) {
      const start = Math.floor(random() * endHour); // 0..endHour-1
      const end = start + 1 + Math.floor(random() * (endHour - start)); // start+1..endHour
      intervals.push(interval(end, start, end));
    }
    // Available hours: every interval's publication hour plus a few empty
    // ones, ascending like a real roster.
    const hourSet = new Set(intervals.map((entry) => entry.hour));
    hourSet.add(endHour);
    if (random() < 0.5) {
      hourSet.add(1 + Math.floor(random() * endHour));
    }
    const hours = Array.from(hourSet).sort((left, right) => left - right);

    const context = contextFromIntervals(hours, intervals);
    const usable = await usableIntervals(context, 0, endHour);
    const plan = await buildPrecipIntervalSumPlan(context, 0, endHour);
    const exists = oracleCoverExists(usable, 0, endHour);
    const greedy = referenceGreedyCover(usable, 0, endHour);

    assert.equal(
      plan.length > 0,
      exists,
      `trial ${trial}: cover found iff one exists (hours=${hours} intervals=${planKeys(usable)} end=${endHour})`,
    );
    if (plan.length > 0) {
      // Structural validity: contiguous from 0 to endHour, entries from usable.
      let cursor = 0;
      for (const entry of plan) {
        assert.equal(entry.startHour, cursor, `trial ${trial}: plan must be contiguous`);
        assert.ok(usable.includes(entry), `trial ${trial}: plan entries must come from usable`);
        cursor = entry.endHour;
      }
      assert.equal(cursor, endHour, `trial ${trial}: plan must end at endHour`);
    }
    if (greedy.length > 0) {
      greedySolved += 1;
      assert.deepEqual(
        planKeys(plan),
        planKeys(greedy),
        `trial ${trial}: greedy-solvable plan must be identical to the pre-fix greedy`,
      );
    } else if (plan.length > 0) {
      backtracked += 1;
    } else {
      uncovered += 1;
    }
  }
  // Engagement evidence: the fuzz must actually drive all three regimes.
  assert.ok(greedySolved > 100, `fuzz must exercise greedy-solvable cases (got ${greedySolved})`);
  assert.ok(backtracked > 0, `fuzz must exercise backtracked covers (got ${backtracked})`);
  assert.ok(uncovered > 100, `fuzz must exercise uncoverable cases (got ${uncovered})`);
});
