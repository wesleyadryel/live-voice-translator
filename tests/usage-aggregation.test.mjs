import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// The chart stores one row per minute and folds it into whatever scale is selected,
// so the folding itself is the part worth exercising against known numbers.
const source = await readFile(new URL("../src/usage.js", import.meta.url), "utf8");
const body = source.slice(source.indexOf("function readBucket"), source.indexOf("function seriesValue"));
const aggregate = new Function("buckets", "view", "MAX_BARS", `${body}; return aggregate();`);

const now = Math.floor(Date.now() / 60000);
const buckets = new Map([
  [now - 2, [100, 50, 80, 40, 0]],
  [now - 1, [200, 100, 160, 80, 0]],
  [now, [300, 150, 240, 120, 0]],
  [now - 300, [1000, 500, 900, 450, 0]]
]);

const hour = aggregate(buckets, { rangeMinutes: 1440, bucketMinutes: 60, series: "all" }, 90);
assert.equal(hour.reduce((sum, item) => sum + item.all, 0), 2400, "folding into hours must preserve every token");
assert.equal(hour.reduce((sum, item) => sum + item.audio, 0), 80 + 40 + 160 + 80 + 240 + 120 + 900 + 450, "audio must be summed from the audio fields only");
assert.ok(hour.every((item) => item.all >= item.audio), "audio can never exceed the total it belongs to");

const minute = aggregate(buckets, { rangeMinutes: 60, bucketMinutes: 1, series: "all" }, 90);
assert.equal(minute.reduce((sum, item) => sum + item.all, 0), 900, "a 1h range must exclude older buckets");
assert.equal(minute.length, 3, "consecutive minutes must produce one bar each");

// Silence is information: a quiet stretch must render as empty bars, not vanish.
const gapped = new Map([[now - 10, [10, 0, 8, 0, 0]], [now, [10, 0, 8, 0, 0]]]);
const withGap = aggregate(gapped, { rangeMinutes: 60, bucketMinutes: 1, series: "all" }, 90);
assert.equal(withGap.length, 11, "quiet minutes inside the range must still be plotted");
assert.equal(withGap.filter((item) => item.all === 0).length, 9, "gaps must stay visible instead of collapsing");

const allTime = aggregate(buckets, { rangeMinutes: 0, bucketMinutes: 1440, series: "all" }, 90);
assert.equal(allTime.reduce((sum, item) => sum + item.all, 0), 2400, "the all-time range must keep everything");

const dense = new Map();
for (let i = 0; i < 500; i += 1) dense.set(now - i, [10, 0, 8, 0, 0]);
assert.ok(aggregate(dense, { rangeMinutes: 0, bucketMinutes: 1, series: "all" }, 90).length <= 90, "bar count must stay bounded");

console.log("usage aggregation test: OK");
