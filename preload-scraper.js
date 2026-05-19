const { contextBridge, ipcRenderer } = require('electron');

const LABEL_MAP = {
  five_hour: 'Session',
  seven_day: 'Week — All models',
  seven_day_sonnet: 'Week — Sonnet',
  seven_day_opus: 'Week — Opus',
  seven_day_omelette: 'Week — Design',
  seven_day_cowork: 'Week — Cowork',
  seven_day_oauth_apps: 'Week — OAuth apps',
};

const SHORT_LABEL_MAP = {
  five_hour: 'SESSION',
  seven_day: 'WEEKLY',
  seven_day_sonnet: 'SONNET',
  seven_day_opus: 'OPUS',
  seven_day_omelette: 'DESIGN',
  seven_day_cowork: 'COWORK',
  seven_day_oauth_apps: 'OAUTH',
};

function prettify(key) {
  if (key.startsWith('seven_day_')) {
    const rest = key.slice('seven_day_'.length).replace(/_/g, ' ');
    return `Week — ${rest.charAt(0).toUpperCase()}${rest.slice(1)}`;
  }
  if (key === 'five_hour') return 'Session';
  return key.replace(/_/g, ' ');
}

const CAPABILITY_PLAN = {
  'claude_pro': 'Pro',
  'claude_max': 'Max',
  'claude_max_5x': 'Max 5×',
  'claude_max_20x': 'Max 20×',
  'claude_team': 'Team',
  'claude_enterprise': 'Enterprise',
};

function extractPlanName(obj) {
  if (Array.isArray(obj.capabilities)) {
    for (const cap of obj.capabilities) {
      if (CAPABILITY_PLAN[cap]) return CAPABILITY_PLAN[cap];
    }
    // has capabilities but no known plan capability = free tier
    if (obj.capabilities.length > 0) return 'Free';
  }
  return null;
}

async function getOrg() {
  const res = await fetch('/api/organizations', {
    credentials: 'include',
    headers: { 'Accept': 'application/json' },
  });
  if (!res.ok) throw new Error(`organizations: ${res.status}`);
  const orgs = await res.json();
  if (!Array.isArray(orgs) || orgs.length === 0) throw new Error('No organizations');
  const active = orgs.find(o => !o.deleted_at) || orgs[0];
  return { uuid: active.uuid, planName: extractPlanName(active) };
}

async function fetchUsage(orgId) {
  const res = await fetch(`/api/organizations/${orgId}/usage`, {
    credentials: 'include',
    headers: { 'Accept': 'application/json' },
  });
  if (!res.ok) throw new Error(`usage: ${res.status}`);
  return res.json();
}

function normalize(usageJson) {
  const bars = [];

  for (const [key, val] of Object.entries(usageJson)) {
    if (val === null || val === undefined) continue;
    if (typeof val !== 'object') continue;
    if (typeof val.utilization !== 'number') continue;

    bars.push({
      key,
      label: LABEL_MAP[key] || prettify(key),
      shortLabel: SHORT_LABEL_MAP[key] || key.toUpperCase().slice(0, 8),
      utilization: val.utilization,
      resetsAt: val.resets_at || null,
      msUntilReset: val.resets_at
        ? Math.max(0, new Date(val.resets_at).getTime() - Date.now())
        : null,
    });
  }

  // Session first, rest sorted by descending utilization
  bars.sort((a, b) => {
    const ao = a.key === 'five_hour' ? 0 : 1;
    const bo = b.key === 'five_hour' ? 0 : 1;
    if (ao !== bo) return ao - bo;
    return b.utilization - a.utilization;
  });

  return { bars, extraUsage: usageJson.extra_usage || null, fetchedAt: Date.now() };
}

let cachedOrg = null;

async function poll() {
  try {
    if (!cachedOrg) cachedOrg = await getOrg();

    let raw;
    try {
      raw = await fetchUsage(cachedOrg.uuid);
    } catch (usageErr) {
      // 403/404 on usage = plan doesn't include usage tracking (free tier)
      if (/usage: (403|404)/.test(usageErr.message)) {
        ipcRenderer.send('usage:update', {
          bars: [], noUsagePage: true,
          planName: cachedOrg.planName,
          fetchedAt: Date.now(),
        });
        return null;
      }
      throw usageErr;
    }

    const data = normalize(raw);
    data.planName = cachedOrg.planName;
    if (data.bars.length === 0) data.noUsagePage = true;
    ipcRenderer.send('usage:update', data);
    return data;
  } catch (err) {
    if (err.message.startsWith('organizations:')) cachedOrg = null;
    ipcRenderer.send('usage:error', {
      message: err.message,
      reauth: /\b401\b/.test(err.message), // 401 only — 403 on usage handled above
    });
    return null;
  }
}

contextBridge.exposeInMainWorld('usageApi', { poll, refresh: poll });

const POLL_INTERVAL_MS = 2 * 60 * 1000;
setInterval(poll, POLL_INTERVAL_MS);
poll();
