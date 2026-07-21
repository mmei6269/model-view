"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  isPointInLower48Mainland,
  lower48LongitudeIntervalsAtLatitude,
} = require("../scripts/lib/noaa-beta/lower48-domain-mask");

function intervalsContain(intervals, lon) {
  return intervals.some(([west, east]) => lon >= west && lon <= east);
}

test("longitude intervals agree with point-in-polygon on a lat/lon sweep", () => {
  const latitudes = [];
  for (let lat = 24; lat <= 50; lat += 0.5) {
    latitudes.push(lat);
  }
  // Coastline rows where the polygon wiggles and the interval list splits:
  // southern tip of Texas, Louisiana bays, Outer Banks, Long Island, Puget
  // Sound, and the northern border.
  latitudes.push(25.1215, 29.0865, 32.5, 34.8995, 40.4495, 47.181, 48.9925);
  let checked = 0;
  let inside = 0;
  for (const lat of latitudes) {
    const intervals = lower48LongitudeIntervalsAtLatitude(lat);
    for (let step = 0; step <= 5900; step += 1) {
      const lon = -125 + step * 0.01;
      const point = isPointInLower48Mainland(lat, lon);
      assert.equal(point, intervalsContain(intervals, lon), `lat=${lat} lon=${lon}`);
      checked += 1;
      if (point) {
        inside += 1;
      }
    }
  }
  assert.ok(inside > 0 && inside < checked, "sweep should cover both mainland and offshore cells");
});

test("rows outside the mainland bbox produce no intervals", () => {
  for (const lat of [Number.NaN, Number.POSITIVE_INFINITY, 20, 52]) {
    assert.deepEqual(lower48LongitudeIntervalsAtLatitude(lat), []);
  }
});

test("intervals are sorted west-to-east pairs inside the bbox", () => {
  for (let lat = 25.5; lat <= 48.5; lat += 0.25) {
    let previousEast = Number.NEGATIVE_INFINITY;
    for (const [west, east] of lower48LongitudeIntervalsAtLatitude(lat)) {
      assert.ok(west <= east, `lat=${lat}: interval not ordered`);
      assert.ok(west >= previousEast, `lat=${lat}: intervals overlap or unsorted`);
      assert.ok(west >= -125 && east <= -66, `lat=${lat}: interval outside bbox`);
      previousEast = east;
    }
  }
});
