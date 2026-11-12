// Offline tests: node --test scripts/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rng, cast, visible, render, validate, run, kf, phaseAt, laNow, PHASES, W } from './generate.mjs';
import { SPECIES } from './sprites.mjs';

const SEED = '2026-11-12';
const PH = Object.keys(PHASES);
const SNAPSHOT = ['0:cat:cream:41', '0:cat:grey:41', '1:dog:choc:59', '1:cat:black:59', '2:cat:brown:37', '2:cat:bluegrey:37'];
const days = (n) => Array.from({ length: n }, (_, d) => new Date(Date.UTC(2026, 0, 1 + d)).toISOString().slice(0, 10));

test('rng: fixed seed gives a fixed sequence', () => {
  const a = rng(SEED), b = rng(SEED);
  const xs = Array.from({ length: 5 }, a);
  assert.deepEqual(xs, Array.from({ length: 5 }, b));
  assert.ok(xs.every((x) => x >= 0 && x < 1));
  assert.notDeepEqual(xs, Array.from({ length: 5 }, rng('2026-11-13')));
});

test('cast: fixed-seed snapshot', () => {
  assert.deepEqual(cast(SEED).map((a) => `${a.lane}:${a.sp}:${a.coat}:${a.T}`), SNAPSHOT);
});

test('cast: cats and dogs only, distinct coats, 3 slots, every appearance inside its own window', () => {
  for (const day of days(366)) {
    const c = cast(day);
    assert.ok(c.length >= 6 && c.length <= 7, `${day}: ${c.length} animals`);
    assert.ok(c.every((a) => a.sp === 'cat' || a.sp === 'dog'), `${day}: species`);
    assert.equal(new Set(c.map((a) => `${a.sp}:${a.coat}`)).size, c.length, `${day}: repeated coat`);
    assert.deepEqual([...new Set(c.map((a) => a.lane))].sort(), [0, 1, 2]);
    assert.equal(c.filter((a) => a.first).length, 3, `${day}: still frame must show exactly one animal per slot`);
    for (const slot of [0, 1, 2]) {
      const s = c.filter((a) => a.lane === slot);
      assert.equal(new Set(s.map((a) => `${a.T}/${a.delay}`)).size, 1, `${day}: a slot shares one loop`);
    }
    for (const a of c) {
      assert.ok(SPECIES[a.sp].idle.includes(a.idle));
      for (const [from, to] of visible(a)) assert.ok(from >= a.win[0] && to <= a.win[1], `${day}: ${a.sp} leaves its window`);
      for (const p of a.apps) {
        const end = p.x + p.dir * (p.w1 + p.w2) * p.speed;
        assert.ok(p.x >= 30 && p.x <= W - 30 && end >= 0 && end <= W, `${day}: walks off the meadow`);
      }
    }
  }
});

test('timeline: never more than 3 animals visible (sampled every 0.25 s for 20 min, 60 days)', () => {
  for (const day of days(60)) {
    const c = cast(day);
    let max = 0;
    for (let t = 0; t < 1200; t += 0.25) {
      const on = c.filter((a) => {
        const local = (((t - a.delay) % a.T) + a.T) % a.T; // CSS: a negative delay starts the loop part-way through
        return visible(a).some(([from, to]) => local >= from && local <= to);
      }).length;
      max = Math.max(max, on);
    }
    assert.ok(max <= 3, `${day}: ${max} visible at once`);
    assert.ok(max >= 2, `${day}: meadow too empty (max ${max})`);
  }
});

test('phaseAt: boundaries in LA local hours', () => {
  const cases = [[0, 'night'], [4.99, 'night'], [5, 'dawn'], [6.99, 'dawn'], [7, 'day'], [15.99, 'day'], [16, 'golden'],
    [17.99, 'golden'], [18, 'dusk'], [19.99, 'dusk'], [20, 'blue'], [20.99, 'blue'], [21, 'night'], [23.99, 'night']];
  for (const [h, p] of cases) assert.equal(phaseAt(h), p, `hour ${h}`);
});

test('laNow: DST-aware phase and LA date (same UTC clock time, different local hour across a DST change)', () => {
  assert.deepEqual(laNow(new Date('2026-03-07T12:30:00Z')), { date: '2026-03-07', phase: 'night' }); // 04:30 PST
  assert.deepEqual(laNow(new Date('2026-03-08T12:30:00Z')), { date: '2026-03-08', phase: 'dawn' }); // 05:30 PDT
  assert.deepEqual(laNow(new Date('2026-10-31T12:30:00Z')), { date: '2026-10-31', phase: 'dawn' }); // 05:30 PDT
  assert.deepEqual(laNow(new Date('2026-11-01T12:30:00Z')), { date: '2026-11-01', phase: 'night' }); // 04:30 PST
  assert.deepEqual(laNow(new Date('2026-11-12T06:00:00Z')), { date: '2026-11-11', phase: 'night' }); // LA is still the 11th
  assert.deepEqual(laNow(new Date('2026-11-12T20:00:00Z')), { date: '2026-11-12', phase: 'day' }); // 12:00 PST
});

test('render: byte-stable per (date, phase), distinct across phases and dates, valid for every phase of a year', () => {
  for (const p of PH) assert.equal(render(SEED, p), render(SEED, p));
  assert.equal(new Set(PH.map((p) => render(SEED, p))).size, PH.length);
  assert.notEqual(render(SEED, 'dusk'), render('2026-11-13', 'dusk'));
  let max = 0;
  for (const day of days(366)) for (const p of PH) {
    const svg = validate(render(day, p));
    max = Math.max(max, Buffer.byteLength(svg));
    assert.match(svg, /^<svg [^>]*role="img" aria-label="[^"]+"><title>/);
  }
  assert.ok(max < 45_000, `largest is ${max} bytes`);
  assert.throws(() => render(SEED, 'noon'), /unknown phase/);
  assert.throws(() => render(SEED, '__proto__'), /unknown phase/);
});

test('validate: rejects scripts, SMIL, external refs, missing still frame, oversize', () => {
  const ok = render(SEED, 'dusk');
  assert.throws(() => validate(ok.replace('</svg>', '<script>x</script></svg>')), /forbidden/);
  assert.throws(() => validate(ok.replace('</svg>', '<animate/></svg>')), /forbidden/);
  assert.throws(() => validate(ok.replace('</svg>', '<image href="http://x"/></svg>')), /forbidden/);
  assert.throws(() => validate(ok.replace('prefers-reduced-motion', 'x')), /reduced-motion/);
  assert.throws(() => validate(ok + ' '.repeat(60_000)), /limit/);
});

test('kf: merges neighbouring stops with the same declarations', () => {
  assert.equal(kf([[0, 'a'], [5, 'a'], [9, 'a'], [10, 'b'], [100, 'a']]), '0%,9%{a}10%{b}100%{a}');
});

test('run: writes once, then no change; new phase rewrites; bad input writes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'meadow-'));
  assert.equal(run({ outDir: dir, date: SEED, phase: 'dusk' }), true);
  assert.equal(run({ outDir: dir, date: SEED, phase: 'dusk' }), false);
  assert.equal(run({ outDir: dir, date: SEED, phase: 'blue' }), true);
  writeFileSync(join(dir, 'header.svg'), 'last good');
  assert.throws(() => run({ outDir: dir, date: '2026-13-xx; rm -rf', phase: 'dusk' }), /invalid date/);
  assert.throws(() => run({ outDir: dir, date: SEED, phase: 'noon' }), /unknown phase/);
  assert.equal(readFileSync(join(dir, 'header.svg'), 'utf8'), 'last good');
});
