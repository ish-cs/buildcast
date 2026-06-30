'use strict';
// Shared numerical primitives — pure, zero-dep, deterministic.
// These are the load-bearing helpers every other module imports, so they are
// written and verified ONCE here (see test/mathutil.test.js) rather than
// re-derived per module. Formulas verified against authoritative sources;
// the digamma asymptotic sign in particular is a common transcription trap.

// ── deterministic RNG ──────────────────────────────────────────────────────
// mulberry32: fast, seedable, ~2^32 period. Returns a function producing
// uniforms in [0,1). Deterministic given the seed — never uses Math.random.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Standard normal draw via Box–Muller from a uniform rng. Deterministic given rng.
function randNormal(rng) {
  let u = 0;
  do { u = rng(); } while (u <= 0); // avoid log(0)
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// FNV-1a string hash → uint32. Used to seed per-type RNG sub-streams so that
// per-type draws are independent yet reproducible.
function hashString(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ── error function & normal CDF/quantile ───────────────────────────────────
// erf via Abramowitz & Stegun 7.1.26 — max abs error ~1.5e-7.
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-x * x);
  return sign * y;
}

// Standard normal CDF Φ(z).
function normCdf(z) {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

// Inverse standard normal CDF Φ⁻¹(p) — Acklam's rational approximation,
// refined by one Halley step for ~full double precision. p ∈ (0,1).
function normInv(p) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.38357751867269e2, -3.066479806614716e1, 2.506628277459239e0,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e0,
    -2.549732539343734e0, 4.374664141464968e0, 2.938163982698783e0,
  ];
  const d = [
    7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e0,
    3.754408661907416e0,
  ];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  let x;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    x =
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= pHigh) {
    const q = p - 0.5;
    const r = q * q;
    x =
      ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x =
      -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  // One Halley refinement step using erf-based CDF.
  const e = normCdf(x) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
  x = x - u / (1 + (x * u) / 2);
  return x;
}

// ── log-gamma and its derivatives ──────────────────────────────────────────
// lnΓ(x) via Lanczos (Numerical Recipes gammln), valid for x > 0.
const LG = [
  76.18009172947146, -86.50532032941677, 24.01409824083091,
  -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5,
];
function lnGamma(x) {
  let a = x;
  let b = x + 5.5;
  b -= (x + 0.5) * Math.log(b);
  let s = 1.000000000190015;
  for (let i = 0; i < 6; i++) s += LG[i] / ++a;
  return -b + Math.log((2.5066282746310005 * s) / x);
}

// digamma ψ(x) = d/dx lnΓ(x). Recurrence up to x≥6 then asymptotic series.
// NOTE: the -0.5/x term is NEGATIVE (ψ(x) ~ ln x − 1/(2x) − 1/(12x²) + …).
// The brief that seeded this had it as +0.5/x — that is wrong; verified here
// against ψ(1) = −γ.
function digamma(x) {
  let r = 0;
  while (x < 10) {
    r -= 1 / x;
    x += 1;
  }
  const f = 1 / (x * x);
  return r + Math.log(x) - 0.5 / x - f * (1 / 12 - f * (1 / 120 - f / 252));
}

// trigamma ψ'(x). Recurrence up to x≥6 then asymptotic series.
function trigamma(x) {
  let r = 0;
  while (x < 10) {
    r += 1 / (x * x);
    x += 1;
  }
  const f = 1 / (x * x);
  return r + (1 / x) * (1 + 0.5 / x + f * (1 / 6 - f * (1 / 30 - f / 42)));
}

module.exports = {
  mulberry32,
  randNormal,
  hashString,
  erf,
  normCdf,
  normInv,
  lnGamma,
  digamma,
  trigamma,
};
