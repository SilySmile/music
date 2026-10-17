import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
const createUpdates = createRequire(import.meta.url)('../../electron/updates.cjs');
const keys = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { format: 'pem', type: 'spki' }, privateKeyEncoding: { format: 'pem', type: 'pkcs8' } });
const directories: string[] = [];
async function fixture(bytes = Buffer.from('fixture installer - must never execute')) {
  await fs.mkdir('test-results', { recursive: true }); const directory = await fs.mkdtemp(path.resolve('test-results/updater-')); directories.push(directory);
  const digest = createHash('sha256').update(bytes).digest('hex');
  function envelope(version = '0.3.10') {
    const payload = Buffer.from(JSON.stringify({ product: 'xianqiji', schema: 1, version, issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(), notes: 'Fixture update', artifacts: { 'win-x64': { kind: 'nsis', file: `releases/v${version}/App.exe`, size: bytes.length, sha256: digest } } }));
    return JSON.stringify({ algorithm: 'RSA-SHA256', payload: payload.toString('base64'), signature: sign('sha256', payload, keys.privateKey).toString('base64') });
  }
  const fetch = vi.fn(async (url: string, options: RequestInit = {}) => {
    if (url.endsWith('manifest.json')) return new Response(envelope());
    const range = new Headers(options.headers).get('range'); const offset = range ? Number(range.match(/\d+/)?.[0]) : 0;
    return new Response(bytes.subarray(offset), { status: range ? 206 : 200, headers: range ? { 'content-range': `bytes ${offset}-${bytes.length - 1}/${bytes.length}` } : {} });
  });
  const launch = vi.fn();
  const app = { getPath: (name: string) => name === 'temp' ? path.dirname(directory) : directory, getVersion: () => '0.3.9', quit: vi.fn() };
  const options = { app, fetch, testing: true, portable: false, launch, executable: path.join(directory, '弦栖霁.exe'), trustConfig: { publicKey: keys.publicKey, defaultBaseUrl: 'https://updates.example.test/music-updates/' } };
  return { directory, fetch, launch, app, options, envelope, digest };
}
afterEach(async () => { for (const directory of directories.splice(0)) { expect(path.dirname(directory)).toBe(path.resolve('test-results')); expect(path.basename(directory)).toMatch(/^(updater-|xianqiji-update-)/); await fs.rm(directory, { recursive: true, force: true }); } });
describe('Windows signed in-app updates', () => {
  it('runs a verified installer outside the installation tree and only then exits the player', async () => {
    const data = await fixture();
    const launch = vi.fn((filename: string, _args: string[], _options: Record<string, unknown>) => { directories.push(path.dirname(filename)); const child = Object.assign(new EventEmitter(), { unref: vi.fn() }); queueMicrotask(() => child.emit('spawn')); return child; });
    const updates = createUpdates({ ...data.options, testing: false, launch });
    await updates.check(); await updates.download();
    expect((await updates.install()).installed).toBe(true);
    expect(launch.mock.calls[0][1]).not.toContain('/S');
    const [staged, args, settings] = launch.mock.calls[0];
    expect(path.dirname(path.dirname(staged))).toBe(path.resolve('test-results'));
    expect(await fs.readFile(staged)).toEqual(await fs.readFile(path.join(data.directory, 'Updates', `${data.digest}.exe`)));
    expect(args).toContain('/XQ_STAGED'); expect(args.at(-1)).toBe(`/D=${data.directory}`);
    expect(settings).toMatchObject({ windowsHide: false, cwd: path.dirname(staged), detached: true, windowsVerbatimArguments: true, argv0: `"${staged}"` });
    await expect(updates.install()).rejects.toThrow('另一个');
    await new Promise((resolve) => setTimeout(resolve, 350)); expect(data.app.quit).toHaveBeenCalledTimes(1);
  });
  it('keeps the player open and the original download intact if installer startup fails', async () => {
    const data = await fixture();
    const launch = vi.fn((filename: string) => { directories.push(path.dirname(filename)); const child = Object.assign(new EventEmitter(), { unref: vi.fn() }); queueMicrotask(() => child.emit('error', new Error('launch denied'))); return child; });
    const updates = createUpdates({ ...data.options, testing: false, launch });
    await updates.check(); await updates.download();
    await expect(updates.install()).rejects.toThrow('launch denied');
    expect(data.app.quit).not.toHaveBeenCalled();
    expect((await fs.stat(path.join(data.directory, 'Updates', `${data.digest}.exe`))).size).toBeGreaterThan(0);
    await expect(updates.install()).rejects.toThrow('launch denied');
  });
  it('rejects a temporary directory inside the install tree before launching or exiting', async () => {
    const data = await fixture();
    const updates = createUpdates({ ...data.options, testing: false, app: { ...data.app, getPath: () => data.directory } });
    await updates.check(); await updates.download();
    await expect(updates.install()).rejects.toThrow('临时目录位于程序');
    expect(data.app.quit).not.toHaveBeenCalled(); expect(data.launch).not.toHaveBeenCalled();
  });
  it('saves a custom domain, checks and downloads a signed release, rechecks it before test installation', async () => {
    const fixtureData = await fixture(); const updates = createUpdates(fixtureData.options);
    expect((await updates.config()).autoCheck).toBe(false);
    expect((await updates.saveConfig({ baseUrl: 'new.example.test', autoCheck: true })).baseUrl).toBe('https://new.example.test/music-updates/');
    expect((await updates.check()).phase).toBe('available'); expect((await updates.download()).phase).toBe('downloaded');
    expect((await updates.install()).testVerified).toBe(true); expect(fixtureData.launch).not.toHaveBeenCalled();
    const restored = createUpdates(fixtureData.options); expect((await restored.config()).autoCheck).toBe(true); expect((await restored.check()).phase).toBe('downloaded');
    await fs.writeFile(path.join(fixtureData.directory, 'Updates', `${fixtureData.digest}.exe`), 'changed'); await expect(restored.install()).rejects.toThrow('改变');
  });
  it('resumes an interrupted download after creating a new updater instance', async () => {
    const data = await fixture(Buffer.alloc(8 * 1024 * 1024 + 1, 71)); let updates: ReturnType<typeof createUpdates>; let paused = false;
    data.fetch.mockImplementation(async (url: string, options: RequestInit = {}) => {
      if (url.endsWith('manifest.json')) return new Response(data.envelope());
      const range = new Headers(options.headers).get('range'); let offset = range ? Number(range.match(/\d+/)?.[0]) : 0; const start = offset;
      const stream = new ReadableStream({ pull(controller) { if (offset >= 8 * 1024 * 1024 + 1) { controller.close(); return; } const length = Math.min(4 * 1024 * 1024, 8 * 1024 * 1024 + 1 - offset); controller.enqueue(new Uint8Array(length).fill(71)); offset += length; } });
      return new Response(stream, { status: range ? 206 : 200, headers: range ? { 'content-range': `bytes ${start}-${8 * 1024 * 1024}/${8 * 1024 * 1024 + 1}` } : {} });
    });
    updates = createUpdates({ ...data.options, progress: (state: { phase: string; bytes: number }) => { if (!paused && state.phase === 'downloading' && state.bytes > 0) { paused = true; updates.pause(); } } });
    await updates.check(); expect((await updates.download()).phase).toBe('paused');
    const size = (await fs.stat(path.join(data.directory, 'Updates', `${data.digest}.exe.part`))).size; expect(size).toBeGreaterThan(0); expect(size).toBeLessThan(8 * 1024 * 1024 + 1);
    const resumed = createUpdates(data.options); expect((await resumed.download()).phase).toBe('downloaded');
    expect(new Headers(data.fetch.mock.calls.at(-1)?.[1]?.headers).get('range')).toBe(`bytes=${size}-`);
  });
  it('rejects unsigned manifests, redirection and rollback without launching an installer', async () => {
    const data = await fixture(); const updates = createUpdates(data.options);
    data.fetch.mockResolvedValueOnce(new Response('{}')); expect((await updates.check()).phase).toBe('error');
    data.fetch.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'http://other.test' } })); expect((await updates.check()).message).toContain('重定向');
    data.fetch.mockResolvedValueOnce(new Response(data.envelope('0.5.0'))); expect((await updates.check()).phase).toBe('available');
    data.fetch.mockResolvedValueOnce(new Response(data.envelope('0.4.0'))); expect((await updates.check()).message).toContain('倒退'); expect(data.launch).not.toHaveBeenCalled();
  });
});
