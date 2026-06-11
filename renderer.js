const THEMES = ['dark', 'light', 'mauve'];

function applyTheme(name) {
  document.documentElement.dataset.theme = name;
  localStorage.setItem('claude-bar-theme', name);
}

function cycleTheme() {
  const cur = document.documentElement.dataset.theme || 'dark';
  applyTheme(THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length]);
}

(function () {
  const saved = localStorage.getItem('claude-bar-theme');
  if (saved && THEMES.includes(saved)) document.documentElement.dataset.theme = saved;
})();

(function () {
  const pinned = localStorage.getItem('claude-bar-pin') !== 'false';
  document.getElementById('pinBtn').textContent = pinned ? '⊤' : '⊥';
  window.claudeBar.setPin(pinned);
})();

function togglePin() {
  const pinned = localStorage.getItem('claude-bar-pin') !== 'false';
  const next = !pinned;
  localStorage.setItem('claude-bar-pin', String(next));
  document.getElementById('pinBtn').textContent = next ? '⊤' : '⊥';
  window.claudeBar.setPin(next);
}

function colorClass(mins) {
  if (mins === null || mins === undefined) return '';
  if (mins <= 15) return 'crit';
  if (mins <= 45) return 'warn';
  return '';
}

function barColor(pct) {
  if (pct >= 80) return 'crit';
  if (pct >= 35) return 'warn';
  return '';
}

function fmt(mins) {
  if (mins === null || mins === undefined) return '--:--';
  if (mins <= 0) return '0:00';
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}` : `0:${String(m).padStart(2, '0')}`;
}

// B9a: show hours when >= 60 min ("1h 5min ago" style)
function timeAgo(ts) {
  if (!ts) return '—';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `last updated ${s}s ago`;
  const totalMin = Math.round(s / 60);
  if (totalMin < 60) return `last updated ${totalMin}min ago`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m > 0 ? `last updated ${h}h ${m}min ago` : `last updated ${h}h ago`;
}

const RESET_LABEL_MAP = {
  seven_day: 'All',
  seven_day_sonnet: 'Snt',
  seven_day_opus: 'Ops',
  seven_day_omelette: 'Dsgn',
  seven_day_cowork: 'Cwk',
  seven_day_oauth_apps: 'Auth',
};

function fmtResetTime(resetsAt) {
  if (!resetsAt) return null;
  const d = new Date(resetsAt);
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${day},${hh}:${mm}`;
}

function fmtDuration(ms) {
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m}min`;
  return `${m}min`;
}

let lastTs = null;
// B5: Store last received data so we can recompute timer locally
let lastData = null;
// B7b: Track if we're in error/stale state
let isStale = false;
// Poll interval (minutes), pushed from main via config-update
let pollIntervalMin = 2;

// B8: Request window resize based on actual content height
function requestFitResize() {
  const zoom = window.innerWidth / BASE_W;
  const contentH = document.body.scrollHeight;
  const desired = Math.round(contentH * zoom);
  window.claudeBar.resize(window.innerWidth, desired);
}

// B5: Update just the timer and its color classes from resetsAt without re-rendering bars
function updateTimerFromResetsAt() {
  if (!lastData || !lastData.bars || lastData.bars.length === 0) return;
  const timer = document.getElementById('timer');
  const dot = document.getElementById('dot');
  const sessionBar = lastData.bars.find(b => b.key === 'five_hour') || lastData.bars[0];
  if (!sessionBar || sessionBar.resetsAt === null || sessionBar.resetsAt === undefined) return;

  const msLeft = Math.max(0, new Date(sessionBar.resetsAt).getTime() - Date.now());
  const resetMins = Math.round(msLeft / 60000);
  const tc = colorClass(resetMins);
  dot.className = 'dot' + (tc ? ' ' + tc : ' ok');
  timer.textContent = fmt(resetMins);
  timer.className = 'timer' + (tc ? ' ' + tc : '');

  // Also refresh the tooltip durations in bar rows (walk DOM)
  const barsEl = document.getElementById('bars');
  const rows = barsEl.querySelectorAll('.bar-row');
  rows.forEach((row, i) => {
    const bar = lastData.bars[i];
    if (!bar) return;
    const msLeft2 = bar.resetsAt
      ? Math.max(0, new Date(bar.resetsAt).getTime() - Date.now())
      : null;
    row.title = msLeft2 !== null
      ? `${bar.label} — resets in ${fmtDuration(msLeft2)}`
      : bar.label;
  });
}

// S5: Build a bar row with DOM nodes (no innerHTML for dynamic strings)
function buildBarRow(bar) {
  const msLeft = bar.resetsAt
    ? Math.max(0, new Date(bar.resetsAt).getTime() - Date.now())
    : null;
  const tooltip = msLeft !== null
    ? `${bar.label} — resets in ${fmtDuration(msLeft)}`
    : bar.label;

  const row = document.createElement('div');
  row.className = 'bar-row';
  row.title = tooltip; // title property = safe, no injection

  const nameSpan = document.createElement('span');
  nameSpan.className = 'bar-name';
  nameSpan.textContent = bar.shortLabel; // textContent = safe

  const track = document.createElement('div');
  track.className = 'track';

  const fill = document.createElement('div');
  const cls = barColor(bar.utilization);
  fill.className = 'fill' + (cls ? ' ' + cls : '');
  fill.style.width = bar.utilization + '%';

  track.appendChild(fill);

  const pct = document.createElement('span');
  pct.className = 'pct';
  pct.textContent = Math.round(bar.utilization) + '%'; // safe number

  row.appendChild(nameSpan);
  row.appendChild(track);
  row.appendChild(pct);
  return row;
}

function render(data) {
  const dot = document.getElementById('dot');
  const timer = document.getElementById('timer');
  const barsEl = document.getElementById('bars');
  const updated = document.getElementById('updated');
  const loginBtn = document.getElementById('loginBtn');

  const planLabel = document.getElementById('planLabel');
  const resetTimesEl = document.getElementById('resetTimes');

  // Clear stale indicator on fresh render
  isStale = false;

  if (!data || !data.bars || data.bars.length === 0) {
    lastData = null;
    timer.textContent = '--:--';
    timer.className = 'timer';
    if (planLabel) planLabel.textContent = data?.planName || '';
    if (resetTimesEl) resetTimesEl.textContent = '';

    if (data?.noUsagePage) {
      lastTs = data.fetchedAt;
      dot.className = 'dot';
      barsEl.innerHTML = '<div class="no-data">No usage limits<br>on this plan</div>';
      updated.textContent = '';
      loginBtn.textContent = '↗ log out';
    } else {
      lastTs = null;
      dot.className = 'dot load';
      barsEl.innerHTML = '<div class="no-data">loading...</div>';
      updated.textContent = `refreshing every ${pollIntervalMin}min`;
      loginBtn.textContent = '↗ log in';
    }
    requestFitResize();
    return;
  }

  lastData = data;
  loginBtn.textContent = '↗ log out';
  lastTs = data.fetchedAt;

  const sessionBar = data.bars.find(b => b.key === 'five_hour') || data.bars[0];
  // B5: compute from resetsAt (absolute time) rather than stale msUntilReset
  const msLeft = sessionBar && sessionBar.resetsAt
    ? Math.max(0, new Date(sessionBar.resetsAt).getTime() - Date.now())
    : null;
  const resetMins = msLeft !== null ? Math.round(msLeft / 60000) : null;

  const tc = colorClass(resetMins);
  dot.className = 'dot' + (tc ? ' ' + tc : ' ok');
  timer.textContent = fmt(resetMins);
  timer.className = 'timer' + (tc ? ' ' + tc : '');
  updated.textContent = timeAgo(data.fetchedAt);
  if (planLabel) planLabel.textContent = data.planName || '';
  if (resetTimesEl) {
    const parts = data.bars
      .filter(b => b.key !== 'five_hour' && b.resetsAt)
      .map(b => {
        const name = RESET_LABEL_MAP[b.key] || b.shortLabel.slice(0, 4);
        const t = fmtResetTime(b.resetsAt);
        return t ? `${name}:${t}` : null;
      })
      .filter(Boolean);
    resetTimesEl.textContent = parts.join(' · ');
  }

  // S5: Build bar rows via DOM API (no innerHTML with dynamic strings)
  barsEl.textContent = ''; // clear existing rows safely
  for (const bar of data.bars) {
    barsEl.appendChild(buildBarRow(bar));
  }

  requestFitResize();
}

window.claudeBar.onUpdate((data) => render(data));

// B7b: Handle poll errors — show stale indicator
window.claudeBar.onError((err) => {
  isStale = true;
  const dot = document.getElementById('dot');
  const updated = document.getElementById('updated');
  // Set dot to idle/grey
  dot.className = 'dot';
  const base = lastTs ? timeAgo(lastTs) : 'last updated —';
  updated.textContent = base + ' · offline';
});

// Feature 4: poll interval pushed from main (tray menu setting)
window.claudeBar.onConfig((cfg) => {
  if (cfg && cfg.pollIntervalMin) pollIntervalMin = cfg.pollIntervalMin;
});

// Feature 5: quiet update banner — click to install
window.claudeBar.onUpdateAvailable((info) => {
  const banner = document.getElementById('updateBanner');
  banner.textContent = `↑ ${info.version} available — install`;
  banner.classList.add('visible');
  requestFitResize();
});

document.getElementById('updateBanner').addEventListener('click', () => window.claudeBar.installUpdate());

document.getElementById('loginBtn').addEventListener('click', () => window.claudeBar.openLogin());
document.getElementById('themeBtn').addEventListener('click', cycleTheme);
document.getElementById('pinBtn').addEventListener('click', togglePin);

// Feature 4: manual refresh — spin the dot to "loading" until the next update
document.getElementById('refreshBtn').addEventListener('click', () => {
  document.getElementById('dot').className = 'dot load';
  window.claudeBar.refresh();
});

// B5: Every 30s, refresh timer display from resetsAt; also refresh timeAgo
setInterval(() => {
  if (lastTs) {
    const updated = document.getElementById('updated');
    // Only overwrite if not currently showing stale message (isStale handled in onError)
    if (!isStale) {
      updated.textContent = timeAgo(lastTs);
    }
  }
  // B5: Recompute timer from absolute resetsAt
  updateTimerFromResetsAt();
}, 30000);

const BASE_W = 224;

function applyScale() {
  document.body.style.zoom = window.innerWidth / BASE_W;
}
window.addEventListener('resize', applyScale);
applyScale();

(function () {
  const handle = document.getElementById('resizeHandle');
  let active = false, ox, ow;

  handle.addEventListener('mousedown', e => {
    e.preventDefault();
    active = true;
    ox = e.screenX;
    ow = window.innerWidth;

    function onMove(e) {
      if (!active) return;
      const newW = Math.max(180, Math.min(500, ow + e.screenX - ox));
      document.body.style.zoom = newW / BASE_W;
      // B8: compute height from actual content, not fixed aspect ratio
      const zoom = newW / BASE_W;
      const contentH = document.body.scrollHeight;
      window.claudeBar.resize(newW, Math.round(contentH * zoom));
    }
    function onUp() {
      active = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
})();
