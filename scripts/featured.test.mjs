// Offline tests: node --test scripts/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickFeatured, renderFeatured, replaceSection, mdText, run, fetchRepos } from './featured.mjs';

const fixture = fileURLToPath(new URL('./fixture-repos.json', import.meta.url));
const repos = JSON.parse(readFileSync(fixture, 'utf8'));
const LOGIN = 'fixture-user';
const README = '# hi\n\n<!-- FEATURED:START -->\nold\n<!-- FEATURED:END -->\n\nfooter\n';

test('pickFeatured: newest 3 public non-fork repos, profile repo skipped, fallbacks applied', () => {
  const f = pickFeatured(repos, LOGIN);
  assert.deepEqual(f.map((r) => r.name), ['alpha', 'beta', 'gamma']);
  assert.equal(f[0].url, 'https://github.com/fixture-user/alpha');
  assert.equal(f[1].desc, 'No description yet.');
  assert.equal(f[1].lang, '');
  assert.equal(f[2].lang, 'TypeScript');
});

test('mdText: untrusted descriptions become one inert Markdown line', () => {
  const d = pickFeatured(repos, LOGIN)[0].desc;
  assert.ok(!d.includes('\n') && !d.includes('<b>'));
  assert.equal(d, 'Line one line &lt;b\\>two&lt;/b\\> with \\[link\\]\\(http://x\\) and \\*stars\\*');
  assert.equal(mdText('x'.repeat(300)).length, 140);
});

test('renderFeatured + replaceSection: exact output, only the marked section changes', () => {
  const body = renderFeatured(pickFeatured(repos, LOGIN));
  assert.equal(body.split('\n')[2], '- **[gamma](https://github.com/fixture-user/gamma)**: Third newest · `TypeScript`');
  assert.equal(body.split('\n')[1], '- **[beta](https://github.com/fixture-user/beta)**: No description yet.');
  const out = replaceSection(README, body);
  assert.ok(out.startsWith('# hi\n\n<!-- FEATURED:START -->\n- **[alpha]') && out.endsWith('<!-- FEATURED:END -->\n\nfooter\n'));
  assert.throws(() => replaceSection('# no markers', body), /markers missing/);
});

test('run: writes once, then no change; API failure or bad payload leaves README untouched', async () => {
  const p = join(mkdtempSync(join(tmpdir(), 'feat-')), 'README.md');
  writeFileSync(p, README);
  assert.equal(await run({ readmePath: p, login: LOGIN, fixture }), true);
  assert.equal(await run({ readmePath: p, login: LOGIN, fixture }), false);
  const before = readFileSync(p, 'utf8');
  await assert.rejects(run({ readmePath: p, login: LOGIN, token: 't', fetchImpl: async () => ({ ok: false, status: 502 }) }), /HTTP 502/);
  await assert.rejects(run({ readmePath: p, login: LOGIN, token: 't', fetchImpl: async () => ({ ok: true, json: async () => ({ message: 'Bad credentials' }) }) }), /not a repo list/);
  await assert.rejects(run({ readmePath: p, login: LOGIN, token: 't', fetchImpl: async () => ({ ok: true, json: async () => [] }) }), /no public/);
  assert.equal(readFileSync(p, 'utf8'), before);
});

test('fetchRepos: validates login and token before any request', async () => {
  await assert.rejects(fetchRepos('bad/login', 't'), /invalid login/);
  await assert.rejects(fetchRepos('ok', ''), /GITHUB_TOKEN/);
});
