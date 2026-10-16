import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Track } from '../types';
import { normalizeSourceUrl, parseSourceConnection, supplementSourceMetadata, uploadSourceTrack, validateSourceTrack, type SourceRequester, type SourceTrack } from './onlineSource';

const createSource = createRequire(import.meta.url)('../../electron/online-source.cjs');
const content = Uint8Array.from([1, 2, 3, 4]);
const identifier = createHash('sha256').update(content).digest('hex');
const track: Track = { id: identifier, title: 'Song', artist: 'Artist', album: 'Album', duration: 1, format: 'wav', audio: new Blob([content], { type: 'audio/wav' }), lyrics: [{ time: 0, text: 'Light', translation: '光' }], favorite: true, addedAt: 1 };
const remote: SourceTrack = { metadata: { ...track, audio: undefined } as unknown as SourceTrack['metadata'], audio: { size: 4, type: 'audio/wav', sha256: identifier }, revision: 1, updatedAt: 1 };
const config = { baseUrl: 'https://example.com/music-library/', token: 'test-private-token', remember: true };
let directory: string | undefined;
beforeEach(() => {
  const entries = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => entries.get(key) || null, setItem: (key: string, value: string) => entries.set(key, value), removeItem: (key: string) => entries.delete(key) });
});
afterEach(async () => { vi.unstubAllGlobals(); if (directory) { expect(path.dirname(directory)).toBe(path.resolve(os.tmpdir())); expect(path.basename(directory)).toMatch(/^xq-source-test-/); await fs.rm(directory, { recursive: true, force: true }); directory = undefined; } });
describe('private online source', () => {
  it('imports only compatible private connection files, without enabling uploads', () => {
    const saved = parseSourceConnection(JSON.stringify({ format: 'xianqiji-source-connection', version: 1, ...config, token: 'private-test-connection-token', autoSync: true }));
    expect(saved.autoSync).toBe(false); expect(saved.remember).toBe(true);
    expect(parseSourceConnection(JSON.stringify({ baseUrl: config.baseUrl, writeToken: 'private-test-connection-token' })).token).toBe('private-test-connection-token');
    for (const value of [{ baseUrl: config.baseUrl, token: 'private-test-connection-token' }, { format: 'xianqiji-source-connection', version: 1, baseUrl: 'http://example.com/', token: 'private-test-connection-token' }, { format: 'xianqiji-source-connection', version: 2, ...config }]) expect(() => parseSourceConnection(JSON.stringify(value))).toThrow();
  });
  it('requires clean HTTPS addresses and validates metadata/content identity', () => {
    expect(normalizeSourceUrl(' https://example.com/music-library ')).toBe(config.baseUrl);
    for (const url of ['http://example.com', 'https://user:secret@example.com', 'https://example.com/?token=secret', 'https://example.com/#fragment']) expect(() => normalizeSourceUrl(url)).toThrow();
    expect(validateSourceTrack(remote)).toBe(remote);
    expect(() => validateSourceTrack({ ...remote, audio: { ...remote.audio, sha256: 'f'.repeat(64) } })).toThrow('指纹');
  });
  it('resumes an acknowledged chunk instead of restarting or publishing partial music', async () => {
    const id = 'a'.repeat(32); let committed = 0; let offset = 0; let interrupted = true;
    const request = vi.fn(async ({ path: route, body }: Parameters<SourceRequester>[0]) => {
      if (route === '/uploads') return { id, offsets: { audio: 0 } };
      if (route === `/uploads/${id}`) return { id, offsets: { audio: offset } };
      if (route.endsWith('/chunk')) { offset += atob((body as { data: string }).data).length; if (interrupted) { interrupted = false; throw new Error('Connection lost after server acknowledged'); } return { offset }; }
      if (route.endsWith('/finish')) { committed++; return remote; }
      throw Error('Unexpected request');
    }) as unknown as SourceRequester;
    await expect(uploadSourceTrack(track, 0, config, vi.fn(), new AbortController().signal, request)).rejects.toThrow('Connection lost');
    expect(committed).toBe(0);
    await uploadSourceTrack(track, 0, config, vi.fn(), new AbortController().signal, request);
    expect(committed).toBe(1);
    expect((request as ReturnType<typeof vi.fn>).mock.calls.filter(([value]) => value.path.endsWith('/chunk'))).toHaveLength(1);
  });
  it('preserves local translations, favorites and audio while filling only exact matched gaps', () => {
    const local = { ...track, lyrics: [{ time: 0, text: 'Light' }, { time: 2, text: 'Home', translation: '本地译文' }, { time: 3, text: 'Different' }] };
    const merged = supplementSourceMetadata(local, { ...remote.metadata, lyrics: [{ time: 0, text: 'Light', translation: '光' }, { time: 2, text: 'Home', translation: '线上译文' }, { time: 3, text: 'Other', translation: '不应套用' }] });
    expect(merged.lyrics.map((line) => line.translation)).toEqual(['光', '本地译文', undefined]); expect(merged.audio).toBe(track.audio); expect(merged.favorite).toBe(true);
  });
  it('returns an existing verified song as success without sending chunks or overwriting metadata', async () => {
    const request = vi.fn(async () => ({ existing: remote })) as unknown as SourceRequester;
    const progress = vi.fn();
    expect(await uploadSourceTrack({ ...track, title: 'Renamed duplicate' }, 0, config, progress, new AbortController().signal, request)).toEqual(remote);
    expect(request).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenLastCalledWith('音频已存在，上传成功 · Song');
    const invalid = vi.fn(async () => ({ existing: { ...remote, audio: { ...remote.audio, size: 99 } } })) as unknown as SourceRequester;
    await expect(uploadSourceTrack(track, 0, config, progress, new AbortController().signal, invalid)).rejects.toThrow('不符');
  });
  it('stores access tokens using encryption and refuses redirects or arbitrary IPC paths', async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'xq-source-test-'));
    const secret = 'private-source-token';
    const storage = { isEncryptionAvailable: () => true, encryptString: (text: string) => Buffer.from(text.split('').reverse().join('')), decryptString: (bytes: Buffer) => bytes.toString().split('').reverse().join('') };
    const fetch = vi.fn(async (_url: string, _options: RequestInit) => new Response(JSON.stringify({ product: 'xianqiji-online-library' })));
    const source = createSource({ directory, safeStorage: storage, fetch });
    await source.save({ ...config, token: secret });
    expect(await fs.readFile(path.join(directory, 'online-source.json'), 'utf8')).not.toContain(secret);
    const restored = createSource({ directory, safeStorage: storage, fetch }); expect((await restored.get()).token).toBe(secret);
    expect((await restored.get()).autoSync).toBe(false);
    await restored.save({ ...config, token: secret, autoSync: true });
    expect((await createSource({ directory, safeStorage: storage, fetch }).get()).autoSync).toBe(true);
    await restored.request({ method: 'GET', path: '/info' });
    await restored.request({ method: 'GET', path: `/tracks/${identifier}/verify` });
    expect(fetch.mock.calls[0][1].redirect).toBe('error');
    for (const route of ['//evil.com/token', '/../../private', '/uploads/not-a-session/chunk']) await expect(restored.request({ method: 'GET', path: route })).rejects.toThrow('无效');
    await restored.save({ ...config, token: secret, remember: false });
    expect((await createSource({ directory, safeStorage: storage, fetch }).get()).token).toBe('');
  });
  it('aborts before any server-side upload or payment request', async () => {
    const request = vi.fn(); const controller = new AbortController(); controller.abort();
    await expect(uploadSourceTrack(track, 0, config, vi.fn(), controller.signal, request as SourceRequester)).rejects.toThrow(); expect(request).not.toHaveBeenCalled();
  });
});
