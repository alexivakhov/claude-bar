const { app, BrowserWindow, screen, ipcMain, session, Tray, Menu, nativeImage, dialog, safeStorage } = require('electron');
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

// Hide Dock icon at every possible lifecycle point — app.dock.hide() may be
// ignored if called before the app is fully initialized on some macOS versions.
if (app.dock) app.dock.hide();
app.on('will-finish-launching', () => { if (app.dock) app.dock.hide(); });

const AUTH_PATTERNS = ['/login', '/auth', 'accounts.google'];

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
    for (const c of cookies) {
      const entry = {
        url: 'https://claude.ai',
        name: c.name,
        value: c.value,
        path: c.path || '/',
        secure: c.secure,
        httpOnly: c.httpOnly,
      };
      if (c.domain) entry.domain = c.domain;
      if (c.expirationDate) entry.expirationDate = c.expirationDate;
      if (['unspecified', 'no_restriction', 'lax', 'strict'].includes(c.sameSite)) {
        entry.sameSite = c.sameSite;
      }
      await scraperSession().cookies.set(entry);
    }
    console.log(`cookies restored: ${cookies.length}`);
    return true;
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
    if (floatWin && !floatWin.isDestroyed()) {
      floatWin.webContents.send('usage-update', { bars: [] });
    }
    scraperWin.loadURL('https://claude.ai/login');
    scraperWin.show();
    scraperWin.focus();
  }
}

// Spoof Chrome UA so Google OAuth doesn't reject the Electron embedded browser.
const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

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
    }
  });

  scraperWin.webContents.setUserAgent(CHROME_UA);

  await restoreCookies();
  scraperWin.loadURL('https://claude.ai/new');

  // OAuth popups (Google/Apple login): must share the same partition so
  // auth cookies land in scraper-temp, not in a separate default session.
  // S4: Only allow popups from trusted OAuth hosts.
  scraperWin.webContents.setWindowOpenHandler(({ url }) => {
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
  });

  scraperWin.webContents.on('did-create-window', (popup) => {
    popup.webContents.setUserAgent(CHROME_UA);
    popup.once('closed', async () => {
      if (!preventAutoLogin) {
        await new Promise(r => setTimeout(r, 500));
        scraperWin.loadURL('https://claude.ai/new');
      }
    });
  });

  scraperWin.webContents.on('did-navigate-in-page', async (_, url, isMainFrame) => {
    if (!isMainFrame) return;
    console.log('spa:', url);

    if (AUTH_PATTERNS.some(p => url.includes(p))) {
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

    if (AUTH_PATTERNS.some(p => url.includes(p))) {
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
    if (!url.startsWith('https://claude.ai')) {
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
ipcMain.on('window-resize', (event, { w, h }) => {
  if (!floatWin || floatWin.isDestroyed()) return;
  if (event.sender !== floatWin.webContents) {
    console.warn('window-resize: ignored from unexpected sender');
    return;
  }
  floatWin.setSize(
    Math.round(Math.max(180, Math.min(500, w))),
    // B8: clamp consistent with maxHeight 340
    Math.round(Math.max(100, Math.min(340, h)))
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

ipcMain.on('usage:update', async (event, data) => {
  if (!scraperWin || scraperWin.isDestroyed() || event.sender !== scraperWin.webContents) {
    console.warn('usage:update: ignored from unexpected sender');
    return;
  }
  await saveCookies();
  if (floatWin && !floatWin.isDestroyed()) {
    floatWin.webContents.send('usage-update', data);
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

// B3: fetchJSON with redirect limit, status check, and error body
function fetchJSON(url, redirectCount = 0) {
  const MAX_REDIRECTS = 5;
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'claude-bar-updater', 'Accept': 'application/vnd.github.v3+json' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        if (redirectCount >= MAX_REDIRECTS) {
          res.resume();
          return reject(new Error(`Too many redirects (${MAX_REDIRECTS}) fetching ${url}`));
        }
        if (!res.headers.location) {
          res.resume();
          return reject(new Error(`Redirect with no Location header from ${url}`));
        }
        return fetchJSON(res.headers.location, redirectCount + 1).then(resolve).catch(reject);
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
        if (res.statusCode === 301 || res.statusCode === 302) {
          if (depth >= MAX_REDIRECTS) {
            res.resume();
            return reject(new Error(`Too many redirects downloading ${u}`));
          }
          if (!res.headers.location) {
            res.resume();
            return reject(new Error(`Redirect with no Location header from ${u}`));
          }
          return get(res.headers.location, depth + 1);
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

function semverGt(a, b) {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
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

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'tray-icon.png'));
  icon.setTemplateImage(true); // macOS auto-colors (white/dark mode aware)
  tray = new Tray(icon);
  tray.setToolTip('Claude Bar');

  const menu = Menu.buildFromTemplate([
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
    { label: 'Check for Updates…', click: () => checkForUpdates() },
    { type: 'separator' },
    { label: 'Quit Claude Bar', click: () => app.quit() },
  ]);

  // left-click: toggle widget visibility
  tray.on('click', () => {
    if (floatWin && !floatWin.isDestroyed()) {
      floatWin.isVisible() ? floatWin.hide() : floatWin.show();
    }
  });
  // right-click: context menu
  tray.on('right-click', () => tray.popUpContextMenu(menu));
}

function createFloatWindow() {
  const { width: sw } = screen.getPrimaryDisplay().workAreaSize;
  floatWin = new BrowserWindow({
    width: 224,
    height: 150,
    x: sw - 240,
    y: 16,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: false,
    resizable: true,
    minWidth: 180,
    minHeight: 120,
    maxWidth: 500,
    maxHeight: 340,
    hasShadow: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  floatWin.loadFile('index.html');
  floatWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
}

app.whenReady().then(async () => {
  if (app.dock) app.dock.hide();
  cookiePath = path.join(app.getPath('userData'), 'claude-cookies.json');
  createTray();
  createFloatWindow();
  await createScraper();
  // macOS 16 shows a launch-bounce icon even for LSUIElement apps and does
  // not auto-remove it. Re-hide after the launch animation window (~1s).
  setTimeout(() => { if (app.dock) app.dock.hide(); }, 1000);
});

// Don't quit when all windows are closed — the tray icon keeps the app alive.
// The only exit path is Tray → "Quit Claude Bar".
app.on('window-all-closed', () => { /* intentionally empty */ });

app.on('activate', () => {
  if (app.dock) app.dock.hide();
  if (floatWin && !floatWin.isDestroyed() && !floatWin.isVisible()) floatWin.show();
});
