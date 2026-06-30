'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { churnModel, fitLogNormal } = require('../src/dist');
const { mulberry32, randNormal } = require('../src/mathutil');

test('churnModel: known size sharpens prediction on churn-correlated data', () => {
  // dur driven by churn: ln(dur) = 1.5 + 0.8·ln(churn) + 0.15·N(0,1)
  const rng = mulberry32(99);
  const s = [];
  for (let i = 0; i < 200; i++) {
    const churn = Math.max(1, Math.round(Math.exp(4 + 1.0 * randNormal(rng))));
    const dur = Math.exp(1.5 + 0.8 * Math.log(churn) + 0.15 * randNormal(rng));
    s.push({ churn, dur, weight: 1 });
  }
  const m = churnModel(s);
  assert.ok(m, 'fits');
  assert.ok(m.r2 > 0.7, `r2 should be high, got ${m.r2.toFixed(2)}`);
  assert.ok(Math.abs(m.slope - 0.8) < 0.15, `slope≈0.8, got ${m.slope.toFixed(2)}`);
  // The payoff: conditioning on a KNOWN churn collapses predictive sd to σ_r,
  // far below the marginal σ used when the size is unknown.
  const cond = m.predictForChurn(100);
  assert.ok(
    cond.sigma < 0.5 * m.params.sigmaM,
    `known-size σ ${cond.sigma.toFixed(2)} should be ≪ marginal σ ${m.params.sigmaM.toFixed(2)}`,
  );
  assert.ok(Math.abs(cond.mu - (1.5 + 0.8 * Math.log(100))) < 0.2, `predicted centre off: ${cond.mu.toFixed(2)}`);
});

test('churnModel: marginal ≈ plain lognormal when churn is uninformative', () => {
  // dur independent of churn → slope≈0, and integrating churn out returns the
  // unconditional lognormal. This is WHY churn cannot help a blind forecast.
  const rng = mulberry32(7);
  const s = [];
  for (let i = 0; i < 200; i++) {
    const churn = Math.max(1, Math.round(Math.exp(4 + 1.0 * randNormal(rng))));
    const dur = Math.exp(6 + 0.5 * randNormal(rng));
    s.push({ churn, dur, weight: 1 });
  }
  const m = churnModel(s);
  assert.ok(m, 'fits');
  assert.ok(Math.abs(m.slope) < 0.2, `slope≈0 when uninformative, got ${m.slope.toFixed(2)}`);
  assert.ok(m.r2 < 0.15, `r2≈0, got ${m.r2.toFixed(2)}`);
  const ln = fitLogNormal(s);
  assert.ok(
    Math.abs(m.params.sigmaM - ln.sigma) < 0.1,
    `marginal σ ${m.params.sigmaM.toFixed(2)} ≈ lognormal σ ${ln.sigma.toFixed(2)}`,
  );
});

test('churnModel: null when too little churn signal', () => {
  const few = [];
  for (let i = 0; i < 5; i++) few.push({ churn: 100, dur: 600, weight: 1 });
  assert.equal(churnModel(few), null, '<8 usable → null');
  const zero = [];
  for (let i = 0; i < 20; i++) zero.push({ churn: 0, dur: 600, weight: 1 });
  assert.equal(churnModel(zero), null, 'all churn 0 → null');
});
