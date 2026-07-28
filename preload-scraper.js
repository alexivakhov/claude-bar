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

// Fallback for keys with no entry in SHORT_LABEL_MAP — derive from the
// suffix (not the whole key) so two "seven_day_*" buckets never collide
// on a shared "SEVEN_DA" prefix.
function shortify(key) {
  if (key.startsWith('seven_day_')) {
    return key.slice('seven_day_'.length).toUpperCase().slice(0, 8);
  }
  if (key === 'five_hour') return 'SESSION';
  return key.toUpperCase().slice(0, 8);
}

// Ordered most-specific-first: an org's capabilities array can contain more
// than one plan-shaped entry (e.g. both 'claude_max' and 'claude_max_20x'),
// and picking by array order rather than specificity previously meant
// whichever happened to come first in the API response won, not the actual
// plan. Enterprise/Team checked before Max/Pro for the same reason.
const CAPABILITY_PLAN_PRIORITY = [
  ['claude_enterprise', 'Enterprise'],
  ['claude_team_premium', 'Team Premium'],
  ['claude_team', 'Team'],
  ['claude_max_20x', 'Max 20×'],
  ['claude_max_5x', 'Max 5×'],
  ['claude_max', 'Max'],
  ['claude_pro', 'Pro'],
];

function extractPlanName(obj) {
  if (Array.isArray(obj.capabilities)) {
    for (const [cap, name] of CAPABILITY_PLAN_PRIORITY) {
      if (obj.capabilities.includes(cap)) return name;
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
  return { uuid: active.uuid, planName: extractPlanName(active), raw: active };
}

async function fetchUsage(orgId) {
  const res = await fetch(`/api/organizations/${orgId}/usage`, {
    credentials: 'include',
    headers: { 'Accept': 'application/json' },
  });
  if (!res.ok) throw new Error(`usage: ${res.status}`);
  return res.json();
}

// Prepaid credit balance + auto-reload — a separate endpoint from /usage's
// `spend`/`extra_usage` (confirmed by inspecting the actual Billing settings
// page's network calls; guessed endpoint names all 404'd). `spend` covers
// the monthly overage cap; this covers the wallet that gets drawn down when
// that cap doesn't cover you and auto-reload tops back up.
async function fetchPrepaidCredits(orgId) {
  const res = await fetch(`/api/organizations/${orgId}/prepaid/credits`, {
    credentials: 'include',
    headers: { 'Accept': 'application/json' },
  });
  if (!res.ok) throw new Error(`prepaid: ${res.status}`);
  return res.json();
}

// Usage credits ("extra usage" pay-past-your-limit, renamed mid-2026). The
// API carries two overlapping representations — `spend` is the newer one
// with amount/currency/exponent split out per field, `extra_usage` is the
// older one with a flat monthly_limit/used_credits pair. Prefer `spend`;
// fall back to `extra_usage` in case an account only has the older shape.
function normalizeCredits(usageJson) {
  const spend = usageJson.spend;
  if (spend && spend.enabled) {
    return {
      enabled: true,
      usedMinor: spend.used ? spend.used.amount_minor : null,
      limitMinor: spend.limit ? spend.limit.amount_minor : null,
      currency: (spend.used && spend.used.currency) || (spend.limit && spend.limit.currency) || 'USD',
      exponent: (spend.used && spend.used.exponent) ?? (spend.limit && spend.limit.exponent) ?? 2,
      percent: typeof spend.percent === 'number' ? spend.percent : null,
      spendLimitReached: !!(usageJson.extra_usage && usageJson.extra_usage.spend_limit_reached),
      canPurchase: !!spend.can_purchase_credits,
    };
  }
  const extra = usageJson.extra_usage;
  if (extra && extra.is_enabled) {
    return {
      enabled: true,
      usedMinor: typeof extra.used_credits === 'number' ? extra.used_credits : null,
      limitMinor: typeof extra.monthly_limit === 'number' ? extra.monthly_limit : null,
      currency: extra.currency || 'USD',
      exponent: extra.decimal_places ?? 2,
      percent: typeof extra.utilization === 'number' ? extra.utilization : null,
      spendLimitReached: !!extra.spend_limit_reached,
      canPurchase: null,
    };
  }
  return { enabled: false };
}

// Fields at the top level of the usage response that are known NOT to be a
// per-bucket bar (money/limits summaries, feature flags). Anything else that
// shows up non-null but doesn't match the {utilization: number} bar shape is
// a genuinely new field we don't understand yet — surfaced via
// data.unknownKeys so main.js can fire a one-time notification instead of
// silently dropping it (which is what happened before this check existed).
const KNOWN_NON_BAR_KEYS = new Set(['extra_usage', 'spend', 'limits', 'member_dashboard_available']);

function collectUnknownKeys(usageJson) {
  const unknown = [];
  for (const [key, val] of Object.entries(usageJson)) {
    if (KNOWN_NON_BAR_KEYS.has(key)) continue;
    if (val === null || val === undefined) continue; // reserved/inactive bucket — nothing to report yet
    if (typeof val !== 'object') continue;
    if (typeof val.utilization === 'number') continue; // handled as a normal bar below
    unknown.push(key);
  }
  return unknown;
}

// Two weekly buckets known to represent alternative pools for the *same*
// underlying work (Sonnet vs Opus on Max plans) rather than different
// features — safe to compare headroom between them. Intentionally NOT
// extended with a guessed frontier/Fable key; see project memory for why
// (the API exposes several null codename fields that don't map to any
// public model name). Add a third key here once a live payload confirms it.
const MODEL_BUCKET_KEYS = ['seven_day_sonnet', 'seven_day_opus'];

function normalize(usageJson) {
  const bars = [];

  for (const [key, val] of Object.entries(usageJson)) {
    if (KNOWN_NON_BAR_KEYS.has(key)) continue;
    if (val === null || val === undefined) continue;
    if (typeof val !== 'object') continue;
    if (typeof val.utilization !== 'number') continue;

    bars.push({
      key,
      label: LABEL_MAP[key] || prettify(key),
      shortLabel: SHORT_LABEL_MAP[key] || shortify(key),
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

  return {
    bars,
    credits: normalizeCredits(usageJson),
    unknownKeys: collectUnknownKeys(usageJson),
    fetchedAt: Date.now(),
  };
}

let cachedOrg = null;
// poll() fires from three places (interval, manual refresh, post-login) and
// they can overlap. Concurrent runs double-report the same sample, which puts
// duplicate points in the history and skews the burn-rate regression.
let pollInFlight = false;

async function poll() {
  if (pollInFlight) {
    console.log('poll: already in flight, skipping');
    return null;
  }
  pollInFlight = true;
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
          credits: { enabled: false },
          unknownKeys: [],
          planName: cachedOrg.planName,
          raw: { org: cachedOrg.raw, usage: null, usageError: usageErr.message },
          fetchedAt: Date.now(),
        });
        return null;
      }
      throw usageErr;
    }

    const data = normalize(raw);
    data.planName = cachedOrg.planName;
    if (data.bars.length === 0) data.noUsagePage = true;

    // Prepaid balance/auto-reload live on a separate endpoint from `spend`
    // (see fetchPrepaidCredits) — best-effort, since accounts without
    // credits enabled at all 404 here and that shouldn't fail the poll.
    let prepaid = null;
    if (data.credits.enabled) {
      try {
        prepaid = await fetchPrepaidCredits(cachedOrg.uuid);
        data.credits.balanceMinor = typeof prepaid.amount === 'number' ? prepaid.amount : null;
        data.credits.balanceCurrency = prepaid.currency || data.credits.currency;
        data.credits.autoReloadEnabled = !!(prepaid.auto_reload_settings && prepaid.auto_reload_settings.enabled);
        data.credits.autoReloadThresholdMinor = prepaid.auto_reload_settings ? prepaid.auto_reload_settings.threshold_in_minor_units : null;
        data.credits.autoReloadTargetMinor = prepaid.auto_reload_settings ? prepaid.auto_reload_settings.reload_to_in_minor_units : null;
        data.credits.nextExpiresAt = prepaid.next_expires_at || null;
      } catch (prepaidErr) {
        console.log('prepaid credits fetch failed (non-fatal):', prepaidErr.message);
      }
    }

    // Kept only for the tray's "Copy Raw Usage JSON" debug item — main.js
    // strips this before forwarding to floatWin/history so the widget IPC
    // payload and stored history stay small. Lets us see real key names
    // (e.g. a new weekly bucket) the moment the API adds one, without
    // waiting on a code change.
    data.raw = { org: cachedOrg.raw, usage: raw, prepaid };
    ipcRenderer.send('usage:update', data);
    return data;
  } catch (err) {
    if (err.message.startsWith('organizations:')) cachedOrg = null;
    ipcRenderer.send('usage:error', {
      message: err.message,
      reauth: /\b401\b/.test(err.message), // 401 only — 403 on usage handled above
    });
    return null;
  } finally {
    pollInFlight = false;
  }
}

contextBridge.exposeInMainWorld('usageApi', { poll, refresh: poll });

// Poll interval is user-configurable (tray menu → Refresh Interval)
const DEFAULT_POLL_INTERVAL_MS = 2 * 60 * 1000;
let pollTimer = null;

function armPoll(ms) {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(poll, ms);
}

ipcRenderer.on('poll-config', (_, ms) => armPoll(ms));

ipcRenderer.invoke('get-poll-interval')
  .then(ms => armPoll(ms || DEFAULT_POLL_INTERVAL_MS))
  .catch(() => armPoll(DEFAULT_POLL_INTERVAL_MS));
poll();
