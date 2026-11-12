// Regenerates assets/header.svg: a Patagonia-style mountain scene with pixel cats and dogs in a meadow.
// Lighting follows the time of day in Los Angeles (6 phases); the cast is reshuffled daily from the LA date.
// Node 20+, zero deps, no network. Usage: node scripts/generate.mjs [--at ISO-time] | [--date YYYY-MM-DD --phase name]
// Builds and validates the whole SVG in memory first; on any error it exits 1 and writes nothing.
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { SPECIES, COATS, OUTLINE } from './sprites.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TEXT = JSON.parse(readFileSync(join(HERE, 'text.json'), 'utf8')); // outlined by outline-text.py
export const W = 880, H = 300, PX = 3; // canvas, sprite pixel scale
const LANES = [272, 284, 296]; // feet y of the 3 slots; far -> near
const PERIODS = [37, 41, 43, 47, 53, 59]; // slot loops, primes: the combined pattern repeats after their product
const n = (v) => Math.round(v * 10) / 10;

// ---------------------------------------------------------------- RNG
export function rng(seed) { // FNV-1a hash of the seed string -> mulberry32
  let h = 2166136261;
  for (const c of String(seed)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r, a) => a[Math.floor(r() * a.length)];
const shuffle = (r, a) => a.map((v) => [r(), v]).sort((x, y) => x[0] - y[0]).map((x) => x[1]);

// ---------------------------------------------------------------- sprites
const widthOf = (sp) => Math.max(...Object.values(SPECIES[sp].frames).flat().map((r) => r.length));
const heightOf = (sp) => Math.max(...Object.values(SPECIES[sp].frames).map((f) => f.length));

// Pixel rows -> one 1px-stroke path per colour key (each horizontal run is `M x y.5 h len`), bottom-aligned to height h.
function runs(rows, h = rows.length) {
  const d = {};
  rows.forEach((row, i) => {
    const y = h - rows.length + i + 0.5;
    for (const m of row.matchAll(/([^.])\1*/g)) (d[m[1]] ??= []).push(`M${m.index} ${y}h${m[0].length}`);
  });
  return d;
}

// Standalone sprite with literal colours (used for the sprite sheet).
export function spriteSvg(rows, pal) {
  const w = Math.max(...rows.map((r) => r.length)), h = rows.length;
  const col = { o: OUTLINE, E: OUTLINE, ...pal };
  return { w, h, body: Object.entries(runs(rows)).map(([k, v]) => `<path d="${v.join('')}" stroke="${col[k]}"/>`).join('') };
}

// Frame as <symbol>-like <g> whose colours come from CSS vars set on each animal (one def serves every coat).
function frameDef(id, rows, h) {
  return `<g id="${id}" class="px">` + Object.entries(runs(rows, h)).map(([k, v]) => `<path class="${k}" d="${v.join('')}"/>`).join('') + '</g>';
}

// An A/B frame pair as three defs: rows both frames share (`sp-act`), and the rows only A or only B has.
// Halves the sprite bytes, since most pairs differ in a few rows (legs, eyes, ears).
export function pairDefs(sp, act) {
  const h = heightOf(sp), pad = (f) => [...Array(h - f.length).fill(''), ...f];
  const a = pad(SPECIES[sp].frames[act + 'A']), b = pad(SPECIES[sp].frames[act + 'B']);
  const same = a.map((r, i) => (r === b[i] ? r : ''));
  return frameDef(`${sp}-${act}`, same, h) + frameDef(`${sp}-${act}A`, a.map((r, i) => (r === b[i] ? '' : r)), h)
    + frameDef(`${sp}-${act}B`, b.map((r, i) => (r === a[i] ? '' : r)), h);
}

// ---------------------------------------------------------------- cast
// 3 slots, one per lane. A slot's loop is split into equal windows, one per animal, and each animal
// appears only inside its own window, so a slot never shows two animals at once: <= 3 on screen, always.
export function cast(seed) {
  const r = rng(seed);
  const pool = shuffle(r, Object.entries(COATS).flatMap(([sp, coats]) => Object.keys(coats).map((coat) => [sp, coat])));
  const sizes = shuffle(r, [2, 2, 2 + Math.floor(r() * 2)]), periods = shuffle(r, PERIODS); // 6-7 animals
  let next = 0;
  return sizes.flatMap((m, slot) => {
    const T = periods[slot], win = T / m, delay = -n(r() * T);
    return Array.from({ length: m }, (_, k) => {
      const [sp, coat] = pool[next++], speed = SPECIES[sp].speed * (0.85 + r() * 0.3);
      const L = win * (0.72 + r() * 0.16); // on stage; the rest of the window is empty meadow
      const start = k * win + r() * (win - L - 1.2);
      const w1 = L * (0.2 + r() * 0.15), w2 = L * (0.1 + r() * 0.12), still = L - w1 - w2 - 1;
      let dir = r() < 0.5 ? 1 : -1;
      const x = 50 + r() * (W - 100), dist = (w1 + w2) * speed;
      if (x + dir * dist < 30 || x + dir * dist > W - 30) dir = -dir;
      return { sp, coat, idle: pick(r, SPECIES[sp].idle), T, delay, lane: slot, first: k === 0, win: [k * win, (k + 1) * win],
        apps: [{ start, x, dir, w1, w2, still, speed }] };
    });
  });
}

// Seconds (within its loop) when an animal is visible: [fade-in start, fade-out end] per appearance.
export const visible = (a) => a.apps.map((p) => [p.start, p.start + 1 + p.w1 + p.still + p.w2]);

// ---------------------------------------------------------------- animation
const pct = (t, T) => Math.round((t / T) * 1000) / 10; // 0.1% steps: <= 53 ms on the longest loop
// Keyframes from [percent, declarations] stops; neighbours with identical declarations share one block.
export function kf(stops) {
  const out = [];
  for (const [p, d] of stops) {
    const last = out.at(-1);
    if (last && last.d === d) last.ps.push(p); else out.push({ ps: [p], d });
  }
  return out.map(({ ps, d }) => `${ps.length > 2 ? `${ps[0]}%,${ps.at(-1)}` : ps.join('%,')}%{${d}}`).join('');
}
// Hard-cut opacity track: `on` inside the given [from, to] second intervals, `1 - on` otherwise.
function steps(ivs, T, on = 1) {
  const st = [[0, 1 - on]];
  for (const [a, b] of ivs) st.push([pct(a, T), 1 - on], [n(pct(a, T) + 0.1), on], [pct(b, T), on], [n(pct(b, T) + 0.1), 1 - on]);
  return kf([...st, [100, 1 - on]].map(([p, o]) => [p, `opacity:${o}`]));
}

function animal(a, i) {
  const { sp, T } = a, w = widthOf(sp), h = heightOf(sp), y = LANES[a.lane];
  const tf = (x, dy, dir) => `transform:translate(${Math.round(x)}px${dy ? `,${dy}px` : ''})${dir < 0 ? ' scaleX(-1)' : ''}`;
  const move = [], walk = [];
  for (const p of a.apps) {
    const t0 = p.start, x1 = p.x + p.dir * p.w1 * p.speed, x2 = x1 + p.dir * p.w2 * p.speed;
    const t1 = t0 + 0.4 + p.w1, t2 = t1 + p.still, t3 = t2 + p.w2;
    move.push([t0, p.x, -9, p.dir, 0], [t0 + 0.4, p.x, 0, p.dir, 1], // pop in: drop the last few px while fading in
      [t1, x1, 0, p.dir, 1], [t2, x1, 0, p.dir, 1], [t3, x2, 0, p.dir, 1], [t3 + 0.6, x2, 0, p.dir, 0]); // walk, rest, walk, fade
    walk.push([t0 + 0.4, t1], [t2, t3 + 0.6]);
  }
  const first = move[0];
  const key = [[0, ...first.slice(1)], ...move, [T, ...first.slice(1)]]
    .map(([t, x, dy, dir, op]) => [pct(t, T), `${tf(x, dy, dir)};opacity:${op}`]);
  const rest = a.idle;
  // Still frame (reduced motion): only each slot's first animal shows, so it too has <= 3.
  const css = `.m${i}{${tf(first[1], 0, first[3])}${a.first ? '' : ';opacity:0'};animation:m${i} ${T}s linear ${a.delay}s infinite}@keyframes m${i}{${kf(key)}}`
    + `.w${i}{opacity:0;animation:w${i} ${T}s linear ${a.delay}s infinite}@keyframes w${i}{${steps(walk, T)}}`
    + `.r${i}{animation:r${i} ${T}s linear ${a.delay}s infinite}@keyframes r${i}{${steps(walk, T, 0)}}`;
  const c = COATS[sp][a.coat], vars = Object.entries({ E: OUTLINE, ...c }).map(([k, v]) => `--${k}:${v}`).join(';');
  const off = `translate(0,${y}) scale(${PX}) translate(${-w / 2},${-h})`;
  const zz = a.idle === 'sleep' ? `<g class="zz"><rect class="z" x="${w - 4}" y="0" width="1" height="1"/><rect class="z z2" x="${w - 3}" y="-1" width="1" height="1"/></g>` : '';
  const body = `<g style="${vars}"><g class="m${i}"><g transform="${off}">`
    + `<g class="w${i}"><use href="#${sp}-walk"/><use href="#${sp}-walkA" class="fa"/><use href="#${sp}-walkB" class="fb"/></g>`
    + `<g class="r${i}"><use href="#${sp}-${rest}"/><use href="#${sp}-${rest}A" class="ia ${rest}"/><use href="#${sp}-${rest}B" class="ib ${rest}"/>${zz}</g>`
    + '</g></g></g>';
  return { css, body, uses: [`${sp}-walk`, `${sp}-${rest}`] };
}

// ---------------------------------------------------------------- phases (time of day in Los Angeles)
// Hour ranges are fixed local clock hours, not solar times. ponytail: no sunrise/sunset maths; shift by season if it matters.
export const PHASES = {
  night: { from: 21, label: 'at night under stars', sky: ['#0B1230', '#17204A', '#2A3263', '#3B4373'], stars: 0.9,
    cloud: ['#4A4F78', '#3A3F66', '#2E3256', '#262A48'], rock: ['#3A3D5E', '#23253D'], glow: ['#43476B', '#383B5C', '#2C2E4A'],
    snow: '#9EA6C8', snowLit: '#B7BEDB', caps: '#17151E', far: '#2E3560', fold: '#1C2B2A', hill: '#14211D', moss: '#2A3D33',
    lake: ['#1F4F63', '#163746'], shimmer: '#7FA9C9', meadow: ['#36513A', '#2E4631', '#45663F'], name: '#E9ECF8', role: '#B8C0E0', tint: 0.3 },
  dawn: { from: 5, label: 'at dawn, faintly pink', sky: ['#6E7BB0', '#A79BC6', '#E2B5C4', '#F6CFC0'], stars: 0.2,
    cloud: ['#F8D2C8', '#E6A9B4', '#B595B5', '#8E86AE'], rock: ['#6C6A93', '#43425F'], glow: ['#E3A8A8', '#C48A9A', '#8E7393'],
    snow: '#D3CEE4', snowLit: '#F4D8D8', caps: '#2E2A36', far: '#9B98C0', fold: '#33493F', hill: '#283C31', moss: '#4D6A4B',
    lake: ['#6FB9BE', '#3D8792'], shimmer: '#D9F0EE', meadow: ['#668650', '#587545', '#80A060'], name: '#1C2242', role: '#2F3866', tint: 0 },
  day: { from: 7, label: 'in bright daylight', sky: ['#3F7FD0', '#6FA4E0', '#A9CBEE', '#D8E8F5'], stars: 0,
    cloud: ['#FFFFFF', '#EEF2F8', '#C9D3E3', '#AFBBD0'], rock: ['#707891', '#474E66'], glow: ['#B9B3AA', '#968F8C', '#6A6B7E'],
    snow: '#F2F4FA', snowLit: '#FFFFFF', caps: '#2A2A30', far: '#8FA6C8', fold: '#3E6A45', hill: '#2F5537', moss: '#6C9658',
    lake: ['#43C9C3', '#1E9AA3'], shimmer: '#E8FFFB', meadow: ['#79A452', '#6A9446', '#94BE66'], name: '#0F1E3D', role: '#1E3560', tint: 0 },
  golden: { from: 16, label: 'in golden-hour light', sky: ['#5E86C2', '#9DB3D6', '#EBCB9E', '#F8D59A'], stars: 0,
    cloud: ['#FFE7B8', '#F8C987', '#D9A47A', '#A99098'], rock: ['#6B6880', '#45435A'], glow: ['#F2B76E', '#DB9864', '#A2766F'],
    snow: '#E6E1E6', snowLit: '#FBE6C2', caps: '#2D2830', far: '#A7A7BF', fold: '#3C5C3F', hill: '#2E4A33', moss: '#7E9A4E',
    lake: ['#58C2B4', '#2B8F92'], shimmer: '#FFF1C9', meadow: ['#7C9A4A', '#6B8A40', '#A2B85E'], name: '#17203A', role: '#26335E', tint: 0 },
  dusk: { from: 18, label: 'glowing pink at dusk', sky: ['#6B87BC', '#A3B1D6', '#DDC1C9', '#F3CDB6'], stars: 0,
    cloud: ['#FCD3B0', '#F3A286', '#C98593', '#9C88B2'], rock: ['#6A668F', '#3F3D5E'], glow: ['#F2A57F', '#D9837A', '#9C6A86'],
    snow: '#CFCDE4', snowLit: '#F9DCCD', caps: '#2B2733', far: '#9A9AC0', fold: '#35503F', hill: '#2A4233', moss: '#56774C',
    lake: ['#5FC2BE', '#2F8E94'], shimmer: '#C8F0EA', meadow: ['#6D8E4E', '#5F8044', '#88A95E'], name: '#17203A', role: '#26335E', tint: 0 },
  blue: { from: 20, label: 'in the blue hour', sky: ['#1D2A5C', '#33468A', '#5A6BA8', '#8E8DBE'], stars: 0.55,
    cloud: ['#7680B4', '#5F68A0', '#4A5186', '#393F6C'], rock: ['#4A4F7A', '#2D3152'], glow: ['#7A6E9E', '#5F5888', '#45436C'],
    snow: '#AFB6D8', snowLit: '#C9C3E0', caps: '#1E1C28', far: '#4A5590', fold: '#22363A', hill: '#1A2B2B', moss: '#36504A',
    lake: ['#2F6E86', '#1F4D63'], shimmer: '#A9C9E6', meadow: ['#46644A', '#3C573F', '#587A52'], name: '#EEF0FA', role: '#C2C8E8', tint: 0.16 },
};

// Phase for a local hour (0-24, fractional ok): the last phase whose start hour has passed, wrapping at midnight.
export function phaseAt(hour) {
  const order = Object.entries(PHASES).sort((a, b) => a[1].from - b[1].from);
  return (order.findLast(([, p]) => p.from <= hour) ?? order.at(-1))[0];
}

// Los Angeles local date and phase for an instant. Intl handles DST.
export function laNow(when = new Date()) {
  const f = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(when).map((x) => [x.type, x.value]));
  return { date: `${f.year}-${f.month}-${f.day}`, phase: phaseAt(Number(f.hour) + Number(f.minute) / 60) };
}

// ---------------------------------------------------------------- scene (shapes fixed; colours per phase)
const P = (pts) => 'M' + pts.map(([x, y]) => `${x} ${y}`).join('L') + 'Z';

// Cumulus: a lavender shadow blob, then the same blob nudged up-left in an alpenglow gradient (peach top, pink belly).
function cloud(id, cx, cy, s, lumps, c) {
  const blob = (dx, dy, k) => lumps.map(([x, y, r]) => `<circle cx="${n(cx + (x + dx) * s)}" cy="${n(cy + (y + dy) * s)}" r="${n(r * k * s)}"/>`).join('');
  const g = `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" y1="${n(cy - 80 * s)}" x2="0" y2="${n(cy + 30 * s)}"><stop offset="0" stop-color="${c[0]}"/><stop offset=".45" stop-color="${c[1]}"/><stop offset="1" stop-color="${c[2]}"/></linearGradient>`;
  return `${g}<g fill="${c[3]}">${blob(0, 0, 1)}</g><g fill="url(#${id})">${blob(-5, -8, 0.94)}</g>`;
}

export function scene(phase) {
  const c = PHASES[phase], r = rng('alpine-scene');
  const grad = (id, cols) => `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">` + cols.map((col, i) => `<stop offset="${n(i / (cols.length - 1))}" stop-color="${col}"/>`).join('') + '</linearGradient>';
  const sky = '<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">' + c.sky.map((col, i) => `<stop offset="${[0, 0.45, 0.72, 0.86][i]}" stop-color="${col}"/>`).join('') + '</linearGradient>';
  const lakeG = grad('lake', c.lake);
  let stars = ''; // fixed positions from their own RNG, so the scene RNG below is identical in every phase
  const rs = rng('stars');
  if (c.stars) for (let i = 0; i < 26; i++) { const sz = rs() < 0.3 ? 2 : 1; stars += `<rect x="${Math.floor(rs() * W)}" y="${Math.floor(rs() * 150)}" width="${sz}" height="${sz}"/>`; }
  const big = [[-150, 0, 34], [-112, -22, 40], [-66, -42, 50], [-12, -54, 58], [44, -44, 50], [92, -26, 42], [134, -8, 32], [-90, 4, 36], [-30, -8, 48], [30, -6, 46], [84, 2, 34], [170, 6, 22]];
  const small = [[-24, 0, 16], [0, -12, 22], [24, -4, 16]];
  const clouds = `<g class="cl">${cloud('cg1', 590, 120, 1.08, big, c.cloud)}</g><g class="cl2">${cloud('cg2', 816, 52, 0.8, small, c.cloud)}</g>`;
  // Far hazy range behind the massif.
  let far = 'M0 200';
  for (let x = 0; x <= W; x += 20 + r() * 26) far += `L${n(x)} ${n(158 + r() * 20 + (x > 360 ? 10 : 0))}`;
  far += `L${W} 200Z`;
  // Massif: shadow silhouette, alpenglow faces, snow streaks, dark caps. Original shapes, Cuernos-like.
  const mass = [[300, 205], [338, 176], [366, 150], [388, 112], [398, 82], [420, 74], [440, 70], [452, 56], [462, 70], [474, 96], [486, 120], [500, 104], [512, 82], [524, 70], [534, 60], [546, 72], [556, 96], [566, 118], [578, 104], [590, 98], [604, 114], [618, 104], [640, 88], [662, 78], [690, 76], [712, 84], [732, 96], [752, 112], [776, 132], [804, 150], [836, 170], [880, 184], [880, 215], [300, 215]];
  const lit = [ // sunlit (west) faces in alpenglow
    [[338, 176], [366, 150], [388, 112], [398, 82], [408, 96], [400, 140], [384, 172], [356, 196]],
    [[398, 82], [420, 74], [440, 70], [452, 56], [448, 86], [432, 92], [414, 100], [408, 96]],
    [[486, 120], [500, 104], [512, 82], [524, 70], [534, 60], [528, 92], [516, 120], [500, 150], [490, 140]],
    [[566, 118], [578, 104], [590, 98], [586, 126], [574, 150]],
    [[604, 114], [618, 104], [640, 88], [662, 78], [656, 104], [640, 124], [628, 146], [612, 132]],
  ];
  const snow = [ // streaks running down the flanks
    [[452, 56], [462, 70], [474, 96], [486, 120], [492, 150], [478, 136], [470, 118], [458, 108], [454, 86]],
    [[534, 60], [546, 72], [556, 96], [566, 118], [560, 146], [550, 128], [542, 112], [536, 90]],
    [[662, 78], [690, 76], [712, 84], [732, 96], [752, 112], [776, 132], [804, 150], [790, 158], [764, 146], [748, 158], [730, 140], [716, 160], [700, 132], [686, 152], [676, 120], [664, 136], [660, 104]],
    [[410, 120], [424, 108], [432, 136], [420, 160], [412, 150]],
    [[500, 154], [512, 132], [520, 160], [508, 182]],
    [[586, 126], [596, 112], [602, 140], [590, 160]],
    [[628, 146], [640, 126], [648, 152], [636, 178], [626, 168]],
  ];
  const snowLit = [
    [[454, 86], [458, 108], [452, 122], [446, 104]],
    [[536, 90], [542, 112], [532, 128], [528, 108]],
    [[660, 104], [664, 136], [652, 150], [652, 120]],
  ];
  const caps = [ // dark caprock on the horns
    [[398, 82], [420, 74], [440, 70], [452, 56], [462, 70], [470, 84], [452, 86], [432, 90], [414, 96], [402, 94]],
    [[512, 82], [524, 70], [534, 60], [546, 72], [552, 86], [540, 84], [528, 92], [516, 94]],
    [[578, 104], [590, 98], [604, 114], [596, 112], [584, 116]],
  ];
  const fold = 'M0 214Q60 196 120 204T250 198Q320 186 380 200T520 196Q600 188 680 202T880 196V240H0Z';
  const hill2 = 'M0 230Q50 212 110 220T230 214Q290 222 340 210T470 222Q540 228 600 214T740 222Q810 212 880 218V246H0Z';
  const moss = 'M0 230Q50 212 110 220T230 214Q290 222 340 210T470 222Q540 228 600 214T740 222Q810 212 880 218';
  const shimmer = [[70, 237, 60], [210, 240, 40], [380, 236, 70], [560, 239, 50], [720, 237, 64]]
    .map(([x, y, w], i) => `<rect class="sh s${i % 3}" x="${x}" y="${y}" width="${w}" height="1.2" fill="${c.shimmer}"/>`).join('');
  // Meadow: stepped pixel edge so the sprites sit in it, plus a few pixel tufts and flowers.
  let edge = `M0 ${H}V252`, x = 0;
  while (x < W) { x += PX * (2 + Math.floor(r() * 5)); edge += `V${249 + Math.floor(r() * 3) * PX}H${Math.min(x, W)}`; }
  edge += `V${H}Z`;
  let tufts = '', flowers = '';
  for (let i = 0; i < 30; i++) {
    const tx = Math.floor(r() * W / PX) * PX, ty = 258 + Math.floor(r() * 13) * PX;
    tufts += `M${tx} ${ty}h${PX}v${-PX}h${PX}v${PX}h${PX}v${PX}h${-PX * 3}z`;
  }
  for (let i = 0; i < 18; i++) {
    const fx = Math.floor(r() * W / PX) * PX, fy = 262 + Math.floor(r() * 11) * PX;
    flowers += `<rect x="${fx}" y="${fy}" width="${PX}" height="${PX}" fill="${pick(r, ['#F7E9EE', '#F2A7BC', '#F6D27A'])}"/>`;
  }
  const rock = grad('rock', c.rock) + grad('glow', c.glow);
  const defs = `<defs>${sky}${lakeG}${rock}<clipPath id="card"><rect width="${W}" height="${H}" rx="10"/></clipPath></defs>`;
  const layers = `<rect width="${W}" height="${H}" fill="url(#sky)"/>` + (stars && `<g fill="#F4F1FF" opacity="${c.stars}">${stars}</g>`) + clouds
    + `<path d="${far}" fill="${c.far}" opacity=".85"/>`
    + `<g transform="matrix(1 0 0 1.18 0 -38.7)">` // stretch the massif up 18% about its base (y 215): taller, steeper horns
    + `<path d="${P(mass)}" fill="url(#rock)"/><path d="${lit.map(P).join('')}" fill="url(#glow)"/>`
    + `<path d="${snow.map(P).join('')}" fill="${c.snow}"/><path d="${snowLit.map(P).join('')}" fill="${c.snowLit}"/>`
    + `<path d="${caps.map(P).join('')}" fill="${c.caps}"/></g>`
    + `<path d="${fold}" fill="${c.fold}"/>`
    + `<path d="${hill2}" fill="${c.hill}" transform="translate(0,-8)"/><path d="${moss}" fill="none" stroke="${c.moss}" stroke-width="1.2" transform="translate(0,-8)"/>`
    + `<rect y="232" width="${W}" height="26" fill="url(#lake)"/>${shimmer}`
    + `<path d="${edge}" fill="${c.meadow[0]}" shape-rendering="crispEdges"/><rect y="276" width="${W}" height="${H - 276}" fill="${c.meadow[1]}"/>`
    + `<path d="${tufts}" fill="${c.meadow[2]}" shape-rendering="crispEdges"/>${flowers}`;
  const css = '.cl{animation:cl 70s ease-in-out infinite alternate}.cl2{animation:cl 53s ease-in-out -20s infinite alternate}@keyframes cl{from{transform:translateX(-10px)}to{transform:translateX(12px)}}'
    + '.sh{opacity:.25;animation:sh 6s ease-in-out infinite alternate}.s1{animation-delay:-2s;animation-duration:7.3s}.s2{animation-delay:-4s;animation-duration:8.9s}@keyframes sh{to{opacity:.9;transform:translateX(6px)}}';
  return { defs, layers, css };
}

// ---------------------------------------------------------------- svg
export function render(seed, phase) {
  if (!Object.hasOwn(PHASES, phase)) throw new Error(`unknown phase: ${phase}`);
  const c = PHASES[phase], s = scene(phase), animals = cast(seed).map(animal);
  const ids = [...new Set(animals.flatMap((a) => a.uses))];
  const frames = ids.map((id) => pairDefs(...id.split('-'))).join('');
  const css = s.css + animals.map((a) => a.css).join('')
    + `.px path{fill:none;stroke-width:1}.o{stroke:${OUTLINE}}.A{stroke:var(--A)}.B{stroke:var(--B)}.C{stroke:var(--C)}.P{stroke:var(--P)}.E{stroke:var(--E)}.R{stroke:var(--R)}.Y{stroke:var(--Y)}`
    // A/B frame pairs: B shows while A hides (same 2-stop track, A offset by half a cycle). Hard cuts, no tweening.
    + '.fb{animation:fb .5s linear infinite}.fa{animation:fb .5s linear -.25s infinite}@keyframes fb{0%,49.9%{opacity:0}50%,100%{opacity:1}}'
    + '.ib{opacity:0;animation:ib 3.7s linear infinite}.ia{animation:ia 3.7s linear infinite}' // blink / ear twitch
    + '@keyframes ib{0%,91.9%{opacity:0}92%,97%{opacity:1}97.1%,100%{opacity:0}}@keyframes ia{0%,91.9%{opacity:1}92%,97%{opacity:0}97.1%,100%{opacity:1}}'
    + '.ib.wag{animation:fb .7s linear infinite}.ia.wag{animation:fb .7s linear -.35s infinite}'
    + '.ib.sleep{animation:fb 2.6s linear infinite}.ia.sleep{animation:fb 2.6s linear -1.3s infinite}'
    + '.zz{fill:#F7F2FA}.z{animation:z 2.6s linear infinite}.z2{animation-delay:-1.3s}@keyframes z{0%{opacity:0;transform:translate(0,0)}30%{opacity:.9}100%{opacity:0;transform:translate(1px,-6px)}}';
  const still = '.fb,.ib{opacity:0}';
  const label = `Danny T. Developer and photographer. Granite horns ${c.label} above a mountain lake; small pixel cats and dogs wander a meadow in front.`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${label}"><title>${label}</title>`
    + `<style>${css}@media (prefers-reduced-motion:reduce){*{animation:none!important}${still}}</style>`
    + s.defs.replace('</defs>', `${frames}</defs>`)
    + `<g clip-path="url(#card)">${s.layers}`
    + `<g shape-rendering="crispEdges">${animals.map((a) => a.body).join('')}</g>`
    + (c.tint ? `<rect width="${W}" height="${H}" fill="#0A0F2A" opacity="${c.tint}"/>` : '') // night dims the meadow and animals too
    + `<path d="${TEXT.name.d}" fill="${c.name}"/><path d="${TEXT.role.d}" fill="${c.role}"/></g></svg>\n`;
}

export function validate(svg) {
  const kb = Buffer.byteLength(svg);
  if (kb >= 60_000) throw new Error(`header.svg is ${kb} bytes (limit 60000)`);
  if (/<script|<animate|<set\b|@import|@font-face|url\(http|href="http|foreignObject|<image/i.test(svg)) throw new Error('forbidden content in SVG');
  if (!svg.includes('prefers-reduced-motion')) throw new Error('missing reduced-motion still frame');
  return svg;
}

// Build, validate, then write only if the file changed. Returns true when written.
export function run({ outDir, date, phase }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) throw new Error(`invalid date: ${date}`);
  const svg = validate(render(date, phase)), p = join(outDir, 'header.svg');
  if (existsSync(p) && readFileSync(p, 'utf8') === svg) return false;
  writeFileSync(p, svg);
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
    const at = arg('--at') ? new Date(arg('--at')) : new Date();
    if (Number.isNaN(at.getTime())) throw new Error(`invalid --at: ${arg('--at')}`);
    const now = laNow(at), date = arg('--date') ?? now.date, phase = arg('--phase') ?? now.phase;
    const wrote = run({ outDir: join(HERE, '..', 'assets'), date, phase });
    console.log(wrote ? `header.svg updated: ${date} ${phase}` : `no change: ${date} ${phase}`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `phase=${phase}\n`);
  } catch (err) {
    console.error(`generate failed, existing header.svg left untouched: ${err.message}`);
    process.exitCode = 1;
  }
}
