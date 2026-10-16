import { nativeAudio } from './nativeAudio';
import { normalizeSourceUrl, sourceRequest, type SourceConfig, type SourceRequester, type SourceTrack } from './onlineSource';
import type { Track } from '../types';

export function cloudPreferences(value: Partial<Track>) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const fields = new Set(['favorite', 'lastPlayed', 'lyrics', 'lyricsSource', 'translationSource', 'translationAudit', 'onlineUpdatedAt']);
  return Object.fromEntries(Object.entries(value).filter(([field]) => fields.has(field))) as Partial<Track>;
}

export function cloudTrack(record: SourceTrack, config: SourceConfig, publicRead: boolean, request: SourceRequester = sourceRequest): Track {
  const streamUrl = new URL(`tracks/${record.metadata.id}/stream/audio`, normalizeSourceUrl(config.baseUrl)).href;
  const read = async (kind: 'audio' | 'cover', offset: number, length: number) => {
    const value = await request<{ data: string; offset: number; size: number; sha256: string }>({ method: 'GET', path: `/tracks/${record.metadata.id}/media/${kind}?offset=${offset}&length=${length}` });
    const descriptor = record[kind]!;
    if (value.offset !== offset || value.size !== descriptor.size || value.sha256 !== descriptor.sha256) throw new Error('云端文件变化，请刷新后重试。');
    return Uint8Array.from(atob(value.data), (character) => character.charCodeAt(0));
  };
  const audio = nativeAudio({ metadata: record.metadata, audio: { ...record.audio, file: '' } }, (_id, _kind, offset, length) => read('audio', offset, length), publicRead ? streamUrl : '');
  const cover = record.cover ? nativeAudio({ metadata: record.metadata, audio: { ...record.cover, file: '' } }, (_id, _kind, offset, length) => read('cover', offset, length), new URL(`tracks/${record.metadata.id}/stream/cover`, normalizeSourceUrl(config.baseUrl)).href) : undefined;
  return { ...record.metadata, audio, cover: publicRead ? cover : undefined, cloud: { source: normalizeSourceUrl(config.baseUrl), record, streamUrl, publicRead } };
}
export function mergeCloudTracks(local: Track[], cloud: Track[]) {
  const ids = new Set(local.map((track) => track.id));
  return [...local, ...cloud.filter((track) => !ids.has(track.id))];
}
