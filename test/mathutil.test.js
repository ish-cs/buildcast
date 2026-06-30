'use strict';
const test = require('node:test');
const assert = require('node:assert');
const m = require('../src/mathutil');

const close = (a, b, tol, msg) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);

test('lnGamma matches known values', () => {
  close(m.lnGamma(1), 0, 1e-9, 'lnΓ(1)=0');
  close(m.lnGamma(2), 0, 1e-9, 'lnΓ(2)=0');
  close(m.lnGamma(0.5), Math.log(Math.sqrt(Math.PI)), 1e-9, 'lnΓ(0.5)=ln√π');
  close(m.lnGamma(5), Math.log(24), 1e-9, 'lnΓ(5)=ln24');
  close(m.lnGamma(10), Math.log(362880), 1e-9, 'lnΓ(10)=ln9!');
});

test('digamma matches known values (sign correct)', () => {
  const gamma = 0.5772156649015329;
  close(m.digamma(1), -gamma, 1e-9, 'ψ(1)=-γ');
  close(m.digamma(2), 1 - gamma, 1e-9, 'ψ(2)=1-γ');
  close(m.digamma(10), 2.251752589066721, 1e-9, 'ψ(10)');
});

test('trigamma matches known values', () => {
  close(m.trigamma(1), (Math.PI * Math.PI) / 6, 1e-9, "ψ'(1)=π²/6");
  close(m.trigamma(10), 0.1051663356816858, 1e-9, "ψ'(10)");
});

// erf/normCdf use Abramowitz & Stegun 7.1.26 — abs error envelope ~1.5e-7.
test('erf and normCdf', () => {
  close(m.erf(0), 0, 2e-7, 'erf(0)=0');
  close(m.erf(1), 0.8427007929497149, 2e-7, 'erf(1)');
  close(m.normCdf(0), 0.5, 2e-7, 'Φ(0)=0.5');
  close(m.normCdf(-1), 0.15865525393145707, 2e-7, 'Φ(-1)');
  close(m.normCdf(1.959963984540054), 0.975, 2e-7, 'Φ(1.96)=0.975');
});

// normInv vs truth inherits erf's envelope (~few×1e-6 in x near the centre);
// the round-trip against our own normCdf is self-consistent to ~1e-7.
test('normInv is the inverse of normCdf', () => {
  close(m.normInv(0.5), 0, 1e-6, 'Φ⁻¹(0.5)=0');
  close(m.normInv(0.975), 1.959963984540054, 1e-5, 'Φ⁻¹(0.975)');
  close(m.normInv(0.025), -1.959963984540054, 1e-5, 'Φ⁻¹(0.025)');
  for (const p of [0.01, 0.1, 0.3, 0.6, 0.9, 0.99]) {
    close(m.normCdf(m.normInv(p)), p, 1e-7, `round-trip p=${p}`);
  }
});

test('mulberry32 is deterministic and in [0,1)', () => {
  const r1 = m.mulberry32(42);
  const r2 = m.mulberry32(42);
  const a = [];
  for (let i = 0; i < 1000; i++) {
    const x = r1();
    assert.ok(x >= 0 && x < 1, `in range: ${x}`);
    a.push(x);
  }
  for (let i = 0; i < 1000; i++) assert.equal(r2(), a[i], 'same seed → same stream');
  const r3 = m.mulberry32(43);
  assert.notEqual(r3(), a[0], 'different seed → different stream');
});

test('randNormal: deterministic, ~N(0,1)', () => {
  const rng = m.mulberry32(7);
  let sum = 0;
  let sumsq = 0;
  const N = 50000;
  for (let i = 0; i < N; i++) {
    const z = m.randNormal(rng);
    sum += z;
    sumsq += z * z;
  }
  const mean = sum / N;
  const variance = sumsq / N - mean * mean;
  close(mean, 0, 0.03, 'sample mean ≈ 0');
  close(variance, 1, 0.05, 'sample variance ≈ 1');
});

test('hashString deterministic and varied', () => {
  assert.equal(m.hashString('feat'), m.hashString('feat'), 'stable');
  assert.notEqual(m.hashString('feat'), m.hashString('test'), 'varied');
});
