#!/usr/bin/env node
'use strict';
// buildcast — zero-config probabilistic ETA for any git repo.
// Reads real commit velocity, runs a Monte Carlo forecast, prints effort + calendar.
const { readCommits, filterTasks } = require('../src/git');
const { forecast, backtest } = require('../src/forecast');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
function has(name) { return process.argv.includes(name); }

function human(sec) {
  if (sec == null) return '—';
  sec = Math.round(sec);
  if (sec < 90) return `${sec}s`;
  const m = sec / 60; if (m < 90) return `~${Math.round(m)}m`;
  const h = m / 60; if (h < 36) return `~${h.toFixed(1)}h`;
  return `~${(h / 24).toFixed(1)}d`;
}
function whenLocal(unixSec) {
  if (unixSec == null) return '—';
  const d = new Date(unixSec * 1000);
  return d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function main() {
  if (has('--help') || has('-h')) {
    console.log(`buildcast — probabilistic ETA from git velocity

Usage:
  buildcast --repo <path> --remaining <N> [options]

Options:
  --repo <path>        git repo to read           (default: .)
  --match <regex>      task-closing commit filter  (default: ^(feat|fix|perf|refactor)\\()
  --remaining <N>      untouched tasks left        (required unless --backtest)
  --wip <N>            in-flight tasks             (default 0)
  --wip-elapsed <sec>  how long the WIP task has run (default 0)
  --types a,b,c        known types of remaining tasks, in order (optional)
  --json               machine-readable output
  --backtest           report calibration accuracy on this repo's own history
`);
    return;
  }

  const repo = arg('--repo', '.');
  const matchRe = new RegExp(arg('--match', '^(feat|fix|perf|refactor)\\('));
  const all = readCommits(repo);
  const tasks = filterTasks(all, matchRe);

  if (has('--backtest')) {
    const bt = backtest(tasks);
    if (has('--json')) { console.log(JSON.stringify(bt, null, 2)); return; }
    if (bt.insufficient) { console.log(`Not enough history to backtest (have ${bt.have || 0} task samples; need ~13+).`); return; }
    const pct = x => `${Math.round(x * 100)}%`;
    console.log(`\n  buildcast backtest · ${bt.windows} hold-out windows\n`);
    console.log(`  P50 coverage   ${pct(bt.coverageP50)}   (ideal 50%)`);
    console.log(`  P85 coverage   ${pct(bt.coverageP85)}   (ideal 85%)`);
    console.log(`  P95 coverage   ${pct(bt.coverageP95)}   (ideal 95%)`);
    console.log(`  P50 error      ${pct(bt.mapeP50)}  mean abs % off\n`);
    return;
  }

  const remainingFull = parseInt(arg('--remaining', 'NaN'), 10);
  if (!Number.isFinite(remainingFull)) { console.error('error: --remaining <N> required (or use --backtest)'); process.exit(1); }
  const remainingWip = parseInt(arg('--wip', '0'), 10) || 0;
  const wipElapsedSec = parseInt(arg('--wip-elapsed', '0'), 10) || 0;
  const typesArg = arg('--types', '');
  const remainingTypes = typesArg ? typesArg.split(',').map(s => s.trim()) : null;

  const f = forecast({
    commits: tasks, allTimestamps: all.map(c => c.ts),
    remainingFull, remainingWip, wipElapsedSec, remainingTypes,
    nowSec: Math.floor(Date.now() / 1000),
  });

  if (has('--json')) { console.log(JSON.stringify(f, null, 2)); return; }

  console.log(`\n  buildcast · ${f.remainingTasks} tasks left · ${f.samples} history samples\n`);
  if (f.done) { console.log('  🎉 nothing left — done.\n'); return; }
  if (f.insufficient) { console.log('  not enough task history yet (need ≥5 samples).\n'); return; }
  console.log(`  EFFORT (hands-on build time)`);
  console.log(`    P50  ${human(f.effort.p50)}   coin-flip`);
  console.log(`    P85  ${human(f.effort.p85)}   safe commitment`);
  console.log(`    P95  ${human(f.effort.p95)}   high confidence`);
  if (f.calendar) {
    console.log(`\n  CALENDAR (duty cycle ${(f.dutyCycle * 100).toFixed(0)}% — active vs idle)`);
    console.log(`    P50  ${whenLocal(f.calendar.p50Sec)}`);
    console.log(`    P85  ${whenLocal(f.calendar.p85Sec)}`);
  }
  console.log('');
}

main();
