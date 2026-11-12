// Rewrites the README section between <!-- FEATURED:START --> and <!-- FEATURED:END --> with the 3 most
// recently pushed public, non-fork repos (the profile repo itself excluded), via the GitHub REST API.
// Node 20+, zero deps. Usage: GITHUB_TOKEN=... node scripts/featured.mjs [--fixture repos.json]
// On any API or validation error it prints a warning, writes nothing, and exits 0: the section stays as it was.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const START = '<!-- FEATURED:START -->', END = '<!-- FEATURED:END -->';
const LOGIN_RE = /^[A-Za-z0-9-]{1,39}$/, NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

export async function fetchRepos(login, token, fetchImpl = fetch) {
  if (!LOGIN_RE.test(login)) throw new Error(`invalid login: ${login}`);
  if (!token) throw new Error('GITHUB_TOKEN is not set');
  const res = await fetchImpl(`https://api.github.com/users/${login}/repos?type=owner&sort=pushed&per_page=30`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'profile-readme-featured' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}`);
  return res.json();
}

// Untrusted text -> one safe Markdown line: no newlines, no HTML, Markdown punctuation escaped, capped length.
export function mdText(s, max = 140) {
  let t = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (t.length > max) t = t.slice(0, max - 1).trimEnd() + '…';
  return t.replace(/[\\`*_[\]()#|~>!]/g, '\\$&').replace(/</g, '&lt;');
}

// API payload (untrusted) -> the 3 entries to show. Throws if the payload is not a repo list.
export function pickFeatured(repos, login) {
  if (!Array.isArray(repos)) throw new Error('GitHub API payload is not a repo list');
  const top = repos
    .filter((r) => r && !r.fork && !r.private && NAME_RE.test(String(r.name)) && String(r.name).toLowerCase() !== login.toLowerCase())
    .sort((a, b) => String(b.pushed_at).localeCompare(String(a.pushed_at)))
    .slice(0, 3);
  if (!top.length) throw new Error('no public non-fork repos found');
  return top.map((r) => ({
    name: r.name,
    url: `https://github.com/${login}/${r.name}`, // built from validated parts, not taken from the payload
    desc: r.description ? mdText(r.description) : 'No description yet.',
    lang: /^[\w#+. -]{1,40}$/.test(String(r.language ?? '')) ? r.language : '',
  }));
}

export const renderFeatured = (items) => items.map((r) => `- **[${r.name}](${r.url})**: ${r.desc}${r.lang ? ` · \`${r.lang}\`` : ''}`).join('\n');

export function replaceSection(readme, body) {
  const a = readme.indexOf(START), b = readme.indexOf(END);
  if (a < 0 || b < a) throw new Error('FEATURED markers missing from README.md');
  return `${readme.slice(0, a + START.length)}\n${body}\n${readme.slice(b)}`;
}

// Returns true when README.md was rewritten.
export async function run({ readmePath, login, token, fixture, fetchImpl }) {
  const repos = fixture ? JSON.parse(readFileSync(fixture, 'utf8')) : await fetchRepos(login, token, fetchImpl);
  const old = readFileSync(readmePath, 'utf8');
  const next = replaceSection(old, renderFeatured(pickFeatured(repos, login))); // throws before any write
  if (next === old) return false;
  writeFileSync(readmePath, next);
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fx = process.argv.indexOf('--fixture');
  try {
    const wrote = await run({
      readmePath: join(dirname(fileURLToPath(import.meta.url)), '..', 'README.md'),
      login: process.env.GITHUB_REPOSITORY_OWNER || 'BrooklynD23',
      token: process.env.GITHUB_TOKEN,
      fixture: fx > 0 ? process.argv[fx + 1] : undefined,
    });
    console.log(wrote ? 'featured: updated' : 'featured: no change');
  } catch (err) {
    console.log(`::warning::featured not updated, README left as it was: ${err.message}`);
  }
}
