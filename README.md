# buildcast

**Probabilistic build forecasting from git history — calibrated, self-validating, and honest about its own accuracy.**

Point it at a repo, say how many tasks remain, and buildcast forecasts the remaining work from your *actual* commit velocity as a calibrated `P50 / P85 / P95` range — then proves the calibration on your own history. It treats "how long will this take?" as a probabilistic forecasting problem and scores itself with proper scoring rules, not vibes.

```text
$ buildcast --repo . --remaining 6 --wip 1 --wip-elapsed 600

  buildcast · 7 tasks left · 58 history samples

  EFFORT (hands-on build time)
    P50  ~3.3h   coin-flip
    P85  ~6.0h   safe commitment
    P95  ~7.2h   high confidence

  CALENDAR (duty cycle 35% — active vs idle)
    P50  Tue, Jun 30, 2:21 AM
    P85  Tue, Jun 30, 10:01 AM

  model: empirical · half-life none (stationary) · n_eff 58
  auto-calibrated by walk-forward CRPS
```

Zero dependencies · deterministic (seeded) · 114 tests · Node ≥ 18.

---

## Why this is not another estimate-multiplier

Most "estimators" multiply a guessed velocity by a task count. buildcast is built on three ideas from the forecasting literature that those tools skip:

1. **Forecast the distribution, not a point.** A single number is a lie with a confidence interval hidden inside it. buildcast Monte-Carlos the *sum of the remaining tasks* and reports percentiles. Summing N tasks cancels per-task variance (central-limit), so the band is far tighter than `single-task-range × N`.
2. **Score it with a proper scoring rule.** It evaluates itself with the **Continuous Ranked Probability Score (CRPS)** under **walk-forward (rolling-origin) cross-validation** — the same machinery used to verify weather ensembles — so "accuracy" is measured, not asserted.
3. **Adapt to *your* data, and never do worse than the naive baseline.** It auto-selects its recency half-life, its sampler, and a reference-class bias correction by scoring each candidate on your repo's own history. The plain bootstrap is *inside* its model space, so it provably degrades to the baseline when nothing fancier helps — and only deploys heavier machinery when your data rewards it.

---

## Benchmarks

Every number below is reproducible: `--validate` runs the naive bootstrap and the full engine head-to-head over identical walk-forward origins on a repo's own history and reports the **CRPS skill score** `1 − CRPS_v2/CRPS_v1` (higher = better), point error (MAPE of P50), and coverage. The synthetic cases below are generated from a fixed seed so you can reproduce them exactly ([benchmarks/synthetic.js](#reproducing-the-benchmarks)).

| history (70 tasks, seeded) | CRPS skill | P50 error (MAPE) | P95 coverage | what's happening |
|---|---:|---|---|---|
| **drifting** (velocity slows ~10×) | **+78%** | 52% → **12%** | **3% → 100%** | the regime a stationary bootstrap silently breaks on |
| **heavy-tailed** (σ=1.25 lognormal) | **+8%** | 117% → 86% | 100% → 94% | a fitted tail beats the empirical max |
| **stationary** (well-behaved) | ~0% | — | ~ideal | nothing to fix; it ties the baseline by design |

On **real, near-stationary repositories** the full-distribution score (CRPS) ties the baseline — because a plain bootstrap is already near-optimal there — while the **P50 point estimate you actually read tightens by ~20%** (reference-class uplift). The headline is the *drifting* column: that `0% → 50%` P50 coverage and `3% → 100%` P95 coverage is a forecaster going from **systematically wrong** to **calibrated**.

> The honest takeaway, stated plainly: **buildcast is never worse than the naive bootstrap, and it is dramatically better exactly when the naive bootstrap fails** (drift, fat tails). On already-easy histories it correctly does nothing clever.

### Reproducing the benchmarks

```bash
node benchmarks/synthetic.js     # prints the table above from a fixed seed
buildcast --repo /your/repo --validate   # A/B on your own history
```

---

## How it works

```
git log ─▶ clean recency-weighted samples ─▶ fit + auto-select model ─▶ Monte-Carlo
          (winsorize away-gaps,             (lognormal/gamma/weibull       sum of N
           exp. half-life weights)           by AICc, or spliced tail,      (+ conditional
                                             or plain bootstrap)             in-flight task)
                                                      │
                                          walk-forward CRPS picks the
                                          half-life, sampler & uplift
```

The statistical machinery, each piece earning its place against the backtest:

- **Recency weighting.** Samples are exponentially down-weighted by age (a learned half-life), with the Kish effective sample size `n_eff = (Σw)²/Σw²` guarding against over-aggressive discounting. This is what tracks non-stationary velocity drift.
- **Distribution fitting.** Log-normal, gamma (Minka's fixed-point MLE), and Weibull are fit by **weighted maximum likelihood** and selected by **corrected AIC (AICc)** — with a reliability-weight Bessel correction on the variance so the tail isn't optimistically thin.
- **Spliced tail.** For burst-y builds the body is empirical but the upper tail is a fitted log-normal spliced in above the 80th percentile, so `P95/P99` can extrapolate beyond the largest observed task.
- **Reference-class uplift.** A multiplicative bias correction (Flyvbjerg's outside view) calibrated from the walk-forward residuals and applied *only if it lowers held-out CRPS*.
- **Hierarchical shrinkage.** Per-task-type means are shrunk toward the global mean by empirical Bayes (DerSimonian–Laird between-type variance τ²), so a `test`-typed forecast borrows strength when its own history is thin.
- **Conditional in-flight task.** A task already running for *t* seconds is drawn from the **truncated** conditional `P(D | D > t)`, not a fresh task — a real survival-analysis remainder, not `draw − t`.
- **Self-validation.** CRPS (closed O(m log m) ensemble form), PIT histograms, coverage, and pinball loss under expanding-window walk-forward, with a paired bootstrap on the A/B skill score.

Full derivations, formulas, and citations: **[docs/METHODOLOGY.md](docs/METHODOLOGY.md)**.

---

## Honesty: how accurate is it, really?

A forecast claiming 100% accuracy is lying — the future is genuinely uncertain. buildcast tells you *how often it's right, by construction*, and lets you audit that on your own repo:

```text
$ buildcast --repo . --backtest

  buildcast backtest · 24 hold-out windows · horizon 5 · sampler empirical
  P50 coverage   52%   (ideal 50%)
  P85 coverage   83%   (ideal 85%)
  P95 coverage   96%   (ideal 95%)
  P50 error      19%   mean abs % off
  mean CRPS      311s
```

`--backtest` hides the last *K* tasks, forecasts them from the rest, and checks how often reality landed inside each band — across every hold-out window. **Accuracy depends on your data, not just the math**, and the tool shows you which regime you're in instead of hiding it.

It forecasts **effort** (active build-time) far more reliably than a **calendar date** — it cannot know when you'll next sit down. The duty-cycle calendar is a best-effort projection layered on top, not a validated promise.

---

## Install & usage

```bash
# run without installing (once published / from the repo)
npx buildcast --repo . --remaining 5
# or clone and run — zero dependencies
git clone https://github.com/ish-cs/buildcast && node buildcast/bin/buildcast.js --repo . --remaining 5
```

```text
buildcast --repo <path> --remaining <N> [options]

  --repo <path>        git repo to read              (default: .)
  --match <regex>      task-closing commit filter     (default: ^(feat|fix|perf|refactor)\()
  --remaining <N>      untouched tasks left           (required unless --backtest/--validate)
  --wip <N>            in-flight tasks                (default 0)
  --wip-elapsed <sec>  how long the WIP task has run  (default 0)
  --types a,b,c        known types of remaining tasks, in order
  --horizon <N>        hold-out window for --backtest/--validate (default 5)
  --no-auto            skip auto-calibration (plain bootstrap)
  --json               machine-readable output
  --backtest           report calibration accuracy on this repo's own history
  --validate           A/B the naive bootstrap vs the full engine on your history
```

A "task" is one task-closing commit (`feat(...)`, `fix(...)`, …). Amend gaps < 30s are dropped; an "away" gap longer than a learned threshold is *winsorized* (kept but capped), so an overnight pause neither poisons the velocity nor vanishes from the count.

---

## Architecture

Seven small, single-purpose, independently-tested modules — pure JavaScript, no runtime dependencies, fully deterministic from a seed:

| module | responsibility |
|---|---|
| `mathutil` | erf/Φ/Φ⁻¹, lnΓ/ψ/ψ′, seeded RNG — verified against known values |
| `samples` | commits → recency-weighted effort samples, winsorize, Kish n_eff |
| `dist` | weighted-MLE fits, AICc selection, sampling models, EB shrinkage |
| `scoring` | CRPS (O(m log m)), PIT, coverage, pinball |
| `forecast` | Monte-Carlo sum, conditional WIP, auto-calibration |
| `backtest` | walk-forward, v1↔v2 A/B, skill score, paired bootstrap |
| `git` | minimal commit + churn reader (numstat) |

Every estimator is pinned by a parameter-recovery test (fit a known distribution → recover its parameters); the CRPS implementation is checked against the O(m²) brute-force form. `npm test` → 114/114.

---

## Limitations

- Forecasts **active work**, not calendar time — the duty-cycle date is a best-effort projection.
- It models velocity *drift*, but cannot foresee a discontinuity with no precedent in the history (a brand-new kind of task, an unstarted scope change). Run `--validate` to see how much the modelling is (or isn't) helping.
- It forecasts the *count you give it*; it doesn't know how many tasks truly remain. Wrong `--remaining` → wrong answer.
- Needs ≥ 5 task samples to forecast, ~20 for a meaningful `--backtest`/`--validate`.
- Per-commit churn is read but **not** used in the blind forecast: integrating out an unknown future task's size returns the unconditional distribution, so churn only helps when a task's size is known. The capability is wired and tested for that case.

---

## References

The methods buildcast leans on, for the curious:

- T. Gneiting & A. Raftery (2007), *Strictly Proper Scoring Rules, Prediction, and Estimation* — CRPS.
- B. Flyvbjerg (2006), *From Nobel Prize to Project Management* — reference-class forecasting / the outside view.
- T. Minka (2002), *Estimating a Gamma Distribution* — the gamma MLE fixed-point.
- H. Akaike (1974) & Hurvich–Tsai (1989) — AIC and the small-sample correction AICc.
- R. DerSimonian & N. Laird (1986), *Meta-analysis in Clinical Trials* — the between-group variance estimator used for shrinkage.
- L. Kish (1965), *Survey Sampling* — effective sample size under weighting.
- Fenton (1960) / Wilkinson — the log-normal-sum moment-matching cross-check.
- Hyndman & Athanasopoulos, *Forecasting: Principles and Practice* — rolling-origin evaluation.

See **[docs/METHODOLOGY.md](docs/METHODOLOGY.md)** for how each is used, with formulas.

---

## License

MIT.
