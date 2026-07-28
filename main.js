const { app, BrowserWindow, screen, ipcMain, session, Tray, Menu, nativeImage, dialog, safeStorage, Notification, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const os = require('os');
const { spawn } = require('child_process');

let floatWin;
let scraperWin;
let tray;
let isLoggedIn = false;
let wasOnAuthPage = false;
let preventAutoLogin = false;
let cookiePath;

// Backoff state for did-fail-load retries
let failLoadRetryTimeout = null;
let failLoadRetryDelay = 30000; // start at 30s, double up to 5min

// Persisted user settings ({userData}/settings.json)
let settingsPath;
const settings = {
  pollIntervalMin: 2,
  notifyThresholds: true,
  notifySessionReset: true,
  // Usage-field keys we've already fired the one-time "new field detected"
  // notification for, so it doesn't repeat every poll (see checkUnknownKeys).
  notifiedUnknownKeys: [],
};

function loadSettings() {
  try {
    Object.assign(settings, JSON.parse(fs.readFileSync(settingsPath, 'utf8')));
  } catch {}
}

function saveSettings() {
  try {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  } catch (e) {
    console.error('saveSettings error:', e.message);
  }
}

// Usage history — [[timestamp_ms, utilization], ...] per bar key, 7-day retention
let historyData = {};
let historyPath;
let historySaveTimeout = null;
const HISTORY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const HISTORY_SEND_AGE_MS = 48 * 60 * 60 * 1000;

// A file that parses as JSON but holds the wrong shape used to throw deep
// inside trimHistory() — i.e. inside the usage:update handler, before the
// widget send — silently killing every future update. Validate on load and
// drop only the malformed keys.
function loadHistory() {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(historyPath, 'utf8')); } catch { return; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
  const clean = {};
  for (const [k, pts] of Object.entries(parsed)) {
    if (!Array.isArray(pts)) {
      console.warn(`loadHistory: dropping "${k}" — not an array`);
      continue;
    }
    const valid = pts.filter(p =>
      Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number');
    if (valid.length !== pts.length) {
      console.warn(`loadHistory: "${k}" — dropped ${pts.length - valid.length} malformed point(s)`);
    }
    if (valid.length) clean[k] = valid;
  }
  historyData = clean;
}

function trimHistory() {
  const cutoff = Date.now() - HISTORY_MAX_AGE_MS;
  for (const k of Object.keys(historyData)) {
    if (!Array.isArray(historyData[k])) { delete historyData[k]; continue; }
    historyData[k] = historyData[k].filter(p => p[0] > cutoff);
    if (!historyData[k].length) delete historyData[k];
  }
}

function writeHistoryNow() {
  try { fs.writeFileSync(historyPath, JSON.stringify(historyData)); }
  catch (e) { console.error('saveHistory error:', e.message); }
}

function saveHistory() {
  if (historySaveTimeout) return;
  historySaveTimeout = setTimeout(() => {
    historySaveTimeout = null;
    writeHistoryNow();
  }, 5000);
}

// Quit cancels the 5s debounce, so the newest points would be lost — write
// them out synchronously before the app exits.
function flushHistory() {
  if (!historySaveTimeout) return;
  clearTimeout(historySaveTimeout);
  historySaveTimeout = null;
  writeHistoryNow();
}

function recordUsage(data) {
  if (!Array.isArray(data.bars)) return;
  const ts = Date.now();
  for (const bar of data.bars) {
    if (typeof bar.utilization !== 'number' || !Number.isFinite(bar.utilization)) continue;
    if (!Array.isArray(historyData[bar.key])) historyData[bar.key] = [];
    historyData[bar.key].push([ts, bar.utilization]);
  }
  trimHistory();
  saveHistory();
}

function getHistoryForWidget() {
  const cutoff = Date.now() - HISTORY_SEND_AGE_MS;
  const out = {};
  for (const [k, pts] of Object.entries(historyData)) {
    const slice = pts.filter(p => p[0] > cutoff);
    if (slice.length) out[k] = slice;
  }
  return out;
}

// Hide Dock icon at every possible lifecycle point — app.dock.hide() may be
// ignored if called before the app is fully initialized on some macOS versions.
if (app.dock) app.dock.hide();
app.on('will-finish-launching', () => { if (app.dock) app.dock.hide(); });

// Auth pages: claude.ai/login|auth or Google accounts. Parsed by hostname +
// pathname so substrings in query params (or look-alike hosts) can't match.
function isAuthUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.hostname === 'accounts.google.com') return true;
    return u.hostname === 'claude.ai' &&
      (u.pathname.startsWith('/login') || u.pathname.startsWith('/auth'));
  } catch {
    return false;
  }
}

// Exact-host check — startsWith('https://claude.ai') would also match
// https://claude.ai.evil.com and mark a hostile page as authenticated.
function isClaudeUrl(urlStr) {
  try {
    return new URL(urlStr).hostname === 'claude.ai';
  } catch {
    return false;
  }
}

// In-memory (no 'persist:' prefix) = no LevelDB files, no lock conflicts between restarts.
// Cookies are persisted manually via claude-cookies.json (encrypted with safeStorage).
const SCRAPER_PARTITION = 'scraper-temp';
const GITHUB_REPO = 'alexivakhov/claude-bar';
const scraperSession = () => session.fromPartition(SCRAPER_PARTITION);

// S1: Cookie encryption via safeStorage
async function saveCookies() {
  try {
    const cookies = await scraperSession().cookies.get({ url: 'https://claude.ai' });
    // B6: Never overwrite a good cookie file with an empty set
    if (cookies.length === 0) {
      console.log('saveCookies: skipping — no cookies to save');
      return;
    }
    const json = JSON.stringify(cookies, null, 2);
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(json);
      fs.writeFileSync(cookiePath, encrypted.toString('base64'));
    } else {
      console.warn('safeStorage unavailable — saving cookies as plaintext');
      fs.writeFileSync(cookiePath, json);
    }
    console.log(`cookies saved: ${cookies.length}`);
  } catch (e) {
    console.error('saveCookies error:', e.message);
  }
}

async function restoreCookies() {
  if (!fs.existsSync(cookiePath)) return false;
  try {
    let raw = fs.readFileSync(cookiePath);
    let jsonStr;
    // S1: Migration — if file starts with '[' it's plaintext legacy format
    const strHead = raw.slice(0, 1).toString();
    if (strHead === '[') {
      console.log('restoreCookies: migrating plaintext cookies to encrypted storage');
      jsonStr = raw.toString('utf8');
      // Re-save immediately as encrypted
      const cookies = JSON.parse(jsonStr);
      if (Array.isArray(cookies) && cookies.length > 0) {
        if (safeStorage.isEncryptionAvailable()) {
          const encrypted = safeStorage.encryptString(jsonStr);
          fs.writeFileSync(cookiePath, encrypted.toString('base64'));
        }
      }
    } else {
      // Encrypted base64
      if (!safeStorage.isEncryptionAvailable()) {
        console.warn('safeStorage unavailable — cannot decrypt cookies');
        return false;
      }
      const buf = Buffer.from(raw.toString(), 'base64');
      jsonStr = safeStorage.decryptString(buf);
    }

    const cookies = JSON.parse(jsonStr);
    if (!Array.isArray(cookies) || cookies.length === 0) return false;
    // Each cookie is set independently: Chromium rejects some individually
    // (e.g. a __Host- prefixed cookie carrying a `domain`), and one rejection
    // must not abandon the rest of an otherwise valid session.
    let restored = 0;
    for (const c of cookies) {
      const entry = {
        url: 'https://claude.ai',
        name: c.name,
        value: c.value,
        path: c.path || '/',
        secure: c.secure,
        httpOnly: c.httpOnly,
      };
      if (c.domain && !c.name.startsWith('__Host-')) entry.domain = c.domain;
      if (c.expirationDate) entry.expirationDate = c.expirationDate;
      if (['unspecified', 'no_restriction', 'lax', 'strict'].includes(c.sameSite)) {
        entry.sameSite = c.sameSite;
      }
      try {
        await scraperSession().cookies.set(entry);
        restored++;
      } catch (e) {
        console.warn(`restoreCookies: skipped "${c.name}" — ${e.message}`);
      }
    }
    console.log(`cookies restored: ${restored}/${cookies.length}`);
    return restored > 0;
  } catch (e) {
    console.error('restoreCookies error:', e.message);
    return false;
  }
}

function clearCookies() {
  try { fs.unlinkSync(cookiePath); } catch {}
}

async function logout() {
  clearCookies();
  isLoggedIn = false;
  wasOnAuthPage = false;
  preventAutoLogin = true;
  try {
    await scraperSession().clearStorageData();
    console.log('full session storage cleared');
  } catch (e) {
    console.error('logout error:', e.message);
  }
}

// B4: Named openLogin function called from both ipcMain handler and tray menu item
async function openLogin() {
  if (scraperWin && !scraperWin.isDestroyed()) {
    await logout();
    updateTrayTitle(null);
    if (floatWin && !floatWin.isDestroyed()) {
      floatWin.webContents.send('usage-update', { bars: [] });
    }
    scraperWin.loadURL('https://claude.ai/login');
    scraperWin.show();
    scraperWin.focus();
  }
}

// Spoof Chrome UA so Google OAuth doesn't reject the Electron embedded browser.
// Chrome version must match the bundled Chromium — a mismatch between the UA
// string and the real TLS/JS fingerprint triggers Cloudflare bot challenges.
const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  `AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome.split('.')[0]}.0.0.0 Safari/537.36`;

// S4: Allowed OAuth popup hosts
const ALLOWED_POPUP_HOSTS = [
  'claude.ai',
  'accounts.google.com',
  'google.com',
  'appleid.apple.com',
  'apple.com',
];

function isAllowedPopupHost(urlStr) {
  try {
    const host = new URL(urlStr).hostname;
    return ALLOWED_POPUP_HOSTS.some(allowed =>
      host === allowed || host.endsWith('.' + allowed)
    );
  } catch {
    return false;
  }
}

async function createScraper() {
  scraperWin = new BrowserWindow({
    width: 480,
    height: 680,
    show: false,
    title: 'Claude — log in here',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload-scraper.js'),
      partition: SCRAPER_PARTITION,
      // Hidden window — don't let Chromium throttle the 2-min poll timer.
      backgroundThrottling: false,
    }
  });

  scraperWin.webContents.setUserAgent(CHROME_UA);

  await restoreCookies();
  scraperWin.loadURL('https://claude.ai/new');

  // OAuth popups (Google/Apple login): must share the same partition so
  // auth cookies land in scraper-temp, not in a separate default session.
  // S4: Only allow popups from trusted OAuth hosts. Applied to the scraper
  // window AND to every popup it spawns — without it, pages inside a popup
  // could open unfiltered windows.
  const oauthPopupHandler = ({ url, frameName, disposition }) => {
    console.log(`popup request: url=${url || '(empty)'} frame=${frameName} disposition=${disposition}`);
    if (!isAllowedPopupHost(url)) {
      console.warn('setWindowOpenHandler: denied popup for', url);
      return { action: 'deny' };
    }
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: 480,
        height: 640,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          partition: SCRAPER_PARTITION,
        }
      }
    };
  };
  scraperWin.webContents.setWindowOpenHandler(oauthPopupHandler);

  scraperWin.webContents.on('did-create-window', (popup, details) => {
    console.log('popup created:', details && details.url);
    popup.webContents.setUserAgent(CHROME_UA);
    popup.webContents.setWindowOpenHandler(oauthPopupHandler);
    popup.webContents.on('did-navigate', (_, u) => console.log('popup navigate:', u));
    popup.once('closed', async () => {
      console.log('popup closed, preventAutoLogin =', preventAutoLogin);
      if (preventAutoLogin) return;
      // The opener page finishes the OAuth code exchange asynchronously after
      // the popup closes — reloading too early kills the in-flight request and
      // the session cookie is never set. Let the SPA complete login and
      // redirect itself; reload only as a fallback if still stuck on auth.
      await new Promise(r => setTimeout(r, 8000));
      if (!scraperWin || scraperWin.isDestroyed()) return;
      const cur = scraperWin.webContents.getURL();
      if (isAuthUrl(cur)) {
        console.log('still on auth page after popup close — reloading /new');
        scraperWin.loadURL('https://claude.ai/new');
      }
    });
  });

  scraperWin.webContents.on('did-navigate-in-page', async (_, url, isMainFrame) => {
    if (!isMainFrame) return;
    console.log('spa:', url);

    if (isAuthUrl(url)) {
      wasOnAuthPage = true;
      if (isLoggedIn) {
        isLoggedIn = false;
        clearCookies();
      }
      scraperWin.show();
      scraperWin.focus();
      return;
    }

    // SPA redirect away from auth page = login completed
    if (wasOnAuthPage && !isLoggedIn) {
      wasOnAuthPage = false;
      preventAutoLogin = false;
      isLoggedIn = true;
      await saveCookies();
      scraperWin.hide();
      scraperWin.webContents.executeJavaScript('window.usageApi && window.usageApi.poll()').catch(() => {});
    }
  });

  scraperWin.webContents.on('did-navigate', (_, url) => {
    console.log('navigate:', url);
  });

  scraperWin.webContents.on('did-finish-load', async () => {
    const url = scraperWin.webContents.getURL();
    console.log('loaded:', url);

    // B7a: Reset backoff on successful load
    failLoadRetryDelay = 30000;
    if (failLoadRetryTimeout) {
      clearTimeout(failLoadRetryTimeout);
      failLoadRetryTimeout = null;
    }

    if (isAuthUrl(url)) {
      wasOnAuthPage = true;
      if (isLoggedIn) {
        isLoggedIn = false;
        clearCookies();
      }
      scraperWin.show();
      scraperWin.focus();
      return;
    }

    // B6: Only treat as authenticated if we're actually on claude.ai (not error/cloudflare pages)
    if (!isClaudeUrl(url)) {
      console.log('did-finish-load: non-claude.ai URL, ignoring:', url);
      return;
    }

    // Authenticated page (reached via full navigation after popup close).
    const justLoggedIn = wasOnAuthPage && !isLoggedIn;
    wasOnAuthPage = false;
    if (!isLoggedIn) {
      isLoggedIn = true;
      preventAutoLogin = false;
      await saveCookies();
    }
    scraperWin.hide();
    if (justLoggedIn) {
      scraperWin.webContents.executeJavaScript('window.usageApi && window.usageApi.poll()').catch(() => {});
    }
  });

  // B7a: Handle load failures with exponential backoff retry
  scraperWin.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    // -3 = ABORTED (navigations cancelled intentionally), ignore
    if (errorCode === -3) return;
    console.warn(`did-fail-load: ${errorCode} ${errorDescription} for ${validatedURL}`);

    if (failLoadRetryTimeout) clearTimeout(failLoadRetryTimeout);
    const delay = failLoadRetryDelay;
    failLoadRetryDelay = Math.min(failLoadRetryDelay * 2, 5 * 60 * 1000); // max 5min
    console.log(`Retrying load in ${delay / 1000}s`);
    failLoadRetryTimeout = setTimeout(() => {
      failLoadRetryTimeout = null;
      if (scraperWin && !scraperWin.isDestroyed()) {
        scraperWin.loadURL('https://claude.ai/new');
      }
    }, delay);
  });
}

// S6: Validate IPC senders
// Resize range: width 224 (the design's 1:1 scale) to 820, height follows
// content (capped at 640 so the history screen fits at max width)
const WIN_MIN_W = 224, WIN_MAX_W = 820;
const WIN_MIN_H = 100, WIN_MAX_H = 640;

ipcMain.on('window-resize', (event, { w, h }) => {
  if (!floatWin || floatWin.isDestroyed()) return;
  if (event.sender !== floatWin.webContents) {
    console.warn('window-resize: ignored from unexpected sender');
    return;
  }
  floatWin.setSize(
    Math.round(Math.max(WIN_MIN_W, Math.min(WIN_MAX_W, w))),
    Math.round(Math.max(WIN_MIN_H, Math.min(WIN_MAX_H, h)))
  );
});

ipcMain.on('pin-toggle', (event, pinned) => {
  if (!floatWin || floatWin.isDestroyed()) return;
  if (event.sender !== floatWin.webContents) {
    console.warn('pin-toggle: ignored from unexpected sender');
    return;
  }
  floatWin.setAlwaysOnTop(pinned);
});

// Feature 1: utilization % in the menubar next to the tray icon.
// Shows the Session (five_hour) bar only — showing whichever bucket was
// closest to its cap (weekly, credits) made the number ambiguous, since
// there was nothing next to it clarifying which bucket it referred to
// beyond a one-letter prefix that was easy to miss at a glance.
function updateTrayTitle(data) {
  if (!tray) return;
  if (!data || !Array.isArray(data.bars) || data.bars.length === 0) {
    tray.setTitle('');
    return;
  }
  const sessionBar = data.bars.find(b => b.key === 'five_hour') || data.bars[0];
  tray.setTitle(` ${Math.round(sessionBar.utilization)}%`, { fontType: 'monospacedDigit' });
}

// Feature 2: system notifications on threshold crossings and session reset.
const NOTIFY_THRESHOLDS = [80, 95];
const prevUtilization = {}; // bar key -> last seen utilization
function checkUsageNotifications(data) {
  if (!Array.isArray(data.bars)) return;
  for (const bar of data.bars) {
    const prev = prevUtilization[bar.key];
    if (prev !== undefined && Notification.isSupported()) {
      if (settings.notifyThresholds) {
        for (const t of NOTIFY_THRESHOLDS) {
          if (prev < t && bar.utilization >= t) {
            new Notification({
              title: `Claude Bar — ${bar.label}`,
              body: `Usage reached ${Math.round(bar.utilization)}% (threshold ${t}%)`,
            }).show();
            break; // one notification per bar per poll is enough
          }
        }
      }
      // Session reset: utilization dropped from high back to near zero
      if (settings.notifySessionReset && bar.key === 'five_hour' &&
          prev >= 50 && bar.utilization < 10) {
        new Notification({
          title: 'Claude Bar',
          body: 'Session limit reset — you can work again.',
        }).show();
      }
    }
    prevUtilization[bar.key] = bar.utilization;
  }

  // Usage credits (spend cap) — same threshold policy as the % bars, plus a
  // one-off when the account-level spend limit is actually hit (a distinct
  // condition from crossing 95%, since the cap can be raised/lowered
  // independent of the running total).
  if (data.credits && data.credits.enabled && Notification.isSupported()) {
    const pct = data.credits.percent;
    const prevPct = prevUtilization.__credits;
    if (typeof pct === 'number' && prevPct !== undefined && settings.notifyThresholds) {
      for (const t of NOTIFY_THRESHOLDS) {
        if (prevPct < t && pct >= t) {
          new Notification({
            title: 'Claude Bar — Usage Credits',
            body: `Spend reached ${Math.round(pct)}% of your monthly cap (threshold ${t}%)`,
          }).show();
          break;
        }
      }
    }
    if (typeof pct === 'number') prevUtilization.__credits = pct;

    const wasReached = prevUtilization.__spendLimitReached;
    if (data.credits.spendLimitReached && !wasReached) {
      new Notification({
        title: 'Claude Bar — Usage Credits',
        body: 'Spend limit reached — extra usage is paused until it resets or you raise the cap.',
      }).show();
    }
    prevUtilization.__spendLimitReached = data.credits.spendLimitReached;
  }
}

// New, previously-unseen top-level usage fields (see collectUnknownKeys in
// preload-scraper.js) get a one-time notification instead of vanishing
// silently — persisted so it doesn't repeat on every poll.
function checkUnknownKeys(data) {
  if (!Array.isArray(data.unknownKeys) || data.unknownKeys.length === 0) return;
  const newOnes = data.unknownKeys.filter(k => !settings.notifiedUnknownKeys.includes(k));
  if (newOnes.length === 0) return;
  settings.notifiedUnknownKeys.push(...newOnes);
  saveSettings();
  if (Notification.isSupported()) {
    new Notification({
      title: 'Claude Bar',
      body: `New usage field(s) from the API: ${newOnes.join(', ')} — check tray → Copy Raw Usage JSON`,
    }).show();
  }
}

// Last usage payload — replayed to the widget on did-finish-load, because the
// scraper's first poll often completes before the widget registers listeners.
let lastUsageData = null;
// Unnormalized org + usage JSON from the last poll, for the "Copy Raw Usage
// JSON" debug menu item — lets us see real key/capability names the API
// adds (new weekly buckets, plan capabilities) without a code change first.
let lastRawUsageData = null;

ipcMain.on('usage:update', async (event, data) => {
  if (!scraperWin || scraperWin.isDestroyed() || event.sender !== scraperWin.webContents) {
    console.warn('usage:update: ignored from unexpected sender');
    return;
  }
  lastRawUsageData = data.raw || null;
  delete data.raw;
  lastUsageData = data;
  await saveCookies();
  recordUsage(data);
  updateTrayTitle(data);
  checkUsageNotifications(data);
  checkUnknownKeys(data);
  if (floatWin && !floatWin.isDestroyed()) {
    floatWin.webContents.send('usage-update', data);
    floatWin.webContents.send('history-update', getHistoryForWidget());
  }
});

ipcMain.on('usage:error', async (event, err) => {
  if (!scraperWin || scraperWin.isDestroyed() || event.sender !== scraperWin.webContents) {
    console.warn('usage:error: ignored from unexpected sender');
    return;
  }
  console.log('usage error:', err.message);

  // B7b: Forward non-reauth errors to floatWin for stale indicator
  if (!err.reauth) {
    if (floatWin && !floatWin.isDestroyed()) {
      floatWin.webContents.send('usage-error', { message: err.message });
    }
  }

  if (err.reauth && isLoggedIn) {
    isLoggedIn = false;
    clearCookies();
    updateTrayTitle(null);
    if (floatWin && !floatWin.isDestroyed()) {
      floatWin.webContents.send('usage-update', { bars: [] });
    }
    if (scraperWin && !scraperWin.isDestroyed()) {
      scraperWin.loadURL('https://claude.ai/login');
      scraperWin.show();
      scraperWin.focus();
    }
  }
});

// B4: ipcMain handler uses named openLogin()
ipcMain.on('open-login', async () => {
  await openLogin();
});

// Feature 4: manual refresh from the widget
function triggerPoll() {
  if (scraperWin && !scraperWin.isDestroyed()) {
    scraperWin.webContents.executeJavaScript('window.usageApi && window.usageApi.poll()').catch(() => {});
  }
}

ipcMain.on('manual-refresh', (event) => {
  if (!floatWin || event.sender !== floatWin.webContents) return;
  triggerPoll();
});

// Feature 4: scraper preload asks for the configured poll interval on startup
ipcMain.handle('get-poll-interval', () => settings.pollIntervalMin * 60 * 1000);

function applyPollInterval(min) {
  settings.pollIntervalMin = min;
  saveSettings();
  if (scraperWin && !scraperWin.isDestroyed()) {
    scraperWin.webContents.send('poll-config', min * 60 * 1000);
  }
  sendConfigToWidget();
}

function sendConfigToWidget() {
  if (floatWin && !floatWin.isDestroyed()) {
    floatWin.webContents.send('config-update', { pollIntervalMin: settings.pollIntervalMin });
    floatWin.webContents.send('history-update', getHistoryForWidget());
    if (lastUsageData) floatWin.webContents.send('usage-update', lastUsageData);
  }
}

// Feature 5: clicking the in-widget update banner starts the normal update flow
ipcMain.on('install-update', (event) => {
  if (!floatWin || event.sender !== floatWin.webContents) return;
  checkForUpdates();
});

// GitHub answers asset downloads with 302 today, but 303/307/308 are all
// valid for the same hop and used to surface as a bare "HTTP 307".
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

// Location may legitimately be relative — resolve it against the URL we asked
// for, since https.get() only accepts an absolute URL.
function resolveRedirect(location, base) {
  try { return new URL(location, base).toString(); } catch { return null; }
}

// B3: fetchJSON with redirect limit, status check, and error body
function fetchJSON(url, redirectCount = 0) {
  const MAX_REDIRECTS = 5;
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'claude-bar-updater', 'Accept': 'application/vnd.github.v3+json' } }, (res) => {
      if (REDIRECT_CODES.has(res.statusCode)) {
        res.resume();
        if (redirectCount >= MAX_REDIRECTS) {
          return reject(new Error(`Too many redirects (${MAX_REDIRECTS}) fetching ${url}`));
        }
        if (!res.headers.location) {
          return reject(new Error(`Redirect with no Location header from ${url}`));
        }
        const next = resolveRedirect(res.headers.location, url);
        if (!next) {
          return reject(new Error(`Invalid redirect target "${res.headers.location}" from ${url}`));
        }
        return fetchJSON(next, redirectCount + 1).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          let detail = '';
          try { detail = JSON.parse(data).message || ''; } catch {}
          return reject(new Error(`HTTP ${res.statusCode}${detail ? ': ' + detail : ''}`));
        }
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

// B2: downloadFile with status check and response error handling
function downloadFile(url, destPath, redirectCount = 0) {
  const MAX_REDIRECTS = 10;
  return new Promise((resolve, reject) => {
    function get(u, depth) {
      https.get(u, { headers: { 'User-Agent': 'claude-bar-updater' } }, (res) => {
        if (REDIRECT_CODES.has(res.statusCode)) {
          res.resume();
          if (depth >= MAX_REDIRECTS) {
            return reject(new Error(`Too many redirects downloading ${u}`));
          }
          if (!res.headers.location) {
            return reject(new Error(`Redirect with no Location header from ${u}`));
          }
          const next = resolveRedirect(res.headers.location, u);
          if (!next) {
            return reject(new Error(`Invalid redirect target "${res.headers.location}" from ${u}`));
          }
          return get(next, depth + 1);
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          return reject(new Error(`Download failed: HTTP ${res.statusCode} from ${u}`));
        }
        const file = fs.createWriteStream(destPath);
        res.pipe(file);
        res.on('error', (e) => { file.destroy(); fs.unlink(destPath, () => {}); reject(e); });
        file.on('finish', () => file.close(resolve));
        file.on('error', (e) => { fs.unlink(destPath, () => {}); reject(e); });
      }).on('error', reject);
    }
    get(url, redirectCount);
  });
}

// Splits off pre-release/build suffixes before the numeric compare —
// Number('0-beta') is NaN, which used to make 2.1.0-beta read as 2.1.0 → 0
// and rank below 2.0.9.
function parseVersion(v) {
  const core = String(v).replace(/^v/, '').split('+')[0];
  const dash = core.indexOf('-');
  const nums = (dash === -1 ? core : core.slice(0, dash))
    .split('.')
    .map(n => parseInt(n, 10) || 0);
  return { nums, pre: dash === -1 ? null : core.slice(dash + 1) };
}

function semverGt(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if ((pa.nums[i] || 0) > (pb.nums[i] || 0)) return true;
    if ((pa.nums[i] || 0) < (pb.nums[i] || 0)) return false;
  }
  // Equal core versions: a final release outranks a pre-release of the same
  // version, so 2.0.0 offers an update to someone running 2.0.0-beta.
  return !pa.pre && !!pb.pre;
}

// S2: Sanitize asset names
function isSafeAssetName(name) {
  return /^[A-Za-z0-9._-]+$/.test(path.basename(name));
}

async function checkForUpdates() {
  tray.setToolTip('Claude Bar — checking…');
  try {
    const release = await fetchJSON(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`);
    tray.setToolTip('Claude Bar');

    if (!release.tag_name) {
      await dialog.showMessageBox(floatWin, { message: 'No releases found on GitHub.', buttons: ['OK'] });
      if (app.dock) app.dock.hide();
      return;
    }

    if (!semverGt(release.tag_name, app.getVersion())) {
      await dialog.showMessageBox(floatWin, {
        type: 'info',
        title: 'Claude Bar',
        message: `You're up to date! (${app.getVersion()})`,
        buttons: ['OK'],
      });
      if (app.dock) app.dock.hide();
      return;
    }

    // B1: Select asset matching process.arch (arm64 or x64)
    const arch = process.arch; // 'arm64' or 'x64'
    const asset = release.assets.find(a => a.name.includes(arch) && a.name.endsWith('.dmg'));
    if (!asset) {
      await dialog.showMessageBox(floatWin, {
        type: 'warning',
        message: `${release.tag_name} is available but no ${arch} DMG asset found in this release.`,
        buttons: ['OK'],
      });
      if (app.dock) app.dock.hide();
      return;
    }

    // S2: Validate asset name before using it in file paths
    const safeAssetName = path.basename(asset.name);
    if (!isSafeAssetName(safeAssetName)) {
      await dialog.showMessageBox(floatWin, {
        type: 'error',
        message: 'Update asset name contains unsafe characters — aborting.',
        buttons: ['OK'],
      });
      if (app.dock) app.dock.hide();
      return;
    }

    const { response } = await dialog.showMessageBox(floatWin, {
      type: 'info',
      title: 'Update Available',
      message: `Claude Bar ${release.tag_name} is available`,
      detail: `Installed: ${app.getVersion()}\n\nThe app will quit, install the update, and relaunch automatically.`,
      buttons: ['Install & Relaunch', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
    });
    if (app.dock) app.dock.hide();
    if (response !== 0) return;

    // S2: Use a private temp dir to avoid symlink-race attacks
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-bar-'));
    const dmgPath = path.join(tmpDir, safeAssetName);
    const scriptPath = path.join(tmpDir, 'update.sh');
    const logPath = path.join(tmpDir, 'update.log');
    const mntPath = path.join(tmpDir, 'mnt');

    tray.setToolTip('Claude Bar — downloading…');
    await downloadFile(asset.browser_download_url, dmgPath);
    tray.setToolTip('Claude Bar');

    fs.mkdirSync(mntPath, { recursive: true });
    fs.writeFileSync(scriptPath, [
      '#!/bin/bash',
      `exec > "${logPath}" 2>&1`,
      'echo "Update started at $(date)"',
      'sleep 2',
      `hdiutil detach "${mntPath}" -quiet 2>/dev/null || true`,
      `echo "Attaching: ${dmgPath}"`,
      `hdiutil attach -nobrowse "${dmgPath}" -mountpoint "${mntPath}"`,
      'echo "Mounted. Contents:"',
      `ls "${mntPath}/"`,
      'echo "Copying..."',
      `ditto "${mntPath}/Claude Bar.app" "/Applications/Claude Bar.app"`,
      'echo "Copy done, exit $?"',
      `hdiutil detach "${mntPath}" -quiet`,
      'xattr -r -d com.apple.quarantine "/Applications/Claude Bar.app" 2>/dev/null || true',
      'touch "/Applications/Claude Bar.app"',
      '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "/Applications/Claude Bar.app"',
      `rm -rf "${tmpDir}"`,
      'echo "Launching..."',
      'open "/Applications/Claude Bar.app"',
      'echo "Done."',
    ].join('\n'), { mode: 0o755 });

    const child = spawn('bash', [scriptPath], { detached: true, stdio: 'ignore' });
    child.unref();
    app.quit();

  } catch (e) {
    tray.setToolTip('Claude Bar');
    console.error('update check failed:', e.message);
    await dialog.showMessageBox(floatWin, {
      type: 'error',
      title: 'Claude Bar',
      message: 'Update check failed',
      detail: e.message,
      buttons: ['OK'],
    });
    if (app.dock) app.dock.hide();
  }
}

// Feature 5: silent daily update check — no dialogs, just a banner in the widget.
async function quietUpdateCheck() {
  try {
    const release = await fetchJSON(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`);
    if (release.tag_name && semverGt(release.tag_name, app.getVersion())) {
      console.log('quiet update check: update available', release.tag_name);
      if (floatWin && !floatWin.isDestroyed()) {
        floatWin.webContents.send('update-available', { version: release.tag_name });
      }
    }
  } catch (e) {
    console.log('quiet update check failed:', e.message);
  }
}

// Debug: copies the last poll's unnormalized org + usage JSON to the
// clipboard, so a new API field (bucket key, capability) can be inspected
// without attaching a debugger to the hidden scraper window.
function copyRawUsageJson() {
  const hasData = !!lastRawUsageData;
  clipboard.writeText(hasData
    ? JSON.stringify(lastRawUsageData, null, 2)
    : 'No usage data captured yet — wait for the next poll.');
  if (Notification.isSupported()) {
    new Notification({
      title: 'Claude Bar',
      body: hasData ? 'Raw usage JSON copied to clipboard.' : 'No usage data yet — try again shortly.',
    }).show();
  }
}

// Menu is rebuilt on demand so checkbox/radio states always reflect settings.
function buildTrayMenu() {
  const POLL_CHOICES = [1, 2, 5, 10];
  return Menu.buildFromTemplate([
    {
      label: 'Show / Hide',
      click: () => {
        if (floatWin && !floatWin.isDestroyed()) {
          floatWin.isVisible() ? floatWin.hide() : floatWin.show();
        }
      }
    },
    {
      label: 'Log in…',
      // B4: call openLogin() directly — no dead send, no emit hack
      click: () => openLogin(),
    },
    { type: 'separator' },
    {
      label: 'Refresh Interval',
      submenu: POLL_CHOICES.map(min => ({
        label: `${min} min`,
        type: 'radio',
        checked: settings.pollIntervalMin === min,
        click: () => applyPollInterval(min),
      })),
    },
    {
      label: 'Notify at 80% / 95%',
      type: 'checkbox',
      checked: settings.notifyThresholds,
      click: (item) => { settings.notifyThresholds = item.checked; saveSettings(); },
    },
    {
      label: 'Notify on Session Reset',
      type: 'checkbox',
      checked: settings.notifySessionReset,
      click: (item) => { settings.notifySessionReset = item.checked; saveSettings(); },
    },
    {
      // Feature 3: launch at login, toggleable
      label: 'Launch at Login',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    { type: 'separator' },
    { label: 'Copy Raw Usage JSON', click: () => copyRawUsageJson() },
    { label: 'Check for Updates…', click: () => checkForUpdates() },
    { type: 'separator' },
    { label: 'Quit Claude Bar', click: () => app.quit() },
  ]);
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'tray-icon.png'));
  icon.setTemplateImage(true); // macOS auto-colors (white/dark mode aware)
  tray = new Tray(icon);
  tray.setToolTip('Claude Bar');

  // left-click: toggle widget visibility
  tray.on('click', () => {
    if (floatWin && !floatWin.isDestroyed()) {
      floatWin.isVisible() ? floatWin.hide() : floatWin.show();
    }
  });
  // right-click: context menu (rebuilt each time so states are current)
  tray.on('right-click', () => tray.popUpContextMenu(buildTrayMenu()));
}

function createFloatWindow() {
  const { width: sw } = screen.getPrimaryDisplay().workAreaSize;
  floatWin = new BrowserWindow({
    width: WIN_MIN_W,
    height: 150,
    x: sw - WIN_MIN_W - 16,
    y: 16,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: false,
    resizable: true,
    minWidth: WIN_MIN_W,
    minHeight: WIN_MIN_H,
    maxWidth: WIN_MAX_W,
    maxHeight: WIN_MAX_H,
    hasShadow: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      // Transparent frameless windows can be treated as occluded by Chromium,
      // which throttles their timers — the live countdown stops ticking.
      backgroundThrottling: false,
    }
  });
  floatWin.loadFile('index.html');
  floatWin.webContents.on('console-message', (event, level, message) => {
    console.log('[widget]', event.message !== undefined ? event.message : message);
  });
  floatWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
}

app.whenReady().then(async () => {
  if (app.dock) app.dock.hide();
  cookiePath = path.join(app.getPath('userData'), 'claude-cookies.json');
  settingsPath = path.join(app.getPath('userData'), 'settings.json');
  historyPath = path.join(app.getPath('userData'), 'usage-history.json');
  loadSettings();
  loadHistory();
  createTray();
  createFloatWindow();
  floatWin.webContents.once('did-finish-load', sendConfigToWidget);
  await createScraper();
  // macOS 16 shows a launch-bounce icon even for LSUIElement apps and does
  // not auto-remove it. Re-hide after the launch animation window (~1s).
  setTimeout(() => { if (app.dock) app.dock.hide(); }, 1000);

  // Feature 5: check once shortly after launch, then daily
  setTimeout(quietUpdateCheck, 60 * 1000);
  setInterval(quietUpdateCheck, 24 * 60 * 60 * 1000);
});

app.on('before-quit', flushHistory);

// Don't quit when all windows are closed — the tray icon keeps the app alive.
// The only exit path is Tray → "Quit Claude Bar".
app.on('window-all-closed', () => { /* intentionally empty */ });

app.on('activate', () => {
  if (app.dock) app.dock.hide();
  if (floatWin && !floatWin.isDestroyed() && !floatWin.isVisible()) floatWin.show();
});
