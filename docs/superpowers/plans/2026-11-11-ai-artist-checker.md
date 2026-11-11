# AI Artist Checker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **This repo's execution method (Wai's setup):** the lead Claude session routes each task to a local Qwen pane with `mates send`, gives it the task text and the check command, then runs `mates check N -- <check>` and reads `mates diff N` before `mates merge`. Tasks marked **[Claude]** are done by the lead itself (recon, prompt copy, live tests). Tests are written by the lead and committed to `main` *before* the task is sent; Qwen never edits `tests/`.

**Goal:** While a song plays, look at the upcoming queue, judge whether new artists are AI, skip only on verified hard evidence, and log every verdict quietly in the popup.

**Architecture:** Pure decision logic lives in `checker/*.js` (plain scripts that set one global each, loaded by the content script, the service worker and the helper, and tested in Node with `vm` like the existing tests). A new MV3 service worker (`background.js`) owns all network calls and job polling. A small Node helper (`helper/server.mjs`) runs headless `claude -p` for Wai's subscription path.

**Tech Stack:** Chrome MV3, plain JavaScript (no build step), Node ≥ 20 for tests and the helper (`node:http`, `node:child_process`, `node:test` not required: tests follow the existing `PASS/FAIL … N/N pass` script style).

**Spec:** `docs/superpowers/specs/2026-11-11-ai-artist-checker-design.md`

## Global Constraints

- Skip **only** on verified hard evidence (tracker-list hit or a Deezer AI label the code confirmed on the page). Model-only `ai` → shown as **suspected**, song plays.
- A verdict that arrives after its song started never skips that song.
- Any failure (helper down, timeout, bad output, rate limit) → the song plays.
- Verdicts keyed by the **whole artist line** before the first "•", trimmed, lowercased, inner whitespace collapsed. Never split on "," or "&".
- Look ahead at most **5** queue songs; at most **3** web searches per artist (prompt rule).
- `ai` and `unsure` model verdicts expire after **60 days**; user overrules never expire.
- Helper: `127.0.0.1` only, port **47615**, header `X-Checker-Token` required except on `OPTIONS`; `claude -p` started with an argv array, empty temp cwd, `--restricted`, `--allowedTools WebSearch WebFetch`, `--disallowedTools Bash Edit Write Read`, `--permission-mode dontAsk`, `--no-session-persistence`, `--output-format json`, `--json-schema`.
- Thumbnails are **not** sent in v1 (only 2 of 6 queue thumbnails load; images would need the Read tool). Claude's call, from the review's hardening.
- Token and API key stored after `chrome.storage.local.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'})`; verdicts under the single key `checkerVerdicts`.
- `content.js` `chrome.storage.onChanged` reacts only to `blockedArtists`, `blockedKeywords`, `blockedTracks`, `dislikeBlocked`.

## Review Focus

1. **Helper not running / token wrong** → popup shows "Helper unreachable" or "Token rejected"; songs play; nothing logged as checked.
2. **Queue panel not rendered** (zero `ytmusic-player-queue-item`) → checker does nothing, no errors in console.
3. **Model returns an artist it wasn't asked about, or omits one** → extra ignored, missing gets no verdict (re-tried next song change).
4. **Evidence URL on an unexpected domain, or page lacks the label** → verdict stays *suspected*, never *skip*.
5. **Same title, different artist after a block** ("Summer" by A blocked, "Summer" by B next) → B is still checked (existing bug fixed in Task 7).

Each line's test is named in the owning task (Tasks 2, 3, 6, 7).

---

### Task 1 [Claude]: Recon and fixtures

Unknowns the rest of the plan depends on. No product code.

**Files:**
- Create: `tests/fixtures/artist-page.sample.html`, `tests/fixtures/deezer-album-ai.sample.html`, `tests/fixtures/deezer-album-human.sample.html`, `tests/fixtures/tracker.sample.html` (public pages only, trimmed to < 200 KB each)
- Create: `docs/superpowers/plans/2026-11-11-ai-artist-checker-recon.md`

- [ ] **Step 1:** From a throwaway MV3 test extension (or the real one with a temporary service worker), fetch `http://127.0.0.1:47615/` served by `python3 -m http.server 47615 --bind 127.0.0.1` in WSL. Record: reachable or not, and any Private/Local Network Access prompt.
- [ ] **Step 2:** Find how to get an artist's release history without a channel id: try `fetch('https://music.youtube.com/search?q=<artist>')` from the YTM page context and look for `ytInitialData`; record which JSON paths give the artist channel id, first release year and release count. Save one page as the fixture.
- [ ] **Step 3:** Find Deezer's AI label in a server response: try `https://api.deezer.com/search/artist?q=`, `https://api.deezer.com/artist/<id>/albums`, and an album page HTML. Record whether any response carries the label, and the exact field or phrase. Save AI and human fixtures.
- [ ] **Step 4:** Same for SlopTracker / SoullessMusic artist pages: exact URL pattern and the phrase that marks an artist as flagged.
- [ ] **Step 5:** Write the recon note: for each of steps 1–4, *works / doesn't*, the exact URL pattern, and the exact JSON path or phrase. **If Step 2 fails**, Task 3 is dropped and every unchecked artist goes to the provider under the daily cap. **If Steps 3–4 both fail**, stop and tell Wai: nothing could ever be "verified", so the checker would only flag.
- [ ] **Step 6:** Commit fixtures + note.

### Task 2: Core decision logic (`checker/core.js`)

**Files:** Create `checker/core.js`; Test `tests/checker-core.test.mjs` (written by the lead first).

**Interfaces — Produces** `globalThis.YTMChecker` with:
- `SIGNALS = ['deezer_label','self_disclosure','tracker_flag','no_footprint','new_heavy_catalogue','ai_art']`; `STRONG = ['deezer_label','self_disclosure','tracker_flag']`
- `artistKey(artistLine: string): string`
- `pickArtistsToCheck(songs: {title, artistLine}[], isListed: (artistLine) => boolean, verdicts: Record<string, Verdict>, now: number): {key, artistLine, title}[]` — first 5 songs, dedup by key, drop listed, drop keys with a fresh verdict.
- `isFresh(v: Verdict, now: number): boolean` — `source==='user'` → true; else `now - v.checkedAt < 60*864e5`.
- `validateBatch(sentKeys: string[], raw: unknown, now: number): Verdict[]`
- `skipDecision(v: Verdict | undefined): 'skip' | 'suspected' | 'play'` — `skip` iff `verdict==='ai' && verified===true`; `suspected` iff `verdict==='ai'`; else `play`.
- `Verdict = {key, artistLine, verdict: 'ai'|'human'|'unsure', reasons: string[], signals: string[], evidence: {kind:'deezer'|'tracker', url}[], verified: boolean, source: 'model'|'user', checkedAt: number}`

`validateBatch` rules: `raw.artists` must be an array; keep only items whose `key` is in `sentKeys`; `verdict` must be one of the three; `reasons` → at most 3 strings, each cut to 200 chars; `signals` → filtered to `SIGNALS`, deduped; `evidence` → kept only if `url` is `https:` and host ends with `deezer.com`, `sloptracker.org` or `soullessmusic.com` (exact list confirmed by Task 1); an `ai` with fewer than 2 signals and no `STRONG` signal becomes `unsure`; `verified` always `false` (Task 4 sets it); `source:'model'`, `checkedAt: now`.

- [ ] **Step 1: Tests** (`tests/checker-core.test.mjs`), cases with exact assertions:
  - `artistKey("  Earth, Wind & Fire • Album • 1975 ")` → `"earth, wind & fire"`
  - `pickArtistsToCheck` with 7 songs (2 share an artist line, 1 listed, 1 with a fresh verdict, 1 with a 61-day-old `unsure`) → exactly the expected keys, at most 5 songs looked at.
  - `validateBatch`: unknown key dropped; missing key absent from result (Review Focus 3); bad `verdict` dropped; 4 reasons → 3; 300-char reason → 200; `signals:['ai_art','made_up']` → `['ai_art']`; `ai` with only `['ai_art']` → `unsure`; `ai` with `['no_footprint','ai_art']` stays `ai`; evidence on `evil.com` dropped (Review Focus 4); `verified` is `false`.
  - `skipDecision`: verified ai → `skip`; unverified ai → `suspected`; `unsure`/`human`/`undefined` → `play`.
- [ ] **Step 2:** `node tests/checker-core.test.mjs` fails (file missing).
- [ ] **Step 3:** Implement `checker/core.js` (plain script, no imports, ends with `globalThis.YTMChecker = {...}`).
- [ ] **Step 4:** `node tests/checker-core.test.mjs` → `N/N pass`; existing three tests still pass.
- [ ] **Step 5:** Commit.

### Task 3: First pass from the artist page (`checker/artist-page.js`)

Dropped if Task 1 Step 2 failed.

**Files:** Create `checker/artist-page.js`; Test `tests/artist-page.test.mjs`.

**Interfaces — Produces** `globalThis.YTMArtistPage`:
- `parseSearchPage(html: string, artistLine: string): {channelId: string|null, firstReleaseYear: number|null, releaseCount: number|null}` — JSON paths from the recon note.
- `firstPassSuspicious(info, nowYear: number): boolean` — true if `firstReleaseYear === null`, or `>= 2024`, or `releaseCount / max(1, nowYear - firstReleaseYear + 1) >= 12`.

- [ ] **Step 1: Tests:** fixture parses to the values recorded in the recon note; empty string → all `null`; `firstPassSuspicious` cases: `{2019, 30}`, 2026 → false; `{2025, 4}` → true; `{2021, 120}` → true; all-null → true.
- [ ] **Steps 2–5:** fail, implement, pass, commit.

### Task 4: Evidence verifier (`checker/evidence.js`)

**Files:** Create `checker/evidence.js`; Test `tests/evidence.test.mjs`.

**Interfaces — Produces** `globalThis.YTMEvidence`:
- `verifyEvidence(item: {kind, url}, artistLine: string, pageText: string): boolean` — true only if the URL's host matches the kind's domain, `pageText` contains the artist's key (case-insensitive), and contains the label phrase recorded in the recon note for that domain.
- `applyVerification(v: Verdict, pages: Record<url, string>): Verdict` — sets `verified` true iff `v.verdict==='ai'` and any evidence item verifies.

- [ ] **Step 1: Tests:** AI fixture + right artist → true; human fixture → false; AI fixture + other artist name → false; tracker fixture → true; deezer URL with tracker fixture text → false; `applyVerification` on an `unsure` with good evidence → `verified:false`.
- [ ] **Steps 2–5:** fail, implement, pass, commit.

### Task 5: Local helper (`helper/server.mjs`)

**Files:** Create `helper/server.mjs`, `helper/prompt.md` **[Claude writes the prompt]**, `helper/verdict.schema.json`, `helper/README.md`; Test `tests/helper.test.mjs` with `tests/fixtures/fake-claude.mjs`.

**Interfaces:**
- Consumes: `checker/core.js` `validateBatch`, `checker/evidence.js` `applyVerification` (loaded with `vm.runInThisContext`).
- Produces HTTP API on `127.0.0.1:${PORT||47615}`:
  - `GET /health` → `200 {ok:true}`
  - `POST /jobs` body `{artists:[{key, artistLine, title}]}` (1–5 items) → `202 {jobId}`
  - `GET /jobs/:id` → `{status:'running'}` | `{status:'done', verdicts: Verdict[]}` | `{status:'error', error}`
  - Missing/wrong `X-Checker-Token` → `401`; `Host` not `127.0.0.1:PORT`/`localhost:PORT` → `403`; `OPTIONS` → `204` with CORS headers, no token needed.
- Token: `$XDG_CONFIG_HOME/ytm-ai-checker/token` (default `~/.config/...`), 32 random bytes hex, created mode 600 on first run and printed once.
- Runs `process.env.CLAUDE_BIN || 'claude'` with the Global Constraints flags, prompt = `prompt.md` + the artists as JSON; parses `--output-format json` `result`; runs `validateBatch`; for each evidence URL on the allowlist, `fetch` it (10 s timeout, 2 MB cap) and `applyVerification`.

- [ ] **Step 1: Tests** (helper started on a random port with `CLAUDE_BIN=tests/fixtures/fake-claude.mjs`, which echoes a canned JSON result and records its argv to a temp file): health ok; no token → 401; bad Host → 403; OPTIONS → 204; POST then poll → `done` with validated verdicts; fake-claude argv contains `--restricted`, `--permission-mode dontAsk` and no shell (`argv[0]` is the binary, not `sh`); fake-claude exit 1 → `status:'error'`; an artist name containing `"; rm -rf ~` reaches fake-claude as one argv string inside the prompt.
- [ ] **Steps 2–5:** fail, implement, pass, commit.

### Task 6: Service worker and providers (`background.js`)

**Files:** Create `background.js`; Modify `manifest.json` (add `"background": {"service_worker": "background.js"}`, host permissions `http://127.0.0.1/*`, `https://api.anthropic.com/*`, `https://api.deezer.com/*`, `https://www.deezer.com/*`, the tracker host from recon); Test `tests/background.test.mjs` (fake `chrome`, fake `fetch`).

**Interfaces:**
- Consumes: Tasks 2–4 globals via `importScripts('checker/core.js', 'checker/artist-page.js', 'checker/evidence.js')`.
- Produces: `chrome.runtime.onMessage` handler for `{type:'checkQueue', songs}` → replies `{started: number}` at once; if a job is already running and `songs[0]`'s key is unchecked and not in it, `songs[0]` is sent as its own one-artist job first; job ids kept in `chrome.storage.session` key `checkerJobs`; a `chrome.alarms` alarm `checkerPoll` (or `setTimeout` chain while jobs exist) polls every 10 s; finished verdicts merged into `chrome.storage.local.checkerVerdicts`; status in `chrome.storage.local.checkerStatus = {state:'ok'|'unreachable'|'token'|'rate_limited'|'off', at}`.
- Provider `helper`: the HTTP API above with `checkerHelperToken`. Provider `anthropic`: `POST https://api.anthropic.com/v1/messages`, model `claude-opus-5-5`, tools `web_search_20260209` (`max_uses: 3` per artist × batch size) and `web_fetch_20260209`, headers `anthropic-version`, `x-api-key`, `anthropic-dangerous-direct-browser-access: true`, streamed; daily cap `checkerDailyCap` default 50 counted in `checkerUsage {day, count}`. Same `validateBatch` + evidence fetch + `applyVerification` as the helper.

- [ ] **Step 1: Tests:** `checkQueue` with a listed artist and a fresh verdict sends only the rest; second `checkQueue` while a job runs → the new next song goes out alone; helper 401 → status `token`, no verdicts; helper unreachable → `unreachable`; job done → verdicts saved with `checkedAt`; 429 → `rate_limited`; API cap 50 reached → no request, status `rate_limited`; worker "restart" (new context, same storage) resumes polling stored job ids.
- [ ] **Steps 2–5:** fail, implement, pass, commit.

### Task 7: Content script wiring (`content.js`)

**Files:** Modify `content.js`, `manifest.json` (content_scripts js: `["checker/core.js", "content.js"]`); Test: extend `tests/dom.test.mjs` and `tests/content.test.mjs`.

**Interfaces:**
- Consumes: `YTMChecker.artistKey`, `skipDecision`; `checkerVerdicts` in storage.
- Produces: `readQueue(): {title, artistLine}[]` (from `ytmusic-player-queue-item` `.song-title` / `.byline`, skipping the `selected` item and those before it); on each song change sends `{type:'checkQueue', songs: readQueue()}`; in `checkAndSkip`, after list matching, `skipDecision(verdicts[artistKey(song.artist)]) === 'skip'` → `blockCurrentSong()` **only if** the verdict's `checkedAt` is before the song started (`songStartedAt`, set when the title/artist key changes).

- [ ] **Step 1: Tests:**
  - `readQueue` on a fake queue of 6 with item 2 `selected` → items 3–6.
  - zero queue items → `[]`, no message sent (Review Focus 2).
  - verified-ai verdict saved before the song started → Next clicked, Dislike not clicked.
  - same verdict saved *after* the song started → nothing clicked (late-verdict rule).
  - unverified ai → nothing clicked.
  - "Summer" by A blocked, then "Summer" by B → B still checked (Review Focus 5; replace the title-only `lastProcessedSong` guard with the artist+title key).
  - writing `checkerVerdicts` does **not** call `updateBlockList`; writing `blockedArtists` does.
- [ ] **Steps 2–5:** fail, implement, pass (all test files), commit.

### Task 8: Popup checker tab (`popup.html`, `popup.js`)

**Files:** Modify `popup.html` (fifth tab button `data-tab="checker"`), `popup.js`; Test `tests/popup.test.mjs` (fake DOM like `dom.test.mjs`).

**Interfaces — Consumes:** `checkerVerdicts`, `checkerStatus`, `checkerProvider` (`'off'|'helper'|'anthropic'`, default `'off'`), `checkerHelperToken`, `checkerApiKey`, `checkerDailyCap`.

Tab content, top to bottom: provider select; token or API-key field (password input) shown per provider; status line (`Helper unreachable` / `Token rejected` / `Paused: usage limit` / `Checking ahead` / `Off`); log of verdicts newest first: artist line, label (`Skipped` for verified ai, `Suspected` for unverified ai, `Unsure`, `Human`), reasons, date; buttons: `Not AI` on Skipped/Suspected (sets `verdict:'human', source:'user'`), `Block` on Suspected/Unsure (adds the artist line to `blockedArtists`).

- [ ] **Step 1: Tests:** log order newest first; labels per verdict; `Not AI` writes `source:'user'`; `Block` appends to `blockedArtists` once; status text per `checkerStatus.state`; `setAccessLevel` called before the key is saved.
- [ ] **Steps 2–5:** fail, implement, pass, commit.

### Task 9 [Claude + Wai]: Live end-to-end

- [ ] **Step 1:** Wai starts the helper (`node helper/server.mjs` in WSL), pastes the printed token into the popup, picks "Local helper"; Claude reloads the extension (try `chrome://extensions` first, ask Wai if blocked).
- [ ] **Step 2:** Play a queue mixing a Soul Over AI artist, a post-February suspected AI artist, and a small human indie artist. Record per artist: verdict, label, reasons, time to verdict, and whether anything was skipped.
- [ ] **Step 3:** Pass = no human artist skipped; checker status `Checking ahead`; time to verdict measured (for the next tuning round). Report to Wai with the table.
