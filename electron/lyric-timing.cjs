function timedWords(line) {
  const words = line.words;
  if (line.time < 0 || !Array.isArray(words) || !words.length || words.length > 6000) return;
  let previous = line.time;
  for (const word of words) {
    if (!word || typeof word.text !== 'string' || !word.text.length || !Number.isFinite(word.time) || word.time < previous || (word.endTime !== undefined && (!Number.isFinite(word.endTime) || word.endTime < word.time))) return;
    previous = word.time;
  }
  return words.map((word) => word.text).join('') === line.text ? words : undefined;
}
function timestamp(seconds, precision = 3) {
  const scale = 10 ** precision;
  const ticks = Math.round(Math.max(0, seconds) * scale);
  return `${String(Math.floor(ticks / (60 * scale))).padStart(2, '0')}:${String(Math.floor(ticks / scale) % 60).padStart(2, '0')}.${String(ticks % scale).padStart(precision, '0')}`;
}
function enhancedText(line) {
  const words = timedWords(line);
  const marker = (words && line.wordTiming === 'estimated' ? '[x-timing:estimated]' : '') + (Number.isFinite(line.endTime) && line.time >= 0 && line.endTime > line.time ? `[x-end:${timestamp(line.endTime)}]` : '');
  return marker + (words ? words.map((word, index) => `<${timestamp(word.time)}>${word.text}${word.endTime !== undefined && word.endTime !== words[index + 1]?.time ? `<${timestamp(word.endTime)}>` : ''}`).join('') : line.text);
}
module.exports = { timedWords, timestamp, enhancedText };
