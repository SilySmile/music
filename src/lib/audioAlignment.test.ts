import { describe, expect, it, vi } from 'vitest';
import { alignSpeechWords, alignmentSignature, needsWordAlignment, normalizeAudioAIUrl, readSpeechWords, validateAudioAI } from './audioAlignment';
import { generateWordAlignment, monoWav, prepareAlignmentAudio } from './audioAI';
import { parseLyrics } from './lyrics';
import type { AudioAIRequest, Track } from '../types';

const track: Track = { id: 'audio-hash', title: 'Fixture', artist: 'Singer', album: '', duration: 30, format: 'mp3', audio: new Blob(['audio']), lyrics: [{ time: 1, text: 'Hello, world!', translation: '你好世界' }, { time: 10, text: 'Stay here', translation: '留在这里' }], favorite: false, addedAt: 1 };
const config = { url: 'https://audio.example.test/v1', model: 'text-model', audioModel: 'whisper-1', key: 'fake-local-test-key', autoAlign: true };

describe('audio-backed word alignment', () => {
  it('retains an instrumental gap after the last recognized word and refuses cross-phrase words', () => {
    const lines = [{ time: 1, text: '你好' }, { time: 7, text: '再见' }];
    const words = [{ word: '你', start: 1, end: 2 }, { word: '好', start: 3, end: 4 }];
    expect(alignSpeechWords(lines, words).lyrics[0].endTime).toBe(4);
    expect(alignSpeechWords(lines, [{ ...words[0] }, { ...words[1], end: 8 }]).matched).toBe(0);
    expect(alignSpeechWords([{ ...lines[0], endTime: 3.5 }, lines[1]], words).matched).toBe(0);
    expect(alignSpeechWords(lines, [{ ...words[0], end: 3.5 }, words[1]]).matched).toBe(0);
  });
  it('routes audio to the same configured service and rejects text-only official services before upload', () => {
    expect(normalizeAudioAIUrl(config.url)).toBe('https://audio.example.test/v1/audio/transcriptions');
    expect(normalizeAudioAIUrl('https://audio.example.test/v1/chat/completions')).toBe('https://audio.example.test/v1/audio/transcriptions');
    expect(normalizeAudioAIUrl('https://api.openai.com')).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(() => validateAudioAI({ ...config, url: 'https://api.deepseek.com' })).toThrow('不能返回音频逐字时间戳');
    expect(() => validateAudioAI({ ...config, key: '' })).toThrow('API Key');
    expect(() => normalizeAudioAIUrl('http://audio.example.test')).toThrow('HTTPS');
  });
  it('uses sung word starts and explicit ends while preserving punctuation, spaces and Chinese', () => {
    const result = alignSpeechWords(track.lyrics, [{ word: 'Hello', start: 1.2, end: 1.6 }, { word: 'world', start: 3, end: 5 }, { word: 'Stay', start: 10, end: 10.4 }, { word: 'here', start: 10.7, end: 12 }]);
    expect(result).toMatchObject({ matched: 2, unmatched: 0 });
    expect(result.lyrics[0]).toEqual({ time: 1.2, endTime: 5, text: 'Hello, world!', translation: '你好世界', words: [{ time: 1.2, endTime: 1.6, text: 'Hello, ' }, { time: 3, endTime: 5, text: 'world!' }] });
    expect(track.lyrics[0].time).toBe(1); expect(track.lyrics[0].words).toBeUndefined();
    expect(needsWordAlignment({ lyrics: result.lyrics })).toBe(false);
  });
  it('retains unmatched text and translation instead of inventing timestamps or replacing the lyrics with ASR', () => {
    const result = alignSpeechWords(track.lyrics, [{ word: 'wrong', start: 1, end: 2 }, { word: 'Stay', start: 10, end: 11 }, { word: 'here', start: 11, end: 12 }]);
    expect(result).toMatchObject({ matched: 1, unmatched: 1 });
    expect(result.lyrics[0]).toBe(track.lyrics[0]);
    expect(result.lyrics[1].translation).toBe('留在这里');
  });
  it('chooses the correct repeated occurrence by the existing line time', () => {
    const result = alignSpeechWords([{ time: 10, text: 'Hello' }, { time: 20, text: 'Hello' }], [{ word: 'Hello', start: 3, end: 4 }, { word: 'Hello', start: 10.2, end: 11 }, { word: 'Hello', start: 20.3, end: 21 }]);
    expect(result.lyrics.map((line) => line.time)).toEqual([10.2, 20.3]);
  });
  it('does not split one Chinese ASR word into fabricated character intervals', () => {
    const result = alignSpeechWords([{ time: 1, text: '你好，世界', translation: 'Hello world' }], [{ word: '你好', start: 1, end: 2 }, { word: '世界', start: 3, end: 5 }]);
    expect(result.lyrics[0].words).toEqual([{ time: 1, endTime: 2, text: '你好，' }, { time: 3, endTime: 5, text: '世界' }]);
  });
  it('keeps existing real word timing and ignores credits when checking for missing timing', () => {
    const lyrics = [...parseLyrics('[00:01]<00:01>Hello<00:02>'), { time: 0, text: '作词：原作者' }];
    expect(needsWordAlignment({ lyrics })).toBe(false);
    expect(alignSpeechWords(lyrics, [{ word: 'Hello', start: 1.5, end: 2 }]).lyrics[0]).toBe(lyrics[0]);
  });
  it('rejects empty, segment-only, reversed or out-of-audio timestamps', () => {
    for (const data of [{ segments: [] }, { words: [] }, { words: [{ word: 'A', start: 2, end: 1 }] }, { words: [{ word: 'A', start: 30, end: 35 }] }, { words: [{ word: 'A', start: 4, end: 5 }, { word: 'B', start: 1, end: 2 }] }]) expect(() => readSpeechWords(data, 30)).toThrow();
    expect(readSpeechWords({ words: [{ word: 'Hi', start: 1, end: 2 }] }, 30)).toEqual([{ word: 'Hi', start: 1, end: 2 }]);
  });
  it('includes audio and source identity in checkpoints but never the API secret or translated text', () => {
    const first = alignmentSignature(track, config);
    const otherKey = { ...config, key: 'different' };
    expect(alignmentSignature({ ...track, lyrics: track.lyrics.map((line) => ({ ...line, translation: '编辑中文' })) }, otherKey)).toBe(first);
    expect(alignmentSignature({ ...track, id: 'different-audio' }, config)).not.toBe(first);
    expect(alignmentSignature({ ...track, lyrics: [{ time: 1, text: 'Different' }] }, config)).not.toBe(first);
  });
  it('awaits real audio recognition, uses the separate audio model and honors cancellation before submitting', async () => {
    const request = vi.fn(async (_request: AudioAIRequest, _signal: AbortSignal) => ({ words: [{ word: 'Hello', start: 1, end: 2 }, { word: 'world', start: 2, end: 3 }] }));
    const prepare = vi.fn(async () => ({ bytes: new Uint8Array([1, 2, 3]), filename: 'song.mp3', type: 'audio/mpeg' }));
    const result = await generateWordAlignment(track, config, new AbortController().signal, { request, prepare });
    expect(result.matched).toBe(1);
    expect(request.mock.calls[0][0]).toMatchObject({ model: 'whisper-1', url: 'https://audio.example.test/v1/audio/transcriptions', key: config.key });
    const aborted = new AbortController(); aborted.abort();
    await expect(generateWordAlignment(track, config, aborted.signal, { request, prepare: prepareAlignmentAudio })).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('materializes native audio bytes for multipart upload and writes valid mono WAV when conversion is needed', async () => {
    const audio = await prepareAlignmentAudio(track, new AbortController().signal);
    expect(audio.filename).toBe('song.mp3'); expect(new TextDecoder().decode(audio.bytes)).toBe('audio');
    const wav = monoWav(new Float32Array([-1, 0, 1]), 16000); const view = new DataView(wav.buffer);
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe('RIFF'); expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getInt16(44, true)).toBe(-32768); expect(view.getInt16(48, true)).toBe(32767);
  });
});
