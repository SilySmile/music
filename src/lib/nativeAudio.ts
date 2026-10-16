import { sha256 } from '@noble/hashes/sha2.js';
import type { StoredTrack } from '../types';
const urls = new WeakMap<Blob, string>();

export function nativeAudio(record: StoredTrack, reader = (id: string, kind: 'audio' | 'cover', offset: number, length: number) => window.tingyuDesktop!.readLibraryChunk(id, kind, offset, length), url = `xianqiji://library/${encodeURIComponent(record.metadata.id)}/audio`): Blob {
  const media = record.audio;
  class AudioFile extends Blob {
    constructor(private startOffset = 0, private endOffset = media.size, contentType = media.type) { super([], { type: contentType }); }
    get size() { return this.endOffset - this.startOffset; }
    slice(start = 0, end = this.size, contentType = ''): Blob {
      const from = start < 0 ? Math.max(this.size + start, 0) : Math.min(start, this.size);
      const to = end < 0 ? Math.max(this.size + end, 0) : Math.min(end, this.size);
      return new AudioFile(this.startOffset + from, this.startOffset + Math.max(from, to), contentType);
    }
    async arrayBuffer(): Promise<ArrayBuffer> {
      const output = new Uint8Array(this.size);
      for (let offset = 0; offset < this.size; offset += 4 * 1024 * 1024) {
        const bytes = new Uint8Array(await reader(record.metadata.id, 'audio', this.startOffset + offset, Math.min(4 * 1024 * 1024, this.size - offset)));
        if (bytes.length !== Math.min(4 * 1024 * 1024, this.size - offset)) throw new Error('音频文件不完整，请恢复备份。');
        output.set(bytes, offset);
      }
      if (this.startOffset === 0 && this.size === media.size && Array.from(sha256(output), (byte) => byte.toString(16).padStart(2, '0')).join('') !== media.sha256) throw new Error('音频校验失败，请恢复备份。');
      return output.buffer;
    }
    async text() { return new TextDecoder().decode(await this.arrayBuffer()); }
    async bytes(): Promise<Uint8Array<ArrayBuffer>> { return new Uint8Array(await this.arrayBuffer()); }
    stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
      let offset = 0;
      return new ReadableStream({ pull: async (controller) => {
        if (offset >= this.size) { controller.close(); return; }
        const length = Math.min(4 * 1024 * 1024, this.size - offset);
        controller.enqueue(new Uint8Array(await this.slice(offset, offset + length).arrayBuffer())); offset += length;
      } });
    }
  }
  const blob = new AudioFile();
  urls.set(blob, url);
  return blob;
}
export function nativeAudioUrl(blob: Blob) { return urls.get(blob); }
