'use strict';
// Probabilistic scoring rules for evaluating forecast calibration & sharpness.
// Pure, zero-dep, deterministic. Durations are in SECONDS upstream, but these
// functions are unit-agnostic. Lower CRPS / pinball = better forecast.

const { normCdf } = require('./mathutil');

// Linear-interpolated quantile of an ASCENDING-sorted numeric array. p∈[0,1].
// k=(n-1)*p; interpolate between the two bracketing order statistics.
function quantileSorted(sorted, p) {
  const n = sorted.length;
  if (n === 0) return null;
  if (n === 1) return sorted[0];
  const k = (n - 1) * p;
  const lo = Math.floor(k);
  const hi = Math.min(lo + 1, n - 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (k - lo);
}

// CRPS of an ensemble vs scalar actual y, via the O(m log m) sorted "energy"
// form. Equivalent to (1/m)Σ|X_i−y| − (1/(2m²))ΣΣ|X_i−X_j|. Lower = better.
//   x  = ens sorted ascending
//   mae   = Σ_i |x_i − y|
//   spread = Σ_i (2i − m + 1) x_i           (i = 0 … m−1)
//   CRPS  = mae/m − spread/m²
function crpsEnsemble(ens, y) {
  const m = ens.length;
  if (m === 0) return null;
  if (m === 1) return Math.abs(ens[0] - y);
  const x = ens.slice().sort((a, b) => a - b);
  let mae = 0;
  let spread = 0;
  for (let i = 0; i < m; i++) {
    mae += Math.abs(x[i] - y);
    spread += (2 * i - m + 1) * x[i];
  }
  return mae / m - spread / (m * m);
}

// Closed-form CRPS for a Lognormal(mu, sig) predictive distribution (mu, sig on
// the LOG scale), actual y > 0. Derived from the Gaussian CRPS under the
// log-transform (Baran & Lerch 2015).
//   w = (ln y − mu) / sig
//   CRPS = y(2Φ(w) − 1) − 2 e^{mu+σ²/2}( Φ(w−σ) + Φ(σ/√2) − 1 )
function crpsLognormal(mu, sig, y) {
  const w = (Math.log(y) - mu) / sig;
  return (
    y * (2 * normCdf(w) - 1) -
    2 *
      Math.exp(mu + (sig * sig) / 2) *
      (normCdf(w - sig) + normCdf(sig / Math.SQRT2) - 1)
  );
}

// Probability Integral Transform of actual y under the ensemble forecast,
// with the standard (+1)/(m+1) plotting-position correction so the value lives
// strictly in (0,1). Well-calibrated forecasts → PIT ~ Uniform(0,1).
function pit(ens, y) {
  let c = 0;
  for (let i = 0; i < ens.length; i++) if (ens[i] <= y) c++;
  return (c + 1) / (ens.length + 1);
}

// Indicator: did the actual y fall at/below the p-quantile of the ensemble?
// Used to estimate empirical coverage of one-sided predictive intervals.
function coverageHit(ens, y, p) {
  const sorted = ens.slice().sort((a, b) => a - b);
  return y <= quantileSorted(sorted, p) ? 1 : 0;
}

// Pinball (quantile) loss for predicted quantile q at level a∈(0,1) vs actual y.
// Asymmetric: under-prediction (y≥q) weighted a, over-prediction weighted 1−a.
function pinball(y, q, a) {
  return y >= q ? a * (y - q) : (1 - a) * (q - y);
}

module.exports = {
  quantileSorted,
  crpsEnsemble,
  crpsLognormal,
  pit,
  coverageHit,
  pinball,
};
