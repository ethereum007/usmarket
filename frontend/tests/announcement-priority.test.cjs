const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reviewPriority, comparePriority } = require('../app/latest-updates/priority.ts');
const base = { id: 'a', event_type: 'order_win', event_date: '2026-10-11T10:00:00Z', materiality: 'high', confidence: 'high', source_url: 'https://nsearchives.nseindia.com/corporate/test.pdf', metadata: {} };
test('negative developments receive the same priority as positive ones', () => {
  assert.equal(reviewPriority(base).level, 'high');
  assert.equal(reviewPriority({ ...base, event_type: 'regulatory_action' }).level, 'high');
});
test('weak evidence, unknown impact and missing sources do not get high priority', () => {
  for (const change of [{ confidence: 'low' }, { materiality: 'unknown', signal_score: 100 }, { source_url: null }]) assert.notEqual(reviewPriority({ ...base, ...change }).level, 'high');
});
test('repeated news and low impact stay low', () => {
  assert.equal(reviewPriority({ ...base, materiality: 'low' }).level, 'low');
  assert.equal(reviewPriority({ ...base, metadata: { is_repeat: true } }).level, 'low');
});
test('older high priority events rank before newer low priority news', () => {
  const low = { ...base, id: 'b', materiality: 'low', event_date: '2026-10-11T11:00:00Z' };
  assert.deepEqual([low, base].sort(comparePriority).map(row => row.id), ['a', 'b']);
});
test('invalid persisted priority safely falls back to evidence ratings', () => {
  assert.equal(reviewPriority({ ...base, metadata: { review_priority: { level: 'high', score: 'bad' } } }).level, 'high');
});
