const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const filename = path.resolve(__dirname, '../app/lib/intraday-priority.ts');
const compiled = new Module(filename, module);
compiled._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, filename);
const { entryStatus, priorityFor, comparePriority } = compiled.exports;
const now = Date.parse('2026-09-24T11:00:00+05:30');
const context = { now, stale: false, marketOpen: true };
const signal = (status = 'CHECKS_PASSED', age = 2, type = 'FIVE_MIN_BREAKOUT', rr = 1.8) => ({
  type, signalTime: new Date(now - age * 60000).toISOString(),
  entryAssessment: { status, asOf: new Date(now).toISOString(), remainingRewardRisk: rr, checks: [] },
});
const candidate = (signals, score = 80, symbol = 'TEST') => ({ symbol, direction: 'LONG', score, signals });
const rank = (signals, score = 80, selected = signals[0], ctx = context) => priorityFor(candidate(signals, score), selected, ctx);

test('current entry checks outrank high-score watch, review and invalid rows', () => {
  const entries = ['INVALIDATED', 'EXPIRED', 'WAIT', 'CHECKS_PASSED'].map((status, i) => ({
    key: status, priority: rank([signal(status)], 100 - i * 20),
  }));
  entries.sort((a, b) => comparePriority(a.priority, b.priority, a.key, b.key));
  assert.deepEqual(entries.map(x => x.key), ['CHECKS_PASSED', 'WAIT', 'EXPIRED', 'INVALIDATED']);
});

test('agreement only counts the newest valid confirmation per basis', () => {
  const rows = [signal('CHECKS_PASSED', 8), signal('INVALIDATED', 1),
    signal('CHECKS_PASSED', 3, 'PDH_BREAK'), signal('CHECKS_PASSED', 20, 'FIFTEEN_MIN_BREAKOUT')];
  assert.equal(rank(rows).agreement, 1);
  const more = rank([signal(), signal('CHECKS_PASSED', 3, 'PDH_BREAK')], 60);
  assert.ok(comparePriority(more, rank([signal()], 99), 'A', 'B') < 0);
});

test('freshness precedes remaining reward/risk, which precedes Radar score', () => {
  assert.ok(comparePriority(rank([signal('CHECKS_PASSED', 1)], 50), rank([signal('CHECKS_PASSED', 4)], 99), 'A', 'B') < 0);
  assert.ok(comparePriority(rank([signal('CHECKS_PASSED', 2, 'FIVE_MIN_BREAKOUT', 2)], 50), rank([signal()], 99), 'A', 'B') < 0);
  assert.ok(comparePriority(rank([signal()], 90), rank([signal()], 80), 'A', 'B') < 0);
});

test('stale, expired and future timestamps cannot produce a current entry', () => {
  assert.equal(rank([signal()], 80, undefined, { ...context, stale: true }).group, 3);
  assert.equal(entryStatus(signal(), { ...context, marketOpen: false }), 'MARKET_CLOSED');
  assert.equal(entryStatus(signal('CHECKS_PASSED', 16), context), 'EXPIRED');
  assert.equal(entryStatus(signal('CHECKS_PASSED', -1), context), 'DATA_CHECK');
  const expiredAssessment = signal();
  expiredAssessment.entryAssessment.asOf = new Date(now - 91000).toISOString();
  assert.equal(entryStatus(expiredAssessment, context), 'DATA_CHECK');
});

test('missing selected basis is a watch candidate only with usable other evidence', () => {
  assert.equal(priorityFor(candidate([signal()]), undefined, context).group, 1);
  assert.equal(priorityFor(candidate([signal('DATA_CHECK')]), undefined, context).group, 3);
  assert.equal(priorityFor(candidate([signal('INVALIDATED')]), undefined, context).group, 3);
  assert.equal(priorityFor(candidate([signal('EXPIRED')]), undefined, context).group, 3);
  assert.equal(priorityFor(candidate([]), undefined, context).group, 3);
});

test('missing and invalid values sort deterministically without NaN', () => {
  const invalid = { ...signal(), signalTime: 'invalid' };
  const a = rank([invalid], NaN), b = rank([], NaN);
  assert.equal(a.age, Infinity);
  assert.ok(comparePriority(a, b, 'A-LONG', 'B-LONG') < 0);
  assert.ok(comparePriority(b, a, 'B-LONG', 'A-LONG') > 0);
  assert.equal(comparePriority(a, a, 'A-LONG', 'A-LONG'), 0);
});
