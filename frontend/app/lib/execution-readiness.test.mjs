import assert from "node:assert/strict";
import test from "node:test";
import { executionBlockers } from "./execution-readiness.ts";

const ready = {
  researchOnly: false, marketOpen: true, freshness: "fresh", ageSeconds: 10,
  spreadPct: 0.05, liquidityScore: 80, entry: 100, stop: 95, bias: "LONG",
  quotePrice: 100, quoteReceivedAt: 100000, now: 110000, feedError: false,
};

test("complete live evidence passes mandatory checks", () => {
  assert.deepEqual(executionBlockers(ready), []);
});

test("each missing mandatory input independently blocks execution", () => {
  for (const override of [
    { researchOnly: true }, { marketOpen: false }, { freshness: "unknown" },
    { ageSeconds: null }, { ageSeconds: 91 }, { spreadPct: null },
    { spreadPct: -0.01 }, { spreadPct: 0.13 }, { spreadPct: NaN },
    { liquidityScore: 54 }, { stop: null }, { stop: 101 }, { bias: "NEUTRAL" },
    { quotePrice: null }, { quoteReceivedAt: null }, { now: 200001 },
    { feedError: true },
  ]) assert.ok(executionBlockers({ ...ready, ...override }).length, JSON.stringify(override));
});

test("short stop must be above entry", () => {
  assert.deepEqual(executionBlockers({ ...ready, bias: "SHORT", stop: 105 }), []);
  assert.ok(executionBlockers({ ...ready, bias: "SHORT", stop: 95 }).length);
});
