'use strict';
// Reproducible benchmark: the naive bootstrap (v1) vs the full engine (v2) on
// three regimes — drift, heavy tail, stationary — from a fixed seed. Every
// number in the README's benchmark table is produced here.
//
//   node benchmarks/synthetic.js
//
// All randomness is seeded, so the output is byte-for-byte reproducible.
const { abCompare } = require('../src/backtest');
const { mulberry32, randNormal } = require('../src/mathutil');

// Turn a list of task durations (seconds) into a synthetic commit history where
// each gap between consecutive commits is one task.
function commitsFrom(durs) {
  let ts = 1700000000;
  const c = [{ ts, subject: 'seed: x' }];
  for (const d of durs) {
    ts += Math.max(1, Math.round(d));
    c.push({ ts, subject: 'feat: x' });
  }
  return c;
}

// Non-stationary: task time drifts up ~10× across the project (later tasks
// harder) — the regime a stationary bootstrap silently under-forecasts.
function drift(n, seed) {
  const r = mulberry32(seed);
  const o = [];
  for (let i = 0; i < n; i++) o.push(Math.exp(Math.log(240) + (i / n) * Math.log(10) + 0.35 * randNormal(r)));
  return o;
}
// Heavy-tailed, stationary: σ=1.25 log-normal — the empirical max under-covers P95.
function heavy(n, seed) {
  const r = mulberry32(seed);
  const o = [];
  for (let i = 0; i < n; i++) o.push(Math.exp(Math.log(500) + 1.25 * randNormal(r)));
  return o;
}
// Well-behaved, stationary: the bootstrap is already near-optimal here.
function stationary(n, seed) {
  const r = mulberry32(seed);
  const o = [];
  for (let i = 0; i < n; i++) o.push(Math.exp(Math.log(600) + 0.5 * randNormal(r)));
  return o;
}

const P = (x) => (x == null ? '  —' : `${(100 * x).toFixed(0).padStart(3)}%`);
function row(label, durs) {
  const r = abCompare(commitsFrom(durs), { horizon: 5 });
  if (r.insufficient) return console.log(label.padEnd(12), 'insufficient');
  console.log(
    label.padEnd(12),
    `skill ${`${(100 * r.skill).toFixed(0)}%`.padStart(5)}`,
    ` CRPS ${String(Math.round(r.v1.meanCRPS)).padStart(5)}→${String(Math.round(r.v2.meanCRPS)).padStart(5)}`,
    ` MAPE ${P(r.v1.mapeP50)}→${P(r.v2.mapeP50)}`,
    ` P95cov ${P(r.v1.coverageP95)}→${P(r.v2.coverageP95)}`,
    ` P50cov ${P(r.v1.coverageP50)}→${P(r.v2.coverageP50)}`,
  );
}

console.log('\nbuildcast — naive bootstrap (v1) → full engine (v2) · 70 tasks · horizon 5 · seeded\n');
row('drifting', drift(70, 11));
row('heavy-tail', heavy(70, 22));
row('stationary', stationary(70, 5));
console.log('\nskill = 1 − CRPS_v2/CRPS_v1 (higher = better). On your own repo:  buildcast --repo . --validate\n');
