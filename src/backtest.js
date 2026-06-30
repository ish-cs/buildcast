'use strict';
// Walk-forward validation + A/B receipt.
//
// This is how buildcast PROVES v2 beats v1 instead of asserting it: run both
// engines through identical expanding-window origins on the repo's own history
// and score every forecast with CRPS (proper, sharpness+calibration) plus
// coverage hit-rates and a PIT histogram. The A/B skill score and a paired
// bootstrap over per-origin CRPS differences are the legible "v2 wins" evidence.

const { walkForward, makeV2Forecaster, reindex, calibrate } = require('./forecast');
const { buildSamples } = require('./samples');
const { quantileSorted } = require('./scoring');
const { mulberry32 } = require('./mathutil');

const CV_TRIALS = 4000;

// The v1 engine we're beating: naive unweighted bootstrap of raw commit gaps.
function makeV1Forecaster(trials = CV_TRIALS) {
  return (train, horizon, seed) => {
    const durs = train.map((x) => x.dur);
    if (!durs.length) return [];
    const rng = mulberry32(seed);
    const totals = new Array(trials);
    for (let t = 0; t < trials; t++) {
      let s = 0;
      for (let h = 0; h < horizon; h++) s += durs[Math.floor(rng() * durs.length)];
      totals[t] = s;
    }
    totals.sort((a, b) => a - b);
    return totals;
  };
}

function pitHistogram(rows, bins = 10) {
  const h = new Array(bins).fill(0);
  for (const r of rows) {
    if (r.pit == null) continue;
    let b = Math.floor(r.pit * bins);
    if (b >= bins) b = bins - 1;
    if (b < 0) b = 0;
    h[b]++;
  }
  return h;
}

function aggregate(rows) {
  const n = rows.length;
  if (!n) return { insufficient: true, windows: 0 };
  const mean = (k) => rows.reduce((a, r) => a + r[k], 0) / n;
  const mape = rows.reduce((a, r) => a + Math.abs(r.actual - r.p50) / Math.max(r.actual, 1e-9), 0) / n;
  return {
    windows: n,
    meanCRPS: mean('crps'),
    coverageP50: mean('hit50'),
    coverageP85: mean('hit85'),
    coverageP95: mean('hit95'),
    mapeP50: mape,
    pitHist: pitHistogram(rows),
  };
}

// Paired bootstrap over per-origin CRPS differences d = crps_v1 − crps_v2
// (positive ⇒ v2 better). Returns the fraction of resamples whose mean d > 0.
function pairedBootstrap(diffs, seed = 7, B = 2000) {
  if (!diffs.length) return null;
  const rng = mulberry32(seed);
  let wins = 0;
  for (let b = 0; b < B; b++) {
    let s = 0;
    for (let i = 0; i < diffs.length; i++) s += diffs[Math.floor(rng() * diffs.length)];
    if (s > 0) wins++;
  }
  return wins / B;
}

// v2-only walk-forward report (back-compat superset of the v1 `backtest`).
// Accepts `window` as an alias for `horizon` (v1 CLI compatibility).
function backtest(commits, opts = {}) {
  const built = buildSamples(commits, {});
  const samples = built.samples;
  const horizon = opts.horizon || opts.window || 1;
  const warmup = Math.max(15, Math.ceil(0.4 * samples.length));
  if (samples.length < warmup + horizon) return { insufficient: true, have: samples.length };

  const cfg = opts.config || calibrate(samples, { horizon });
  const rows = walkForward(
    samples,
    makeV2Forecaster({ H: cfg.H, sampler: cfg.sampler, uplift: cfg.uplift, trials: opts.trials || CV_TRIALS }),
    { horizon, warmup, seed: opts.seed || 1000 },
  );
  const agg = aggregate(rows);
  return { ...agg, config: cfg, samples: samples.length, insufficient: false };
}

// Full A/B: v1 vs v2 through identical origins/seeds.
function abCompare(commits, opts = {}) {
  const built = buildSamples(commits, {});
  const samples = built.samples;
  const horizon = opts.horizon || 1;
  const warmup = Math.max(15, Math.ceil(0.4 * samples.length));
  if (samples.length < warmup + horizon) return { insufficient: true, have: samples.length };

  const cfg = opts.config || calibrate(samples, { horizon });
  const seed = opts.seed || 1000;
  const trials = opts.trials || CV_TRIALS;

  const v1rows = walkForward(samples, makeV1Forecaster(trials), { horizon, warmup, seed });
  const v2rows = walkForward(
    samples,
    makeV2Forecaster({ H: cfg.H, sampler: cfg.sampler, uplift: cfg.uplift, trials }),
    { horizon, warmup, seed },
  );

  const v1 = aggregate(v1rows);
  const v2 = aggregate(v2rows);
  const skill = v1.meanCRPS > 0 ? 1 - v2.meanCRPS / v1.meanCRPS : null;
  // align by origin (same warmup/horizon/seed base ⇒ same actuals)
  const m = Math.min(v1rows.length, v2rows.length);
  const diffs = [];
  for (let i = 0; i < m; i++) diffs.push(v1rows[i].crps - v2rows[i].crps);
  const winProb = pairedBootstrap(diffs, opts.bootSeed || 7);

  return { v1, v2, skill, winProb, config: cfg, origins: m };
}

module.exports = { backtest, abCompare, makeV1Forecaster, aggregate, pairedBootstrap, pitHistogram };
