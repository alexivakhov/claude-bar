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

function timeAgo(ts) {
  if (!ts) return '—';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `last updated ${s}s ago`;
  return `last updated ${Math.round(s / 60)}min ago`;
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

function render(data) {
  const dot = document.getElementById('dot');
  const timer = document.getElementById('timer');
  const barsEl = document.getElementById('bars');
  const updated = document.getElementById('updated');
  const loginBtn = document.getElementById('loginBtn');

  const planLabel = document.getElementById('planLabel');
  const resetTimesEl = document.getElementById('resetTimes');

  if (!data || !data.bars || data.bars.length === 0) {
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
      updated.textContent = 'refreshing every 2min';
      loginBtn.textContent = '↗ log in';
    }
    return;
  }

  loginBtn.textContent = '↗ log out';
  lastTs = data.fetchedAt;

  const sessionBar = data.bars.find(b => b.key === 'five_hour') || data.bars[0];
  const resetMins = sessionBar && sessionBar.msUntilReset !== null
    ? Math.round(sessionBar.msUntilReset / 60000)
    : null;

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

  barsEl.innerHTML = data.bars.map(bar => {
    const cls = barColor(bar.utilization);
    const tooltip = bar.msUntilReset
      ? `${bar.label} — resets in ${fmtDuration(bar.msUntilReset)}`
      : bar.label;
    return `
      <div class="bar-row" title="${tooltip}">
        <span class="bar-name">${bar.shortLabel}</span>
        <div class="track"><div class="fill ${cls}" style="width:${bar.utilization}%"></div></div>
        <span class="pct">${Math.round(bar.utilization)}%</span>
      </div>`;
  }).join('');
}

window.claudeBar.onUpdate((data) => render(data));

document.getElementById('loginBtn').addEventListener('click', () => window.claudeBar.openLogin());
document.getElementById('themeBtn').addEventListener('click', cycleTheme);
document.getElementById('pinBtn').addEventListener('click', togglePin);

setInterval(() => {
  if (lastTs) document.getElementById('updated').textContent = timeAgo(lastTs);
}, 60000);

const BASE_W = 224;
const BASE_H = 150;
const ASPECT = BASE_W / BASE_H;

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
      window.claudeBar.resize(newW, Math.round(newW / ASPECT));
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
