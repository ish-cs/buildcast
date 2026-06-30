# buildcast — methodology

How buildcast turns a git history into a calibrated forecast of remaining effort, and how it proves the calibration. Every method below maps to a small, independently-tested module; formulas are the ones actually implemented.

## Problem

Given a repository's task-closing commits and a count `N` of remaining tasks, estimate the distribution of total remaining **effort** `S = Σ_{i=1}^{N} D_i`, where each `D_i` is a future task duration, and report `P50/P85/P95`. Effort durations are positive, right-skewed, often **non-stationary** (later tasks run longer), and there are few of them (tens, not thousands). The forecast must be reproducible and must never be worse than the obvious baseline.

The pipeline is five stages — clean → fit → correct → simulate → score — each gated by the same walk-forward backtest.

---

## 1. Commits → clean effort samples  (`samples.js`)

A task duration is the time gap between consecutive task-closing commits. Two cleaning steps:

- **Amend noise.** Gaps `< 30 s` are dropped (typo/amend commits, not work).
- **Away gaps.** A gap longer than a learned threshold straddles a break — it is **winsorized** to the threshold (kept but capped), not dropped. Dropping long gaps thins the right tail and undercounts tasks; winsorizing preserves the count and bounds the idle contribution. The threshold defaults to `max(3 h, Q3 + 1.5·IQR)` of the observed gaps.

**Recency weighting.** To track non-stationary drift, sample *i* at age `a_i` (in commits-ago, newest = 0) gets an exponential weight

```
w_i = 2^(−a_i / H)
```

with half-life `H`. The age axis is the **commit index**, not wall-clock time, because burst-y / agent-driven builds make calendar gaps a poor proxy for "work done since." Aggressive weighting collapses the usable sample, so we track the **Kish effective sample size** (Kish 1965)

```
n_eff = (Σ w_i)² / Σ w_i²
```

and reject any half-life that drives `n_eff < 8`, falling back to unweighted.

---

## 2. Fitting the duration distribution  (`dist.js`)

Three positive, right-skewed families are fit by **weighted maximum likelihood** and compared by corrected AIC. Let `W = Σw_i`, `W₂ = Σw_i²`, `L̄ = Σw_i ln x_i / W`, `x̄ = Σw_i x_i / W`.

**Log-normal.** `μ̂ = L̄`; the variance uses the unbiased *reliability-weight* estimator (a weighted Bessel correction) — the ordinary MLE underestimates σ and makes the tail dangerously optimistic:

```
σ̂² = Σ w_i (ln x_i − μ̂)² / (W − W₂/W)
```

**Gamma.** Minka's (2002) fixed-point. With `s = ln x̄ − L̄`, seed `α₀ = (3 − s + √((s−3)²+24s)) / (12s)`, then iterate

```
1/α ← 1/α + (L̄ − ln x̄ + ln α − ψ(α)) / (α²(1/α − ψ′(α))),   θ̂ = x̄/α̂
```

with ψ, ψ′ the digamma/trigamma functions (`mathutil.js`, verified against ψ(1)=−γ).

**Weibull.** Shape `k` solves the monotone score equation `Σw x^k ln x / Σw x^k − 1/k − L̄ = 0` by bisection on `[0.05, 30]`; scale `λ = (Σw x^k / W)^{1/k}`.

**Model selection — AICc.** With weighted log-likelihood `LL` and `k = 2` parameters,

```
AICc = 2k − 2·LL + 2k(k+1)/(n_eff − k − 1)
```

The small-sample correction term is non-negligible at `n_eff ≈ 20–100` (it vanishes as `n→∞`); ordinary AIC over-fits in this regime. The selected family is `argmin AICc`; **Akaike weights** `ωᵢ ∝ exp(−½ΔAICcᵢ)` are retained for diagnostics.

**Sampling models.** Each fit exposes a uniform interface `{sample(rng), conditionalSample(rng,T), quantile(p), mean()}`. Gamma draws use Marsaglia–Tsang; log-normal/Weibull use inverse-CDF; the gamma quantile uses the Wilson–Hilferty cube-root-normal approximation — all driven by a single seeded RNG so the whole forecast is reproducible.

---

## 3. Correcting for non-stationarity & the inside view  (`forecast.js`)

**Reference-class uplift.** Historical resampling reproduces only observed tasks and structurally under-shoots — the *inside view* (Flyvbjerg 2006; Kahneman & Lovallo). buildcast estimates a multiplicative correction from the walk-forward residuals,

```
uplift = clip( median_k( actual_k / forecastP50_k ), 0.8, 2.0 )
```

and applies it **only if it lowers held-out CRPS**. On well-calibrated data the median ratio is ≈1 and the correction is a no-op; on a drifting series it is the dominant fix.

**Half-life and sampler are chosen, not assumed.** A small grid of half-lives `{∞, n, n/2, n/3}` × samplers `{empirical bootstrap, fitted parametric, spliced tail}` is scored by walk-forward CRPS; the minimiser wins, with ties broken toward the *simpler* sampler and *larger* half-life so cross-validation noise can never buy complexity. With fewer than 10 hold-out origins there is nothing to validate, so it falls back to the plain bootstrap rather than guessing.

---

## 4. Hierarchical per-type shrinkage  (`dist.js`)

When the remaining tasks have known types (`feat`, `test`, …) with thin per-type histories, each type's log-mean `μ_t` is shrunk toward the global mean by empirical Bayes (James–Stein):

```
μ_t* = λ_t·μ_t + (1−λ_t)·μ_global,    λ_t = τ² / (τ² + σ²/n_eff,t)
```

The between-type variance `τ²` is the DerSimonian–Laird (1986) method-of-moments estimator; `σ²` is the pooled within-type variance. A type with abundant data keeps its own mean; a type with a handful of samples pools toward global. With `< 3` types there is nothing to borrow from and means pass through unchanged.

---

## 5. The forecast  (`forecast.js`)

A Monte-Carlo sum over 20 000 trials:

```
for each trial:
   S = Σ_{i=1..N}  model_i.sample(rng)          # per-type model if the type is known
       + Σ_{wip}   model.conditionalSample(rng, t_elapsed) − t_elapsed
   S *= uplift
percentiles(S) → P50/P85/P95
```

Two details matter:

- **In-flight tasks** are not fresh draws. A task already running for `t` is drawn from the **truncated conditional** `P(D | D > t)` (a real survival remainder), then `t` is subtracted — fixing the common bug of assigning a half-finished task a full-length draw.
- **Spliced tail.** For the `spliced` sampler the body below the 80th percentile is empirical while the tail above it is a fitted log-normal, so `P95/P99` can exceed the largest observed task instead of being capped by it.

A closed-form **Fenton–Wilkinson** log-normal-sum approximation is kept as a cross-check: if the Monte-Carlo P95 and the moment-matched P95 diverge, that flags a sampler bug.

---

## 6. Scoring & validation  (`scoring.js`, `backtest.js`)

Calibration is *measured*, with proper scoring rules under leakage-free cross-validation.

**CRPS.** The Continuous Ranked Probability Score (Gneiting & Raftery 2007) is the proper score for a full predictive distribution — it rewards calibration *and* sharpness together. For an ensemble `X` and realised `y` it is computed in `O(m log m)` from the energy form via the sorted identity

```
CRPS = (1/m)Σ|Xᵢ − y| − (1/m²) Σᵢ (2i − m + 1)·x₍ᵢ₎
```

(verified in tests against the `O(m²)` double-sum, and against the closed-form log-normal CRPS).

**Calibration diagnostics.** PIT rank `(#{Xᵢ ≤ y}+1)/(m+1)` (uniform ⇒ calibrated; U-shaped ⇒ under-dispersed), empirical coverage at each percentile, and pinball/quantile loss.

**Walk-forward.** Expanding-window, rolling-origin evaluation (Hyndman & Athanasopoulos): at origin *t*, fit on tasks `1…t−1` only, forecast the next `h`, score against the realised sum. Strictly no leakage — recency weights are recomputed within each training slice.

**A/B skill.** The full engine is run head-to-head with the naive bootstrap over identical origins and seeds. The headline is the CRPS skill score `1 − CRPS_v2/CRPS_v1`, with a paired bootstrap over per-origin score differences reporting `P(v2 better)`.

---

## 7. The "never worse than baseline" guarantee

The naive bootstrap is **inside** the engine's own model space — it is one of the candidate samplers. Model selection is by held-out CRPS with ties broken toward the baseline. Therefore the engine can only deviate from the baseline when the deviation *improves* held-out score, and it provably degrades to the baseline otherwise (modulo cross-validation noise, which the tie tolerance absorbs). A more capable model that contains its own baseline cannot do systematically worse than it — that is the design property the benchmarks confirm empirically (`skill ≈ 0` on stationary data, never materially negative).

---

## 8. Validation study

Reproducible synthetic benchmark (`benchmarks/synthetic.js`, fixed seed, 70 tasks, horizon 5):

| regime | CRPS skill | P50 MAPE | P95 coverage | P50 coverage |
|---|---:|---|---|---|
| drifting (~10× velocity drift) | **+78%** | 52% → 12% | 3% → 100% | 0% → 50% |
| heavy-tailed (σ=1.25) | +8% | 117% → 86% | 100% → 94% | 56% → 50% |
| stationary | +1% | 16% → 14% | 100% → 92% | 58% → 50% |

The drift row is the result: a forecaster going from *systematically wrong* (the P50 was beaten 100% of the time; the P95 covered 3% of outcomes) to *calibrated* (50% / 100%). On stationary data the engine correctly does nothing and ties the baseline. On real near-stationary repositories the same pattern holds — CRPS ties, P50 point error falls ~20% from the uplift.

**Two defects this validation surfaced and fixed**, recorded for honesty:
1. A calibration tie-break stored a CRPS value mismatched with its hold-out rows, corrupting the uplift acceptance gate.
2. On very short histories the first cut applied an *un-validated* recency/uplift correction and lost ~10% skill on a small repo. Both were fixed by the discipline of §7 — never deploy a correction the backtest cannot validate.

**Churn (lines changed per commit), built and then pruned by evidence.** A churn-conditional regression model (`ln dur ~ ln churn`) is implemented and unit-tested; conditioning on a *known* task size collapses predictive spread from the marginal σ to the residual σ_r. But for a *blind* forecast the future size is unknown, and integrating it out returns the unconditional distribution — so churn cannot improve a blind forecast, which the backtest confirmed (no CRPS gain). It is therefore deliberately excluded from the default path and retained only for explicit known-size use. This is the methodology applied to its own honest conclusion: a lever that does not improve held-out score does not ship.

---

## 9. Limitations & threats to validity

- **Small samples.** Parametric fits and τ² are estimated from tens of points; this is mitigated by AICc, shrinkage, and the never-worse fallback, but a forecast on 6 tasks is a forecast on 6 tasks.
- **Stationarity of the residual process.** Recency weighting tracks gradual drift but cannot anticipate a discontinuity with no precedent.
- **The proxy.** "Effort" is the commit-gap proxy, not instrumented keystroke time; the forecast is of that proxy. Its biases (thinking time, interruptions inside the away threshold) are a ceiling no amount of modelling removes.
- **The count is an input.** The forecast is conditional on the supplied `N`; the dominant practical error is usually a wrong remaining-task count, which is outside the model.
- **Calendar is unvalidated.** The duty-cycle date projection is a single active/idle ratio layered on the (validated) effort forecast; it is best-effort, not backtested.

---

## References

- Gneiting, T. & Raftery, A. E. (2007). *Strictly Proper Scoring Rules, Prediction, and Estimation.* JASA 102(477).
- Flyvbjerg, B. (2006). *From Nobel Prize to Project Management: Getting Risks Right.* Project Management Journal 37(3).
- Kahneman, D. & Lovallo, D. (1993). *Timid Choices and Bold Forecasts.* Management Science 39(1).
- Minka, T. (2002). *Estimating a Gamma Distribution.* Technical note.
- Akaike, H. (1974). *A New Look at the Statistical Model Identification.* IEEE TAC 19(6); Hurvich, C. & Tsai, C.-L. (1989). *Regression and Time Series Model Selection in Small Samples.* Biometrika 76(2).
- DerSimonian, R. & Laird, N. (1986). *Meta-analysis in Clinical Trials.* Controlled Clinical Trials 7(3).
- Kish, L. (1965). *Survey Sampling.* Wiley.
- Fenton, L. (1960). *The Sum of Log-Normal Probability Distributions in Scatter Transmission Systems.* IRE Transactions 8(1).
- Marsaglia, G. & Tsang, W. W. (2000). *A Simple Method for Generating Gamma Variables.* ACM TOMS 26(3).
- Hyndman, R. J. & Athanasopoulos, G. *Forecasting: Principles and Practice* (3rd ed.), §5.10 — time-series cross-validation.
- Wilson, E. B. & Hilferty, M. M. (1931). *The Distribution of Chi-Square.* PNAS 17(12).
