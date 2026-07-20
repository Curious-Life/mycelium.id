/**
 * Egress-layer markdown → Telegram converter (R2-TGFORMAT).
 *
 * The agent emits its natural rich markdown; this adapts it to Telegram at SEND
 * time — NOT via the model prompt (the model is unreliable at emitting valid
 * escaped markup; hermes deliberately keeps this at the egress layer). It is the
 * load-bearing correctness path: telegram-api.js sendMessage sends the HTML this
 * produces with `parse_mode:'HTML'`, and falls back to the ORIGINAL plaintext on
 * a Telegram 400 so a message is never lost.
 *
 * Why HTML (not MarkdownV2): HTML is the most forgiving Bot API mode — only
 * `< > &` need escaping, and it supports bold/italic/underline/strike/code/pre/
 * links/blockquote. MarkdownV2 requires escaping ~18 metacharacters everywhere
 * and mangles nested constructs.
 *
 * Unsupported constructs are DOWNGRADED, never dropped:
 *   headers (#..)      → <b>bold</b>
 *   tables (| a | b |) → bulleted row-groups under the header cells
 *   ordered/bullet lists (incl. nesting) → indented • / n. bullets
 *   fenced code ``` ```→ <pre>, inline `code` → <code>
 *
 * Security: all user/agent text is HTML-escaped BEFORE any tag is inserted, so a
 * literal `<script>` in the reply can never become live markup in the chat. Code
 * spans are extracted first and their contents escaped on re-insertion, so `*`/`_`
 * inside code is never treated as emphasis.
 */

export const TELEGRAM_MAX_LEN = 4096; // Telegram hard cap per message (HTML counts too).
// Chunk the MARKDOWN below this so tag expansion still fits under the hard cap;
// each chunk is converted INDEPENDENTLY so a tag/fence can never span a boundary.
const MD_CHUNK_BUDGET = 3500;

/** Escape the only three characters Telegram HTML treats as markup. */
export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// A table is a run of lines that each look like `| ... |`. Render small tables as
// bulleted row-groups (one group per data row, the first cell bolded as a heading,
// the rest as "• Header: value"); a header-only table degrades to plain bullets.
// Cells arrive ALREADY html-escaped (this runs after escapeHtml on the body).
function renderTable(rows) {
  const cells = rows.map((r) =>
    r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim()));
  // Drop separator rows (|---|:--:|) and fully-empty rows.
  const data = cells.filter((r) => !r.every((c) => c === '' || /^:?-{2,}:?$/.test(c)));
  if (data.length === 0) return [];
  const header = data[0];
  const body = data.slice(1);
  if (body.length === 0) return data.map((r) => r.filter(Boolean).map((c) => `• ${c}`).join('\n'));
  const out = [];
  for (const row of body) {
    const parts = [];
    if (row[0]) parts.push(`<b>${row[0]}</b>`);
    for (let i = 1; i < row.length; i++) {
      if (row[i]) parts.push(`• ${header[i] ? `${header[i]}: ` : ''}${row[i]}`);
    }
    if (parts.length) out.push(parts.join('\n'));
  }
  return out;
}

/**
 * Convert a markdown string to Telegram-flavoured HTML.
 * @param {string} md
 * @returns {string}
 */
export function markdownToTelegramHtml(md) {
  if (typeof md !== 'string' || md === '') return '';

  const codeBlocks = [];
  const inlineCodes = [];
  let text = md;

  // 1. Pull fenced code blocks out FIRST (raw), so their contents are never
  //    treated as markdown/emphasis. The \x00 sentinels can't appear in real text.
  text = text.replace(/```[^\n`]*\n?([\s\S]*?)```/g, (_m, code) => {
    const i = codeBlocks.push(code.replace(/\n+$/, '')) - 1;
    return `\x00CB${i}\x00`;
  });
  // 2. Then inline code.
  text = text.replace(/`([^`\n]+)`/g, (_m, code) => {
    const i = inlineCodes.push(code) - 1;
    return `\x00IC${i}\x00`;
  });

  // 3. Escape the body ONCE. Everything after this inserts trusted literal tags;
  //    the sentinels survive (no special chars). Code contents are re-escaped on
  //    re-insertion below.
  text = escapeHtml(text);

  // 4. Line-based constructs: headers, blockquotes, lists, tables.
  const lines = text.split('\n');
  const out = [];
  let tableBuf = [];
  const flushTable = () => { if (tableBuf.length) { out.push(...renderTable(tableBuf)); tableBuf = []; } };
  for (const line of lines) {
    if (/^\s*\|.*\|\s*$/.test(line)) { tableBuf.push(line); continue; }
    flushTable();

    const header = line.match(/^\s{0,3}(#{1,6})\s+(.*\S)\s*#*\s*$/);
    if (header) { out.push(`<b>${header[2]}</b>`); continue; }

    const hr = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line);
    if (hr) { out.push('──────────'); continue; }

    const quote = line.match(/^\s*&gt;\s?(.*)$/); // '>' was escaped to '&gt;'
    if (quote) { out.push(`<blockquote>${quote[1]}</blockquote>`); continue; }

    const li = line.match(/^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/);
    if (li) {
      const indent = li[1].replace(/\t/g, '  ');
      const depth = Math.min(Math.floor(indent.length / 2), 4);
      const marker = /^\d/.test(li[2]) ? li[2].replace(/\)$/, '.') : '•';
      out.push(`${'   '.repeat(depth)}${marker} ${li[3]}`);
      continue;
    }
    out.push(line);
  }
  flushTable();
  text = out.join('\n');

  // 5. Inline emphasis (on already-escaped text). Order: strongest markers first.
  text = text.replace(/\*\*([^\n]+?)\*\*/g, '<b>$1</b>');
  text = text.replace(/__([^\n]+?)__/g, '<b>$1</b>');
  text = text.replace(/~~([^\n]+?)~~/g, '<s>$1</s>');
  // Italic — single * or _ not adjacent to its double form / word chars.
  text = text.replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?!\*)/g, '$1<i>$2</i>');
  text = text.replace(/(^|[^_\w])_(?!\s)([^_\n]+?)_(?![_\w])/g, '$1<i>$2</i>');
  // Links [text](http…). URL was html-escaped already; guard the attribute quote.
  text = text.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_m, label, url) => `<a href="${url.replace(/"/g, '%22')}">${label}</a>`);

  // 6. Re-insert code with escaped contents.
  text = text.replace(/\x00CB(\d+)\x00/g, (_m, i) => `<pre>${escapeHtml(codeBlocks[Number(i)] ?? '')}</pre>`);
  text = text.replace(/\x00IC(\d+)\x00/g, (_m, i) => `<code>${escapeHtml(inlineCodes[Number(i)] ?? '')}</code>`);

  return text;
}

/**
 * Split MARKDOWN into chunks that stay under the budget, preferring paragraph
 * (blank-line) then line boundaries, and NEVER cutting inside a fenced code block
 * (keeps ``` fences balanced per chunk). Each chunk is converted independently by
 * the caller, so an HTML tag can never straddle two Telegram messages.
 * @param {string} text
 * @param {number} [budget]
 * @returns {string[]}
 */
export function chunkMarkdown(text, budget = MD_CHUNK_BUDGET) {
  const s = String(text ?? '');
  if (s.length <= budget) return s ? [s] : [];
  const parts = [];
  let rest = s;
  while (rest.length > budget) {
    const window = rest.slice(0, budget);
    let cut = window.lastIndexOf('\n\n');
    if (cut < budget * 0.4) cut = window.lastIndexOf('\n');
    if (cut < budget * 0.4) cut = budget; // no good boundary → hard cut
    // Keep code fences balanced: if the chunk would open a fence it doesn't close,
    // back up to just before that opening fence.
    let chunk = rest.slice(0, cut);
    if ((chunk.match(/```/g) || []).length % 2 !== 0) {
      const openIdx = chunk.lastIndexOf('```');
      if (openIdx > budget * 0.2) { cut = openIdx; chunk = rest.slice(0, cut); }
    }
    parts.push(chunk.replace(/\s+$/, ''));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest.trim()) parts.push(rest);
  return parts;
}

/**
 * Normalize a Telegram forum topic id to a positive integer, or null.
 * Bot API `message_thread_id` is a positive int; anything else is dropped so a
 * malformed value can never reach the wire (and General/no-topic stays default).
 * @param {*} v
 * @returns {number|null}
 */
export function normalizeThreadId(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}
