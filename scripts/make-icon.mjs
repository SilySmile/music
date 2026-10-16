import fs from 'node:fs/promises';
import zlib from 'node:zlib';

const size = 256;
const pixels = Buffer.alloc(size * (size * 4 + 1));

function roundedRectangle(column, row, left, top, right, bottom, radius) {
  const horizontal = Math.max(left + radius - column, 0, column - right + radius);
  const vertical = Math.max(top + radius - row, 0, row - bottom + radius);
  return column >= left && column <= right && row >= top && row <= bottom && horizontal ** 2 + vertical ** 2 <= radius ** 2;
}

for (let row = 0; row < size; row++) {
  for (let column = 0; column < size; column++) {
    const offset = row * (size * 4 + 1) + 1 + column * 4;
    const inside = roundedRectangle(column, row, 8, 8, 247, 247, 56);
    const distance = Math.hypot(column - 128, row - 120);
    const arc = row <= 124 && distance > 56 && distance < 68;
    const leftCup = roundedRectangle(column, row, 59, 117, 84, 177, 10) && !roundedRectangle(column, row, 68, 128, 75, 166, 3);
    const rightCup = roundedRectangle(column, row, 172, 117, 197, 177, 10) && !roundedRectangle(column, row, 181, 128, 188, 166, 3);
    const tailRadius = Math.hypot(column - 159, row - 165);
    const tail = column >= 159 && row >= 165 && tailRadius > 25 && tailRadius < 35 || column >= 137 && column <= 159 && row >= 190 && row <= 200;
    const white = arc || leftCup || rightCup || tail;
    const color = white ? [255, 247, 233] : [221, 114, 86];
    color.forEach((value, channel) => { pixels[offset + channel] = value; });
    pixels[offset + 3] = inside ? 255 : 0;
  }
}

function chunk(type, data) {
  const name = Buffer.from(type);
  const bytes = Buffer.concat([name, data]);
  let checksum = 0xffffffff;
  for (const byte of bytes) { checksum ^= byte; for (let bit = 0; bit < 8; bit++) checksum = (checksum >>> 1) ^ (checksum & 1 ? 0xedb88320 : 0); }
  const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length); bytes.copy(output, 4); output.writeUInt32BE((checksum ^ 0xffffffff) >>> 0, data.length + 8);
  return output;
}

const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
const icoHeader = Buffer.alloc(22); icoHeader.writeUInt16LE(1, 2); icoHeader.writeUInt16LE(1, 4); icoHeader.writeUInt16LE(1, 10); icoHeader.writeUInt16LE(32, 12); icoHeader.writeUInt32LE(png.length, 14); icoHeader.writeUInt32LE(22, 18);
await fs.mkdir('build', { recursive: true });
await fs.mkdir('public', { recursive: true });
await fs.writeFile('build/icon.ico', Buffer.concat([icoHeader, png]));
await fs.writeFile('public/icon.png', png);
console.log('弦栖霁应用图标已生成。');
