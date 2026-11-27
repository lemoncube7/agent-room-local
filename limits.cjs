'use strict';
const fs = require('node:fs');
const path = require('node:path');

function readLimits(localDir) {
  const limits = {};
  for (const name of fs.readdirSync(localDir).filter(file => /^limits-[a-z]+\.json$/.test(file))) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(localDir, name), 'utf8'));
      if (data.provider) limits[data.provider] = data;
    } catch {}
  }
  return limits;
}

function limitResetAt(localDir, provider) {
  const windows = Object.values(readLimits(localDir)[provider]?.windows || {});
  const times = windows.filter(w => Number(w?.utilization) >= 1).map(w => {
    const raw = w.resets_at ?? w.resetsAt;
    return typeof raw === 'number' ? (raw < 1e12 ? raw * 1000 : raw) : Date.parse(raw);
  }).filter(ms => Number.isFinite(ms) && ms > Date.now());
  return times.length ? Math.max(...times) + 30000 : 0;
}

function agentQuotaSummary(provider, model, limits) {
  const raw = limits?.[provider]?.windows;
  if (!raw || typeof raw !== 'object') return null;
  let pairs;
  if (provider === 'agy') {
    const isGemini = !model || /gemini/i.test(model);
    pairs = isGemini
      ? [['five_hour', raw['gemini-5h']], ['seven_day', raw['gemini-weekly']]]
      : [['five_hour', raw['3p-5h']], ['seven_day', raw['3p-weekly']]];
  } else {
    pairs = Object.entries(raw);
  }
  const windows = {};
  let min = null;
  const now = Date.now();
  for (const [k, w] of pairs) {
    if (!w || typeof w !== 'object') continue;
    const rawReset = w.resets_at ?? w.resetsAt;
    const ms = typeof rawReset === 'number' ? (rawReset < 1e12 ? rawReset * 1000 : rawReset) : Date.parse(rawReset);
    const expired = Number.isFinite(ms) && ms <= now;
    const rem = expired ? 100 : Math.max(0, Math.min(100, Math.round(100 - (Number(w.utilization) || 0) * 100)));
    let resetsIn;
    if (expired) resetsIn = 'reset';
    else if (Number.isFinite(ms) && ms > now) {
      const mins = Math.max(1, Math.round((ms - now) / 60000));
      resetsIn = mins < 60
        ? mins + 'm'
        : mins < 1440
          ? Math.floor(mins / 60) + 'h' + (mins % 60 ? mins % 60 + 'm' : '')
          : Math.floor(mins / 1440) + 'd' + Math.floor((mins % 1440) / 60) + 'h';
    }
    windows[k] = { remaining: rem + '%', ...(resetsIn ? { resetsIn } : {}) };
    min = min === null ? rem : Math.min(min, rem);
  }
  return min === null ? null : { minRemainingPct: min, windows };
}

function formatLimitsContext(localDir, limits = readLimits(localDir)) {
  const out = {};
  for (const [provider, data] of Object.entries(limits)) {
    if (!data?.windows || typeof data.windows !== 'object') continue;
    const wins = {};
    for (const [k, w] of Object.entries(data.windows)) {
      if (!w || typeof w !== 'object') continue;
      const raw = w.resets_at ?? w.resetsAt;
      const ms = typeof raw === 'number' ? (raw < 1e12 ? raw * 1000 : raw) : Date.parse(raw);
      const expired = Number.isFinite(ms) && ms <= Date.now();
      const rem = expired ? 100 : Math.max(0, Math.min(100, Math.round(100 - (Number(w.utilization) || 0) * 100)));
      const resets = expired
        ? 'reset'
        : Number.isFinite(ms)
          ? 'in ' + (ms - Date.now() >= 86400000 ? Math.floor((ms - Date.now()) / 86400000) + 'd ' : '') + Math.floor(((ms - Date.now()) % 86400000) / 3600000) + 'h ' + Math.floor(((ms - Date.now()) % 3600000) / 60000) + 'm'
          : undefined;
      wins[k] = { remaining: rem + '%', ...(resets ? { resets } : {}) };
    }
    if (Object.keys(wins).length) out[provider] = wins;
  }
  if (!Object.keys(out).length) return '';
  const text = Object.entries(out).map(([provider, wins]) => provider + ' ' + Object.entries(wins).map(([k, w]) => k + ' ' + w.remaining + (w.resets ? ' (' + w.resets + ')' : '')).join(', ')).join(' | ');
  return ' Quota remaining: ' + text + '.';
}

module.exports = { readLimits, limitResetAt, agentQuotaSummary, formatLimitsContext };
