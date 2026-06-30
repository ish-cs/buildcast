#!/usr/bin/env node
'use strict';
// buildcast — zero-config probabilistic ETA for any git repo.
// Reads real commit velocity, fits a recency-weighted model (auto-selected by
// walk-forward CRPS), Monte-Carlos the remaining work, prints effort + calendar.
const { readCommits, filterTasks } = require('../src/git');
const { forecast } = require('../src/forecast');
const { backtest, abCompare } = require('../src/backtest');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
function has(name) {
  return process.argv.includes(name);
}

function human(sec) {
  if (sec == null) return '—';
  sec = Math.round(sec);
  if (sec < 90) return `${sec}s`;
  const m = sec / 60;
  if (m < 90) return `~${Math.round(m)}m`;
  const h = m / 60;
  if (h < 36) return `~${h.toFixed(1)}h`;
  return `~${(h / 24).toFixed(1)}d`;
}
function whenLocal(unixSec) {
  if (unixSec == null) return '—';
  const d = new Date(unixSec * 1000);
  return d.toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}
function pct(x) {
  return x == null ? '—' : `${Math.round(x * 100)}%`;
}
function describeH(H) {
  return H == null || !isFinite(H) ? 'none (stationary)' : `${H} commits`;
}

function help() {
  console.log(`buildcast — probabilistic ETA from git velocity

Usage:
  buildcast --repo <path> --remaining <N> [options]

Options:
  --repo <path>        git repo to read            (default: .)
  --match <regex>      task-closing commit filter   (default: ^(feat|fix|perf|refactor)\\()
  --remaining <N>      untouched tasks left         (required unless --backtest/--validate)
  --wip <N>            in-flight tasks              (default 0)
  --wip-elapsed <sec>  how long the WIP task has run (default 0)
  --types a,b,c        known types of remaining tasks, in order (optional)
  --horizon <N>        hold-out window for --backtest/--validate (default 5)
  --no-auto            skip auto-calibration (use defaults)
  --json               machine-readable output
  --backtest           report v2 calibration accuracy on this repo's own history
  --validate           A/B: prove v2 beats (or ties) the v1 naive bootstrap
`);
}

function runForecast(tasks, allTs) {
  const remainingFull = parseInt(arg('--remaining', 'NaN'), 10);
  if (!Number.isFinite(remainingFull)) {
    console.error('error: --remaining <N> required (or use --backtest / --validate)');
    process.exit(1);
  }
  const typesArg = arg('--types', '');
  const f = forecast({
    commits: tasks,
    allTimestamps: allTs,
    remainingFull,
    remainingWip: parseInt(arg('--wip', '0'), 10) || 0,
    wipElapsedSec: parseInt(arg('--wip-elapsed', '0'), 10) || 0,
    remainingTypes: typesArg ? typesArg.split(',').map((s) => s.trim()) : null,
    nowSec: Math.floor(Date.now() / 1000),
    auto: !has('--no-auto'),
  });

  if (has('--json')) {
    console.log(JSON.stringify(f, null, 2));
    return;
  }
  console.log(`\n  buildcast · ${f.remainingTasks} tasks left · ${f.samples} history samples\n`);
  if (f.done) return console.log('  🎉 nothing left — done.\n');
  if (f.insufficient) return console.log('  not enough task history yet (need ≥5 samples).\n');

  console.log(`  EFFORT (hands-on build time)`);
  console.log(`    P50  ${human(f.effort.p50)}   coin-flip`);
  console.log(`    P85  ${human(f.effort.p85)}   safe commitment`);
  console.log(`    P95  ${human(f.effort.p95)}   high confidence`);
  if (f.calendar) {
    console.log(`\n  CALENDAR (duty cycle ${(f.dutyCycle * 100).toFixed(0)}% — active vs idle)`);
    console.log(`    P50  ${whenLocal(f.calendar.p50Sec)}`);
    console.log(`    P85  ${whenLocal(f.calendar.p85Sec)}`);
  }
  const upStr = f.uplift && f.uplift !== 1 ? ` · uplift ×${f.uplift.toFixed(2)}` : '';
  console.log(`\n  model: ${f.model} · half-life ${describeH(f.halfLife)} · n_eff ${Math.round(f.nEff)}${upStr}`);
  console.log(`  ${f.calibrated ? 'auto-calibrated by walk-forward CRPS' : 'defaults (history too short to calibrate)'}\n`);
}

function runBacktest(tasks) {
  const horizon = parseInt(arg('--horizon', '5'), 10) || 5;
  const bt = backtest(tasks, { horizon });
  if (has('--json')) return console.log(JSON.stringify(bt, null, 2));
  if (bt.insufficient) return console.log(`\n  not enough history to backtest (have ${bt.have || 0}; need ~20+).\n`);
  console.log(`\n  buildcast backtest · ${bt.windows} hold-out windows · horizon ${horizon} · sampler ${bt.config.sampler}\n`);
  console.log(`  P50 coverage   ${pct(bt.coverageP50)}   (ideal 50%)`);
  console.log(`  P85 coverage   ${pct(bt.coverageP85)}   (ideal 85%)`);
  console.log(`  P95 coverage   ${pct(bt.coverageP95)}   (ideal 95%)`);
  console.log(`  P50 error      ${pct(bt.mapeP50)}  mean abs % off`);
  console.log(`  mean CRPS      ${Math.round(bt.meanCRPS)}s\n`);
}

function runValidate(tasks) {
  const horizon = parseInt(arg('--horizon', '5'), 10) || 5;
  const r = abCompare(tasks, { horizon });
  if (has('--json')) return console.log(JSON.stringify(r, null, 2));
  if (r.insufficient) return console.log(`\n  not enough history to validate (have ${r.have || 0}; need ~20+).\n`);
  const skill = r.skill == null ? '—' : `${(r.skill * 100).toFixed(1)}%`;
  console.log(`\n  buildcast A/B · v1 naive bootstrap → v2 · ${r.origins} origins · horizon ${horizon}`);
  console.log(`  v2 picked: ${r.config.sampler} · half-life ${describeH(r.config.H)}${r.config.uplift !== 1 ? ` · uplift ×${r.config.uplift.toFixed(2)}` : ''}\n`);
  console.log(`                  v1        v2`);
  console.log(`  mean CRPS    ${String(Math.round(r.v1.meanCRPS)).padStart(7)}   ${String(Math.round(r.v2.meanCRPS)).padStart(7)}   (lower=better)`);
  console.log(`  P50 coverage ${pct(r.v1.coverageP50).padStart(7)}   ${pct(r.v2.coverageP50).padStart(7)}   (ideal 50%)`);
  console.log(`  P85 coverage ${pct(r.v1.coverageP85).padStart(7)}   ${pct(r.v2.coverageP85).padStart(7)}   (ideal 85%)`);
  console.log(`  P95 coverage ${pct(r.v1.coverageP95).padStart(7)}   ${pct(r.v2.coverageP95).padStart(7)}   (ideal 95%)`);
  console.log(`  P50 MAPE     ${pct(r.v1.mapeP50).padStart(7)}   ${pct(r.v2.mapeP50).padStart(7)}   (lower=better)`);
  console.log(`\n  CRPS skill (1 − v2/v1) = ${skill}   ·   P(v2 better) = ${pct(r.winProb)}\n`);
}

function main() {
  if (has('--help') || has('-h')) return help();
  const repo = arg('--repo', '.');
  const matchRe = new RegExp(arg('--match', '^(feat|fix|perf|refactor)\\('));
  const all = readCommits(repo);
  const tasks = filterTasks(all, matchRe);

  if (has('--validate')) return runValidate(tasks);
  if (has('--backtest')) return runBacktest(tasks);
  return runForecast(tasks, all.map((c) => c.ts));
}

main();
