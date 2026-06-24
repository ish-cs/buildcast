'use strict';
// buildcast forecasting engine — pure, no I/O. Monte Carlo over real task durations.
//
// Improvements over naive "range × tasks":
//  1. Monte Carlo: resample remaining tasks from history, sum, take percentiles.
//     Summing N tasks cancels per-task variance (central limit) → tight band.
//  2. Type buckets: sample a remaining task from its OWN commit-type history
//     (feat tasks ≠ test tasks), when the remaining task's type is known.
//  3. Conditional in-flight: the WIP task has already run `wipElapsedSec`; we
//     forecast only the REMAINDER (right-censored draw), not a fresh full task.
//  4. Duty-cycle calendar: learn the active/idle rhythm from commit clock and
//     convert effort-seconds into a projected wall-clock finish.

const IDLE_CAP = 3 * 3600; // gaps longer than this = "away", not task work
const MIN_GAP = 30;        // gaps shorter than this = amend/typo commits

// deterministic RNG (mulberry32) so output is stable until inputs change
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(sorted, p) {
  const n = sorted.length;
  if (n === 0) return null;
  if (n === 1) return sorted[0];
  const k = (n - 1) * p;
  const lo = Math.floor(k), hi = Math.min(lo + 1, n - 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (k - lo);
}

// conventional-commit type from a subject line: "feat(x): ..." -> "feat"
function commitType(subject) {
  const m = /^(\w+)(\([^)]*\))?!?:/.exec((subject || '').trim());
  return m ? m[1].toLowerCase() : 'other';
}

// Build per-task duration samples from consecutive task-closing commits.
// commits: [{ts (unix sec), subject, churn?}], ascending by ts.
// Each gap is attributed to the task CLOSED by the later commit.
function buildSamples(commits) {
  const samples = [];
  for (let i = 1; i < commits.length; i++) {
    const dur = commits[i].ts - commits[i - 1].ts;
    if (dur < MIN_GAP || dur > IDLE_CAP) continue;
    samples.push({ dur, type: commitType(commits[i].subject), churn: commits[i].churn || 0 });
  }
  return samples;
}

// Duty cycle + active-hour profile from ALL commit timestamps (not just tasks).
function dutyProfile(allTimestamps) {
  const ts = [...allTimestamps].sort((a, b) => a - b);
  if (ts.length < 2) return { dutyCycle: null, activeSec: 0, wallSec: 0 };
  let active = 0;
  for (let i = 1; i < ts.length; i++) {
    const g = ts[i] - ts[i - 1];
    if (g > 0 && g <= IDLE_CAP) active += g;
  }
  const wall = ts[ts.length - 1] - ts[0];
  return { dutyCycle: wall > 0 ? active / wall : null, activeSec: active, wallSec: wall };
}

// Core Monte Carlo forecast.
// opts:
//   commits        [{ts, subject, churn?}]  task-closing commits, ascending
//   allTimestamps  number[]                 every commit ts (for duty cycle); defaults to commits' ts
//   remainingFull  int                      untouched tasks
//   remainingWip   int                      in-flight tasks (default 0)
//   wipElapsedSec  number                   how long the in-flight task has already run
//   remainingTypes string[]                 optional known types of remaining tasks (e.g. ['feat','test'])
//   nowSec         number                   current unix sec (for calendar); required for calendar
//   trials         int                      MC iterations (default 20000)
//   seed           int                      RNG seed (default 42)
function forecast(opts) {
  const {
    commits = [], remainingFull = 0, remainingWip = 0, wipElapsedSec = 0,
    remainingTypes = null, nowSec = null, trials = 20000, seed = 42,
  } = opts;
  const allTs = opts.allTimestamps || commits.map(c => c.ts);

  const samples = buildSamples(commits);
  const remaining = remainingFull + (remainingWip > 0 ? 1 : 0); // distinct task count
  const out = { method: 'monte-carlo', samples: samples.length, remainingTasks: remainingFull + remainingWip };

  if (remainingFull <= 0 && remainingWip <= 0) { out.done = true; return out; }
  if (samples.length < 5) { out.insufficient = true; return out; }

  // global pool + per-type pools
  const pool = samples.map(s => s.dur);
  const byType = {};
  for (const s of samples) (byType[s.type] = byType[s.type] || []).push(s.dur);
  const drawFrom = (r, arr) => arr[Math.floor(r() * arr.length)];
  const drawType = (r, type) => {
    const b = type && byType[type] && byType[type].length >= 3 ? byType[type] : pool;
    return drawFrom(r, b);
  };

  const r = rng(seed);
  const totals = new Array(trials);
  for (let t = 0; t < trials; t++) {
    let sum = 0;
    for (let i = 0; i < remainingFull; i++) {
      const type = remainingTypes && remainingTypes[i] ? remainingTypes[i] : null;
      sum += drawType(r, type);
    }
    for (let w = 0; w < remainingWip; w++) {
      // conditional: only the remainder beyond what's already elapsed
      sum += Math.max(0, drawFrom(r, pool) - wipElapsedSec);
    }
    totals[t] = sum;
  }
  totals.sort((a, b) => a - b);

  const eP50 = percentile(totals, 0.50);
  const eP85 = percentile(totals, 0.85);
  const eP95 = percentile(totals, 0.95);
  out.effort = { p50: eP50, p85: eP85, p95: eP95 };
  out.perTaskTypical = percentile([...pool].sort((a, b) => a - b), 0.50);

  // duty-cycle calendar
  const duty = dutyProfile(allTs);
  out.dutyCycle = duty.dutyCycle;
  if (nowSec != null && duty.dutyCycle && duty.dutyCycle > 0) {
    const wall = e => Math.round(e / duty.dutyCycle); // effort spread at the historical active rate
    out.calendar = {
      p50Sec: nowSec + wall(eP50),
      p85Sec: nowSec + wall(eP85),
      wallSecP50: wall(eP50),
      wallSecP85: wall(eP85),
    };
  }
  return out;
}

// Backtest: hold out the last K task durations, forecast from the rest, check
// whether actual total landed under P50/P85/P95. Returns calibration hit-rates
// over many hold-out windows — this is how we substantiate "X out of 100".
function backtest(commits, { window = 5, seed = 42 } = {}) {
  const samples = buildSamples(commits).map(s => s.dur);
  if (samples.length < window + 8) return { insufficient: true, have: samples.length };
  let n = 0, h50 = 0, h85 = 0, h95 = 0, absErr = 0, sumActual = 0;
  for (let cut = 8; cut + window <= samples.length; cut++) {
    const hist = samples.slice(0, cut);
    const actual = samples.slice(cut, cut + window).reduce((a, b) => a + b, 0);
    // build a synthetic commit list from hist for forecast()
    let ts = 0; const synth = [{ ts: 0, subject: 'seed: x' }];
    for (const d of hist) { ts += d; synth.push({ ts, subject: 'feat: x' }); }
    const f = forecast({ commits: synth, remainingFull: window, trials: 8000, seed: seed + cut });
    if (!f.effort) continue;
    n++;
    if (actual <= f.effort.p50) h50++;
    if (actual <= f.effort.p85) h85++;
    if (actual <= f.effort.p95) h95++;
    absErr += Math.abs(actual - f.effort.p50);
    sumActual += actual;
  }
  if (!n) return { insufficient: true };
  return {
    windows: n,
    coverageP50: h50 / n, coverageP85: h85 / n, coverageP95: h95 / n,
    // MAPE of the P50 point estimate vs actual total
    mapeP50: sumActual ? absErr / sumActual : null,
  };
}

module.exports = { forecast, backtest, buildSamples, dutyProfile, percentile, commitType, rng };
