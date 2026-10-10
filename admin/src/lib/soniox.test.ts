import assert from "node:assert/strict";
import {
  sonioxFailures,
  sonioxInWindow,
  sonioxHourSeries,
  sonioxCost,
  type SonioxGroup,
} from "./soniox";
assert.equal(sonioxFailures("timeout"), true);
assert.equal(sonioxFailures("interrupted"), true);
assert.equal(sonioxFailures("empty"), false);
assert.equal(sonioxInWindow({ window: "previous" } as SonioxGroup, 1), false);
assert.equal(sonioxInWindow({ window: "day" } as SonioxGroup, 1), true);
assert.equal(sonioxInWindow({ window: "previous" } as SonioxGroup, 7), true);
const now = Date.parse("2026-10-10T12:30:00Z");
const points = sonioxHourSeries(
  [{ at: "2026-10-10T10:00:00Z", calls: 5, errors: 2 }],
  1,
  now,
);
assert.equal(points.length, 25);
assert.equal(points.at(-1)?.calls, 0);
assert.equal(points.find((p) => p.at === "2026-10-10T10:00:00Z")?.calls, 5);
assert.equal(sonioxHourSeries([], 7, now).length, 169);
console.log(
  "Soniox periods, error states and continuous hourly timeline passed",
);

assert.equal(sonioxCost(0.000012), "0,000012");
assert.equal(sonioxCost(0), "0,00");
assert.equal(sonioxCost(null), "—");
