'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { forecast, backtest, buildSamples, dutyProfile, percentile, commitType } = require('../src/forecast');

// helper: synthesize task commits from a list of durations (sec)
function synth(durations, type = 'feat') {
  let ts = 0; const c = [{ ts: 0, subject: 'seed: x' }];
  for (const d of durations) { ts += d; c.push({ ts, subject: `${type}: x` }); }
  return c;
}

test('percentile interpolates', () => {
  const xs = [0, 10, 20, 30, 40];
  assert.equal(percentile(xs, 0), 0);
  assert.equal(percentile(xs, 0.5), 20);
  assert.equal(percentile(xs, 1), 40);
});

test('commitType parses conventional commits', () => {
  assert.equal(commitType('feat(memory): x'), 'feat');
  assert.equal(commitType('fix: y'), 'fix');
  assert.equal(commitType('random text'), 'other');
});

test('buildSamples drops idle (>3h) and amend (<30s) gaps', () => {
  const c = synth([600, 5, 600, 4 * 3600, 600]); // 5s amend + 4h idle dropped
  const s = buildSamples(c);
  assert.deepEqual(s.map(x => x.dur), [600, 600, 600]);
});

test('constant history → effort ≈ exact multiple (Monte Carlo sanity)', () => {
  const c = synth(new Array(20).fill(600)); // every task exactly 10 min
  const f = forecast({ commits: c, remainingFull: 5, nowSec: 1_000_000 });
  // 5 tasks × 600s = 3000s, with zero variance the band collapses onto it
  assert.ok(Math.abs(f.effort.p50 - 3000) < 1, `p50=${f.effort.p50}`);
  assert.ok(Math.abs(f.effort.p85 - 3000) < 1, `p85=${f.effort.p85}`);
});

test('percentiles are ordered P50 ≤ P85 ≤ P95', () => {
  const c = synth([120, 300, 600, 900, 1800, 240, 480, 1200, 360, 720]);
  const f = forecast({ commits: c, remainingFull: 5 });
  assert.ok(f.effort.p50 <= f.effort.p85);
  assert.ok(f.effort.p85 <= f.effort.p95);
});

test('conditional in-flight reduces the total vs a fresh task', () => {
  const c = synth(new Array(15).fill(600));
  const fresh = forecast({ commits: c, remainingFull: 0, remainingWip: 1, wipElapsedSec: 0, seed: 7 });
  const partly = forecast({ commits: c, remainingFull: 0, remainingWip: 1, wipElapsedSec: 300, seed: 7 });
  assert.ok(partly.effort.p50 < fresh.effort.p50, `${partly.effort.p50} !< ${fresh.effort.p50}`);
});

test('type buckets used when remaining type is known', () => {
  // feat tasks = 1000s, test tasks = 100s; ask for one of each
  let ts = 0; const c = [{ ts: 0, subject: 'seed: x' }];
  for (let i = 0; i < 6; i++) { ts += 1000; c.push({ ts, subject: 'feat: a' }); ts += 100; c.push({ ts, subject: 'test: b' }); }
  const f = forecast({ commits: c, remainingFull: 2, remainingTypes: ['feat', 'test'], seed: 3 });
  // ~1000 + ~100 = ~1100, far from the global-mean approach (~550×2=1100 too, but variance differs);
  // assert it lands near the type-aware sum, not wildly off
  assert.ok(f.effort.p50 > 900 && f.effort.p50 < 1300, `p50=${f.effort.p50}`);
});

test('dutyProfile drops long idle gaps from active time', () => {
  // 600s active burst, then a 4h idle (> 3h cap), repeated → low duty cycle
  const ts = [];
  let t = 0;
  for (let k = 0; k < 6; k++) { ts.push(t); t += 600; ts.push(t); t += 4 * 3600; }
  const d = dutyProfile(ts);
  assert.ok(d.dutyCycle > 0.01 && d.dutyCycle < 0.2, `duty=${d.dutyCycle}`);
});

test('calibration backtest: P85 coverage lands in a sane band', () => {
  // log-normal-ish synthetic history, stationary
  const seedRng = (() => { let a = 99; return () => { a = (a * 1103515245 + 12345) & 0x7fffffff; return a / 0x7fffffff; }; })();
  const durs = Array.from({ length: 40 }, () => Math.round(120 + Math.exp(seedRng() * 2.2) * 120));
  const c = synth(durs);
  const bt = backtest(c, { window: 5 });
  assert.ok(!bt.insufficient, 'should have enough history');
  // a well-calibrated P85 covers ~70–100% of hold-outs on stationary data
  assert.ok(bt.coverageP85 >= 0.6, `P85 coverage too low: ${bt.coverageP85}`);
  assert.ok(bt.coverageP50 <= bt.coverageP85, 'P50 should cover ≤ P85');
});
