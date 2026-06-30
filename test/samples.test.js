'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  commitType,
  buildSamples,
  applyRecencyWeights,
  nEff,
  MIN_GAP,
  IDLE_CAP,
} = require('../src/samples');

// Helper: each gap in `durs` becomes exactly one task (one inter-commit
// interval). Seed commit at ts=0; every subsequent commit a 'feat: x'.
function synth(durs) {
  let ts = 0;
  const c = [{ ts: 0, subject: 'seed: x' }];
  for (const d of durs) {
    ts += d;
    c.push({ ts, subject: 'feat: x' });
  }
  return c;
}

// ── commitType ──────────────────────────────────────────────────────────────
test('commitType: conventional types, scope, bang, fallback', () => {
  assert.strictEqual(commitType('feat(memory): x'), 'feat');
  assert.strictEqual(commitType('fix: y'), 'fix');
  assert.strictEqual(commitType('random'), 'other');
  assert.strictEqual(commitType('feat!: bang'), 'feat');
  // case folding + leading whitespace trimmed
  assert.strictEqual(commitType('  FEAT: caps'), 'feat');
  assert.strictEqual(commitType('chore(ci)!: scoped bang'), 'chore');
  // no colon → other
  assert.strictEqual(commitType('feat add thing'), 'other');
});

// ── constants ────────────────────────────────────────────────────────────────
test('constants MIN_GAP and IDLE_CAP exported with expected values', () => {
  assert.strictEqual(MIN_GAP, 30);
  assert.strictEqual(IDLE_CAP, 3 * 3600);
});

// ── buildSamples: drops sub-MIN_GAP gaps ────────────────────────────────────
test('buildSamples drops <30s gaps (counted in dropped, not samples)', () => {
  // gaps: 600 (kept), 5 (dropped — amend/typo noise), 600 (kept)
  const commits = synth([600, 5, 600]);
  const { samples, dropped } = buildSamples(commits, { awaySec: 10800 });
  assert.strictEqual(dropped, 1);
  assert.strictEqual(samples.length, 2);
  // both kept samples are the 600s gaps
  for (const s of samples) assert.strictEqual(s.dur, 600);
});

// ── buildSamples: WINSORIZES, does not drop, long gaps ──────────────────────
test('buildSamples winsorizes a long gap to awaySec (forced), keeps count', () => {
  // gaps: [600, 600, 4h, 600] with awaySec forced to 3h
  const commits = synth([600, 600, 4 * 3600, 600]);
  const { samples, awaySec, dropped } = buildSamples(commits, {
    awaySec: 3 * 3600,
  });
  assert.strictEqual(awaySec, 3 * 3600);
  assert.strictEqual(dropped, 0);
  assert.strictEqual(samples.length, 4); // nothing dropped
  const durs = samples.map((s) => s.dur).sort((a, b) => a - b);
  assert.deepStrictEqual(durs, [600, 600, 600, 3 * 3600]); // 4h clamped to 3h
  // exactly the cap, not more
  assert.strictEqual(Math.max(...samples.map((s) => s.dur)), 3 * 3600);
});

test('buildSamples respects opts.awaySec=10800 passed explicitly', () => {
  const commits = synth([600, 5 * 3600, 600]);
  const { samples, awaySec } = buildSamples(commits, { awaySec: 10800 });
  assert.strictEqual(awaySec, 10800);
  assert.strictEqual(samples.length, 3); // gaps 600,5h,600 — all ≥30, none dropped
  // 5h gap winsorized to 10800, the two 600s untouched
  const durs = samples.map((s) => s.dur).sort((a, b) => a - b);
  assert.deepStrictEqual(durs, [600, 600, 10800]);
});

// ── adaptive awaySec ────────────────────────────────────────────────────────
test('adaptive awaySec is ≥ 3h and finite with ≥4 samples', () => {
  // 6 normal-ish gaps, all well under 3h → upperFence small → floor at 3h
  const commits = synth([600, 700, 650, 800, 720, 680]);
  const { awaySec, samples } = buildSamples(commits, {}); // adaptive
  assert.strictEqual(samples.length, 6);
  assert.ok(Number.isFinite(awaySec), `awaySec finite: ${awaySec}`);
  assert.ok(awaySec >= 3 * 3600, `awaySec ${awaySec} >= ${3 * 3600}`);
  // no gap exceeds the cap, so nothing is winsorized
  assert.deepStrictEqual(
    samples.map((s) => s.dur).sort((a, b) => a - b),
    [600, 650, 680, 700, 720, 800]
  );
});

test('adaptive awaySec winsorizes a clear outlier gap', () => {
  // Tight cluster around ~3.5h so Q3+1.5·IQR sits between the cluster and the
  // outlier AND above the 3h floor — then the 12h outlier gets clamped to it.
  const base = [
    3.0 * 3600,
    3.2 * 3600,
    3.4 * 3600,
    3.6 * 3600,
    3.8 * 3600,
    4.0 * 3600,
  ];
  const commits = synth([...base, 12 * 3600]);
  const { awaySec, samples } = buildSamples(commits, {}); // adaptive
  assert.strictEqual(samples.length, 7);
  assert.ok(awaySec >= 3 * 3600, `awaySec ${awaySec} >= floor`);
  assert.ok(awaySec < 12 * 3600, `awaySec ${awaySec} below outlier so it clamps`);
  const maxDur = Math.max(...samples.map((s) => s.dur));
  assert.strictEqual(maxDur, awaySec); // outlier clamped exactly to awaySec
  // the outlier is the only one touched; the cluster is untouched
  const clamped = samples.filter((s) => s.dur === awaySec).length;
  assert.strictEqual(clamped, 1);
});

test('adaptive: <4 samples → upperFence Infinity → nothing winsorized', () => {
  // 3 gaps incl. a huge one; floor is 3h but upperFence=Infinity so the
  // adaptive awaySec = max(3h, Infinity) = Infinity → no clamping.
  const commits = synth([600, 50 * 3600, 600]);
  const { awaySec, samples } = buildSamples(commits, {}); // adaptive
  assert.strictEqual(samples.length, 3);
  assert.strictEqual(awaySec, Infinity);
  const durs = samples.map((s) => s.dur).sort((a, b) => a - b);
  assert.deepStrictEqual(durs, [600, 600, 50 * 3600]); // unchanged
});

// ── ageIdx mapping ──────────────────────────────────────────────────────────
test('ageIdx: newest sample is 0, oldest is count-1 (last commit is newest)', () => {
  // Distinct durs so we can map each sample back to its chronological slot.
  // gaps chronological: [100, 200, 300, 400] → 4 samples
  const commits = synth([100, 200, 300, 400]);
  const { samples } = buildSamples(commits, { awaySec: 1e9 });
  assert.strictEqual(samples.length, 4);
  const byDur = new Map(samples.map((s) => [s.dur, s.ageIdx]));
  // chronological index: 100→0(oldest), 200→1, 300→2, 400→3(newest)
  // ageIdx = (count-1) - chronoIdx
  assert.strictEqual(byDur.get(100), 3); // oldest
  assert.strictEqual(byDur.get(200), 2);
  assert.strictEqual(byDur.get(300), 1);
  assert.strictEqual(byDur.get(400), 0); // newest (last commit's task)
  // ageIdx set is exactly {0,1,2,3}
  assert.deepStrictEqual(
    samples.map((s) => s.ageIdx).sort((a, b) => a - b),
    [0, 1, 2, 3]
  );
});

// ── churn carried through ───────────────────────────────────────────────────
test('churn carried through onto samples (default 0 when absent)', () => {
  const commits = [
    { ts: 0, subject: 'seed: x' },
    { ts: 600, subject: 'feat: a', churn: 42 },
    { ts: 1200, subject: 'fix: b', churn: 7 },
    { ts: 1800, subject: 'feat: c' }, // no churn → 0
  ];
  const { samples } = buildSamples(commits, { awaySec: 1e9 });
  assert.strictEqual(samples.length, 3);
  // map churn by type to avoid ordering assumptions
  const byChurn = samples.map((s) => ({ type: s.type, churn: s.churn }));
  // the record for commit[i] uses commit[i]'s churn (dur is i-1→i gap)
  const churns = byChurn.map((b) => b.churn).sort((a, b) => a - b);
  assert.deepStrictEqual(churns, [0, 7, 42]);
  // type also carried
  assert.ok(samples.some((s) => s.type === 'fix' && s.churn === 7));
  assert.ok(samples.some((s) => s.type === 'feat' && s.churn === 42));
  assert.ok(samples.some((s) => s.type === 'feat' && s.churn === 0));
});

test('every sample has weight 1 before applyRecencyWeights', () => {
  const commits = synth([100, 200, 300]);
  const { samples } = buildSamples(commits, { awaySec: 1e9 });
  for (const s of samples) assert.strictEqual(s.weight, 1);
});

// ── applyRecencyWeights ─────────────────────────────────────────────────────
test('applyRecencyWeights: H=Infinity → all weights 1, nEff===count', () => {
  const commits = synth([100, 200, 300, 400, 500]);
  const built = buildSamples(commits, { awaySec: 1e9 });
  const { samples, nEff: ne } = applyRecencyWeights(built.samples, Infinity);
  assert.strictEqual(samples.length, 5);
  for (const s of samples) assert.strictEqual(s.weight, 1);
  assert.strictEqual(ne, 5);
  // does NOT mutate input
  for (const s of built.samples) assert.strictEqual(s.weight, 1);
});

test('applyRecencyWeights: finite H → weight strictly decreasing in ageIdx', () => {
  const commits = synth([100, 200, 300, 400, 500, 600]);
  const built = buildSamples(commits, { awaySec: 1e9 });
  const H = 2;
  const { samples } = applyRecencyWeights(built.samples, H);
  // sort by ageIdx ascending (0 = newest)
  const sorted = samples.slice().sort((a, b) => a.ageIdx - b.ageIdx);
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(
      sorted[i].weight < sorted[i - 1].weight,
      `ageIdx ${sorted[i].ageIdx} weight ${sorted[i].weight} should be < ageIdx ${
        sorted[i - 1].ageIdx
      } weight ${sorted[i - 1].weight}`
    );
  }
  // newest weight is exactly 1 (2^0)
  assert.strictEqual(sorted[0].weight, 1);
});

test('applyRecencyWeights: weight at ageIdx=H is half the weight at ageIdx=0', () => {
  // Need a sample whose ageIdx equals H. With 6 samples ageIdx ∈ {0..5}; H=3.
  const commits = synth([100, 200, 300, 400, 500, 600]);
  const built = buildSamples(commits, { awaySec: 1e9 });
  const H = 3;
  const { samples } = applyRecencyWeights(built.samples, H);
  const w0 = samples.find((s) => s.ageIdx === 0).weight;
  const wH = samples.find((s) => s.ageIdx === H).weight;
  assert.ok(Math.abs(wH - 0.5 * w0) < 1e-12, `wH=${wH} w0=${w0}`);
  assert.ok(Math.abs(w0 - 1) < 1e-12);
  assert.ok(Math.abs(wH - 0.5) < 1e-12);
});

test('applyRecencyWeights: returns NEW array, input untouched', () => {
  const commits = synth([100, 200, 300]);
  const built = buildSamples(commits, { awaySec: 1e9 });
  const ref = built.samples;
  const { samples } = applyRecencyWeights(ref, 1);
  assert.notStrictEqual(samples, ref); // different array object
  for (let i = 0; i < ref.length; i++) {
    assert.notStrictEqual(samples[i], ref[i]); // new sample objects
    assert.strictEqual(ref[i].weight, 1); // originals still weight 1
  }
});

test('applyRecencyWeights: H<=0 treated like no weighting (all 1)', () => {
  const commits = synth([100, 200, 300]);
  const built = buildSamples(commits, { awaySec: 1e9 });
  const { samples, nEff: ne } = applyRecencyWeights(built.samples, 0);
  for (const s of samples) assert.strictEqual(s.weight, 1);
  assert.strictEqual(ne, 3);
});

// ── nEff (Kish) ─────────────────────────────────────────────────────────────
test('nEff: equal weights → n', () => {
  assert.strictEqual(nEff([1, 1, 1, 1]), 4);
  assert.strictEqual(nEff([2, 2, 2]), 3); // scale-invariant
  assert.strictEqual(nEff([]), 0);
});

test('nEff: degenerate weights [1,0,0,...] → 1', () => {
  assert.strictEqual(nEff([1, 0, 0, 0, 0]), 1);
});

test('nEff: known small case by hand', () => {
  // weights [1,1,2]: (Σw)²/Σw² = (4)²/(1+1+4) = 16/6 = 2.6666…
  const got = nEff([1, 1, 2]);
  assert.ok(Math.abs(got - 16 / 6) < 1e-12, `got=${got}`);
  // weights [3,1]: 16 / 10 = 1.6
  assert.ok(Math.abs(nEff([3, 1]) - 1.6) < 1e-12);
});
