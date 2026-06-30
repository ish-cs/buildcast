'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  // fitters
  fitLogNormal,
  fitGamma,
  fitWeibull,
  // likelihood / selection
  logLik,
  effectiveN,
  aicc,
  akaikeWeights,
  // models
  parametricModel,
  empiricalModel,
  splicedModel,
  selectModel,
  // shrinkage
  shrinkTypeMeans,
  // helpers
  weightedMean,
  weightedQuantile,
  fentonWilkinson,
} = require('../src/dist');

const { mulberry32 } = require('../src/mathutil');

// ── helpers ────────────────────────────────────────────────────────────────
function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}
function variance(arr) {
  const m = mean(arr);
  return arr.reduce((a, b) => a + (b - m) * (b - m), 0) / arr.length;
}
function toSamples(durs) {
  return durs.map((d) => ({ dur: d }));
}

// ────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ────────────────────────────────────────────────────────────────────────────
test('exports all frozen-contract symbols', () => {
  for (const fn of [
    fitLogNormal,
    fitGamma,
    fitWeibull,
    logLik,
    effectiveN,
    aicc,
    akaikeWeights,
    parametricModel,
    empiricalModel,
    splicedModel,
    selectModel,
    shrinkTypeMeans,
    weightedMean,
    weightedQuantile,
    fentonWilkinson,
  ]) {
    assert.strictEqual(typeof fn, 'function');
  }
});

// ────────────────────────────────────────────────────────────────────────────
// HELPERS: weightedMean / weightedQuantile
// ────────────────────────────────────────────────────────────────────────────
test('weightedMean: unweighted == arithmetic mean', () => {
  const s = toSamples([10, 20, 30, 40]);
  assert.ok(Math.abs(weightedMean(s) - 25) < 1e-9);
});

test('weightedMean: respects weights', () => {
  const s = [
    { dur: 10, weight: 1 },
    { dur: 20, weight: 3 },
  ];
  // (10*1 + 20*3) / 4 = 70/4 = 17.5
  assert.ok(Math.abs(weightedMean(s) - 17.5) < 1e-9);
});

test('weightedMean: missing weight treated as 1', () => {
  const s = [{ dur: 10 }, { dur: 20, weight: 1 }];
  assert.ok(Math.abs(weightedMean(s) - 15) < 1e-9);
});

test('weightedQuantile: median of symmetric set', () => {
  const s = toSamples([1, 2, 3, 4, 5]);
  const q = weightedQuantile(s, 0.5);
  assert.ok(Math.abs(q - 3) < 1e-6, `median was ${q}`);
});

test('weightedQuantile: monotonic in p', () => {
  const s = toSamples([1, 5, 10, 50, 100, 500]);
  const q10 = weightedQuantile(s, 0.1);
  const q50 = weightedQuantile(s, 0.5);
  const q90 = weightedQuantile(s, 0.9);
  assert.ok(q10 < q50 && q50 < q90, `${q10} ${q50} ${q90}`);
});

test('weightedQuantile: p=0 -> min, p=1 -> max', () => {
  const s = toSamples([3, 7, 11, 19]);
  assert.ok(Math.abs(weightedQuantile(s, 0) - 3) < 1e-6);
  assert.ok(Math.abs(weightedQuantile(s, 1) - 19) < 1e-6);
});

test('weightedQuantile: weights shift the quantile', () => {
  // heavy weight on the large value pulls median up vs unweighted
  const sUnw = toSamples([1, 2, 100]);
  const sW = [
    { dur: 1, weight: 1 },
    { dur: 2, weight: 1 },
    { dur: 100, weight: 10 },
  ];
  assert.ok(weightedQuantile(sW, 0.5) > weightedQuantile(sUnw, 0.5));
});

// ────────────────────────────────────────────────────────────────────────────
// effectiveN (Kish)
// ────────────────────────────────────────────────────────────────────────────
test('effectiveN: equal weights ~= n', () => {
  const s = toSamples(new Array(50).fill(10));
  assert.ok(Math.abs(effectiveN(s) - 50) < 1e-6);
});

test('effectiveN: one weight dominating -> ~1', () => {
  const s = [
    { dur: 10, weight: 1e6 },
    { dur: 10, weight: 1 },
    { dur: 10, weight: 1 },
  ];
  assert.ok(effectiveN(s) < 1.01, `nEff=${effectiveN(s)}`);
});

// ────────────────────────────────────────────────────────────────────────────
// FITTER PARAMETER RECOVERY
// ────────────────────────────────────────────────────────────────────────────
test('fitLogNormal recovers mu, sigma from 20000 samples', () => {
  const rng = mulberry32(12345);
  const { randNormal } = require('../src/mathutil');
  const durs = [];
  for (let i = 0; i < 20000; i++) durs.push(Math.exp(6 + 0.5 * randNormal(rng)));
  const { family, mu, sigma } = fitLogNormal(toSamples(durs));
  assert.strictEqual(family, 'lognormal');
  assert.ok(Math.abs(mu - 6) < 0.03, `mu=${mu}`);
  assert.ok(Math.abs(sigma - 0.5) < 0.03, `sigma=${sigma}`);
});

test('fitLogNormal: weighted mu matches duplicated-data mu (first moment is frequency-invariant)', () => {
  // The weighted MEAN of logs equals the duplicated-rows mean of logs exactly.
  // (The VARIANCE deliberately does NOT match: these are RELIABILITY weights,
  //  so sigma uses the W − Σw²/W unbiased denominator, not the frequency W−1.
  //  That divergence is the whole point of the reliability-weight estimator and
  //  is what keeps the tail honest — so we only assert the mu equivalence here.)
  const base = [2, 4, 8, 16, 32];
  const weighted = base.map((d, i) => ({ dur: d, weight: i + 1 }));
  const expanded = [];
  base.forEach((d, i) => {
    for (let k = 0; k < i + 1; k++) expanded.push({ dur: d });
  });
  const fw = fitLogNormal(weighted);
  const fe = fitLogNormal(expanded);
  assert.ok(Math.abs(fw.mu - fe.mu) < 1e-9, `mu ${fw.mu} vs ${fe.mu}`);
});

test('fitLogNormal: reliability-weight sigma uses W − Σw²/W denominator (matches hand calc)', () => {
  // Pin the documented unbiased estimator numerically so the denominator can't
  // silently regress to W or W−1.
  const s = [
    { dur: Math.exp(0), weight: 1 }, // ln=0
    { dur: Math.exp(2), weight: 1 }, // ln=2
    { dur: Math.exp(4), weight: 2 }, // ln=4
  ];
  const W = 4;
  const W2 = 1 + 1 + 4; // =6
  const Lbar = (0 * 1 + 2 * 1 + 4 * 2) / W; // =2.5
  const S = 1 * (0 - 2.5) ** 2 + 1 * (2 - 2.5) ** 2 + 2 * (4 - 2.5) ** 2; // 6.25+0.25+4.5=11
  const sigma2 = S / (W - W2 / W); // 11 / (4 - 1.5) = 11/2.5 = 4.4
  const f = fitLogNormal(s);
  assert.ok(Math.abs(f.mu - Lbar) < 1e-12, `mu ${f.mu}`);
  assert.ok(Math.abs(f.sigma - Math.sqrt(sigma2)) < 1e-12, `sigma ${f.sigma} vs ${Math.sqrt(sigma2)}`);
});

test('gamma sampler sanity: mean ~600, var ~120000', () => {
  const rng = mulberry32(999);
  const m = parametricModel({ family: 'gamma', alpha: 3, theta: 200 });
  const draws = [];
  for (let i = 0; i < 20000; i++) draws.push(m.sample(rng));
  const mu = mean(draws);
  const v = variance(draws);
  assert.ok(Math.abs(mu - 600) / 600 < 0.03, `mean=${mu}`);
  assert.ok(Math.abs(v - 120000) / 120000 < 0.08, `var=${v}`);
});

test('fitGamma recovers alpha, theta from sampler output', () => {
  const rng = mulberry32(999);
  const m = parametricModel({ family: 'gamma', alpha: 3, theta: 200 });
  const durs = [];
  for (let i = 0; i < 20000; i++) durs.push(m.sample(rng));
  const { family, alpha, theta } = fitGamma(toSamples(durs));
  assert.strictEqual(family, 'gamma');
  assert.ok(Math.abs(alpha - 3) / 3 < 0.08, `alpha=${alpha}`);
  assert.ok(Math.abs(theta - 200) / 200 < 0.08, `theta=${theta}`);
});

test('fitGamma: mean is preserved (alpha*theta == xbar)', () => {
  const rng = mulberry32(7);
  const m = parametricModel({ family: 'gamma', alpha: 2.5, theta: 120 });
  const durs = [];
  for (let i = 0; i < 5000; i++) durs.push(m.sample(rng));
  const f = fitGamma(toSamples(durs));
  const xbar = weightedMean(toSamples(durs));
  assert.ok(Math.abs(f.alpha * f.theta - xbar) / xbar < 1e-6);
});

test('fitWeibull recovers k, lambda from sampler output', () => {
  const rng = mulberry32(2024);
  const m = parametricModel({ family: 'weibull', k: 1.5, lambda: 500 });
  const durs = [];
  for (let i = 0; i < 20000; i++) durs.push(m.sample(rng));
  const { family, k, lambda } = fitWeibull(toSamples(durs));
  assert.strictEqual(family, 'weibull');
  assert.ok(Math.abs(k - 1.5) / 1.5 < 0.08, `k=${k}`);
  assert.ok(Math.abs(lambda - 500) / 500 < 0.08, `lambda=${lambda}`);
});

// ────────────────────────────────────────────────────────────────────────────
// LIKELIHOOD / SELECTION
// ────────────────────────────────────────────────────────────────────────────
test('logLik: lognormal closed form matches manual on one point', () => {
  const params = { family: 'lognormal', mu: 1, sigma: 0.5 };
  const s = [{ dur: Math.E }]; // ln dur = 1
  const lnd = 1;
  const expected =
    -lnd -
    0.5 * Math.log(2 * Math.PI) -
    Math.log(0.5) -
    ((lnd - 1) * (lnd - 1)) / (2 * 0.25);
  assert.ok(Math.abs(logLik(params, s) - expected) < 1e-9);
});

test('logLik: weights scale contributions', () => {
  const params = { family: 'lognormal', mu: 0, sigma: 1 };
  const one = [{ dur: 5, weight: 1 }];
  const three = [{ dur: 5, weight: 3 }];
  assert.ok(Math.abs(logLik(params, three) - 3 * logLik(params, one)) < 1e-9);
});

test('logLik: gamma and weibull are finite on valid data', () => {
  const s = toSamples([100, 200, 300, 400, 500]);
  const g = logLik({ family: 'gamma', alpha: 2, theta: 150 }, s);
  const w = logLik({ family: 'weibull', k: 1.5, lambda: 300 }, s);
  assert.ok(Number.isFinite(g) && Number.isFinite(w));
});

test('aicc: matches formula and penalty branch', () => {
  // normal branch
  const LL = -100;
  const k = 2;
  const nEff = 50;
  const expected = 2 * k - 2 * LL + (2 * k * (k + 1)) / (nEff - k - 1);
  assert.ok(Math.abs(aicc(LL, k, nEff) - expected) < 1e-9);
  // degenerate branch
  const deg = aicc(-100, 2, 2); // nEff - k - 1 = -1 <= 0
  assert.ok(Math.abs(deg - (2 * 2 - 2 * -100 + 1e6)) < 1e-6);
});

test('akaikeWeights: normalized, sum to 1, min AICc gets max weight', () => {
  const w = akaikeWeights([10, 12, 20]);
  const sum = w.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `sum=${sum}`);
  assert.ok(w[0] > w[1] && w[1] > w[2]);
});

test('AICc selection: lognormal data -> lognormal beats gamma', () => {
  const rng = mulberry32(54321);
  const { randNormal } = require('../src/mathutil');
  const durs = [];
  for (let i = 0; i < 4000; i++) durs.push(Math.exp(6 + 0.6 * randNormal(rng)));
  const s = toSamples(durs);
  const nEff = effectiveN(s);
  const lnFit = fitLogNormal(s);
  const gFit = fitGamma(s);
  const aiccLN = aicc(logLik(lnFit, s), 2, nEff);
  const aiccG = aicc(logLik(gFit, s), 2, nEff);
  assert.ok(aiccLN < aiccG, `LN ${aiccLN} should beat gamma ${aiccG}`);
});

// ────────────────────────────────────────────────────────────────────────────
// PARAMETRIC MODELS — quantile monotonicity & closed forms
// ────────────────────────────────────────────────────────────────────────────
test('lognormal quantile monotonic + closed form', () => {
  const { normInv } = require('../src/mathutil');
  const m = parametricModel({ family: 'lognormal', mu: 5, sigma: 0.7 });
  assert.ok(m.quantile(0.1) < m.quantile(0.5));
  assert.ok(m.quantile(0.5) < m.quantile(0.9));
  const exact = Math.exp(5 + 0.7 * normInv(0.42));
  assert.ok(Math.abs(m.quantile(0.42) - exact) < 1e-6);
});

test('lognormal mean closed form', () => {
  const mu = 5;
  const sigma = 0.7;
  const m = parametricModel({ family: 'lognormal', mu, sigma });
  assert.ok(Math.abs(m.mean() - Math.exp(mu + (sigma * sigma) / 2)) < 1e-6);
});

test('weibull quantile monotonic + mean closed form', () => {
  const { lnGamma } = require('../src/mathutil');
  const k = 1.5;
  const lambda = 500;
  const m = parametricModel({ family: 'weibull', k, lambda });
  assert.ok(m.quantile(0.1) < m.quantile(0.5));
  assert.ok(m.quantile(0.5) < m.quantile(0.9));
  assert.ok(Math.abs(m.mean() - lambda * Math.exp(lnGamma(1 + 1 / k))) < 1e-6);
});

test('gamma quantile monotonic + mean closed form', () => {
  const m = parametricModel({ family: 'gamma', alpha: 3, theta: 200 });
  assert.ok(m.quantile(0.1) < m.quantile(0.5));
  assert.ok(m.quantile(0.5) < m.quantile(0.9));
  assert.ok(Math.abs(m.mean() - 600) < 1e-9);
});

test('all parametric samples are positive', () => {
  const rng = mulberry32(11);
  for (const params of [
    { family: 'lognormal', mu: 5, sigma: 0.7 },
    { family: 'weibull', k: 1.5, lambda: 500 },
    { family: 'gamma', alpha: 3, theta: 200 },
    { family: 'gamma', alpha: 0.5, theta: 200 }, // alpha < 1 branch
  ]) {
    const m = parametricModel(params);
    for (let i = 0; i < 1000; i++) {
      const x = m.sample(rng);
      assert.ok(x > 0 && Number.isFinite(x), `${params.family} produced ${x}`);
    }
  }
});

test('gamma alpha<1 sampler recovers mean', () => {
  const rng = mulberry32(321);
  const m = parametricModel({ family: 'gamma', alpha: 0.5, theta: 100 });
  const draws = [];
  for (let i = 0; i < 20000; i++) draws.push(m.sample(rng));
  // mean = alpha*theta = 50
  assert.ok(Math.abs(mean(draws) - 50) / 50 < 0.05, `mean=${mean(draws)}`);
});

// ────────────────────────────────────────────────────────────────────────────
// conditionalSample
// ────────────────────────────────────────────────────────────────────────────
test('lognormal conditionalSample: all draws > T', () => {
  const rng = mulberry32(77);
  const m = parametricModel({ family: 'lognormal', mu: 5, sigma: 0.7 });
  const T = m.quantile(0.5); // condition above the median
  for (let i = 0; i < 2000; i++) {
    assert.ok(m.conditionalSample(rng, T) > T);
  }
});

test('lognormal conditionalSample: E[D|D>T] > T and excess shrinks for large T', () => {
  const rng = mulberry32(88);
  const m = parametricModel({ family: 'lognormal', mu: 5, sigma: 0.7 });
  const uncMean = m.mean();

  const Tsmall = m.quantile(0.2);
  let condSmall = [];
  for (let i = 0; i < 5000; i++) condSmall.push(m.conditionalSample(rng, Tsmall));
  assert.ok(mean(condSmall) > Tsmall);

  const Tlarge = m.quantile(0.95);
  let excess = [];
  for (let i = 0; i < 5000; i++) excess.push(m.conditionalSample(rng, Tlarge) - Tlarge);
  // conditional excess at a high threshold is smaller than the unconditional mean
  assert.ok(mean(excess) < uncMean, `excess=${mean(excess)} unc=${uncMean}`);
});

test('weibull conditionalSample: all draws > T', () => {
  const rng = mulberry32(99);
  const m = parametricModel({ family: 'weibull', k: 1.5, lambda: 500 });
  const T = m.quantile(0.5);
  for (let i = 0; i < 2000; i++) {
    assert.ok(m.conditionalSample(rng, T) > T);
  }
});

test('gamma conditionalSample (rejection): draws > T when feasible', () => {
  const rng = mulberry32(1212);
  const m = parametricModel({ family: 'gamma', alpha: 3, theta: 200 });
  const T = m.quantile(0.3);
  let ok = 0;
  const N = 2000;
  for (let i = 0; i < N; i++) {
    if (m.conditionalSample(rng, T) > T) ok++;
  }
  // overwhelming majority exceed T (some fallback-to-T allowed but rare at p=0.3)
  assert.ok(ok / N > 0.99, `only ${ok}/${N} exceeded T`);
});

// ────────────────────────────────────────────────────────────────────────────
// EMPIRICAL MODEL
// ────────────────────────────────────────────────────────────────────────────
test('empiricalModel: sample only returns observed durations', () => {
  const rng = mulberry32(3);
  const durs = [10, 20, 30];
  const m = empiricalModel(toSamples(durs));
  const set = new Set(durs);
  for (let i = 0; i < 500; i++) assert.ok(set.has(m.sample(rng)));
});

test('empiricalModel: weighted sampling honors weights', () => {
  const rng = mulberry32(4);
  const s = [
    { dur: 1, weight: 1 },
    { dur: 100, weight: 99 },
  ];
  const m = empiricalModel(s);
  let big = 0;
  const N = 5000;
  for (let i = 0; i < N; i++) if (m.sample(rng) === 100) big++;
  assert.ok(Math.abs(big / N - 0.99) < 0.03, `frac=${big / N}`);
});

test('empiricalModel: conditionalSample returns dur>T, fallback when none', () => {
  const rng = mulberry32(5);
  const durs = [10, 20, 30, 40];
  const m = empiricalModel(toSamples(durs));
  for (let i = 0; i < 500; i++) assert.ok(m.conditionalSample(rng, 25) > 25);
  // T above max -> fallback to max(maxDur, T) = T
  assert.strictEqual(m.conditionalSample(rng, 1000), 1000);
});

test('empiricalModel: mean and quantile match helpers', () => {
  const s = toSamples([5, 10, 15, 20, 25]);
  const m = empiricalModel(s);
  assert.ok(Math.abs(m.mean() - weightedMean(s)) < 1e-9);
  assert.ok(Math.abs(m.quantile(0.5) - weightedQuantile(s, 0.5)) < 1e-9);
});

// ────────────────────────────────────────────────────────────────────────────
// SPLICED MODEL
// ────────────────────────────────────────────────────────────────────────────
test('splicedModel: median ~ weighted median, tail extrapolates beyond data', () => {
  const rng = mulberry32(424242);
  const { randNormal } = require('../src/mathutil');
  const durs = [];
  for (let i = 0; i < 3000; i++) durs.push(Math.exp(6 + 0.5 * randNormal(rng)));
  const s = toSamples(durs);
  const lnFit = fitLogNormal(s);
  const m = splicedModel(s, lnFit, 0.8);

  const wmed = weightedQuantile(s, 0.5);
  assert.ok(Math.abs(m.quantile(0.5) - wmed) / wmed < 0.05, `${m.quantile(0.5)} vs ${wmed}`);

  // Tail must EXTRAPOLATE: every quantile above the splice exceeds the body
  // cutoff c and stays monotone (the parametric lognormal tail is unbounded,
  // unlike the empirical body which saturates at the observed max).
  //
  // NOTE: "q99 >= max observed" is NOT a valid invariant here. With n=3000
  // lognormal draws the sample MAX lands near CDF 0.9997-0.9999 (a ~1-in-3000+
  // draw), so it naturally sits far above the fitted q99 (the 1-in-100 level).
  // Verified across 10 seeds: q99 >= maxObs held in 0/10. The correct guarantee
  // is that the tail is unbounded and CAN extrapolate past the data — checked by
  // pushing p high enough that the lognormal tail surpasses the observed max.
  const c = weightedQuantile(s, 0.8);
  assert.ok(m.quantile(0.99) > c, `q99=${m.quantile(0.99)} should extrapolate past cutoff c=${c}`);
  assert.ok(m.quantile(0.99) > m.quantile(0.95), 'tail monotone past splice');

  const maxObs = Math.max(...durs);
  // a far-tail quantile must be able to exceed any observed value:
  assert.ok(
    m.quantile(0.999999) > maxObs,
    `far tail q(1-1e-6)=${m.quantile(0.999999)} should exceed maxObs=${maxObs}`
  );
});

test('splicedModel: all samples >= 0 and mean matches weightedMean', () => {
  const rng = mulberry32(55);
  const durs = [10, 20, 30, 40, 50, 60, 200, 500];
  const s = toSamples(durs);
  const lnFit = fitLogNormal(s);
  const m = splicedModel(s, lnFit, 0.8);
  for (let i = 0; i < 2000; i++) assert.ok(m.sample(rng) >= 0);
  assert.ok(Math.abs(m.mean() - weightedMean(s)) < 1e-9);
});

test('splicedModel: quantile monotonic across the splice point', () => {
  const rng = mulberry32(66);
  const { randNormal } = require('../src/mathutil');
  const durs = [];
  for (let i = 0; i < 2000; i++) durs.push(Math.exp(5 + 0.5 * randNormal(rng)));
  const s = toSamples(durs);
  const lnFit = fitLogNormal(s);
  const m = splicedModel(s, lnFit, 0.8);
  let prev = -Infinity;
  for (const p of [0.1, 0.3, 0.5, 0.7, 0.79, 0.81, 0.9, 0.95, 0.99]) {
    const q = m.quantile(p);
    assert.ok(q >= prev - 1e-6, `non-monotonic at p=${p}: ${q} < ${prev}`);
    prev = q;
  }
});

// ────────────────────────────────────────────────────────────────────────────
// selectModel
// ────────────────────────────────────────────────────────────────────────────
test('selectModel: returns structured result with aicc + weights', () => {
  const rng = mulberry32(135);
  const { randNormal } = require('../src/mathutil');
  const durs = [];
  for (let i = 0; i < 3000; i++) durs.push(Math.exp(6 + 0.5 * randNormal(rng)));
  const s = toSamples(durs);
  const res = selectModel(s);
  assert.ok(['lognormal', 'gamma', 'weibull'].includes(res.family));
  assert.ok(typeof res.aicc.lognormal === 'number');
  assert.ok(typeof res.aicc.gamma === 'number');
  assert.ok(typeof res.aicc.weibull === 'number');
  const wsum = res.weights.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(wsum - 1) < 1e-9);
  assert.ok(typeof res.model.quantile === 'function');
  // lognormal data should pick lognormal
  assert.strictEqual(res.family, 'lognormal');
});

test('selectModel: spliced option returns a spliced model with extrapolating tail', () => {
  const rng = mulberry32(246);
  const { randNormal } = require('../src/mathutil');
  const durs = [];
  for (let i = 0; i < 3000; i++) durs.push(Math.exp(6 + 0.5 * randNormal(rng)));
  const s = toSamples(durs);
  const res = selectModel(s, { spliced: true });
  const maxObs = Math.max(...durs);
  // far-tail extrapolation capability (see splicedModel test for why q99>=max
  // is not a valid invariant at n=3000)
  assert.ok(res.model.quantile(0.999999) > maxObs);
  assert.ok(res.model.quantile(0.99) > res.model.quantile(0.95));
  assert.ok(Math.abs(res.model.mean() - weightedMean(s)) < 1e-9);
});

// ────────────────────────────────────────────────────────────────────────────
// shrinkTypeMeans (James–Stein / DerSimonian–Laird)
// ────────────────────────────────────────────────────────────────────────────
test('shrinkTypeMeans: <3 types -> lambda 1, muStar = mu', () => {
  const perType = [
    { type: 'a', mu: 5, nEff: 10 },
    { type: 'b', mu: 7, nEff: 20 },
  ];
  const out = shrinkTypeMeans(perType, 6, 0.5);
  assert.strictEqual(out.length, 2);
  for (const o of out) {
    assert.strictEqual(o.lambda, 1);
    const src = perType.find((p) => p.type === o.type);
    assert.strictEqual(o.muStar, src.mu);
  }
});

test('shrinkTypeMeans: 3 identical means -> tau2~0 -> muStar ~ global', () => {
  const perType = [
    { type: 'a', mu: 5, nEff: 30 },
    { type: 'b', mu: 5, nEff: 30 },
    { type: 'c', mu: 5, nEff: 30 },
  ];
  const globalMu = 6;
  const out = shrinkTypeMeans(perType, globalMu, 0.5);
  for (const o of out) {
    assert.ok(o.lambda < 0.05, `lambda=${o.lambda}`);
    assert.ok(Math.abs(o.muStar - globalMu) < 0.1, `muStar=${o.muStar}`);
  }
});

test('shrinkTypeMeans: well-separated + large nEff -> lambda near 1 (little shrink)', () => {
  const perType = [
    { type: 'a', mu: 1, nEff: 1e6 },
    { type: 'b', mu: 5, nEff: 1e6 },
    { type: 'c', mu: 9, nEff: 1e6 },
  ];
  const out = shrinkTypeMeans(perType, 5, 0.5);
  for (const o of out) {
    assert.ok(o.lambda > 0.95, `lambda=${o.lambda}`);
    const src = perType.find((p) => p.type === o.type);
    assert.ok(Math.abs(o.muStar - src.mu) < 0.3, `muStar=${o.muStar} mu=${src.mu}`);
  }
});

test('shrinkTypeMeans: tiny nEff -> strong shrink toward global', () => {
  const perType = [
    { type: 'a', mu: 1, nEff: 0.01 },
    { type: 'b', mu: 5, nEff: 0.01 },
    { type: 'c', mu: 9, nEff: 0.01 },
  ];
  const globalMu = 5;
  const out = shrinkTypeMeans(perType, globalMu, 0.5);
  for (const o of out) {
    assert.ok(o.lambda < 0.2, `lambda=${o.lambda}`);
    assert.ok(Math.abs(o.muStar - globalMu) < Math.abs(o.muStar - perType.find((p) => p.type === o.type).mu) + 1e-9);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// fentonWilkinson
// ────────────────────────────────────────────────────────────────────────────
test('fentonWilkinson: returns lognormal params for sum', () => {
  const out = fentonWilkinson(6, 0.5, 10);
  assert.ok(Number.isFinite(out.mu) && Number.isFinite(out.sigma));
  // mean of sum should be ~ N * exp(mu + sigma^2/2); FW preserves the first moment
  const Mtrue = 10 * Math.exp(6 + 0.25 / 2);
  const Mfw = Math.exp(out.mu + (out.sigma * out.sigma) / 2);
  assert.ok(Math.abs(Mfw - Mtrue) / Mtrue < 1e-6, `M ${Mfw} vs ${Mtrue}`);
});

test('fentonWilkinson: P95 cross-checks against MC sum within 12%', () => {
  const { randNormal, normInv } = require('../src/mathutil');
  const rng = mulberry32(20260629);
  const mu = 0;
  const sigma = 0.5;
  const N = 10;
  const trials = 40000;
  const sums = [];
  for (let t = 0; t < trials; t++) {
    let s = 0;
    for (let i = 0; i < N; i++) s += Math.exp(mu + sigma * randNormal(rng));
    sums.push(s);
  }
  sums.sort((a, b) => a - b);
  const mcP95 = sums[Math.floor(0.95 * trials)];

  const fw = fentonWilkinson(mu, sigma, N);
  const fwP95 = Math.exp(fw.mu + fw.sigma * normInv(0.95));
  assert.ok(Math.abs(fwP95 - mcP95) / mcP95 < 0.12, `FW ${fwP95} vs MC ${mcP95}`);
});
