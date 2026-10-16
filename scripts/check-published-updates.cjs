const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createReadStream } = require('node:fs');
const { createHash } = require('node:crypto');
const trust = require('../updates/public.json');
const { verifyEnvelope, artifactUrl } = require('../updates/protocol.cjs');

async function main() {
  const root = path.resolve(__dirname, '..');
  const request = (url, options = {}) => fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(30000) });
  const response = await request(new URL('manifest.json', trust.defaultBaseUrl));
  assert.equal(response.status, 200);
  const release = verifyEnvelope(await response.text(), trust.publicKey);
  assert.equal(release.version, require('../package.json').version);
  const artifacts = [];
  for (const [platform, artifact] of Object.entries(release.artifacts)) {
    const local = path.join(root, 'release', `v${release.version}`, path.basename(artifact.file));
    const digest = createHash('sha256');
    for await (const bytes of createReadStream(local)) digest.update(bytes);
    assert.equal(digest.digest('hex'), artifact.sha256);
    assert.equal((await fs.stat(local)).size, artifact.size);
    const url = artifactUrl(trust.defaultBaseUrl, artifact);
    const head = await request(url, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(Number(head.headers.get('content-length')), artifact.size);
    const handle = await fs.open(local, 'r');
    try {
      for (const offset of [0, 8 * 1024 * 1024]) {
        const length = Math.min(1024, artifact.size - offset);
        const range = await request(url, { headers: { Range: `bytes=${offset}-${offset + length - 1}`, 'Accept-Encoding': 'identity' } });
        assert.equal(range.status, 206);
        assert.equal(range.headers.get('content-range'), `bytes ${offset}-${offset + length - 1}/${artifact.size}`);
        const expected = Buffer.alloc(length);
        await handle.read(expected, 0, length, offset);
        assert.deepEqual(Buffer.from(await range.arrayBuffer()), expected);
      }
    } finally { await handle.close(); }
    artifacts.push({ platform, size: artifact.size, sha256: artifact.sha256, httpsRangeVerified: true });
    console.log(`PASS ${platform}: signed local SHA-256, HTTPS length, first-byte and 8 MB Range`);
  }
  await fs.mkdir(path.join(root, 'test-results'), { recursive: true });
  await fs.writeFile(path.join(root, 'test-results/published-update-check.json'), JSON.stringify({ checkedAt: new Date().toISOString(), baseUrl: trust.defaultBaseUrl, version: release.version, signatureVerified: true, artifacts }, null, 2));
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
