'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  quantileSorted,
  crpsEnsemble,
  crpsLognormal,
  pit,
  coverageHit,
  pinball,
} = require('../src/scoring');
const { mulberry32, randNormal } = require('../src/mathutil');

// ── oracle: brute-force O(m^2) CRPS ────────────────────────────────────────
// CRPS = (1/m) Σ|X_i − y| − (1/(2m²)) ΣΣ|X_i − X_j|.
function crpsBrute(ens, y) {
  const m = ens.length;
  if (m === 0) return null;
  if (m === 1) return Math.abs(ens[0] - y);
  let mae = 0;
  for (let i = 0; i < m; i++) mae += Math.abs(ens[i] - y);
  let dd = 0;
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < m; j++) dd += Math.abs(ens[i] - ens[j]);
  }
  return mae / m - dd / (2 * m * m);
}

// ── quantileSorted ─────────────────────────────────────────────────────────
test('quantileSorted: endpoints, median, interpolation', () => {
  const s = [0, 10, 20, 30, 40];
  assert.strictEqual(quantileSorted(s, 0), 0);
  assert.strictEqual(quantileSorted(s, 0.5), 20);
  assert.strictEqual(quantileSorted(s, 1), 40);
  assert.strictEqual(quantileSorted(s, 0.25), 10); // k=(5-1)*0.25=1 → exactly s[1]
  // an interpolated (non-grid) point: k=(5-1)*0.3=1.2 → 10 + (20-10)*0.2 = 12
  assert.ok(Math.abs(quantileSorted(s, 0.3) - 12) < 1e-12);
});

test('quantileSorted: edge sizes', () => {
  assert.strictEqual(quantileSorted([], 0.5), null);
  assert.strictEqual(quantileSorted([42], 0.5), 42);
  assert.strictEqual(quantileSorted([42], 0), 42);
  assert.strictEqual(quantileSorted([42], 1), 42);
});

// ── crpsEnsemble == brute force ────────────────────────────────────────────
test('crpsEnsemble equals O(m^2) brute force on random ensembles', () => {
  const rng = mulberry32(123456789);
  const ys = [0, 5, 12.5, -3, 30];
  for (let trial = 0; trial < 4; trial++) {
    const m = 180 + trial * 20; // ~200
    const ens = [];
    for (let i = 0; i < m; i++) ens.push(10 + 4 * randNormal(rng));
    for (const y of ys) {
      const fast = crpsEnsemble(ens, y);
      const brute = crpsBrute(ens, y);
      assert.ok(
        Math.abs(fast - brute) < 1e-6,
        `m=${m} y=${y}: fast=${fast} brute=${brute} diff=${Math.abs(fast - brute)}`
      );
    }
  }
});

test('crpsEnsemble: edge sizes', () => {
  assert.strictEqual(crpsEnsemble([], 5), null);
  assert.strictEqual(crpsEnsemble([7], 5), 2); // |7-5|
  assert.strictEqual(crpsEnsemble([3], 5), 2); // |3-5|
});

test('crpsEnsemble: does not assume input is sorted', () => {
  const ens = [30, 10, 20, 0, 40];
  assert.ok(Math.abs(crpsEnsemble(ens, 15) - crpsBrute(ens, 15)) < 1e-9);
});

// ── crpsLognormal cross-check against large ensemble ───────────────────────
test('crpsLognormal matches large lognormal ensemble within 2% rel', () => {
  const cases = [
    { mu: 6, sig: 0.5 },
    { mu: 3, sig: 0.8 },
  ];
  for (const { mu, sig } of cases) {
    const rng = mulberry32(0xC0FFEE ^ Math.round(mu * 1000 + sig * 7));
    const m = 60000;
    const ens = new Array(m);
    for (let i = 0; i < m; i++) ens.push; // placeholder (overwritten below)
    for (let i = 0; i < m; i++) ens[i] = Math.exp(mu + sig * randNormal(rng));
    const median = Math.exp(mu);
    const ys = [median, median * 0.6, median * 1.7];
    for (const y of ys) {
      const closed = crpsLognormal(mu, sig, y);
      const empirical = crpsEnsemble(ens, y);
      const rel = Math.abs(closed - empirical) / Math.abs(empirical);
      assert.ok(
        rel < 0.02,
        `mu=${mu} sig=${sig} y=${y}: closed=${closed} emp=${empirical} rel=${rel}`
      );
    }
  }
});

// ── crpsEnsemble penalizes a shifted (biased) forecast ─────────────────────
test('crpsEnsemble: centered ensemble beats shifted-by-large', () => {
  const rng = mulberry32(987654321);
  const y = 50;
  const m = 500;
  const centered = [];
  for (let i = 0; i < m; i++) centered.push(y + 5 * randNormal(rng));
  const shifted = centered.map((v) => v + 40);
  const sCentered = crpsEnsemble(centered, y);
  const sShifted = crpsEnsemble(shifted, y);
  assert.ok(
    sCentered < sShifted,
    `centered=${sCentered} should be < shifted=${sShifted}`
  );
});

// ── pit ─────────────────────────────────────────────────────────────────────
test('pit: above all → ~1, below all → ~1/(m+1), median → ~0.5', () => {
  const rng = mulberry32(424242);
  const m = 999;
  const ens = [];
  for (let i = 0; i < m; i++) ens.push(100 + 10 * randNormal(rng));
  const sorted = ens.slice().sort((a, b) => a - b);
  const median = sorted[Math.floor(m / 2)];

  // y above every member
  const above = pit(ens, 1e9);
  assert.strictEqual(above, (m + 1) / (m + 1)); // == 1
  assert.strictEqual(above, 1);

  // y below every member → only the +1 in numerator survives
  const below = pit(ens, -1e9);
  assert.ok(
    Math.abs(below - 1 / (m + 1)) < 1e-12,
    `below=${below} expected≈${1 / (m + 1)}`
  );

  // near median → ≈ 0.5
  const mid = pit(ens, median);
  assert.ok(Math.abs(mid - 0.5) < 0.05, `mid=${mid}`);
});

test('pit: exact hand value (≤ is inclusive)', () => {
  const ens = [1, 2, 3, 4]; // count ≤ 3 is 3 → (3+1)/(4+1)=0.8
  assert.ok(Math.abs(pit(ens, 3) - 0.8) < 1e-12);
  // y below all: count ≤ 0 is 0 → 1/5 = 0.2
  assert.ok(Math.abs(pit(ens, 0) - 0.2) < 1e-12);
});

// ── coverageHit ───────────────────────────────────────────────────────────
test('coverageHit: hand-checked', () => {
  const ens = [0, 10, 20, 30, 40]; // q(0.9): k=4*0.9=3.6 → 30+(40-30)*0.6=36
  assert.strictEqual(coverageHit(ens, 35, 0.9), 1); // 35 ≤ 36
  assert.strictEqual(coverageHit(ens, 37, 0.9), 0); // 37 > 36
  // boundary: y exactly == quantile → hit (≤)
  assert.strictEqual(coverageHit(ens, 36, 0.9), 1);
  // unsorted input still works (sorted internally)
  const shuffled = [40, 0, 30, 10, 20];
  assert.strictEqual(coverageHit(shuffled, 35, 0.9), 1);
});

// ── pinball ─────────────────────────────────────────────────────────────────
test('pinball: hand-checked incl. a=0.5 symmetry', () => {
  // y >= q branch: a*(y-q)
  assert.strictEqual(pinball(10, 4, 0.9), 0.9 * 6);
  // y < q branch: (1-a)*(q-y)
  assert.strictEqual(pinball(4, 10, 0.9), (1 - 0.9) * 6);
  // a=0.5 → exactly 0.5*|y-q| both directions
  assert.strictEqual(pinball(10, 4, 0.5), 0.5 * Math.abs(10 - 4));
  assert.strictEqual(pinball(4, 10, 0.5), 0.5 * Math.abs(4 - 10));
  // y == q → 0
  assert.strictEqual(pinball(7, 7, 0.3), 0);
});
