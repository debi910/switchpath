// node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const T = require('../extension/core/tree.js');
const P = require('../extension/core/priors.js');

// Every way to scan items i..j as one list (contiguous children), by brute force.
function bruteCost(p, i, j) {
  const P_ = p.slice(i, j + 1).reduce((a, b) => a + b, 0);
  if (i === j) return P_;
  let best = Infinity;
  for (let k = i; k < j; k++) best = Math.min(best, P_ + (k > i ? bruteCost(p, i, k) : 0) + bruteCost(p, k + 1, j));
  return best;
}

test('dynamic program matches brute force and its own tree', () => {
  let seed = 7;
  const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let trial = 0; trial < 40; trial++) {
    const n = 1 + Math.floor(r() * 8);
    const raw = Array.from({ length: n }, r);
    const t = raw.reduce((a, b) => a + b, 0);
    const p = raw.map((x) => x / t);
    const tree = T.buildTree(p, { order: 'coherent' });
    assert.ok(Math.abs(tree.expected - bruteCost(p, 0, n - 1)) < 1e-9);
    const viaPaths = p.reduce((s, pi, i) => s + pi * T.stepsTo(tree, i), 0);
    assert.ok(Math.abs(tree.expected - viaPaths) < 1e-9);
    assert.deepEqual(T.leaves(tree).sort((a, b) => a - b), [...Array(n).keys()]);
  }
});

test('beats row-column and linear scanning on a uniform 8x8 grid', () => {
  const boxes = Array.from({ length: 64 }, (_, i) => [(i % 8) * 100, Math.floor(i / 8) * 40, 80, 30]);
  const ro = T.readingOrderOf(boxes);
  const rows = T.rowsOf(boxes, ro);
  const tree = T.buildTree(Array(64).fill(1), { order: 'coherent', readingOrder: ro });
  const avg = (f) => [...Array(64).keys()].reduce((s, i) => s + f(i), 0) / 64;
  assert.equal(rows.length, 8);
  assert.equal(avg((i) => T.rowColumnSteps(rows, i)), 9);
  assert.ok(avg((i) => T.stepsTo(tree, i)) < 9);
  assert.equal(avg((i) => T.linearSteps(ro, i)), 32.5);
});

test('history moves a repeated pick to the front', () => {
  const descs = Array.from({ length: 30 }, (_, i) => ({ tag: 'a', text: 'Link ' + String.fromCharCode(97 + (i % 26)) + String.fromCharCode(97 + Math.floor(i / 26)), box: [0, i * 20, 100, 18] }));
  const sigs = descs.map(P.signature);
  const heur = P.heuristicProbs(descs);
  const hist = {};
  for (let k = 0; k < 3; k++) P.recordPick(hist, sigs[17], 0);
  const probs = P.mix(heur, sigs, { siteHistory: hist, now: 0 });
  const tree = T.buildTree(probs, { order: 'fast' });
  assert.ok(T.stepsTo(tree, 17) <= 2);
});

test('signature folds numbers', () => {
  assert.equal(P.signature({ tag: 'a', text: 'Order #1234', href: '/orders/1234' }), P.signature({ tag: 'a', text: 'Order #98', href: '/orders/98' }));
});
