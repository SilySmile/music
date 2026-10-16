import { describe, expect, it } from 'vitest';
import { BlobReader, BlobWriter, ZipReader } from '@zip.js/zip.js';
import { crcUpdate, initialZipCheckpoint, runZipCheckpoint } from './zipCheckpoint';
import type { ExportEntry, ZipCheckpoint } from './transferTypes';

function fixture(length = 81) {
  const source = Uint8Array.from({ length }, (_value, index) => index % 251);
  const entries: ExportEntry[] = [{ name: '歌曲/原音.wav', size: source.length, source: { type: 'text', text: '' } }];
  const chunks = new Map<number, Uint8Array>();
  let saved = initialZipCheckpoint();
  const operations = {
    read: async (_entry: ExportEntry, offset: number, size: number) => source.slice(offset, offset + size),
    write: async (offset: number, bytes: Uint8Array) => { chunks.set(offset, bytes.slice()); },
    save: async (state: ZipCheckpoint) => { saved = structuredClone(state); },
  };
  return { source, entries, operations, checkpoint: () => saved, archive: () => {
    const output = new Uint8Array(saved.offset);
    for (const [offset, bytes] of chunks) output.set(bytes, offset);
    return output;
  } };
}

async function unpack(bytes: Uint8Array<ArrayBuffer>) {
  const reader = new ZipReader(new BlobReader(new Blob([bytes])));
  try {
    const entries = await reader.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].filename).toBe('歌曲/原音.wav');
    const entry = entries[0];
    if (entry.directory) throw new Error('Unexpected directory');
    return new Uint8Array(await (await entry.getData!(new BlobWriter(), { checkSignature: true })).arrayBuffer());
  } finally { await reader.close(); }
}

describe('resumable ZIP64 writer', () => {
  it('writes standard ZIP64 with original bytes and CRC verification', async () => {
    const data = fixture();
    await runZipCheckpoint(data.entries, initialZipCheckpoint(), data.operations);
    expect(Buffer.from(await unpack(data.archive())).equals(Buffer.from(data.source))).toBe(true);
  });
  it('resumes after a persisted 4 MB chunk rather than starting the file over', async () => {
    const data = fixture(5 * 1024 * 1024 + 19);
    const controller = new AbortController();
    await expect(runZipCheckpoint(data.entries, initialZipCheckpoint(), { ...data.operations, signal: controller.signal, onProgress: (state) => { if (state.entryOffset >= 4 * 1024 * 1024) controller.abort(); } })).rejects.toThrow();
    const checkpoint = data.checkpoint();
    expect(checkpoint.entryOffset).toBe(4 * 1024 * 1024);
    const offsets: number[] = [];
    await runZipCheckpoint(data.entries, checkpoint, { ...data.operations, read: async (entry, offset, size) => { offsets.push(offset); return data.operations.read(entry, offset, size); } });
    expect(offsets[0]).toBe(4 * 1024 * 1024);
    expect(Buffer.from(await unpack(data.archive())).equals(Buffer.from(data.source))).toBe(true);
  });
  it('overwrites an uncheckpointed write after a crash instead of duplicating it', async () => {
    const data = fixture();
    let crash = true;
    await expect(runZipCheckpoint(data.entries, initialZipCheckpoint(), { ...data.operations, save: async (state) => { if (state.entryOffset && crash) { crash = false; throw new Error('Simulated power loss'); } await data.operations.save(state); } })).rejects.toThrow('power loss');
    expect(data.checkpoint().entryOffset).toBe(0);
    await runZipCheckpoint(data.entries, data.checkpoint(), data.operations);
    expect(await unpack(data.archive())).toEqual(data.source);
  });
  it.each(['descriptor', 'central', 'footer', 'done'] as const)('resumes cleanly at the %s checkpoint', async (phase) => {
    const data = fixture();
    const controller = new AbortController();
    try { await runZipCheckpoint(data.entries, initialZipCheckpoint(), { ...data.operations, signal: controller.signal, onProgress: (state) => { if (state.phase === phase) controller.abort(); } }); } catch { expect(controller.signal.aborted).toBe(true); }
    expect(data.checkpoint().phase).toBe(phase);
    await runZipCheckpoint(data.entries, data.checkpoint(), data.operations);
    expect(await unpack(data.archive())).toEqual(data.source);
  });
  it('encodes offsets and lengths above 4 GB without allocating a giant file', async () => {
    const large = 0x100000000 + 17;
    const checkpoint = { ...initialZipCheckpoint(), phase: 'central' as const, offset: large + 100, centralOffset: large + 100, records: [{ name: 'huge.wav', size: large, crc: 123, offset: large + 1 }] };
    const writes: Uint8Array[] = [];
    await runZipCheckpoint([], checkpoint, { read: async () => new Uint8Array(), write: async (_offset, bytes) => { writes.push(bytes); }, save: async () => {} });
    const central = new DataView(writes[0].buffer);
    const extra = 46 + new TextEncoder().encode('huge.wav').length;
    expect(central.getBigUint64(extra + 4, true)).toBe(BigInt(large));
    expect(central.getBigUint64(extra + 20, true)).toBe(BigInt(large + 1));
    expect(new DataView(writes[1].buffer).getBigUint64(48, true)).toBe(BigInt(large + 100));
  });
  it('computes the canonical CRC32 checksum incrementally', () => {
    let checksum = crcUpdate(0xffffffff, new TextEncoder().encode('1234'));
    checksum = crcUpdate(checksum, new TextEncoder().encode('56789'));
    expect((checksum ^ 0xffffffff) >>> 0).toBe(0xcbf43926);
  });
});
