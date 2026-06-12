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
  if (s < 60) return `updated ${s}s ago`;
  const totalMin = Math.round(s / 60);
  if (totalMin < 60) return `updated ${totalMin}min ago`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m > 0 ? `updated ${h}h ${m}min ago` : `updated ${h}h ago`;
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
// Usage history: { barKey: [[ts_ms, utilization], ...] }
let historyData = {};
let histScreen = false;
let selectedBarKey = null;

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

// Linear regression to compute burn rate (%/h) over a sliding window.
// Segments at resets (>15pt drop) so only the current session's slope is used.
function computeBurnRate(points, barKey) {
  const windowMs = barKey === 'five_hour' ? 45 * 60000 : 12 * 3600000;
  const cutoff = Date.now() - windowMs;
  let recent = points.filter(([ts]) => ts >= cutoff);
  for (let i = recent.length - 1; i > 0; i--) {
    if (recent[i][1] - recent[i - 1][1] < -15) { recent = recent.slice(i); break; }
  }
  if (recent.length < 2) return null;
  const t0 = recent[0][0];
  const xs = recent.map(([ts]) => (ts - t0) / 3600000);
  const ys = recent.map(([, u]) => u);
  const n = xs.length;
  const sumX = xs.reduce((a, b) => a + b, 0);
  const sumY = ys.reduce((a, b) => a + b, 0);
  const sumXY = xs.reduce((s, x, i) => s + x * ys[i], 0);
  const sumX2 = xs.reduce((s, x) => s + x * x, 0);
  const denom = n * sumX2 - sumX * sumX;
  return Math.abs(denom) < 1e-10 ? null : Math.max(0, (n * sumXY - sumX * sumY) / denom);
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function mksvg(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

function fmtClock(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function renderSparklineSVG(svgEl, points, barKey) {
  const W = 200, H = 64;
  const PAD_T = 4, PAD_B = 10; // bottom strip for time labels
  svgEl.textContent = '';
  svgEl.setAttribute('viewBox', `0 0 ${W} ${H}`);

  const maxWindowMs = barKey === 'five_hour' ? 6 * 3600000 : 24 * 3600000;
  const now = Date.now();
  const visible = points.filter(([ts]) => ts >= now - maxWindowMs);

  if (visible.length < 2) {
    const txt = mksvg('text', {
      x: W / 2, y: H / 2 + 3, 'text-anchor': 'middle',
      fill: 'currentColor', 'font-size': 9, 'font-family': 'SF Mono, Menlo, monospace',
    });
    txt.textContent = 'collecting data…';
    svgEl.appendChild(txt);
    return;
  }

  // Fit the time axis to the data instead of a fixed window: start at the
  // first visible point (min 30 min span so early points don't fill the
  // whole width), forecast region at most as wide as the history.
  const histSpan = Math.max(now - visible[0][0], 30 * 60000);
  const tStart = now - histSpan;

  const rate = computeBurnRate(points, barKey);
  const last = visible[visible.length - 1];
  const tsLimit = rate && rate > 0.5
    ? last[0] + (100 - last[1]) / rate * 3600000
    : null;
  const tEnd = tsLimit
    ? Math.min(tsLimit + histSpan * 0.05, now + histSpan)
    : now + histSpan * 0.15;
  const range = tEnd - tStart;

  const tx = (ts) => ((ts - tStart) / range) * W;
  const plotH = H - PAD_T - PAD_B;
  const ty = (u) => PAD_T + (1 - Math.min(1, Math.max(0, u / 100))) * plotH;

  // Gridlines at 0 / 50 / 100% with tiny labels
  for (const lvl of [0, 50, 100]) {
    const gy = ty(lvl).toFixed(1);
    svgEl.appendChild(mksvg('line', {
      x1: 0, y1: gy, x2: W, y2: gy,
      stroke: 'currentColor', 'stroke-width': 0.5,
      opacity: lvl === 100 ? 0.35 : 0.15,
      ...(lvl === 100 ? { 'stroke-dasharray': '2,2' } : {}),
    }));
    if (lvl > 0) {
      const lbl = mksvg('text', {
        x: 1, y: Number(gy) - 1.5, fill: 'currentColor',
        'font-size': 5.5, 'font-family': 'SF Mono, Menlo, monospace', opacity: 0.6,
      });
      lbl.textContent = `${lvl}%`;
      svgEl.appendChild(lbl);
    }
  }

  // "now" boundary between history and forecast
  svgEl.appendChild(mksvg('line', {
    x1: tx(now).toFixed(1), y1: PAD_T, x2: tx(now).toFixed(1), y2: PAD_T + plotH,
    stroke: 'currentColor', 'stroke-width': 0.5, opacity: 0.2,
  }));

  // Time labels: start of window, now
  const mkTimeLabel = (ts, anchor) => {
    const t = mksvg('text', {
      x: tx(ts).toFixed(1), y: H - 1.5, 'text-anchor': anchor,
      fill: 'currentColor', 'font-size': 5.5,
      'font-family': 'SF Mono, Menlo, monospace', opacity: 0.6,
    });
    t.textContent = fmtClock(ts);
    svgEl.appendChild(t);
  };
  mkTimeLabel(tStart, 'start');
  mkTimeLabel(now, tx(now) > W - 18 ? 'end' : 'middle');

  // Reset markers (vertical accent lines at >15pt drops)
  for (let i = 1; i < visible.length; i++) {
    if (visible[i][1] - visible[i - 1][1] < -15) {
      const rx = tx(visible[i][0]).toFixed(1);
      svgEl.appendChild(mksvg('line', {
        x1: rx, y1: PAD_T, x2: rx, y2: PAD_T + plotH,
        stroke: 'var(--accent)', 'stroke-width': 0.5, opacity: 0.35,
      }));
    }
  }

  // Historical line + area fill — lift pen (M) at each reset so the line
  // doesn't draw through the drop
  const cmds = [];
  const segments = []; // [startIdx, endIdx] per continuous segment, for area fill
  let segStart = 0;
  for (let i = 0; i < visible.length; i++) {
    const [ts, u] = visible[i];
    const isReset = i > 0 && visible[i][1] - visible[i - 1][1] < -15;
    if (isReset) { segments.push([segStart, i - 1]); segStart = i; }
    cmds.push(`${i === 0 || isReset ? 'M' : 'L'}${tx(ts).toFixed(1)},${ty(u).toFixed(1)}`);
  }
  segments.push([segStart, visible.length - 1]);

  const baseY = ty(0).toFixed(1);
  for (const [s, e] of segments) {
    if (e <= s) continue;
    const seg = visible.slice(s, e + 1);
    const top = seg.map(([ts, u], i) =>
      `${i === 0 ? 'M' : 'L'}${tx(ts).toFixed(1)},${ty(u).toFixed(1)}`).join(' ');
    svgEl.appendChild(mksvg('path', {
      d: `${top} L${tx(seg[seg.length - 1][0]).toFixed(1)},${baseY} L${tx(seg[0][0]).toFixed(1)},${baseY} Z`,
      fill: 'var(--accent)', opacity: 0.12, stroke: 'none',
    }));
  }

  svgEl.appendChild(mksvg('path', {
    d: cmds.join(' '),
    stroke: 'var(--accent)', 'stroke-width': 1.5, fill: 'none',
    'stroke-linecap': 'round', 'stroke-linejoin': 'round',
  }));

  // Dot at the current point
  svgEl.appendChild(mksvg('circle', {
    cx: tx(last[0]).toFixed(1), cy: ty(last[1]).toFixed(1), r: 1.8,
    fill: 'var(--accent)',
  }));

  // Dashed forecast from the current point toward the 100% line
  if (tsLimit) {
    const tsF = Math.min(tsLimit, tEnd);
    const uF = tsF === tsLimit ? 100 : last[1] + rate * (tsF - last[0]) / 3600000;
    svgEl.appendChild(mksvg('line', {
      x1: tx(last[0]).toFixed(1), y1: ty(last[1]).toFixed(1),
      x2: tx(tsF).toFixed(1), y2: ty(uF).toFixed(1),
      stroke: 'var(--accent)', 'stroke-width': 1,
      'stroke-dasharray': '3,2', opacity: 0.55,
    }));
    // Where the forecast hits the limit: vertical dashed line + marker + time label
    if (tsLimit <= tEnd) {
      const lx = tx(tsLimit);
      svgEl.appendChild(mksvg('line', {
        x1: lx.toFixed(1), y1: PAD_T, x2: lx.toFixed(1), y2: PAD_T + plotH,
        stroke: 'var(--crit)', 'stroke-width': 0.7,
        'stroke-dasharray': '2,2', opacity: 0.6,
      }));
      svgEl.appendChild(mksvg('circle', {
        cx: lx.toFixed(1), cy: ty(100).toFixed(1), r: 1.8,
        fill: 'none', stroke: 'var(--crit)', 'stroke-width': 0.8,
      }));
      // Skip the label if it would collide with the "now" label
      if (lx - tx(now) > 24) {
        const lbl = mksvg('text', {
          x: lx.toFixed(1), y: H - 1.5,
          'text-anchor': lx > W - 14 ? 'end' : 'middle',
          fill: 'var(--crit)', 'font-size': 5.5,
          'font-family': 'SF Mono, Menlo, monospace', opacity: 0.85,
        });
        lbl.textContent = fmtClock(tsLimit);
        svgEl.appendChild(lbl);
      }
    }
  }
}

function renderHistScreen() {
  const chipsEl = document.getElementById('histChips');
  const svgEl = document.getElementById('sparkline');
  const statusEl = document.getElementById('histStatus');

  if (!lastData || !lastData.bars || !lastData.bars.length) {
    chipsEl.textContent = '';
    svgEl.textContent = '';
    statusEl.textContent = 'no data';
    return;
  }

  const barKeys = lastData.bars.map(b => b.key);
  if (!selectedBarKey || !barKeys.includes(selectedBarKey)) selectedBarKey = barKeys[0];

  chipsEl.textContent = '';
  for (const bar of lastData.bars) {
    const chip = document.createElement('button');
    chip.className = 'hist-chip' + (bar.key === selectedBarKey ? ' active' : '');
    chip.textContent = bar.shortLabel;
    chip.addEventListener('click', () => { selectedBarKey = bar.key; renderHistScreen(); });
    chipsEl.appendChild(chip);
  }

  const pts = historyData[selectedBarKey] || [];
  renderSparklineSVG(svgEl, pts, selectedBarKey);

  const rate = computeBurnRate(pts, selectedBarKey);
  if (!rate || rate <= 0.5) {
    statusEl.textContent = 'no usage';
  } else {
    const bar = lastData.bars.find(b => b.key === selectedBarKey);
    const tsLimit = Date.now() + (100 - (bar ? bar.utilization : 0)) / rate * 3600000;
    const resetsAt = bar && bar.resetsAt ? new Date(bar.resetsAt).getTime() : null;
    if (resetsAt && resetsAt < tsLimit) {
      statusEl.textContent = `${rate.toFixed(1)}%/h · resets before limit`;
    } else if (tsLimit - Date.now() < 24 * 3600000) {
      statusEl.textContent = `${rate.toFixed(1)}%/h · limit ~${fmtClock(tsLimit)}`;
    } else {
      statusEl.textContent = `${rate.toFixed(1)}%/h`;
    }
  }
}

function toggleHistScreen() {
  histScreen = !histScreen;
  document.getElementById('barsScreen').style.display = histScreen ? 'none' : '';
  document.getElementById('histScreen').style.display = histScreen ? '' : 'none';
  document.getElementById('histBtn').textContent = histScreen ? '▤' : '∿';
  if (histScreen) renderHistScreen();
  requestFitResize();
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
  if (histScreen) renderHistScreen();
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
  const base = lastTs ? timeAgo(lastTs) : 'updated —';
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

window.claudeBar.onHistoryUpdate((data) => {
  historyData = data;
  if (histScreen) renderHistScreen();
});

document.getElementById('loginBtn').addEventListener('click', () => window.claudeBar.openLogin());
document.getElementById('themeBtn').addEventListener('click', cycleTheme);
document.getElementById('pinBtn').addEventListener('click', togglePin);
document.getElementById('histBtn').addEventListener('click', toggleHistScreen);

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
