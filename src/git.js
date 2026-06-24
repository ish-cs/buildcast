'use strict';
// Minimal git history reader — no dependencies, shells out to `git`.
const { execFileSync } = require('node:child_process');

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

// Returns every commit as { ts (unix sec), subject }, ascending by time.
function readCommits(repo) {
  const raw = git(repo, ['log', '--format=%ct\x1f%s', '--reverse']);
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const i = line.indexOf('\x1f');
    if (i < 0) continue;
    const ts = parseInt(line.slice(0, i), 10);
    if (Number.isFinite(ts)) out.push({ ts, subject: line.slice(i + 1) });
  }
  return out;
}

// Filter to "task-closing" commits by a subject regex (default: conventional feat/fix/etc.).
function filterTasks(commits, matchRe) {
  return commits.filter(c => matchRe.test(c.subject));
}

module.exports = { readCommits, filterTasks, git };
