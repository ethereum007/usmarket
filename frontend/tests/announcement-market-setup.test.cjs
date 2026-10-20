const { test } = require('node:test');
const assert = require('node:assert/strict');
const { marketSetup } = require('../app/latest-updates/market-setup.ts');
const candles = () => Array.from({ length: 51 }, (_, i) => ({ date: new Date(Date.UTC(2026, 7, 22 + i)).toISOString().slice(0, 10), open: 100, high: 101, low: 99, close: 100, volume: 100 }));
const date = '2026-10-11';
test('breakout uses prior highs, excluding the confirmation candle', () => {
  const bars = candles(); Object.assign(bars.at(-1), { close: 103, high: 104, volume: 200 });
  const setup = marketSetup(bars, date);
  assert.equal(setup.label, 'Breakout'); assert.equal(setup.resistance, 101); assert.equal(setup.volumeRatio, 2);
});
test('small crosses do not bypass the 0.2% breakout buffer', () => {
  const bars = candles(); Object.assign(bars.at(-1), { close: 101.1, high: 102 });
  assert.equal(marketSetup(bars, date).label, 'Near resistance');
});
test('negative price moves are classified as breakdowns', () => {
  const bars = candles(); Object.assign(bars.at(-1), { close: 97, low: 96 });
  assert.equal(marketSetup(bars, date).label, 'Breakdown');
});
test('missing volume never becomes strong volume confirmation', () => {
  const bars = candles().map(bar => ({ ...bar, volume: 0 })); Object.assign(bars.at(-1), { close: 103, high: 104 });
  const setup = marketSetup(bars, date); assert.equal(setup.volumeRatio, null); assert.match(setup.reason, /unavailable/);
});
test('old and future candles cannot be presented as current setups', () => {
  assert.equal(marketSetup(candles(), '2026-10-25').label, 'Data stale');
  assert.equal(marketSetup(candles(), '2026-10-01').label, 'Data stale');
});
test('inadequate history stays unclassified', () => {
  assert.equal(marketSetup(candles().slice(-20), date).label, 'Insufficient data');
});
test('tight ranges away from the larger range edges are consolidations', () => {
  const bars = candles(); bars[35].high = 120; bars[36].low = 80;
  assert.equal(marketSetup(bars, date).label, 'Consolidating');
});
