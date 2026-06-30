'use strict';
// Turn raw git commits into clean, recency-weighted per-task EFFORT duration
// samples. Pure, zero-dep, deterministic. Durations are in SECONDS.
//
// The pipeline:
//   commits → inter-commit gaps → drop sub-MIN_GAP noise (amends/typos)
//           → winsorize gaps that straddle an away-break (bound effort, keep
//             the task so the count stays honest and the tail isn't thinned)
//           → tag each sample with an age index (newest = 0)
//           → (later) exponentially down-weight older samples by half-life.

// Gaps shorter than this are amend/rebase/typo noise, not real work intervals.
const MIN_GAP = 30;
// Default floor for the "away" threshold: a gap longer than ~3h almost
// certainly straddles a break (sleep, meeting, commute), so its effort
// contribution is capped here rather than taken at face value.
const IDLE_CAP = 3 * 3600;

// Conventional-commit type from a subject line. Matches an optional scope and a
// trailing breaking-change bang. Falls back to 'other' when the subject is not
// conventional. e.g. 'feat(memory): x'→'feat', 'fix!: y'→'fix', 'wip'→'other'.
function commitType(subject) {
  const m = /^(\w+)(\([^)]*\))?!?:/.exec(String(subject).trim());
  return m ? m[1].toLowerCase() : 'other';
}

// Linear-interpolated quantile of an ASCENDING-sorted numeric array, p∈[0,1].
// k=(n-1)*p; interpolate between the two bracketing order statistics. Mirrors
// scoring.quantileSorted but kept local so this module stays self-contained.
function quantileSorted(sorted, p) {
  const n = sorted.length;
  if (n === 0) return null;
  if (n === 1) return sorted[0];
  const k = (n - 1) * p;
  const lo = Math.floor(k);
  const hi = Math.min(lo + 1, n - 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (k - lo);
}

// Tukey upper fence Q3 + 1.5·IQR over `durs`. With fewer than 4 samples the
// fence is meaningless (quartiles collapse onto the same few points), so we
// return Infinity → nothing gets winsorized.
function upperFence(durs) {
  if (durs.length < 4) return Infinity;
  const sorted = durs.slice().sort((a, b) => a - b);
  const q1 = quantileSorted(sorted, 0.25);
  const q3 = quantileSorted(sorted, 0.75);
  return q3 + 1.5 * (q3 - q1);
}

// Build EFFORT duration samples from ascending-by-ts commits.
//   commits : [{ ts:unixSec, subject:string, churn?:number }] ASCENDING by ts
//   opts    : { minGapSec=MIN_GAP, awaySec=null }
// Returns { samples, awaySec, dropped } where each sample is
//   { dur, type, churn, ageIdx, weight:1 }  (weight finalized by
//   applyRecencyWeights). `dropped` counts sub-minGap noise intervals.
function buildSamples(commits, opts) {
  const o = opts || {};
  const minGapSec = o.minGapSec == null ? MIN_GAP : o.minGapSec;

  // 1. Collect raw records in chronological order; drop sub-minGap noise.
  const raw = [];
  let dropped = 0;
  for (let i = 1; i < commits.length; i++) {
    const dur = commits[i].ts - commits[i - 1].ts;
    if (dur < minGapSec) {
      dropped += 1; // amend/typo noise — not a real work interval
      continue;
    }
    raw.push({
      dur,
      type: commitType(commits[i].subject),
      churn: commits[i].churn || 0,
    });
  }

  // 2. Resolve the away threshold: explicit override, else adaptive floor.
  let awaySec;
  if (o.awaySec != null) {
    awaySec = o.awaySec;
  } else {
    awaySec = Math.max(IDLE_CAP, upperFence(raw.map((r) => r.dur)));
  }

  // 3. Winsorize (do NOT drop): clamp over-long gaps to awaySec. The task stays
  //    in the sample so the count is honest and the right tail isn't thinned.
  for (const r of raw) {
    if (r.dur > awaySec) r.dur = awaySec;
  }

  // 4+5. Assign ageIdx (newest = 0, oldest = count-1) and a default weight.
  const count = raw.length;
  const samples = raw.map((r, chronoIdx) => ({
    dur: r.dur,
    type: r.type,
    churn: r.churn,
    ageIdx: count - 1 - chronoIdx,
    weight: 1,
  }));

  return { samples, awaySec, dropped };
}

// Kish effective sample size: (Σw)² / Σw². Empty → 0. Scale-invariant; equals
// n for equal weights and collapses toward 1 as weight mass concentrates.
function nEff(weights) {
  let s = 0;
  let s2 = 0;
  for (const w of weights) {
    s += w;
    s2 += w * w;
  }
  return s2 === 0 ? 0 : (s * s) / s2;
}

// Exponentially down-weight older samples by a half-life H (in commit-index
// units). weight = 2^(−ageIdx / H), so the newest sample (ageIdx 0) weighs 1
// and weight halves every H steps back in time. H≤0 or non-finite → uniform
// weights of 1. Returns a NEW array (input untouched) plus the Kish nEff.
function applyRecencyWeights(samples, H) {
  const flat = !isFinite(H) || H <= 0;
  const out = samples.map((s) => ({
    ...s,
    weight: flat ? 1 : Math.pow(2, -s.ageIdx / H),
  }));
  return { samples: out, nEff: nEff(out.map((s) => s.weight)) };
}

module.exports = {
  commitType,
  buildSamples,
  applyRecencyWeights,
  nEff,
  MIN_GAP,
  IDLE_CAP,
};
