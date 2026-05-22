const { app, BrowserWindow, screen, ipcMain, session, Tray, Menu, nativeImage, dialog } = require('electron');
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

// Hide Dock icon at every possible lifecycle point — app.dock.hide() may be
// ignored if called before the app is fully initialized on some macOS versions.
if (app.dock) app.dock.hide();
app.on('will-finish-launching', () => { if (app.dock) app.dock.hide(); });

const AUTH_PATTERNS = ['/login', '/auth', 'accounts.google'];

// In-memory (no 'persist:' prefix) = no LevelDB files, no lock conflicts between restarts.
// Cookies are persisted manually via claude-cookies.json.
const SCRAPER_PARTITION = 'scraper-temp';
const GITHUB_REPO = 'alexivakhov/claude-bar';
const scraperSession = () => session.fromPartition(SCRAPER_PARTITION);

async function saveCookies() {
  try {
    const cookies = await scraperSession().cookies.get({ url: 'https://claude.ai' });
    fs.writeFileSync(cookiePath, JSON.stringify(cookies, null, 2));
    console.log(`cookies saved: ${cookies.length}`);
  } catch (e) {
    console.error('saveCookies error:', e.message);
  }
}

async function restoreCookies() {
  if (!fs.existsSync(cookiePath)) return false;
  try {
    const cookies = JSON.parse(fs.readFileSync(cookiePath, 'utf8'));
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

// Spoof Chrome UA so Google OAuth doesn't reject the Electron embedded browser.
const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

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
  scraperWin.webContents.setWindowOpenHandler(() => ({
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
  }));

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
}

ipcMain.on('window-resize', (_, { w, h }) => {
  if (floatWin && !floatWin.isDestroyed()) {
    floatWin.setSize(
      Math.round(Math.max(180, Math.min(500, w))),
      Math.round(Math.max(100, Math.min(600, h)))
    );
  }
});

ipcMain.on('pin-toggle', (_, pinned) => {
  if (floatWin && !floatWin.isDestroyed()) {
    floatWin.setAlwaysOnTop(pinned);
  }
});

ipcMain.on('usage:update', async (_, data) => {
  await saveCookies();
  if (floatWin && !floatWin.isDestroyed()) {
    floatWin.webContents.send('usage-update', data);
  }
});

ipcMain.on('usage:error', async (_, err) => {
  console.log('usage error:', err.message);
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

ipcMain.on('open-login', async () => {
  if (scraperWin && !scraperWin.isDestroyed()) {
    await logout();
    if (floatWin && !floatWin.isDestroyed()) {
      floatWin.webContents.send('usage-update', { bars: [] });
    }
    scraperWin.loadURL('https://claude.ai/login');
    scraperWin.show();
    scraperWin.focus();
  }
});

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'claude-bar-updater', 'Accept': 'application/vnd.github.v3+json' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchJSON(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    function get(u) {
      https.get(u, { headers: { 'User-Agent': 'claude-bar-updater' } }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) return get(res.headers.location);
        const file = fs.createWriteStream(destPath);
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
        file.on('error', (e) => { fs.unlink(destPath, () => {}); reject(e); });
      }).on('error', reject);
    }
    get(url);
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

    const asset = release.assets.find(a => a.name.includes('arm64') && a.name.endsWith('.dmg'));
    if (!asset) {
      await dialog.showMessageBox(floatWin, {
        type: 'warning',
        message: `${release.tag_name} is available but no arm64 DMG asset found in this release.`,
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

    const dmgPath = path.join(os.tmpdir(), asset.name);
    tray.setToolTip('Claude Bar — downloading…');
    await downloadFile(asset.browser_download_url, dmgPath);
    tray.setToolTip('Claude Bar');

    const scriptPath = path.join(os.tmpdir(), 'claude-bar-update.sh');
    fs.writeFileSync(scriptPath, [
      '#!/bin/bash',
      'sleep 1',
      `hdiutil attach -nobrowse -quiet "${dmgPath}" -mountpoint /tmp/claude-bar-mnt`,
      'ditto "/tmp/claude-bar-mnt/Claude Bar.app" "/Applications/Claude Bar.app"',
      'hdiutil detach /tmp/claude-bar-mnt -quiet',
      'xattr -r -d com.apple.quarantine "/Applications/Claude Bar.app" 2>/dev/null || true',
      'touch "/Applications/Claude Bar.app"',
      '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "/Applications/Claude Bar.app"',
      `rm -f "${dmgPath}"`,
      'rm -f "$0"',
      'open "/Applications/Claude Bar.app"',
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
      click: () => {
        if (scraperWin && !scraperWin.isDestroyed()) {
          scraperWin.webContents.send('open-login');
          // reuse existing open-login IPC path
          require('electron').ipcMain.emit('open-login', { sender: null });
        }
      }
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
});

// Don't quit when all windows are closed — the tray icon keeps the app alive.
// The only exit path is Tray → "Quit Claude Bar".
app.on('window-all-closed', () => { /* intentionally empty */ });

app.on('activate', () => {
  if (app.dock) app.dock.hide();
  if (floatWin && !floatWin.isDestroyed() && !floatWin.isVisible()) floatWin.show();
});
