# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # first time only
npm start            # dev mode — opens Electron directly (hot-ish: restart after main.js changes)
npm run pack -- --arm64   # build arm64 app bundle in dist/mac-arm64/ (faster, no DMG)
npm run dist         # build distributable DMGs for arm64 + x64

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

## Architecture

Two `BrowserWindow` instances managed by `main.js`:

| Window | Visibility | Role |
|--------|-----------|------|
| `floatWin` | Transparent, frameless, always-on-top | Renders the widget (`index.html` + `renderer.js`) |
| `scraperWin` | Hidden (shown only for login) | Real Chromium session logged into `claude.ai` |

### Data flow

```
preload-scraper.js  poll() [configurable interval, default 2 min]
  → fetch /api/organizations              → org UUID + capabilities[] → plan name
  → fetch /api/organizations/{id}/usage   → usage JSON with utilization per bar
  → ipcRenderer.send('usage:update', data)
  → ipcMain (main.js)
      → recordUsage()      saves to usage-history.json (7-day retention)
      → updateTrayTitle()  sets tray % from Session (five_hour) bar only
      → checkUsageNotifications()  fires threshold / reset notifications
      → floatWin.webContents.send('usage-update', data)
      → floatWin.webContents.send('history-update', last48h)
  → renderer.js  render() / renderHistScreen()
```

### Key files

- **`main.js`** — main process: window lifecycle, IPC handlers, cookie persistence (encrypted via `safeStorage`), tray, notifications, self-updater, usage history storage
- **`preload-scraper.js`** — content script in `scraperWin`: polls `/api/organizations` + `/api/organizations/{id}/usage`, normalizes the response into `{ bars, planName, fetchedAt }`, sends results via IPC
- **`preload.js`** — context bridge for `floatWin`: exposes `window.claudeBar` (onUpdate, onError, onConfig, onHistoryUpdate, openLogin, refresh, resize, setPin, installUpdate)
- **`renderer.js`** — all UI logic: progress bars, countdown timer, usage history screen, sparkline SVG, burn-rate regression, theme cycling, resize handling
- **`index.html`** / **`style.css`** — widget markup and CSS custom-property theming

### Persistent storage (all under `app.getPath('userData')`)

| File | Content |
|------|---------|
| `claude-cookies.json` | Session cookies, AES-encrypted via `safeStorage` (base64) |
| `settings.json` | Poll interval, notification toggles |
| `usage-history.json` | `{ barKey: [[ts_ms, utilization], …] }`, 7-day retention |

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

### Window / resize
- `body.style.zoom = window.innerWidth / BASE_W` (BASE_W = 224) scales all content. 224 pt is 1:1 (sharpest text); higher values scale up.
- Height always auto-fits content via `requestFitResize()` → `window-resize` IPC → `floatWin.setSize()`. Width is user-controlled (drag corner: 224–820 pt).
- `backgroundThrottling: false` on both windows — Chromium otherwise throttles timers in transparent/hidden windows, causing the countdown to stop ticking.
- macOS frameless windows have invisible native edge-resize zones that can set arbitrary heights. A debounced `window resize` listener fires `requestFitResize` 150 ms after any native resize to snap height back to content.

### Sparkline / history
- The sparkline SVG is built entirely with `document.createElementNS` — no `innerHTML` on user data.
- Burn rate uses linear regression over a sliding window: 45 min for SESSION, 12 h for weekly bars. The window is segmented at resets (> 15 pt drops) so only the current session's slope contributes.
- `lastUsageData` in `main.js` is replayed to `floatWin` in `sendConfigToWidget()` to fix the race where the scraper's first poll completes before the widget registers its IPC listeners.

### IPC security
All `ipcMain` handlers verify `event.sender` matches the expected window (`floatWin.webContents` or `scraperWin.webContents`) before acting.

### Dock icon
`LSUIElement = true` is set in `Info.plist` via `scripts/after-pack.js`. `app.dock.hide()` is called at every lifecycle point (will-finish-launching, whenReady, activate, and 1 s after launch for macOS 16's bounce animation).
