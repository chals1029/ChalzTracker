'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { compareVersions, parseRelease, downloadAsset } = require('../updater');

function release(version) {
  const name = `ChalzTracker-v${version}-Windows-x64.zip`;
  return {
    tag_name: `v${version}`,
    draft: false,
    prerelease: false,
    assets: [{
      name,
      digest: `sha256:${'a'.repeat(64)}`,
      size: 5,
      browser_download_url: `https://github.com/chals1029/ChalzTracker/releases/download/v${version}/${name}`
    }]
  };
}

test('only a newer stable release with the expected verified Windows asset is offered', () => {
  assert.equal(compareVersions('2.10.0', '2.9.9'), 1);
  assert.equal(parseRelease(release('2.1.0'), '2.1.0'), null);
  assert.equal(parseRelease(release('2.10.0'), '2.9.9').version, '2.10.0');
  const badDigest = release('2.10.0');
  badDigest.assets[0].digest = null;
  assert.throws(() => parseRelease(badDigest, '2.9.9'), /SHA-256/);
  const badUrl = release('2.10.0');
  badUrl.assets[0].browser_download_url = 'https://example.com/update.zip';
  assert.throws(() => parseRelease(badUrl, '2.9.9'), /URL/);
});

test('download rejects corrupted content even when its size matches', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chalz-updater-test-'));
  const originalGet = https.get;
  https.get = (_url, _options, callback) => {
    const req = new EventEmitter();
    req.setTimeout = () => {};
    process.nextTick(() => {
      const response = Readable.from([Buffer.from('hello')]);
      response.statusCode = 200;
      response.headers = {};
      callback(response);
    });
    return req;
  };
  try {
    const digest = crypto.createHash('sha256').update('hello').digest('hex');
    const asset = { url: 'https://github.com/example', size: 5, digest };
    await downloadAsset(asset, path.join(dir, 'valid.zip'), () => {});
    assert.equal(fs.readFileSync(path.join(dir, 'valid.zip'), 'utf8'), 'hello');
    await assert.rejects(downloadAsset({ ...asset, digest: '0'.repeat(64) }, path.join(dir, 'bad.zip'), () => {}), /SHA-256/);
  } finally {
    https.get = originalGet;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
