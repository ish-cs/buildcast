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

`--backtest` hides the last K tasks, forecasts them from the rest, and checks how often reality landed inside each band — repeated across every hold-out window in your history. **Accuracy depends on your data**, not just the math:

- **Stationary, ≥30 samples** → coverage tracks the ideal (well-calibrated, ~85/100 on effort).
- **Small or non-stationary history** (velocity changing, tiny sample) → it under-calibrates. The tool *shows you this* instead of hiding it.

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
  --json               machine-readable output
  --backtest           report calibration accuracy on this repo's own history
```

Each task = one "task-closing" commit (a `feat(...)`, `fix(...)`, etc.). Idle gaps > 3h and amend gaps < 30s are excluded automatically, so an overnight pause doesn't poison the velocity.

## Install

```
npx buildcast --repo . --remaining 5        # no install
npm i -g buildcast && buildcast --backtest   # global
```

No dependencies. Node ≥ 18. MIT.

## Limitations

- Forecasts **active work**, not calendar time, unless duty cycle is stable.
- Assumes future tasks resemble past ones (stationarity). Changing scope/velocity degrades accuracy — run `--backtest` to see by how much.
- Needs ≥5 task samples to forecast, ≥13 to backtest.
