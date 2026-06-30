'use strict';
// Minimal git history reader — no dependencies, shells out to `git`.
const { execFileSync } = require('node:child_process');

// Record separator (0x1e) prefixes each commit; unit separator (0x1f) splits ct/subject.
const RS = '\x1e';
const US = '\x1f';
// numstat + record-separated header so multi-line numstat is unambiguous.
const LOG_FORMAT = `${RS}%ct${US}%s`;
const LOG_ARGS = ['log', '--reverse', '--numstat', `--format=${LOG_FORMAT}`];

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

// PURE: parse the output of `git log --reverse --numstat --format=$'\x1e%ct\x1f%s'`.
// Each record begins with a 0x1e line: "\x1e<ct>\x1f<subject>", followed by zero or
// more numstat rows "<ins>\t<del>\t<path>". Binary files show "-\t-\t<path>" (counts 0).
// Returns [{ ts, subject, churn }] preserving input order (already --reverse => ascending ts).
function parseGitLog(raw) {
  const out = [];
  if (!raw) return out;
  for (const record of raw.split(RS)) {
    if (record === '') continue; // ignore empty leading chunk (and any blank records)
    const nl = record.indexOf('\n');
    const header = nl < 0 ? record : record.slice(0, nl);
    const rest = nl < 0 ? '' : record.slice(nl + 1);

    const us = header.indexOf(US);
    if (us < 0) continue; // malformed header, no unit separator
    const ts = parseInt(header.slice(0, us), 10);
    if (!Number.isFinite(ts)) continue; // skip records whose ct isn't a finite int
    const subject = header.slice(us + 1);

    let churn = 0;
    if (rest) {
      for (const row of rest.split('\n')) {
        if (row === '') continue;
        // numstat: "<ins>\t<del>\t<path>" — split only the first two tab fields; rest is path.
        const t1 = row.indexOf('\t');
        if (t1 < 0) continue;
        const t2 = row.indexOf('\t', t1 + 1);
        if (t2 < 0) continue;
        const insTok = row.slice(0, t1);
        const delTok = row.slice(t1 + 1, t2);
        const ins = insTok === '-' ? 0 : parseInt(insTok, 10);
        const del = delTok === '-' ? 0 : parseInt(delTok, 10);
        if (Number.isFinite(ins)) churn += ins;
        if (Number.isFinite(del)) churn += del;
      }
    }
    out.push({ ts, subject, churn });
  }
  return out;
}

// Returns every commit as { ts (unix sec), subject, churn }, ascending by time.
function readCommits(repo) {
  const raw = git(repo, LOG_ARGS);
  return parseGitLog(raw);
}

// Filter to "task-closing" commits by a subject regex (default: conventional feat/fix/etc.).
function filterTasks(commits, matchRe) {
  return commits.filter(c => matchRe.test(c.subject));
}

module.exports = { readCommits, filterTasks, git, parseGitLog };
