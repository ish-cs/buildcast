# buildcast

**Zero-config probabilistic ETA for any git repo.** Point it at a repo, tell it how many tasks are left, and it forecasts the remaining work from your *actual* commit velocity — as a calibrated P50/P85/P95 range, not a fake single number. Built for burst-y and **AI-agent-driven** builds, where work happens in bursts rather than a 9–5.

```
$ npx buildcast --repo . --remaining 5 --wip 1 --wip-elapsed 600

  buildcast · 6 tasks left · 18 history samples

  EFFORT (hands-on build time)
    P50  ~1.4h   coin-flip
    P85  ~2.6h   safe commitment
    P95  ~3.4h   high confidence

  CALENDAR (duty cycle 38% — active vs idle)
    P50  Tue, Jun 24, 3:10 PM
    P85  Wed, Jun 25, 9:40 AM
```

## Why it exists

Monte Carlo forecasters exist. Git velocity extractors exist. **Nothing combines them zero-config** — you normally hand-paste velocity numbers into a spreadsheet. buildcast reads the git history itself. And nobody models the *duty cycle* of an agent that builds in bursts, which is the only way to turn "2 hours of work" into an actual date.

## How it works

1. **Monte Carlo, not multiplication.** It resamples the remaining tasks from your real per-task commit durations thousands of times and sums each scenario. Summing N tasks cancels per-task variance (central-limit), so the band is far tighter than `single-task-range × N`.
2. **Type buckets.** A `feat` task and a `test` task have different durations; if you tell it the types of the remaining tasks (`--types feat,feat,test`), it samples each from its own history.
3. **Conditional in-flight.** The task you're mid-way through has already run for a while — it forecasts only the *remainder* (`--wip-elapsed`), not a fresh task.
4. **Duty-cycle calendar.** It learns your active-vs-idle rhythm from commit timestamps and projects a wall-clock finish — accounting for the fact that builds pause.
5. **Recency-weighted & drift-aware.** Velocity drifts — later tasks often run longer. buildcast weights recent commits more heavily (a learned half-life) and can fit a parametric tail, so a speeding-up or slowing-down build doesn't fool it. On a genuinely drifting history that's the difference between P95 coverage of **3% and 100%**.
6. **Self-calibrating, never worse than a plain bootstrap.** It auto-selects its half-life, its sampler (empirical bootstrap / fitted distribution / spliced heavy tail) and a reference-class bias correction by scoring each on your repo's *own* walk-forward CRPS. The plain bootstrap is in that menu — so on an already-predictable history it simply picks it and ties, and only deploys heavier machinery when your data rewards it. Prove it on your repo with `--validate`.

## Honesty: how accurate is it?

A forecast that claims 100% accuracy is lying — the future is genuinely uncertain (that's why weather apps say "80% chance"). buildcast tells you how often it's right *by construction*: P85 means "right ~85 times out of 100." Verify it on your own repo:

```
$ buildcast --repo . --backtest

  buildcast backtest · 24 hold-out windows
  P50 coverage   52%   (ideal 50%)
  P85 coverage   83%   (ideal 85%)
  P95 coverage   96%   (ideal 95%)
  P50 error      19%   mean abs % off
```

`--backtest` hides the last K tasks, forecasts them from the rest, and checks how often reality landed inside each band — repeated across every hold-out window in your history.

`--validate` goes further: it runs the **naive bootstrap and the full engine head-to-head** on those same hold-out windows and reports the CRPS skill score, so you can see exactly what the modelling buys *on your data*:

```
$ buildcast --repo . --validate

  buildcast A/B · v1 naive bootstrap → v2 · 30 origins · horizon 5
  v2 picked: spliced · half-life 23 commits · uplift ×1.7

                  v1        v2
  mean CRPS       2977       655   (lower=better)
  P95 coverage      3%      100%   (ideal 95%)
  CRPS skill (1 − v2/v1) = 78.0%   ·   P(v2 better) = 100%
```

**Accuracy depends on your data**, not just the math:

- **Stationary, ≥30 samples** → already easy; the engine ties the plain bootstrap and both track the ideal.
- **Drifting or heavy-tailed** → this is where it earns its keep: it detects the pattern and corrects it (the example above), instead of silently under-covering.
- **Tiny history (<10 hold-out windows)** → it can't validate any correction, so it falls back to the plain bootstrap rather than guessing.

It forecasts **effort** (active build-time) far better than a **calendar date** — because it can't know when you'll next sit down. The duty-cycle calendar is a best-effort projection, not a promise.

## Usage

```
buildcast --repo <path> --remaining <N> [options]

  --repo <path>        git repo to read            (default: .)
  --match <regex>      task-closing commit filter   (default: ^(feat|fix|perf|refactor)\()
  --remaining <N>      untouched tasks left         (required unless --backtest)
  --wip <N>            in-flight tasks              (default 0)
  --wip-elapsed <sec>  how long the WIP task has run (default 0)
  --types a,b,c        known types of remaining tasks, in order
  --horizon <N>        hold-out window for --backtest/--validate (default 5)
  --no-auto            skip auto-calibration (plain recency-free bootstrap)
  --json               machine-readable output
  --backtest           report calibration accuracy on this repo's own history
  --validate           A/B the naive bootstrap vs the full engine on your history
```

Each task = one "task-closing" commit (a `feat(...)`, `fix(...)`, etc.). Amend gaps < 30s are dropped; an "away" gap longer than the learned threshold is *winsorized* (kept but capped) so an overnight pause neither poisons the velocity nor silently vanishes from the count.

## Install

```
npx buildcast --repo . --remaining 5        # no install
npm i -g buildcast && buildcast --backtest   # global
```

No dependencies. Node ≥ 18. MIT.

## Limitations

- Forecasts **active work**, not calendar time — the duty-cycle date is a best-effort projection, not a promise.
- It models velocity *drift* (recency weighting), but it can't see a discontinuity it has no data for — a brand-new kind of task or an unstarted scope change is outside any history-based forecast. Run `--validate` to see how much the modelling is (or isn't) helping.
- It forecasts the *count* you give it; it doesn't know how many tasks are truly left. Wrong `--remaining` → wrong answer.
- Needs ≥5 task samples to forecast, ~20 for a meaningful `--backtest` / `--validate`.
- Churn (lines changed per commit) is read but **not** used in the blind forecast: integrating out an unknown future task's size returns the same distribution, so churn can only help when you already know a task's size. It's wired and tested for that.
