'use strict';
const path = require('node:path');

function updaterLaunchCommand(rootDir, updateLog, powershell, tag) {
  const quote = value => "'" + String(value).replace(/'/g, "''") + "'";
  const args = [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', '"' + path.join(rootDir, 'update.ps1') + '"',
    '-Tag', tag,
    '-HubId', process.pid,
    '-NodePath', '"' + process.execPath + '"'
  ].join(' ');
  return 'Start-Process -FilePath ' + quote(powershell) +
    ' -WindowStyle Hidden -RedirectStandardOutput ' + quote(updateLog) +
    ' -RedirectStandardError ' + quote(updateLog + '.err') +
    ' -ArgumentList ' + quote(args);
}

async function checkUpdate(version) {
  const response = await fetch('https://api.github.com/repos/lemoncube7/agent-room-local/releases?per_page=20', {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Agent-Room' },
    signal: AbortSignal.timeout(8000)
  });
  const newer = (a, b) => {
    const x = a.split('.').map(Number), y = b.split('.').map(Number);
    const diff = x.findIndex((n, i) => n !== y[i]);
    return diff >= 0 && x[diff] > y[diff];
  };
  if (!response.ok) {
    const page = await fetch('https://github.com/lemoncube7/agent-room-local/releases/latest', {
      redirect: 'manual',
      headers: { 'User-Agent': 'Agent-Room' },
      signal: AbortSignal.timeout(8000)
    }).catch(() => null);
    const latestTag = page?.headers.get('location')?.match(/\/releases\/tag\/(v\d+\.\d+\.\d+)$/)?.[1];
    if (!latestTag) throw Error('GitHub에서 업데이트를 확인하지 못했어요 (' + response.status + '). 잠시 후 다시 시도해 주세요.');
    const hasUpdate = newer(latestTag.slice(1), version);
    return {
      version,
      available: hasUpdate,
      latest: latestTag,
      download: hasUpdate ? 'https://github.com/lemoncube7/agent-room-local/releases/download/' + latestTag + '/Agent-Room-' + latestTag + '-Windows.zip' : null
    };
  }
  const releases = (await response.json()).filter(item => !item.draft && /^v\d+\.\d+\.\d+$/.test(item.tag_name));
  const latest = releases.reduce((best, item) => !best || newer(item.tag_name.slice(1), best.tag_name.slice(1)) ? item : best, null);
  const available = Boolean(latest && newer(latest.tag_name.slice(1), version));
  const tag = latest?.tag_name;
  const zip = latest?.assets.find(asset => asset.name === 'Agent-Room-' + tag + '-Windows.zip');
  return {
    version,
    available,
    latest: tag,
    download: available && zip ? 'https://github.com/lemoncube7/agent-room-local/releases/download/' + tag + '/' + zip.name : null
  };
}

module.exports = { updaterLaunchCommand, checkUpdate };
