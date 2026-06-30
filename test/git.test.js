'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseGitLog, readCommits } = require('../src/git.js');

const RS = '\x1e';
const US = '\x1f';

test('normal commit: sums insertions + deletions across numstat rows', () => {
  const raw = `${RS}1700000000${US}feat(x): a\n3\t1\tsrc/a.js\n10\t0\tsrc/b.js\n`;
  const got = parseGitLog(raw);
  assert.equal(got.length, 1);
  assert.equal(got[0].ts, 1700000000);
  assert.equal(got[0].subject, 'feat(x): a');
  assert.equal(got[0].churn, 14);
});

test('binary numstat line ("-\\t-") counts as 0', () => {
  const raw = `${RS}1700000050${US}feat: bin\n5\t2\tx.js\n-\t-\timg.png\n`;
  const got = parseGitLog(raw);
  assert.equal(got.length, 1);
  assert.equal(got[0].churn, 7);
});

test('merge / no numstat → churn 0', () => {
  const raw = `${RS}1700000100${US}merge: m\n`;
  const got = parseGitLog(raw);
  assert.equal(got.length, 1);
  assert.equal(got[0].ts, 1700000100);
  assert.equal(got[0].subject, 'merge: m');
  assert.equal(got[0].churn, 0);
});

test('path containing spaces is handled (only first two tab fields parsed)', () => {
  const raw = `${RS}1700000150${US}feat: spaced\n2\t3\tsrc/my file.js\n`;
  const got = parseGitLog(raw);
  assert.equal(got.length, 1);
  assert.equal(got[0].churn, 5);
});

test('path containing a tab character is handled (rest after two fields is path)', () => {
  // Git quotes paths with tabs, but be robust: extra tabs belong to the path, not numbers.
  const raw = `${RS}1700000175${US}feat: tabby\n4\t6\tsrc/weird\tname.js\n`;
  const got = parseGitLog(raw);
  assert.equal(got.length, 1);
  assert.equal(got[0].churn, 10);
});

test('two commits in one raw → length 2, ascending ts, correct subjects + churn', () => {
  const raw =
    `${RS}1700000000${US}feat(x): a\n3\t1\tsrc/a.js\n10\t0\tsrc/b.js\n` +
    `${RS}1700000200${US}fix: b\n1\t1\tsrc/c.js\n`;
  const got = parseGitLog(raw);
  assert.equal(got.length, 2);
  assert.deepEqual(got.map(c => c.ts), [1700000000, 1700000200]);
  assert.deepEqual(got.map(c => c.subject), ['feat(x): a', 'fix: b']);
  assert.deepEqual(got.map(c => c.churn), [14, 2]);
});

test('subject with colon and parens preserved verbatim', () => {
  const raw = `${RS}1700000300${US}refactor(core): split parser (no IO) — yay\n1\t0\tx\n`;
  const got = parseGitLog(raw);
  assert.equal(got.length, 1);
  assert.equal(got[0].subject, 'refactor(core): split parser (no IO) — yay');
  assert.equal(got[0].churn, 1);
});

test('subject may be empty (everything after first US is subject)', () => {
  const raw = `${RS}1700000350${US}\n2\t2\tx\n`;
  const got = parseGitLog(raw);
  assert.equal(got.length, 1);
  assert.equal(got[0].subject, '');
  assert.equal(got[0].churn, 4);
});

test('trailing newline / no trailing newline both fine', () => {
  const withNl = `${RS}1700000400${US}feat: nl\n1\t1\tx\n`;
  const noNl = `${RS}1700000400${US}feat: nl\n1\t1\tx`;
  assert.deepEqual(parseGitLog(withNl), parseGitLog(noNl));
  assert.equal(parseGitLog(noNl)[0].churn, 2);
});

test('empty / falsy raw → empty array', () => {
  assert.deepEqual(parseGitLog(''), []);
  assert.deepEqual(parseGitLog(undefined), []);
  assert.deepEqual(parseGitLog(null), []);
});

test('record with non-finite ct is skipped', () => {
  const raw =
    `${RS}notanumber${US}bad\n9\t9\tx\n` +
    `${RS}1700000500${US}good\n1\t0\tx\n`;
  const got = parseGitLog(raw);
  assert.equal(got.length, 1);
  assert.equal(got[0].subject, 'good');
  assert.equal(got[0].ts, 1700000500);
});

test('header with no unit separator is skipped', () => {
  const raw = `${RS}1700000600 no-separator-here\n1\t1\tx\n`;
  assert.deepEqual(parseGitLog(raw), []);
});

// ── Optional integration test: runs only if git is available and init succeeds ──
test('integration: readCommits returns real churn from a temp repo', (t) => {
  let dir;
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buildcast-git-'));
    const run = (...args) =>
      execFileSync('git', ['-C', dir, ...args], {
        stdio: 'ignore',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t.t',
          GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t.t',
        },
      });
    run('init');
    run('config', 'commit.gpgsign', 'false');

    fs.writeFileSync(path.join(dir, 'a.txt'), 'line1\nline2\nline3\n');
    run('add', 'a.txt');
    run('commit', '-m', 'feat: first');

    fs.writeFileSync(path.join(dir, 'a.txt'), 'line1\nchanged\nline3\nline4\n');
    run('add', 'a.txt');
    run('commit', '-m', 'fix: second');
  } catch (err) {
    t.skip(`git unavailable or init failed: ${err && err.message}`);
    return;
  }

  const commits = readCommits(dir);
  assert.equal(commits.length, 2);
  assert.deepEqual(commits.map(c => c.subject), ['feat: first', 'fix: second']);
  assert.ok(commits[0].ts <= commits[1].ts, 'ascending ts');
  assert.ok(commits[0].churn > 0, 'first commit has churn');
  assert.ok(commits[1].churn > 0, 'second commit has churn');

  fs.rmSync(dir, { recursive: true, force: true });
});
