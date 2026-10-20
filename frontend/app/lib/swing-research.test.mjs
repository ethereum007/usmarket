import assert from "node:assert/strict";
import test from "node:test";
import { weeklyBars, numberText } from "./swing-research.ts";

test("weekly chart preserves actual session dates and OHLCV across a holiday gap", () => {
  const source = [
    { date: "2026-10-05", open: 100, high: 105, low: 99, close: 103, volume: 10 },
    { date: "2026-10-08", open: 104, high: 109, low: 102, close: 108, volume: 20 },
    { date: "2026-10-12", open: 110, high: 113, low: 107, close: 111, volume: 30 },
  ];
  assert.deepEqual(weeklyBars(source), [
    { date: "2026-10-08", open: 100, high: 109, low: 99, close: 108, volume: 30 },
    { date: "2026-10-12", open: 110, high: 113, low: 107, close: 111, volume: 30 },
  ]);
  assert.equal(source[0].close, 103);
});

test("unknown metrics never format as zero", () => {
  assert.equal(numberText(null), "Unknown");
  assert.equal(numberText(NaN), "Unknown");
  assert.equal(numberText(0), "0");
});
