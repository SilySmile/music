import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { generateKeyPairSync, sign } from 'node:crypto';
const { baseUrl, compareVersions, verifyEnvelope, artifactUrl } = createRequire(import.meta.url)('../../updates/protocol.cjs');
const keys = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { format: 'pem', type: 'spki' }, privateKeyEncoding: { format: 'pem', type: 'pkcs8' } });
const now = Date.now();
const payload = { schema: 1, product: 'xianqiji', version: '0.3.10', issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 86400000).toISOString(), notes: '修复和更新', artifacts: { 'win-x64': { kind: 'nsis', file: 'releases/v0.3.10/App.exe', size: 123, sha256: 'a'.repeat(64) } } };
function envelope(value = payload) { const bytes = Buffer.from(JSON.stringify(value)); return JSON.stringify({ algorithm: 'RSA-SHA256', payload: bytes.toString('base64'), signature: sign('sha256', bytes, keys.privateKey).toString('base64') }); }
describe('signed update protocol', () => {
  it('normalizes custom domains and update directories without accepting cleartext or credentials', () => {
    expect(baseUrl('music.example.com')).toBe('https://music.example.com/music-updates/');
    expect(baseUrl('https://music.example.com/files')).toBe('https://music.example.com/files/');
    for (const url of ['http://music.example.com', 'https://user:pass@music.example.com', 'file:///tmp/test', 'https://music.example.com/?key=x', 'https://music.example.com/#x', '']) expect(() => baseUrl(url)).toThrow();
  });
  it('compares numeric release versions correctly', () => {
    expect(compareVersions('0.3.10', '0.3.9')).toBe(1); expect(compareVersions('1.0.0', '1.0.0')).toBe(0); expect(compareVersions('1.0.0', '2.0.0')).toBe(-1); expect(() => compareVersions('v1.0.0', '1.0.0')).toThrow();
  });
  it('verifies a publisher signature and resolves artifacts relative to the currently configured domain', () => {
    expect(verifyEnvelope(envelope(), keys.publicKey, now).version).toBe('0.3.10');
    expect(artifactUrl('https://new.example.com/music-updates/', payload.artifacts['win-x64'])).toBe('https://new.example.com/music-updates/releases/v0.3.10/App.exe');
  });
  it('rejects tampered, foreign, expired and unsafe manifests', () => {
    const changed = JSON.parse(envelope()); changed.payload = Buffer.from(JSON.stringify({ ...payload, notes: 'tampered' })).toString('base64'); expect(() => verifyEnvelope(JSON.stringify(changed), keys.publicKey, now)).toThrow('签名');
    expect(() => verifyEnvelope(envelope({ ...payload, expiresAt: new Date(now - 1).toISOString() }), keys.publicKey, now)).toThrow('过期');
    expect(() => verifyEnvelope(envelope({ ...payload, product: 'other' }), keys.publicKey, now)).toThrow();
    expect(() => verifyEnvelope(envelope({ ...payload, artifacts: { 'win-x64': { ...payload.artifacts['win-x64'], file: '../App.exe' } } }), keys.publicKey, now)).toThrow('路径');
  });
});
