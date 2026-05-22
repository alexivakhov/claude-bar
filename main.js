const { app, BrowserWindow, screen, ipcMain, session, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

let floatWin;
let scraperWin;
let tray;
let isLoggedIn = false;
let wasOnAuthPage = false;
let preventAutoLogin = false;
let cookiePath;

const AUTH_PATTERNS = ['/login', '/auth', 'accounts.google'];

// In-memory (no 'persist:' prefix) = no LevelDB files, no lock conflicts between restarts.
// Cookies are persisted manually via claude-cookies.json.
const SCRAPER_PARTITION = 'scraper-temp';
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
  app.dock.hide(); // no Dock icon — lives only in the menu bar status area
  cookiePath = path.join(app.getPath('userData'), 'claude-cookies.json');
  createTray();
  createFloatWindow();
  await createScraper();
});

// Don't quit when all windows are closed — the tray icon keeps the app alive.
// The only exit path is Tray → "Quit Claude Bar".
app.on('window-all-closed', () => { /* intentionally empty */ });

app.on('activate', () => {
  if (floatWin && !floatWin.isDestroyed() && !floatWin.isVisible()) floatWin.show();
});
