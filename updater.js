const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { spawn } = require('child_process');

const RELEASE_URL = 'https://api.github.com/repos/chals1029/ChalzTracker/releases/latest';
const DOWNLOAD_PREFIX = 'https://github.com/chals1029/ChalzTracker/releases/download/';
const MAX_DOWNLOAD = 1024 * 1024 * 1024;
const versionPattern = /^\d+\.\d+\.\d+$/;

function compareVersions(a, b) {
  if (!versionPattern.test(a) || !versionPattern.test(b)) throw new Error('Invalid release version.');
  const left = a.split('.').map(BigInt);
  const right = b.split('.').map(BigInt);
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  }
  return 0;
}

function parseRelease(release, currentVersion) {
  if (!release || release.draft || release.prerelease || typeof release.tag_name !== 'string' || !/^v\d+\.\d+\.\d+$/.test(release.tag_name)) throw new Error('GitHub returned an invalid release version.');
  const version = release.tag_name.slice(1);
  if (compareVersions(version, currentVersion) <= 0) return null;
  const name = `ChalzTracker-v${version}-Windows-x64.zip`;
  const asset = Array.isArray(release.assets) && release.assets.find(item => item.name === name);
  if (!asset || typeof asset.digest !== 'string' || !/^sha256:[0-9a-f]{64}$/i.test(asset.digest)) throw new Error('The release has no Windows package with a valid SHA-256 digest.');
  const expectedUrl = `${DOWNLOAD_PREFIX}${encodeURIComponent(release.tag_name)}/${name}`;
  if (asset.browser_download_url !== expectedUrl) throw new Error('The release package URL is invalid.');
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_DOWNLOAD) throw new Error('The release package size is invalid.');
  return { version, url: expectedUrl, digest: asset.digest.slice(7).toLowerCase(), size: asset.size };
}

function request(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5 || new URL(url).protocol !== 'https:') return reject(new Error('Invalid download redirect.'));
    const req = https.get(url, { headers: { 'User-Agent': 'ChalzTracker-Updater', Accept: 'application/vnd.github+json' } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        try { resolve(request(new URL(res.headers.location, url).href, redirects + 1)); } catch (error) { reject(error); }
      } else if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`GitHub request failed (HTTP ${res.statusCode}).`));
      } else resolve(res);
    });
    req.setTimeout(30000, () => req.destroy(new Error('The update request timed out.')));
    req.on('error', reject);
  });
}

async function fetchRelease(url = RELEASE_URL) {
  const response = await request(url);
  let body = '';
  for await (const chunk of response) {
    body += chunk;
    if (body.length > 2 * 1024 * 1024) { response.destroy(); throw new Error('GitHub release response is too large.'); }
  }
  return JSON.parse(body);
}

async function downloadAsset(asset, destination, progress) {
  const response = await request(asset.url);
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  let lastPercent = -1;
  const meter = new Transform({ transform(chunk, encoding, callback) {
    bytes += chunk.length;
    if (bytes > asset.size || bytes > MAX_DOWNLOAD) return callback(new Error('Downloaded package exceeds its expected size.'));
    hash.update(chunk);
    const percent = Math.floor(bytes * 100 / asset.size);
    if (percent !== lastPercent) { lastPercent = percent; progress(percent); }
    callback(null, chunk);
  } });
  await pipeline(response, meter, fs.createWriteStream(destination, { flags: 'wx' }));
  if (bytes !== asset.size || hash.digest('hex') !== asset.digest) throw new Error('The downloaded package failed SHA-256 verification.');
}

function powershell(args) {
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'updater-helper.ps1'), ...args], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  return new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(stderr.trim() || `Update preparation failed (exit ${code}).`)));
  });
}

async function launchUpdateHelper(workDir, version, dataDir, resultFile) {
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (/["\r\n]/.test(executable)) throw new Error('Invalid Windows PowerShell path.');
  const details = { script: path.join(__dirname, 'updater-helper.ps1'), workDir, version, installDir: __dirname, dataDir, parentId: process.pid, resultFile, log: path.join(workDir, 'apply.log') };
  const payload = Buffer.from(JSON.stringify(details), 'utf8').toString('base64');
  const script = `$d = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json; & $d.script -Mode Apply -WorkDir $d.workDir -Version $d.version -InstallDir $d.installDir -DataDir $d.dataDir -ParentId ([int]$d.parentId) -ResultFile $d.resultFile *>&1 | Out-File -LiteralPath $d.log -Encoding utf8`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const commandLine = `"${executable}" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
  if (commandLine.length > 32767) throw new Error('Update helper command is too long.');
  await fs.promises.writeFile(path.join(workDir, 'apply-launch.json'), JSON.stringify({ commandLine }), { flag: 'wx' });
  try {
    await powershell(['-Mode', 'Broker', '-WorkDir', workDir]);
    const broker = JSON.parse((await fs.promises.readFile(path.join(workDir, 'apply-broker.json'), 'utf8')).replace(/^\uFEFF/, ''));
    if (!Number.isSafeInteger(broker.pid) || broker.pid <= 0) throw new Error('Windows returned an invalid helper process ID.');
    const readyFile = path.join(workDir, 'apply-ready');
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      try {
        const ready = await fs.promises.readFile(readyFile, 'utf8');
        if (ready.trim() !== String(broker.pid)) throw new Error('The update helper identity did not match the Windows broker.');
        return;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    let log = '';
    try { log = (await fs.promises.readFile(details.log, 'utf8')).trim().slice(-4000); } catch {}
    throw new Error(log || 'The Windows update helper did not become ready.');
  } catch (error) {
    await fs.promises.writeFile(path.join(workDir, 'apply-cancel'), 'cancel').catch(() => {});
    throw error;
  }
}

function createUpdater({ app, dataDir, notify, broadcast }) {
  const currentVersion = app.getVersion();
  const resultFile = path.join(dataDir, 'update-result.json');
  const pendingFile = path.join(dataDir, 'update-pending.json');
  let state = { status: 'idle', currentVersion };
  let available = null;
  const notificationFile = path.join(dataDir, 'update-notification.json');
  let lastNotifiedVersion = null;
  try { lastNotifiedVersion = JSON.parse(fs.readFileSync(notificationFile, 'utf8')).version; } catch {}
  let busy = false;
  function setState(status, extras = {}) {
    state = { status, currentVersion, ...extras };
    broadcast(state);
    return state;
  }
  async function check() {
    if (busy) return state;
    busy = true;
    setState('checking');
    try {
      const release = parseRelease(await fetchRelease(), currentVersion);
      available = release;
      if (!release) return setState('up-to-date');
      const next = setState('available', { version: release.version });
      if (lastNotifiedVersion !== release.version) {
        try {
          notify(release.version);
          lastNotifiedVersion = release.version;
          fs.mkdirSync(dataDir, { recursive: true });
          fs.writeFileSync(notificationFile, JSON.stringify({ version: release.version }));
        } catch { /* A notification must not turn a successful check into an error. */ }
      }
      return next;
    } catch (error) {
      return setState('error', { ...(available ? { version: available.version } : {}), message: `Could not check for updates: ${error.message}` });
    } finally { busy = false; }
  }
  async function install() {
    if (busy) return state;
    if (!available) return setState('error', { message: 'No update is available yet.' });
    if (process.platform !== 'win32' || process.arch !== 'x64') return setState('error', { version: available.version, message: 'Automatic updates require 64-bit Windows.' });
    busy = true;
    let workDir;
    let preserveWorkDir = false;
    try {
      workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'chalztracker-update-'));
      const archive = path.join(workDir, 'release.zip');
      setState('downloading', { version: available.version, percent: 0 });
      await downloadAsset(available, archive, percent => setState('downloading', { version: available.version, percent }));
      setState('installing', { version: available.version, message: 'Preparing the verified update…' });
      await powershell(['-Mode', 'Stage', '-WorkDir', workDir, '-Archive', archive, '-Version', available.version]);
      await fs.promises.mkdir(dataDir, { recursive: true });
      await fs.promises.rm(resultFile, { force: true });
      await fs.promises.writeFile(pendingFile, JSON.stringify({ workDir, version: available.version }));
      preserveWorkDir = true;
      await launchUpdateHelper(workDir, available.version, dataDir, resultFile);
      setState('installing', { version: available.version, message: 'Restarting to install the update…' });
      app.isQuitting = true;
      app.quit();
      return state;
    } catch (error) {
      await fs.promises.rm(pendingFile, { force: true }).catch(() => {});
      if (workDir && !preserveWorkDir) await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {});
      return setState('error', { version: available.version, message: `Could not install update: ${error.message}${preserveWorkDir ? ` Diagnostic files: ${workDir}` : ''}` });
    } finally { busy = false; }
  }
  function start() {
    try {
      const result = JSON.parse(fs.readFileSync(resultFile, 'utf8').replace(/^\uFEFF/, ''));
      fs.unlinkSync(resultFile);
      try { fs.unlinkSync(pendingFile); } catch {}
      if (result.status === 'error') {
        setState('error', { message: result.message });
        setTimeout(check, 60000);
      } else check();
    } catch {
      try {
        const pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
        setState('error', { message: `The previous update did not report completion. Check the app before trying again. Helper log: ${path.join(pending.workDir, 'apply.log')}` });
        setTimeout(check, 60000);
      } catch { check(); }
    }
    const timer = setInterval(check, 6 * 60 * 60 * 1000);
    timer.unref();
  }
  return { getStatus: () => state, check, install, start };
}

// Pure parsing and download helpers support isolated fixture tests; production always uses RELEASE_URL.
module.exports = { createUpdater, compareVersions, parseRelease, fetchRelease, downloadAsset };
