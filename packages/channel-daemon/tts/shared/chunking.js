/**
 * Split text at sentence boundaries for TTS, respecting a per-provider
 * char limit. Lifted from telegram-bot.js / routes/bots.js (identical
 * implementation in both — now unified).
 *
 * Strategy: find the last sentence terminator within maxLen, but no
 * earlier than 30% of maxLen (avoids tiny chunks). Falls back to last
 * space, then to a hard cut.
 */
export function splitTextForTTS(text, maxLen) {
  if (typeof maxLen !== 'number' || maxLen <= 0) {
    throw new TypeError(`splitTextForTTS: maxLen must be a positive number, got ${maxLen}`);
  }
  if (!text) return [];
  if (text.length <= maxLen) return [text];

  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) { chunks.push(remaining); break; }
    let breakAt = -1;
    for (const sep of ['. ', '! ', '? ', '.\n', '!\n', '?\n']) {
      const idx = remaining.lastIndexOf(sep, maxLen);
      if (idx > maxLen * 0.3 && idx > breakAt) breakAt = idx + sep.length;
    }
    if (breakAt <= 0) breakAt = remaining.lastIndexOf(' ', maxLen);
    if (breakAt <= 0) breakAt = maxLen;
    chunks.push(remaining.substring(0, breakAt).trim());
    remaining = remaining.substring(breakAt).trim();
  }
  return chunks.filter(c => c.length > 0);
}
