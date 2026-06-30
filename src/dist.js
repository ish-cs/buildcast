'use strict';
// Distribution fitting, model selection, and sampling for build-duration data.
//
// Durations are in SECONDS and strictly > 0. All randomness is injected: every
// sampler takes an `rng` function ()→[0,1) so draws are deterministic given a
// seed. Nothing here calls Math.random or Date — that is a hard rule, because
// the whole forecast must be reproducible from a seed.
//
// INPUT CONVENTION: `samples` is an array of { dur:number>0, weight:number>0 }.
// A missing weight is treated as 1. We use *reliability* weights throughout
// (weights express relative confidence / recency, not raw counts), which is why
// the unbiased lognormal variance below uses the W − Σw²/W denominator rather
// than W−1.

const {
  normCdf,
  normInv,
  randNormal,
  lnGamma,
  digamma,
  trigamma,
} = require('./mathutil');

const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);

// ── weighted sufficient statistics ──────────────────────────────────────────
// Computed once per fit. W=Σw, Lbar=Σw·ln(dur)/W (weighted log-mean),
// xbar=Σw·dur/W (weighted linear mean), W2=Σw² (needed for the unbiased
// reliability-weight variance and for Kish's effective N).
function weightedStats(samples) {
  let W = 0;
  let W2 = 0;
  let sumLn = 0;
  let sumLin = 0;
  for (const s of samples) {
    const w = s.weight == null ? 1 : s.weight;
    W += w;
    W2 += w * w;
    sumLn += w * Math.log(s.dur);
    sumLin += w * s.dur;
  }
  return { W, W2, Lbar: sumLn / W, xbar: sumLin / W };
}

// ── helpers (exported, reused, tested) ──────────────────────────────────────

function weightedMean(samples) {
  let W = 0;
  let acc = 0;
  for (const s of samples) {
    const w = s.weight == null ? 1 : s.weight;
    W += w;
    acc += w * s.dur;
  }
  return acc / W;
}

// Interpolated weighted quantile of `dur`.
// Sort ascending by dur, walk cumulative weight, and use the (cw − 0.5·w)/W
// plotting position (Hazen). We then linearly interpolate p between adjacent
// plotting positions. p≤first position → first dur; p≥last → last dur. This is
// the standard "weighted Hazen" estimator and is documented here because the
// brief left the choice open.
function weightedQuantile(samples, p) {
  const pts = samples.map((s) => ({
    dur: s.dur,
    w: s.weight == null ? 1 : s.weight,
  }));
  pts.sort((a, b) => a.dur - b.dur);
  let W = 0;
  for (const pt of pts) W += pt.w;
  // plotting position for each point
  let cw = 0;
  const pos = new Array(pts.length);
  for (let i = 0; i < pts.length; i++) {
    cw += pts[i].w;
    pos[i] = (cw - 0.5 * pts[i].w) / W;
  }
  if (p <= pos[0]) return pts[0].dur;
  if (p >= pos[pos.length - 1]) return pts[pts.length - 1].dur;
  for (let i = 1; i < pts.length; i++) {
    if (p <= pos[i]) {
      const t = (p - pos[i - 1]) / (pos[i] - pos[i - 1]);
      return pts[i - 1].dur + t * (pts[i].dur - pts[i - 1].dur);
    }
  }
  return pts[pts.length - 1].dur;
}

// ── fitters ─────────────────────────────────────────────────────────────────

// LogNormal MLE on the log-scale. mu=Lbar. The variance uses the UNBIASED
// reliability-weight estimator: divide S by (W − Σw²/W) (a weighted Bessel
// correction). This matters for the tail — an underestimated sigma makes P95
// far too optimistic.
function fitLogNormal(samples) {
  const { W, W2, Lbar } = weightedStats(samples);
  let S = 0;
  for (const s of samples) {
    const w = s.weight == null ? 1 : s.weight;
    const d = Math.log(s.dur) - Lbar;
    S += w * d * d;
  }
  const denom = W - W2 / W;
  const sigma2 = denom > 0 ? S / denom : 0;
  return {
    family: 'lognormal',
    mu: Lbar,
    sigma: Math.sqrt(Math.max(sigma2, 1e-12)),
  };
}

// Gamma MLE via Minka's fixed-point. s = ln(xbar) − Lbar is the log of the
// ratio of arithmetic to geometric mean; it is ≥0 and we guard the tiny-s case
// (near-degenerate data) to avoid division blow-ups. Seed from Minka's
// closed-form approximation, then 4 Newton-on-(1/alpha) refinements. theta is
// pinned by the mean: alpha·theta = xbar exactly.
function fitGamma(samples) {
  const { Lbar, xbar } = weightedStats(samples);
  const logXbar = Math.log(xbar);
  let s = logXbar - Lbar;
  if (s < 1e-9) s = 1e-9; // guard: s must be > 0
  let alpha = (3 - s + Math.sqrt((s - 3) ** 2 + 24 * s)) / (12 * s);
  for (let i = 0; i < 4; i++) {
    alpha =
      1 /
      (1 / alpha +
        (Lbar - logXbar + Math.log(alpha) - digamma(alpha)) /
          (alpha * alpha * (1 / alpha - trigamma(alpha))));
  }
  return { family: 'gamma', alpha, theta: xbar / alpha };
}

// Weibull MLE. The shape k solves g(k)=0 where
//   g(k) = Σw·dur^k·ln dur / Σw·dur^k − 1/k − Lbar.
// g is monotonically increasing in k, so a plain bisection on k∈[0.05,30] is
// robust (no derivative, no divergence). Once k is found, the scale is the
// closed-form lambda = (Σw·dur^k / W)^(1/k).
function fitWeibull(samples) {
  const { W, Lbar } = weightedStats(samples);
  const g = (k) => {
    let num = 0;
    let den = 0;
    for (const s of samples) {
      const w = s.weight == null ? 1 : s.weight;
      const dk = Math.pow(s.dur, k);
      num += w * dk * Math.log(s.dur);
      den += w * dk;
    }
    return num / den - 1 / k - Lbar;
  };
  let lo = 0.05;
  let hi = 30;
  // 100 bisection steps drive the bracket to ~1e-29 — far past double precision.
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (g(mid) > 0) hi = mid;
    else lo = mid;
  }
  const k = (lo + hi) / 2;
  let sumdk = 0;
  for (const s of samples) {
    const w = s.weight == null ? 1 : s.weight;
    sumdk += w * Math.pow(s.dur, k);
  }
  const lambda = Math.pow(sumdk / W, 1 / k);
  return { family: 'weibull', k, lambda };
}

// ── likelihood / selection ──────────────────────────────────────────────────

// Weighted log-likelihood Σ w·ln f(dur) for a fitted param object.
function logLik(params, samples) {
  let ll = 0;
  if (params.family === 'lognormal') {
    const { mu, sigma } = params;
    const c = 0.5 * Math.log(2 * Math.PI) + Math.log(sigma);
    for (const s of samples) {
      const w = s.weight == null ? 1 : s.weight;
      const lnd = Math.log(s.dur);
      const z = lnd - mu;
      ll += w * (-lnd - c - (z * z) / (2 * sigma * sigma));
    }
  } else if (params.family === 'gamma') {
    const { alpha, theta } = params;
    const c = alpha * Math.log(theta) + lnGamma(alpha);
    for (const s of samples) {
      const w = s.weight == null ? 1 : s.weight;
      ll += w * ((alpha - 1) * Math.log(s.dur) - s.dur / theta - c);
    }
  } else if (params.family === 'weibull') {
    const { k, lambda } = params;
    const lnk = Math.log(k);
    const klnl = k * Math.log(lambda);
    for (const s of samples) {
      const w = s.weight == null ? 1 : s.weight;
      ll +=
        w *
        (lnk +
          (k - 1) * Math.log(s.dur) -
          klnl -
          Math.pow(s.dur / lambda, k));
    }
  } else {
    throw new Error(`logLik: unknown family ${params.family}`);
  }
  return ll;
}

// Kish effective sample size: (Σw)² / Σw². Equals n for equal weights, →1 when
// one weight dominates. This is the n that goes into the AICc correction.
function effectiveN(samples) {
  let W = 0;
  let W2 = 0;
  for (const s of samples) {
    const w = s.weight == null ? 1 : s.weight;
    W += w;
    W2 += w * w;
  }
  return (W * W) / W2;
}

// Corrected Akaike Information Criterion. The small-sample correction term
// blows up (or goes negative) when nEff ≤ kParams+1; in that degenerate regime
// we return a large but finite penalty so selection still has a usable ordering.
function aicc(LL, kParams, nEff) {
  const denom = nEff - kParams - 1;
  if (denom <= 0) return 2 * kParams - 2 * LL + 1e6;
  return 2 * kParams - 2 * LL + (2 * kParams * (kParams + 1)) / denom;
}

// Akaike weights: softmax over −0.5·ΔAICc (Δ relative to the best/min model).
// Subtracting the min before exp keeps it numerically stable.
function akaikeWeights(aiccArray) {
  const min = Math.min(...aiccArray);
  const ex = aiccArray.map((a) => Math.exp(-0.5 * (a - min)));
  const sum = ex.reduce((a, b) => a + b, 0);
  return ex.map((e) => e / sum);
}

// ── samplers ────────────────────────────────────────────────────────────────

// Gamma draw via Marsaglia–Tsang. For α≥1 use the squeeze acceptance loop
// exactly as specified (no 0.0331 fast-accept shortcut, to stay faithful to the
// contract). For α<1, draw with α+1 and scale by U^(1/α) (Stuart's theorem).
function gammaDraw(rng, alpha, theta) {
  if (alpha < 1) {
    return gammaDraw(rng, alpha + 1, theta) * Math.pow(rng(), 1 / alpha);
  }
  const d = alpha - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const x = randNormal(rng);
    const v = Math.pow(1 + c * x, 3);
    if (
      v > 0 &&
      Math.log(rng()) < 0.5 * x * x + d - d * v + d * Math.log(v)
    ) {
      return d * v * theta;
    }
  }
}

// ── models ──────────────────────────────────────────────────────────────────
// Every model exposes the same shape:
//   { family, params, sample(rng), conditionalSample(rng, T), quantile(p), mean() }
// conditionalSample returns a draw of D given D>T — the FULL D, not the excess.

function parametricModel(params) {
  if (params.family === 'lognormal') {
    const { mu, sigma } = params;
    const quantile = (p) => Math.exp(mu + sigma * normInv(clamp(p, 1e-9, 1 - 1e-9)));
    return {
      family: 'lognormal',
      params,
      sample: (rng) => Math.exp(mu + sigma * randNormal(rng)),
      conditionalSample: (rng, T) => {
        // Invert the truncated CDF: u uniform in [F(T), 1).
        const FT = normCdf((Math.log(T) - mu) / sigma);
        const u = FT + (1 - FT) * rng();
        return Math.exp(mu + sigma * normInv(clamp(u, 1e-9, 1 - 1e-9)));
      },
      quantile,
      mean: () => Math.exp(mu + (sigma * sigma) / 2),
    };
  }
  if (params.family === 'weibull') {
    const { k, lambda } = params;
    const quantile = (p) =>
      lambda * Math.pow(-Math.log(1 - clamp(p, 0, 1 - 1e-12)), 1 / k);
    return {
      family: 'weibull',
      params,
      sample: (rng) => quantile(rng()),
      conditionalSample: (rng, T) => {
        const FT = 1 - Math.exp(-Math.pow(T / lambda, k));
        const u = FT + (1 - FT) * rng();
        return quantile(u);
      },
      quantile,
      mean: () => lambda * Math.exp(lnGamma(1 + 1 / k)),
    };
  }
  if (params.family === 'gamma') {
    const { alpha, theta } = params;
    // Wilson–Hilferty cube-root normal approximation to the gamma quantile.
    const quantile = (p) => {
      const z = normInv(clamp(p, 1e-9, 1 - 1e-9));
      const g = alpha * Math.pow(1 - 1 / (9 * alpha) + z * Math.sqrt(1 / (9 * alpha)), 3);
      return Math.max(theta * g, 0);
    };
    return {
      family: 'gamma',
      params,
      sample: (rng) => gammaDraw(rng, alpha, theta),
      conditionalSample: (rng, T) => {
        // No closed-form truncated inverse for gamma → rejection sample.
        for (let i = 0; i < 500; i++) {
          const x = gammaDraw(rng, alpha, theta);
          if (x > T) return x;
        }
        return T; // give up after 500 tries: treat as ~immediate completion
      },
      quantile,
      mean: () => alpha * theta,
    };
  }
  throw new Error(`parametricModel: unknown family ${params.family}`);
}

// Weighted bootstrap over the observed durations. The cumulative-weight array is
// built once; sample() does an O(log n) lookup.
function empiricalModel(samples) {
  const pts = samples.map((s) => ({
    dur: s.dur,
    w: s.weight == null ? 1 : s.weight,
  }));
  let W = 0;
  const cum = new Array(pts.length);
  for (let i = 0; i < pts.length; i++) {
    W += pts[i].w;
    cum[i] = W;
  }
  let maxDur = -Infinity;
  for (const pt of pts) if (pt.dur > maxDur) maxDur = pt.dur;

  // weighted pick from a (sub)set described by parallel dur/cum arrays
  const pick = (rng, durs, cumArr, total) => {
    const u = rng() * total;
    // linear scan is fine; n is small (commit counts), and binary search would
    // need a fresh cum array per conditional subset anyway.
    for (let i = 0; i < durs.length; i++) {
      if (u <= cumArr[i]) return durs[i];
    }
    return durs[durs.length - 1];
  };

  const allDurs = pts.map((p) => p.dur);

  return {
    family: 'empirical',
    params: { samples },
    sample: (rng) => pick(rng, allDurs, cum, W),
    conditionalSample: (rng, T) => {
      // weighted pick restricted to durations strictly above T
      let total = 0;
      const durs = [];
      const cumArr = [];
      for (const pt of pts) {
        if (pt.dur > T) {
          total += pt.w;
          durs.push(pt.dur);
          cumArr.push(total);
        }
      }
      if (durs.length === 0) return Math.max(maxDur, T);
      return pick(rng, durs, cumArr, total);
    },
    quantile: (p) => weightedQuantile(samples, p),
    mean: () => weightedMean(samples),
  };
}

// Spliced model: empirical BODY below a cutoff quantile, lognormal parametric
// TAIL above it. Lognormal is chosen for the tail because its heavier right tail
// extrapolates beyond the observed max far better than the empirical max, which
// is what we want for P95/P99 of burst-y AI-agent builds. cut is the *quantile*
// at which we splice (default 0.8); c is the corresponding duration cutoff.
function splicedModel(samples, lognormalParams, cut = 0.8) {
  const c = weightedQuantile(samples, cut);
  const lp = parametricModel(lognormalParams);
  const { mu, sigma } = lognormalParams;

  // body = observed durations ≤ c, with weights, for the empirical lower part
  const body = samples.filter((s) => s.dur <= c);
  const bodyPts = body.map((s) => ({
    dur: s.dur,
    w: s.weight == null ? 1 : s.weight,
  }));
  let bodyW = 0;
  const bodyCum = [];
  for (const pt of bodyPts) {
    bodyW += pt.w;
    bodyCum.push(bodyW);
  }
  const bodyDurs = bodyPts.map((p) => p.dur);
  const pickBody = (rng) => {
    if (bodyDurs.length === 0) return c;
    const u = rng() * bodyW;
    for (let i = 0; i < bodyDurs.length; i++) if (u <= bodyCum[i]) return bodyDurs[i];
    return bodyDurs[bodyDurs.length - 1];
  };

  return {
    family: 'spliced',
    params: { samples, lognormalParams, cut },
    sample: (rng) => {
      if (rng() < cut) return pickBody(rng);
      // tail: a lognormal draw conditioned to exceed the cutoff c
      return lp.conditionalSample(rng, c);
    },
    quantile: (p) => {
      if (p <= cut) {
        // body quantile, clamped at the cutoff so it never crosses the splice
        return Math.min(weightedQuantile(samples, p), c);
      }
      // map p∈(cut,1] into the conditional lognormal tail above c
      const Fc = normCdf((Math.log(c) - mu) / sigma);
      const uu = Fc + ((p - cut) / (1 - cut)) * (1 - Fc);
      return Math.exp(mu + sigma * normInv(clamp(uu, 1e-9, 1 - 1e-9)));
    },
    mean: () => weightedMean(samples),
  };
}

// Fit all three families, score by AICc (k=2, nEff=Kish), and return both the
// chosen model and the full comparison. lognormal is ALWAYS fit (the spliced
// tail needs it). spliced:true returns a spliced model on the lognormal fit;
// otherwise the argmin-AICc parametric model.
function selectModel(samples, { spliced = false } = {}) {
  const nEff = effectiveN(samples);
  const lnFit = fitLogNormal(samples);
  const gFit = fitGamma(samples);
  const wFit = fitWeibull(samples);

  const aiccLN = aicc(logLik(lnFit, samples), 2, nEff);
  const aiccG = aicc(logLik(gFit, samples), 2, nEff);
  const aiccW = aicc(logLik(wFit, samples), 2, nEff);

  const fits = [
    { family: 'lognormal', params: lnFit, a: aiccLN },
    { family: 'gamma', params: gFit, a: aiccG },
    { family: 'weibull', params: wFit, a: aiccW },
  ];
  let best = fits[0];
  for (const f of fits) if (f.a < best.a) best = f;

  const model = spliced
    ? splicedModel(samples, lnFit)
    : parametricModel(best.params);

  return {
    model,
    family: best.family,
    aicc: { lognormal: aiccLN, gamma: aiccG, weibull: aiccW },
    weights: akaikeWeights([aiccLN, aiccG, aiccW]),
  };
}

// ── per-type shrinkage (empirical-Bayes / James–Stein, DerSimonian–Laird τ²) ─
// Shrinks each type's log-mean toward the global log-mean. With <3 types there
// is nothing to borrow strength from, so we pass means through unchanged
// (lambda=1). Otherwise estimate between-type variance τ² by DerSimonian–Laird
// and form per-type shrinkage weights lambda = τ²/(τ² + σ²/nEff_t): high nEff or
// large τ² → keep the type's own mean; tiny nEff or τ²≈0 → pool to global.
function shrinkTypeMeans(perType, globalMu, sigma2) {
  if (perType.length < 3) {
    return perType.map((t) => ({ type: t.type, muStar: t.mu, lambda: 1 }));
  }
  let sumW = 0;
  let sumW2 = 0;
  let sumWmu = 0;
  for (const t of perType) {
    const W = t.nEff / sigma2;
    sumW += W;
    sumW2 += W * W;
    sumWmu += W * t.mu;
  }
  const mubar = sumWmu / sumW;
  let Q = 0;
  for (const t of perType) {
    const W = t.nEff / sigma2;
    Q += W * (t.mu - mubar) * (t.mu - mubar);
  }
  const C = sumW - sumW2 / sumW;
  const tau2 = Math.max(0, (Q - (perType.length - 1)) / C);
  return perType.map((t) => {
    const lambda = tau2 / (tau2 + sigma2 / t.nEff);
    return {
      type: t.type,
      muStar: lambda * t.mu + (1 - lambda) * globalMu,
      lambda,
    };
  });
}

// ── Fenton–Wilkinson ─────────────────────────────────────────────────────────
// Approximate the sum of N iid Lognormal(mu,sigma) draws by a single lognormal,
// by moment-matching the first two moments of the sum. Used to get a fast P95 of
// total remaining work without a full Monte Carlo when the per-task fit is
// lognormal.
function fentonWilkinson(mu, sigma, N) {
  const s2 = sigma * sigma;
  const m = Math.exp(mu + s2 / 2);
  const v = (Math.exp(s2) - 1) * Math.exp(2 * mu + s2);
  const M = N * m;
  const V = N * v;
  const sS2 = Math.log(V / (M * M) + 1);
  return { mu: Math.log(M) - sS2 / 2, sigma: Math.sqrt(sS2) };
}

// ── churn-conditional model ──────────────────────────────────────────────────
// Weighted least-squares of ln(dur) on ln(churn). The point of this model is the
// `predictForChurn(churn)` path: when you KNOW a task's size, conditioning on it
// collapses the predictive spread from the marginal σ down to the residual σ_r.
//
// For BLIND forecasting (unknown future churn) `sample()` bootstraps a churn then
// predicts — but note the marginal variance b²·Var(lnχ)+σ_r² ≈ the plain
// lognormal σ²: integrating out an unknown size gives back the unconditional
// distribution. So churn cannot improve a blind forecast (the backtest confirms
// this) — it only helps when the size is supplied. Returns null when there isn't
// enough churn signal (<8 commits with churn>0, or no variance in ln churn).
function churnModel(samples) {
  const usable = samples.filter((s) => s.churn > 0);
  if (usable.length < 8) return null;
  let W = 0;
  let Sx = 0;
  let Sy = 0;
  let W2 = 0;
  for (const s of usable) {
    const w = s.weight == null ? 1 : s.weight;
    W += w;
    W2 += w * w;
    Sx += w * Math.log(s.churn);
    Sy += w * Math.log(s.dur);
  }
  const xbar = Sx / W;
  const ybar = Sy / W;
  let Sxx = 0;
  let Sxy = 0;
  for (const s of usable) {
    const w = s.weight == null ? 1 : s.weight;
    const x = Math.log(s.churn) - xbar;
    Sxx += w * x * x;
    Sxy += w * x * (Math.log(s.dur) - ybar);
  }
  if (Sxx < 1e-9) return null; // churn has no variance → useless predictor
  const b = Sxy / Sxx;
  const a = ybar - b * xbar;
  let SSr = 0;
  let Syy = 0;
  for (const s of usable) {
    const w = s.weight == null ? 1 : s.weight;
    const r = Math.log(s.dur) - (a + b * Math.log(s.churn));
    SSr += w * r * r;
    const y = Math.log(s.dur) - ybar;
    Syy += w * y * y;
  }
  const denom = Math.max(W - W2 / W, 1e-9);
  const sigmaR = Math.sqrt(Math.max(SSr / denom, 1e-12));
  const varX = Sxx / denom;
  const r2 = Syy > 0 ? Math.max(0, 1 - SSr / Syy) : 0;
  // marginal over churn (integrate the predictor out)
  const muM = a + b * xbar;
  const sigmaM = Math.sqrt(b * b * varX + sigmaR * sigmaR);
  const marg = parametricModel({ family: 'lognormal', mu: muM, sigma: sigmaM });
  // weighted bootstrap of ln(churn) for blind sampling
  const pts = usable.map((s) => ({ x: Math.log(s.churn), w: s.weight == null ? 1 : s.weight }));
  let cw = 0;
  const cum = [];
  for (const p of pts) {
    cw += p.w;
    cum.push(cw);
  }
  const pickX = (rng) => {
    const u = rng() * cw;
    for (let i = 0; i < pts.length; i++) if (u <= cum[i]) return pts[i].x;
    return pts[pts.length - 1].x;
  };
  return {
    family: 'churn',
    params: { a, b, sigmaR, muM, sigmaM, r2 },
    slope: b,
    r2,
    sample: (rng) => Math.exp(a + b * pickX(rng) + sigmaR * randNormal(rng)),
    conditionalSample: (rng, T) => {
      for (let i = 0; i < 500; i++) {
        const x = Math.exp(a + b * pickX(rng) + sigmaR * randNormal(rng));
        if (x > T) return x;
      }
      return T;
    },
    quantile: (p) => marg.quantile(p),
    mean: () => marg.mean(),
    // The useful capability: predictive lognormal for a task of KNOWN size.
    predictForChurn: (churn) => ({ family: 'lognormal', mu: a + b * Math.log(churn), sigma: sigmaR }),
  };
}

module.exports = {
  // fitters
  fitLogNormal,
  fitGamma,
  fitWeibull,
  churnModel,
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
};
