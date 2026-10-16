import type { ExportEntry, ZipCheckpoint } from './transferTypes';

const chunkSize = 4 * 1024 * 1024;
const encoder = new TextEncoder();
const crcTable = Array.from({ length: 256 }, (_value, index) => {
  let checksum = index;
  for (let bit = 0; bit < 8; bit++) checksum = (checksum >>> 1) ^ (checksum & 1 ? 0xedb88320 : 0);
  return checksum >>> 0;
});

export function crcUpdate(state: number, bytes: Uint8Array): number {
  let checksum = state;
  for (const byte of bytes) checksum = crcTable[(checksum ^ byte) & 255] ^ (checksum >>> 8);
  return checksum >>> 0;
}

export function initialZipCheckpoint(): ZipCheckpoint { return { phase: 'header', entryIndex: 0, entryOffset: 0, offset: 0, crc: 0xffffffff, recordOffset: 0, records: [], centralIndex: 0, centralOffset: 0 }; }

function binary(size: number) {
  const bytes = new Uint8Array(size);
  return { bytes, view: new DataView(bytes.buffer) };
}
function unsigned64(view: DataView, offset: number, value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('归档偏移超出当前设备可处理范围。');
  view.setBigUint64(offset, BigInt(value), true);
}
function localHeader(entry: ExportEntry) {
  const name = encoder.encode(entry.name);
  const { bytes, view } = binary(30 + name.length + 20);
  view.setUint32(0, 0x04034b50, true); view.setUint16(4, 45, true); view.setUint16(6, 0x0808, true);
  view.setUint16(12, 0x21, true);
  view.setUint32(18, 0xffffffff, true); view.setUint32(22, 0xffffffff, true);
  view.setUint16(26, name.length, true); view.setUint16(28, 20, true); bytes.set(name, 30);
  const extra = 30 + name.length;
  view.setUint16(extra, 1, true); view.setUint16(extra + 2, 16, true); unsigned64(view, extra + 4, entry.size); unsigned64(view, extra + 12, entry.size);
  return bytes;
}
function descriptor(size: number, crc: number) {
  const { bytes, view } = binary(24);
  view.setUint32(0, 0x08074b50, true); view.setUint32(4, crc, true); unsigned64(view, 8, size); unsigned64(view, 16, size);
  return bytes;
}
function centralRecord(record: ZipCheckpoint['records'][number]) {
  const name = encoder.encode(record.name);
  const { bytes, view } = binary(46 + name.length + 28);
  view.setUint32(0, 0x02014b50, true); view.setUint16(4, 45, true); view.setUint16(6, 45, true); view.setUint16(8, 0x0808, true);
  view.setUint16(14, 0x21, true);
  view.setUint32(16, record.crc, true); view.setUint32(20, 0xffffffff, true); view.setUint32(24, 0xffffffff, true);
  view.setUint16(28, name.length, true); view.setUint16(30, 28, true); view.setUint32(42, 0xffffffff, true); bytes.set(name, 46);
  const extra = 46 + name.length;
  view.setUint16(extra, 1, true); view.setUint16(extra + 2, 24, true); unsigned64(view, extra + 4, record.size); unsigned64(view, extra + 12, record.size); unsigned64(view, extra + 20, record.offset);
  return bytes;
}
function footer(checkpoint: ZipCheckpoint) {
  const { bytes, view } = binary(98);
  view.setUint32(0, 0x06064b50, true); unsigned64(view, 4, 44); view.setUint16(12, 45, true); view.setUint16(14, 45, true);
  unsigned64(view, 24, checkpoint.records.length); unsigned64(view, 32, checkpoint.records.length);
  unsigned64(view, 40, checkpoint.offset - checkpoint.centralOffset); unsigned64(view, 48, checkpoint.centralOffset);
  view.setUint32(56, 0x07064b50, true); unsigned64(view, 64, checkpoint.offset); view.setUint32(72, 1, true);
  view.setUint32(76, 0x06054b50, true); view.setUint16(84, 0xffff, true); view.setUint16(86, 0xffff, true); view.setUint32(88, 0xffffffff, true); view.setUint32(92, 0xffffffff, true);
  return bytes;
}

export async function runZipCheckpoint(entries: ExportEntry[], checkpoint: ZipCheckpoint, operations: { read(entry: ExportEntry, offset: number, length: number): Promise<Uint8Array>; write(offset: number, bytes: Uint8Array): Promise<void>; save(checkpoint: ZipCheckpoint): Promise<void>; signal?: AbortSignal; onProgress?(checkpoint: ZipCheckpoint): void }) {
  let state = structuredClone(checkpoint);
  const commit = async (next: ZipCheckpoint) => { await operations.save(next); state = next; operations.onProgress?.(state); };
  while (state.phase !== 'done') {
    operations.signal?.throwIfAborted();
    const entry = entries[state.entryIndex];
    if (state.phase === 'header') {
      if (!entry) { await commit({ ...state, phase: 'central', centralOffset: state.offset }); continue; }
      const header = localHeader(entry);
      await operations.write(state.offset, header);
      await commit({ ...state, phase: 'data', recordOffset: state.offset, offset: state.offset + header.length, entryOffset: 0, crc: 0xffffffff });
    } else if (state.phase === 'data') {
      if (state.entryOffset >= entry.size) { await commit({ ...state, phase: 'descriptor' }); continue; }
      const length = Math.min(chunkSize, entry.size - state.entryOffset);
      const data = await operations.read(entry, state.entryOffset, length);
      if (data.byteLength !== length) throw new Error('源歌曲大小发生变化，请恢复原文件后继续。');
      const crc = crcUpdate(state.crc, data);
      await operations.write(state.offset, data);
      await commit({ ...state, crc, entryOffset: state.entryOffset + length, offset: state.offset + length });
    } else if (state.phase === 'descriptor') {
      const crc = (state.crc ^ 0xffffffff) >>> 0;
      const data = descriptor(entry.size, crc);
      await operations.write(state.offset, data);
      await commit({ ...state, phase: 'header', entryIndex: state.entryIndex + 1, offset: state.offset + data.length, entryOffset: 0, records: [...state.records, { name: entry.name, size: entry.size, crc, offset: state.recordOffset }] });
    } else if (state.phase === 'central') {
      if (state.centralIndex >= state.records.length) { await commit({ ...state, phase: 'footer' }); continue; }
      const data = centralRecord(state.records[state.centralIndex]);
      await operations.write(state.offset, data);
      await commit({ ...state, centralIndex: state.centralIndex + 1, offset: state.offset + data.length });
    } else {
      const data = footer(state);
      await operations.write(state.offset, data);
      await commit({ ...state, phase: 'done', offset: state.offset + data.length });
    }
  }
  return state;
}
