# Alpine meadow profile README: notes (v2, owner revisions applied)

## Layout

| Path | What |
|---|---|
| `README.md` | Header (links to the portfolio), links, About, Featured (between `FEATURED` markers) |
| `assets/header.svg` | 880x300 scene, rewritten when the LA phase or the day's cast changes |
| `scripts/generate.mjs` | Zero-dep Node 20: phase palettes, date-seeded cast, SVG build, validation, CLI |
| `scripts/sprites.mjs` | Original pixel sprites: cat (6 coats), dog (2 coats) |
| `scripts/featured.mjs` | Zero-dep Node 20: REST API → top 3 repos → README section |
| `scripts/*.test.mjs` | `node --test scripts/`: 15 tests |
| `scripts/fixture-repos.json` | Offline fixture for the Featured tests |
| `scripts/text.json`, `scripts/outline-text.py` | "Danny T." and the tagline as outlined paths; the dev-only rebuild script |
| `.github/workflows/meadow.yml` | Hourly at :23, commits only on change |
| `preview-*.png`, `sprites.png` | Review images, gitignored |

Preview tooling lives outside the repo, in `../final-dev/`: `shoot.mjs`, `verify.mjs`, `sheet.mjs`, `phases.mjs`.

## Time of day (America/Los_Angeles)

`laNow()` uses `Intl.DateTimeFormat` with `timeZone: 'America/Los_Angeles'`, so DST is handled. The phase comes from the local hour:

| Phase | LA hours | Look |
|---|---|---|
| night | 21:00-05:00 | navy sky, stars, cool snow, no alpenglow, scene dimmed 30% |
| dawn | 05:00-07:00 | lavender sky, faint pink on the faces |
| day | 07:00-16:00 | blue sky, white snow and cloud, bright turquoise lake |
| golden | 16:00-18:00 | warm gold faces and cloud |
| dusk | 18:00-20:00 | pink alpenglow (the v1 look) |
| blue | 20:00-21:00 | deep blue, a few stars, dimmed 16% |

The hours are fixed clock times, not solar times. In winter, real sunset in LA is around 16:50, so "dusk" runs after real dark. To fix that, shift the hours by month (marked `ponytail:` in the code).

The cast seed is the LA date. The output is a pure function of (LA date, phase), so the hourly run writes a file only about 7 times a day: 6 phase changes plus the cast change at LA midnight.

## Animals: at most 3 visible, structurally

- **Slots:** there are 3 slots, one per lane. Each slot has a prime loop period (37/41/43/47/53/59 s, 3 picked daily) and one shared delay.
- **Windows:** each slot holds 2-3 animals (6-7 a day in total). The slot loop is split into equal windows, one per animal, and an animal fades in, walks, idles, walks and fades out only inside its own window. A slot therefore never shows 2 animals at once, which caps the screen at 3.
- **Still frame:** with reduced motion, only the first animal of each slot is shown, so exactly 3.
- **Daily shuffle:** distinct species/coat pairs drawn from 6 cat coats and 2 dog coats, plus slot sizes, periods, lanes, x spots, directions, speeds and idle actions (cat: sit + blink or nap; dog: sit + wag).
- **Test:** samples 20 minutes at 0.25 s steps for 60 seeds and asserts at most 3 visible (and at least 2 at some point).

## Featured

- **Source:** `GET /users/{owner}/repos?type=owner&sort=pushed&per_page=30` with `GITHUB_TOKEN`.
- **Selection:** non-fork, non-private, and not the profile repo (name equal to the owner login). Sorted by `pushed_at`, top 3.
- **Untrusted input:** repo names must match `[A-Za-z0-9._-]`, and links are built as `https://github.com/{owner}/{name}`, not taken from the payload. Descriptions are flattened to 1 line, have Markdown punctuation escaped and `<` turned into `&lt;`, and are capped at 140 characters. The fallback is "No description yet."
- **Failure handling:** on an API error or a bad payload, the script prints a `::warning::`, writes nothing and exits 0. The scene still updates.
- **Seed:** the current section comes from live data (`gh api users/BrooklynD23/repos`, 2026-11-12): HealthCentral, shoppilot, CEO-Business-Challenge. Descriptions are copied verbatim from GitHub; edit them in each repo's settings.

## Size (every phase stays under the 45 KB the tests enforce for all 366 days x 6 phases)

| Phase (2026-11-12 cast) | Bytes |
|---|---|
| night | 33,209 |
| day | 31,987 |
| dusk | 31,991 |

## IP

- **Sprites:** original ASCII grids. The owner's sprite sheet guided style only.
- **Landscape:** original vector shapes, inspired by the Patagonia photo's composition and light. Not traced.
- **Fonts:** Fraunces and Geist (OFL 1.1), embedded only as outlined paths.

## Verified (headless)

1. `node --test scripts/`: 15/15 pass.
2. Chromium previews as a real `<img>` for night, day and dusk. A sheet of all 6 phases was reviewed.
3. Reduced motion, all 6 phases: 0 running animations (59 normally), and exactly 3 animals in the still frame.
4. Firefox renders the dusk page as an `<img>`, with correct coats (CSS variables through `<use>`).

## UNVERIFIED

1. Safari/WebKit (not installed here).
2. Rendering through GitHub's camo proxy, and its caching. Camo may serve the previous phase for a while after a commit.
3. The workflow on GitHub. Untested: cron timing, commit and push, and REST output under the Actions token.
4. Timing: GitHub's scheduler can run 5-30+ minutes late at busy times, so a phase switch can lag.
