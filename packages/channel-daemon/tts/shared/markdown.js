/**
 * Strip markdown formatting for cleaner speech synthesis.
 *
 * Lifted byte-for-byte from packages/bots/telegram-bot.js so admin
 * behavior is preserved. The Discord route used a simpler subset; we
 * unify on this one (a strict superset — Discord output won't change
 * because the extra rules only strip more aggressively).
 */
export function stripMarkdownForTTS(text) {
  return text
    .replace(/```[\s\S]*?```/g, '')          // code blocks
    .replace(/`[^`]+`/g, '')                 // inline code
    .replace(/^\s*[-*+] \[[ x]\]\s*/gm, '')  // task list markers
    .replace(/^\s*#{1,6}\s+/gm, '')          // heading markers
    .replace(/^\s*>\s?/gm, '')               // blockquote markers
    .replace(/^\s*[-*_]{3,}\s*$/gm, '')      // horizontal rules
    .replace(/\*{3}([^*]+)\*{3}/g, '$1')     // ***bold italic***
    .replace(/\*{2}([^*]+)\*{2}/g, '$1')     // **bold**
    .replace(/\*([^*]+)\*/g, '$1')           // *italic*
    .replace(/__([^_]+)__/g, '$1')           // __bold__
    .replace(/(?<!\w)_([^_]+)_(?!\w)/g, '$1') // _italic_
    .replace(/~~([^~]+)~~/g, '$1')           // ~~strike~~
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // [text](url)
    .replace(/^\s*[-*+]\s+/gm, '')           // bullet lists
    .replace(/^\s*\d+\.\s+/gm, '')           // numbered lists
    .replace(/[*_`#~]/g, '')                 // residual formatting chars
    .replace(/\n{3,}/g, '\n\n')              // collapse newlines
    .trim();
}
