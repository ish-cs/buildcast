'use strict';
// buildcast v2 forecasting engine.
//
// Pipeline: commits → clean recency-weighted samples (samples.js) → fit a
// parametric/spliced model selected by AICc (dist.js) → Monte-Carlo the sum of
// the N remaining tasks → percentiles, scored honestly by CRPS (scoring.js).
//
// What v2 fixes over the naive bootstrap (measured on Lawd: P50 coverage 17%,
// P95 83%, MAPE 62%):
//   • recency weighting        → tracks non-stationary drift (the 17% under-bias)
//   • parametric (lognormal)   → a fatter, extrapolated tail (the 83% P95)
//     tail, Bessel-corrected σ
//   • reference-class uplift    → corrects residual inside-view optimism
//   • conditional WIP draw      → P(D|D>T), not the v1 floored `draw−T` bug
//   • auto-calibration          → picks H + sampler + uplift by walk-forward CRPS
//
// Calendar/duty-cycle is intentionally unchanged (v2 is effort-first).

const {
  buildSamples,
  applyRecencyWeights,
  nEff,
  commitType,
  IDLE_CAP,
} = require('./samples');
const {
  selectModel,
  parametricModel,
  empiricalModel,
  churnModel,
  effectiveN,
} = require('./dist');
const { crpsEnsemble, quantileSorted, coverageHit, pit } = require('./scoring');
const { mulberry32 } = require('./mathutil');

const TRIALS = 20000; // final forecast resolution
const CV_TRIALS = 4000; // cheaper during calibration walk-forward
const MIN_SAMPLES = 5; // below this we can't fit anything trustworthy

// Back-compat alias — v1 exposed `percentile(sortedAsc, p)`.
const percentile = quantileSorted;

// ── duty-cycle calendar (unchanged from v1) ────────────────────────────────
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

// ── weighted log-space statistics ──────────────────────────────────────────
function weightedLogMean(samples) {
  let W = 0;
  let s = 0;
  for (const x of samples) {
    const w = x.weight == null ? 1 : x.weight;
    W += w;
    s += w * Math.log(x.dur);
  }
  return W > 0 ? s / W : 0;
}

// Pooled within-type variance of ln(dur): Σ_t Σ_i w (ln dur − μ_t)² / (Σw − k).
// Falls back to the ungrouped log-variance when there are too few types.
function pooledLogVar(byType, globalMu) {
  let num = 0;
  let W = 0;
  let k = 0;
  for (const arr of byType.values()) {
    if (!arr.length) continue;
    k++;
    const mu = weightedLogMean(arr);
    for (const x of arr) {
      const w = x.weight == null ? 1 : x.weight;
      num += w * (Math.log(x.dur) - mu) ** 2;
      W += w;
    }
  }
  const denom = W - k;
  if (denom > 1e-9) return num / denom;
  // Degenerate (every type has ~1 effective sample): use the global spread.
  let n2 = 0;
  let W2 = 0;
  for (const arr of byType.values())
    for (const x of arr) {
      const w = x.weight == null ? 1 : x.weight;
      n2 += w * (Math.log(x.dur) - globalMu) ** 2;
      W2 += w;
    }
  return W2 > 0 ? n2 / W2 : 1e-6;
}

function groupByType(samples) {
  const m = new Map();
  for (const x of samples) {
    if (!m.has(x.type)) m.set(x.type, []);
    m.get(x.type).push(x);
  }
  return m;
}

// ── model construction (global + per-type, hierarchical) ───────────────────
// Returns a global model (AICc-selected, optionally spliced) plus a lognormal
// model per type whose log-mean is shrunk toward the global mean (dist.js does
// the empirical-Bayes shrinkage). Type models share one pooled σ — fitting a
// per-type σ from 3-5 samples is pure noise.
function buildModels(samples, { sampler = 'empirical' } = {}) {
  // The global sampler is chosen by calibration. Crucially 'empirical' (the v1
  // weighted bootstrap) is in the menu, so v2 can degrade to the baseline when
  // a parametric fit wouldn't help — guaranteeing v2 ≥ v1 within CV noise.
  let model;
  let family;
  let aicc = null;
  let weights = null;
  if (sampler === 'empirical') {
    model = empiricalModel(samples);
    family = 'empirical';
  } else if (sampler === 'churn') {
    // churn-conditional, blind use (size unknown). Falls back to empirical when
    // there isn't enough churn signal. NOT in the default calibrate menu — the
    // gate (below) shows it can't beat the baseline blind; it's here so the
    // capability can be measured and used explicitly.
    const cm = churnModel(samples);
    model = cm || empiricalModel(samples);
    family = cm ? 'churn' : 'empirical';
  } else {
    const sel = selectModel(samples, { spliced: sampler === 'spliced' });
    model = sel.model;
    family = sel.family;
    aicc = sel.aicc;
    weights = sel.weights;
  }
  const globalMu = weightedLogMean(samples);

  const byType = groupByType(samples);
  const sigma2 = pooledLogVar(byType, globalMu);
  const sigma = Math.sqrt(Math.max(sigma2, 1e-12));

  // Per-type shrinkage via dist.shrinkTypeMeans (handles <3 types → no shrink).
  const { shrinkTypeMeans } = require('./dist');
  const perType = [];
  for (const [type, arr] of byType) {
    if (!arr.length) continue;
    perType.push({ type, mu: weightedLogMean(arr), nEff: effectiveN(arr) });
  }
  const shrunk = shrinkTypeMeans(perType, globalMu, sigma2);
  const typeModels = new Map();
  for (const s of shrunk) {
    typeModels.set(
      s.type,
      parametricModel({ family: 'lognormal', mu: s.muStar, sigma }),
    );
  }

  return { model, typeModels, family, aicc, weights };
}

// ── Monte-Carlo sum of the remaining tasks ─────────────────────────────────
// Returns the ASCENDING-sorted ensemble of total-effort draws.
function simulate(models, opts) {
  const {
    remainingFull = 0,
    remainingWip = 0,
    wipElapsedSec = 0,
    remainingTypes = null,
    trials = TRIALS,
    seed = 42,
    uplift = 1,
  } = opts;
  const { model, typeModels } = models;
  const rng = mulberry32(seed);
  const totals = new Array(trials);

  for (let t = 0; t < trials; t++) {
    let sum = 0;
    for (let i = 0; i < remainingFull; i++) {
      let m = model;
      if (remainingTypes && remainingTypes[i] && typeModels && typeModels.has(remainingTypes[i])) {
        m = typeModels.get(remainingTypes[i]);
      }
      sum += m.sample(rng);
    }
    for (let w = 0; w < remainingWip; w++) {
      // Conditional remainder of an already-running task: draw D|D>elapsed, minus elapsed.
      sum += model.conditionalSample(rng, wipElapsedSec) - wipElapsedSec;
    }
    totals[t] = sum * uplift;
  }
  totals.sort((a, b) => a - b);
  return totals;
}

// ── walk-forward evaluation (expanding window, no leakage) ──────────────────
// Generic over a `forecaster(trainSamples, horizon, seed) → sortedEnsemble`.
// `trainSamples` are raw {dur,type,churn}; the forecaster re-derives recency
// weights itself (ageIdx is relative to the training slice).
function reindex(slice) {
  const n = slice.length;
  return slice.map((x, i) => ({ ...x, ageIdx: n - 1 - i, weight: 1 }));
}

function walkForward(samples, forecaster, opts = {}) {
  const n = samples.length;
  const horizon = opts.horizon || 1;
  const warmup = opts.warmup || Math.max(15, Math.ceil(0.4 * n));
  const seed = opts.seed || 1000;
  const out = [];
  for (let t = warmup; t + horizon <= n; t++) {
    const train = samples.slice(0, t);
    let actual = 0;
    for (let h = 0; h < horizon; h++) actual += samples[t + h].dur;
    const ens = forecaster(train, horizon, seed + t);
    if (!ens || !ens.length) continue;
    out.push({
      actual,
      crps: crpsEnsemble(ens, actual),
      p50: quantileSorted(ens, 0.5),
      pit: pit(ens, actual),
      hit50: coverageHit(ens, actual, 0.5),
      hit85: coverageHit(ens, actual, 0.85),
      hit95: coverageHit(ens, actual, 0.95),
    });
  }
  return out;
}

// A v2 forecaster bound to a config {H, sampler, uplift}.
function makeV2Forecaster({ H, sampler = 'empirical', uplift = 1, trials = CV_TRIALS }) {
  return (train, horizon, seed) => {
    const reidx = reindex(train);
    const { samples: weighted } = applyRecencyWeights(reidx, H);
    const models = buildModels(weighted, { sampler });
    return simulate(models, { remainingFull: horizon, trials, seed, uplift });
  };
}

function meanCRPS(rows) {
  if (!rows.length) return Infinity;
  return rows.reduce((a, r) => a + r.crps, 0) / rows.length;
}

// ── auto-calibration ───────────────────────────────────────────────────────
// Picks the half-life H and sampler mode that minimize walk-forward CRPS, then
// derives a reference-class uplift and keeps it only if it lowers CRPS. Family
// is chosen per-fit by AICc inside buildModels. Small grid + tie-break-to-
// simpler to avoid hyperparameter over-fit on short histories.
const SAMPLER_RANK = { empirical: 0, parametric: 1, spliced: 2 };

function calibrate(samples, opts = {}) {
  const n = samples.length;
  const horizon = opts.horizon || 1;
  const warmup = Math.max(15, Math.ceil(0.4 * n));
  const origins = n - warmup - horizon + 1;

  // candidate half-lives in commit-index units; ∞ = unweighted (stationary)
  const Hgrid = [Infinity, n, Math.max(8, Math.round(n / 2)), Math.max(6, Math.round(n / 3))];
  const samplerModes = ['empirical', 'parametric', 'spliced'];

  // Too few origins to validate any correction → behave EXACTLY like the v1
  // baseline (unweighted empirical bootstrap, no uplift). Recency weighting or a
  // reference-class uplift we can't cross-validate on <10 origins does more harm
  // than good — it made v2 lose to v1 on small repos. Don't deploy unvalidated
  // machinery.
  if (origins < 10) {
    return { H: Infinity, sampler: 'empirical', uplift: 1, family: 'empirical', cvCRPS: null, origins, calibrated: false };
  }

  let best = null;
  for (const H of Hgrid) {
    // guard: reject weighting so aggressive the effective sample size collapses
    const probe = applyRecencyWeights(reindex(samples), H);
    if (probe.nEff < 8 && Number.isFinite(H)) continue;
    for (const sampler of samplerModes) {
      const rows = walkForward(samples, makeV2Forecaster({ H, sampler, uplift: 1 }), { horizon, warmup });
      const c = meanCRPS(rows);
      if (!best) {
        best = { H, sampler, cvCRPS: c, rows };
        continue;
      }
      // "Tie" = within 1% of the best CRPS. On a tie, prefer the SIMPLER sampler
      // (empirical < parametric < spliced) and then the LARGER half-life — so CV
      // noise never buys complexity, and v2 collapses to the baseline on easy data.
      const tol = Math.abs(best.cvCRPS) * 0.01;
      if (c < best.cvCRPS - tol) {
        best = { H, sampler, cvCRPS: c, rows };
      } else if (c <= best.cvCRPS + tol) {
        const simpler = SAMPLER_RANK[sampler] < SAMPLER_RANK[best.sampler];
        const sameRankBiggerH = SAMPLER_RANK[sampler] === SAMPLER_RANK[best.sampler] && H > best.H;
        if (simpler || sameRankBiggerH) {
          // adopt the simpler/larger-H config and record ITS OWN crps + rows, so
          // the downstream uplift gate compares against a consistent baseline.
          best = { H, sampler, cvCRPS: c, rows };
        }
      }
    }
  }
  if (!best) best = { H: Infinity, sampler: 'empirical', cvCRPS: Infinity, rows: [] };

  // Reference-class uplift, gated on CRPS improvement.
  const uplift = deriveUplift(best.rows);
  let chosenUplift = 1;
  if (uplift !== 1) {
    const upRows = walkForward(samples, makeV2Forecaster({ H: best.H, sampler: best.sampler, uplift }), { horizon, warmup });
    if (meanCRPS(upRows) < best.cvCRPS - 1e-9) chosenUplift = uplift;
  }

  return {
    H: best.H,
    sampler: best.sampler,
    uplift: chosenUplift,
    family: best.sampler,
    cvCRPS: best.cvCRPS,
    origins,
    calibrated: true,
  };
}

// Multiplicative bias = median(actual / forecastP50), clipped to a sane band.
function deriveUplift(rows) {
  const ratios = rows
    .filter((r) => r.p50 > 0)
    .map((r) => r.actual / r.p50)
    .sort((a, b) => a - b);
  if (ratios.length < 3) return 1;
  const med = quantileSorted(ratios, 0.5);
  return Math.min(2, Math.max(0.8, med));
}

// ── main entry ─────────────────────────────────────────────────────────────
function forecast(opts) {
  const {
    commits = [],
    remainingFull = 0,
    remainingWip = 0,
    wipElapsedSec = 0,
    remainingTypes = null,
    nowSec = null,
    trials = TRIALS,
    seed = 42,
    auto = true,
    overrides = {},
  } = opts;
  const allTs = opts.allTimestamps || commits.map((c) => c.ts);

  const built = buildSamples(commits, {});
  const samples = built.samples;
  const out = {
    method: 'monte-carlo-v2',
    samples: samples.length,
    remainingTasks: remainingFull + remainingWip,
    awaySec: built.awaySec,
  };

  if (remainingFull <= 0 && remainingWip <= 0) {
    out.done = true;
    return out;
  }
  if (samples.length < MIN_SAMPLES) {
    out.insufficient = true;
    return out;
  }

  // Choose hyperparameters (or accept overrides / skip when auto=false).
  let cfg;
  if (auto && overrides.H == null) {
    cfg = calibrate(samples, { horizon: 1 });
  } else {
    cfg = {
      H: overrides.H != null ? overrides.H : Math.max(6, Math.round(samples.length / 3)),
      sampler: overrides.sampler || 'empirical',
      uplift: overrides.uplift != null ? overrides.uplift : 1,
      family: overrides.sampler || 'empirical',
      calibrated: false,
    };
  }

  const { samples: weighted, nEff: neff } = applyRecencyWeights(reindex(samples), cfg.H);
  const models = buildModels(weighted, { sampler: cfg.sampler });
  const totals = simulate(models, {
    remainingFull,
    remainingWip,
    wipElapsedSec,
    remainingTypes,
    trials,
    seed,
    uplift: cfg.uplift,
  });

  out.effort = {
    p50: quantileSorted(totals, 0.5),
    p85: quantileSorted(totals, 0.85),
    p95: quantileSorted(totals, 0.95),
  };
  out.perTaskTypical = quantileSorted([...totals].map((x) => x / (remainingFull + remainingWip)).sort((a, b) => a - b), 0.5);
  out.model = models.family;
  out.halfLife = cfg.H;
  out.uplift = cfg.uplift;
  out.nEff = neff;
  out.calibrated = cfg.calibrated;

  // duty-cycle calendar (effort spread at the historical active rate)
  const duty = dutyProfile(allTs);
  out.dutyCycle = duty.dutyCycle;
  if (nowSec != null && duty.dutyCycle && duty.dutyCycle > 0) {
    const wall = (e) => Math.round(e / duty.dutyCycle);
    out.calendar = {
      p50Sec: nowSec + wall(out.effort.p50),
      p85Sec: nowSec + wall(out.effort.p85),
      wallSecP50: wall(out.effort.p50),
      wallSecP85: wall(out.effort.p85),
    };
  }
  return out;
}

module.exports = {
  forecast,
  calibrate,
  simulate,
  buildModels,
  walkForward,
  makeV2Forecaster,
  reindex,
  meanCRPS,
  deriveUplift,
  dutyProfile,
  percentile,
  // re-exports for back-compat / convenience
  buildSamples,
  commitType,
  applyRecencyWeights,
  nEff,
  // lazy re-export to avoid a circular import (backtest.js requires this file)
  get backtest() {
    return require('./backtest').backtest;
  },
};
