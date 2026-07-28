# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # first time only
npm start            # dev mode — opens Electron directly (hot-ish: restart after main.js changes)
npm run pack -- --arm64   # build arm64 app bundle in dist/mac-arm64/ (faster, no DMG)
npm run dist         # build distributable DMG — only for the current machine's arch

# Install built app over /Applications:
cp -R "dist/mac-arm64/Claude Bar.app" "/Applications/Claude Bar.app"

# Kill running dev instance:
pkill -f "claude-bar-repo/node_modules/electron"

# Syntax-check JS files (no test suite):
node --check main.js
node --check renderer.js
node --check preload-scraper.js
```

There is no linting or test suite.

**Releasing both architectures**: despite `build.mac.target` in `package.json` listing both `arm64` and `x64` dmg targets, a bare `npm run dist` on this electron-builder version only builds the host machine's arch. Build each explicitly and separately:

```bash
npx electron-builder --mac dmg --arm64
npx electron-builder --mac dmg --x64
```

## Architecture

Two `BrowserWindow` instances managed by `main.js`:

| Window | Visibility | Role |
|--------|-----------|------|
| `floatWin` | Transparent, frameless, always-on-top | Renders the widget (`index.html` + `renderer.js`) |
| `scraperWin` | Hidden (shown only for login) | Real Chromium session logged into `claude.ai` |

### Data flow

```
preload-scraper.js  poll() [configurable interval, default 2 min; guarded against
                             overlapping runs via pollInFlight — the interval timer,
                             manual refresh, and post-login all call poll()]
  → fetch /api/organizations                      → org UUID + capabilities[] → plan name
  → fetch /api/organizations/{id}/usage            → usage JSON (bars, spend/extra_usage, limits)
  → fetch /api/organizations/{id}/prepaid/credits  → real wallet balance + auto-reload (only if
                                                      the usage response indicates credits enabled)
  → ipcRenderer.send('usage:update', { bars, credits, unknownKeys, planName, raw, fetchedAt })
  → ipcMain (main.js)
      → recordUsage()      saves bars to usage-history.json (7-day retention)
      → updateTrayTitle()  sets tray % from Session (five_hour) bar only
      → checkUsageNotifications()  fires threshold / reset / credits-spend notifications
      → checkUnknownKeys() fires a one-time notification for a usage-JSON field that's
                            neither a recognized bar nor a known summary field
      → floatWin.webContents.send('usage-update', data)   [data.raw stripped first]
      → floatWin.webContents.send('history-update', last48h)
  → renderer.js  render() / renderHistScreen()
```

### Key files

- **`main.js`** — main process: window lifecycle, IPC handlers, cookie persistence (encrypted via `safeStorage`), tray (title + "Copy Raw Usage JSON" debug item), notifications, self-updater, usage history storage
- **`preload-scraper.js`** — content script in `scraperWin`: polls `/api/organizations`, `/api/organizations/{id}/usage`, and (when credits are enabled) `/api/organizations/{id}/prepaid/credits`; normalizes the combined response into `{ bars, credits, unknownKeys, planName, fetchedAt }`, sends results via IPC
- **`preload.js`** — context bridge for `floatWin`: exposes `window.claudeBar` (onUpdate, onError, onConfig, onHistoryUpdate, openLogin, refresh, resize, setPin, installUpdate)
- **`renderer.js`** — all UI logic: progress bars, credits row, model-bucket advisory, countdown timer, usage history screen, sparkline SVG, burn-rate regression, theme cycling, resize handling
- **`index.html`** / **`style.css`** — widget markup and CSS custom-property theming

### Persistent storage (all under `app.getPath('userData')`)

| File | Content |
|------|---------|
| `claude-cookies.json` | Session cookies, AES-encrypted via `safeStorage` (base64) |
| `settings.json` | Poll interval, notification toggles, `notifiedUnknownKeys` (dedupes the one-time "new field" notification) |
| `usage-history.json` | `{ barKey: [[ts_ms, utilization], …] }`, 7-day retention; validated on load (see Sparkline / history gotcha) |

## Critical gotchas

### OAuth (Google/Apple login)
- `scraperWin` uses `partition: 'scraper-temp'` (non-persistent, no LevelDB lock). **All OAuth popups must share this same partition** — otherwise auth cookies land in the wrong session.
- `scraperWin.webContents.setUserAgent(CHROME_UA)` is required. Google rejects Electron's default UA with `disallowed_useragent`. The Chrome version in the UA must match the bundled Chromium (`process.versions.chrome`).
- After the OAuth popup closes, the SPA needs ~8 s to complete the code exchange before the session cookie is set. Don't reload too early.
- `setWindowOpenHandler` only allows popups from `ALLOWED_POPUP_HOSTS` (claude.ai, google.com, apple.com domains).

### Cookie persistence
- Filter cookies by `url: 'https://claude.ai'` (not `domain:` — the latter doesn't match `.claude.ai` subdomains).
- `sameSite` must be one of `'unspecified'|'no_restriction'|'lax'|'strict'`; strip other values before `cookies.set()`.
- `saveCookies` skips the write if the cookie list is empty (prevents overwriting a good session with a blank one on error pages).
- Legacy plaintext cookie files are auto-migrated to encrypted format on first read.
- `restoreCookies()` sets each cookie individually with its own try/catch — Chromium can reject an individual cookie (e.g. a `__Host-` prefixed one carrying a `domain`, which `restoreCookies` strips for that reason) and one rejection must not abandon the rest of an otherwise-valid session.

### Usage credits & the `/usage` response shape
The `/api/organizations/{id}/usage` response mixes per-bucket bars (`five_hour`, `seven_day`, `seven_day_*`) with summary fields that are *not* bars: `spend`, `extra_usage`, `limits`, `member_dashboard_available` (`KNOWN_NON_BAR_KEYS` in `preload-scraper.js`). Both the bar-building loop in `normalize()` and `collectUnknownKeys()` must exclude this same set — missing it in one but not the other previously caused `extra_usage` to render as a duplicate "EXTRA_US" bar once its `utilization` field stopped being `null` (it had always been `null` in every payload seen until an account started actually using credits).
- `spend` (newer) and `extra_usage` (older) both describe the same monthly overage cap — `normalizeCredits()` prefers `spend`, falls back to `extra_usage`. Neither carries the actual wallet balance; that's a separate `/prepaid/credits` endpoint (`amount`, `auto_reload_settings`, `tranches`, `promo_tranches`, `next_expires_at`) discovered by inspecting the real Billing settings page's network calls — the endpoint name is not guessable from the `/usage` payload.
- The API also exposes several always-`null` codename fields (`tangelo`, `iguana_necktie`, `omelette_promotional`, etc.) reserved for buckets not enabled on the polling account. Don't invent labels for these; `collectUnknownKeys()` will surface one the moment it goes non-null with an unrecognized shape.
- `MODEL_BUCKET_KEYS` (`seven_day_sonnet`, `seven_day_opus`) is intentionally the only pair compared in the "headroom" advisory — these are the only two weekly buckets confirmed to be alternative pools for the same underlying work. Don't extend it with a guessed frontier/Fable key.

### Window / resize
- `body.style.zoom = window.innerWidth / BASE_W` (BASE_W = 224) scales all content. 224 pt is 1:1 (sharpest text); higher values scale up.
- Height always auto-fits content via `requestFitResize()` → `window-resize` IPC → `floatWin.setSize()`. Width is user-controlled (drag corner: 224–820 pt).
- `backgroundThrottling: false` on both windows — Chromium otherwise throttles timers in transparent/hidden windows, causing the countdown to stop ticking.
- macOS frameless windows have invisible native edge-resize zones that can set arbitrary heights. A debounced `window resize` listener fires `requestFitResize` 150 ms after any native resize to snap height back to content.

### Sparkline / history
- The sparkline SVG is built entirely with `document.createElementNS` — no `innerHTML` on user data.
- Burn rate uses linear regression over a sliding window: 45 min for SESSION, 12 h for weekly bars. The window is segmented at resets (> 15 pt drops) so only the current session's slope contributes.
- The "no usage" cutoff (`minMeaningfulRate()`) is scaled to each bar's own reset period, not a flat number — the same real activity level produces a ~33x smaller %/h slope over a 7-day weekly cycle than over Session's 5-hour one, so a fixed Session-tuned cutoff was misreporting real, steadily-climbing weekly usage as "no usage".
- The history status line also shows a pace multiplier: current rate vs. the rate that would exactly exhaust the limit by reset.
- `loadHistory()` validates the on-disk shape (must be a plain object of arrays of `[number, number]` pairs) rather than trusting it — a malformed file used to throw inside the `usage:update` handler and silently kill every future widget update. `flushHistory()` runs on `before-quit` since the normal 5s debounced save gets cancelled by app exit.
- `lastUsageData` in `main.js` is replayed to `floatWin` in `sendConfigToWidget()` to fix the race where the scraper's first poll completes before the widget registers its IPC listeners.

### IPC security
All `ipcMain` handlers verify `event.sender` matches the expected window (`floatWin.webContents` or `scraperWin.webContents`) before acting.

### Self-updater
- `fetchJSON`/`downloadFile` follow all of 301/302/303/307/308 (`REDIRECT_CODES`), and resolve a relative `Location` header against the request URL (`resolveRedirect()`) rather than assuming it's absolute.
- `semverGt()` parses off a `-prerelease` suffix (`parseVersion()`) before the numeric compare — treating it as part of the numeric string used to make e.g. `2.1.0-beta` read as version `0`.

### Dock icon
`LSUIElement = true` is set in `Info.plist` via `scripts/after-pack.js`. `app.dock.hide()` is called at every lifecycle point (will-finish-launching, whenReady, activate, and 1 s after launch for macOS 16's bounce animation).
