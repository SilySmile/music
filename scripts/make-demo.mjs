import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import JSZip from 'jszip';

const sampleRate = 22050;
const seconds = 36;
const themes = [
  { name: '01 - 晨光来信', artist: '弦栖霁合成器', root: 48, color: [175, 162, 125], lines: ['A little light arrives at dawn', 'The quiet room begins to glow', 'We let the morning take its time', 'And follow where the soft winds go', 'Keep a little peace inside', 'Let this moment gently stay'], translations: ['一束微光在黎明抵达', '安静的房间渐渐明亮', '让清晨慢慢展开', '跟随轻风去往远方', '在心中留一点宁静', '让这一刻轻轻停留'] },
  { name: '02 - 海岛慢行', artist: '弦栖霁合成器', root: 53, color: [118, 155, 150], lines: ['The island hums a gentle tune', 'The waves return to touch the sand', 'No need to hurry through the blue', 'Just let the sunlight warm your hands', 'A slower rhythm finds its way', 'Across the water, through the day'], translations: ['小岛轻轻哼着旋律', '海浪一次次轻吻沙滩', '不必匆忙穿过这片蔚蓝', '让阳光温暖你的掌心', '缓慢的节奏找到方向', '越过海面，漫过日常'] },
  { name: '03 - 黄昏留白', artist: '弦栖霁合成器', root: 50, color: [184, 133, 106], lines: ['The evening folds its wings of gold', 'A softer color fills the sky', 'There is a story left untold', 'We watch the little clouds drift by', 'The day can rest, the night can sing', 'And silence holds a gentle spring'], translations: ['傍晚收起金色的羽翼', '天空染上柔和的色彩', '还有一个故事尚未讲完', '我们看着小小的云飘过', '白昼歇息，夜晚轻唱', '寂静里藏着温柔的春天'] },
];

function makeWave(root) {
  const count = sampleRate * seconds;
  const buffer = Buffer.alloc(44 + count * 2);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(count * 2, 40);
  const melody = [12, 16, 19, 23, 19, 16, 14, 12, 9, 12, 16, 19, 16, 12, 7, 9];
  const chords = [[0, 4, 7], [-3, 0, 4], [5, 9, 12], [7, 11, 14]];
  for (let sample = 0; sample < count; sample++) {
    const time = sample / sampleRate;
    const beat = Math.floor(time / 0.45);
    const phase = time % 0.45;
    const midi = root + melody[beat % melody.length];
    const frequency = 440 * 2 ** ((midi - 69) / 12);
    const envelope = (1 - Math.exp(-phase * 70)) * Math.exp(-phase * 6);
    const bell = (Math.sin(time * frequency * Math.PI * 2) + 0.23 * Math.sin(time * frequency * Math.PI * 4)) * envelope;
    const chord = chords[Math.floor(time / 3.6) % chords.length];
    const pad = chord.reduce((sum, note) => sum + Math.sin(time * 440 * 2 ** ((root + note - 69) / 12) * Math.PI * 2), 0) / 3;
    const fade = Math.min(1, time / 2, (seconds - time) / 3);
    const value = (bell * 0.24 + pad * 0.12) * fade;
    buffer.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32767), 44 + sample * 2);
  }
  return buffer;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, bytes) {
  const name = Buffer.from(type);
  const result = Buffer.alloc(bytes.length + 12);
  result.writeUInt32BE(bytes.length); name.copy(result, 4); bytes.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([name, bytes])), bytes.length + 8);
  return result;
}

function makeCover(color) {
  const size = 256;
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let row = 0; row < size; row++) {
    raw[row * (size * 3 + 1)] = 0;
    for (let column = 0; column < size; column++) {
      const sun = (column - 174) ** 2 + (row - 76) ** 2 < 36 ** 2;
      const hill = row > 175 + Math.sin(column / 55) * 29;
      const ridge = row > 220 - Math.sin(column / 80) * 34;
      const pixels = sun ? [230, 207, 153] : ridge ? [66, 89, 77] : hill ? [100, 119, 91] : color.map((value) => value + (1 - row / size) * 18);
      for (let channel = 0; channel < 3; channel++) raw[row * (size * 3 + 1) + 1 + column * 3 + channel] = Math.round(pixels[channel]);
    }
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}

const zip = new JSZip();
for (const theme of themes) {
  const base = `${theme.artist} - ${theme.name.slice(5)}`;
  const folder = zip.folder(theme.name);
  folder.file(`${base}.wav`, makeWave(theme.root));
  folder.file('cover.png', makeCover(theme.color));
  folder.file(`${base}.lrc`, '[00:00.00]原创合成音乐示例 · 以下文字非人声演唱\n' + theme.lines.map((line, index) => `[00:${String(3 + index * 5).padStart(2, '0')}.00]${line}`).join('\n'));
  folder.file(`${base}.zh.lrc`, '[00:00.00]弦栖霁 · 旋律与双语歌词演示\n' + theme.translations.map((line, index) => `[00:${String(3 + index * 5).padStart(2, '0')}.00]${line}`).join('\n'));
}
zip.file('说明.txt', '本包包含弦栖霁项目生成的原创合成器音乐与原创中英文本，用于验证导入、播放和双语歌词同步。非人声歌曲，歌词为同步文字演示。可自由使用。');
const output = path.resolve('public/demo');
await fs.mkdir(output, { recursive: true });
await fs.writeFile(path.join(output, '弦栖霁示例.zip'), await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } }));
console.log('原创示例包已生成：public/demo/弦栖霁示例.zip');
