// Minimal markdown / front-matter parsing for Obsidian note import.
//
// No YAML dependency (the repo ships none — see package.json). This is a
// small, defensive front-matter reader that handles the common Obsidian
// shapes: `key: value`, inline lists `tags: [a, b]`, and block lists
//   tags:
//     - a
//     - b
// Anything it can't parse is ignored rather than thrown — a note must never
// fail to import because its front-matter is exotic.

const FM_RE = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Split a note into { frontmatter, body }. No front-matter → {}, full text. */
export function parseFrontmatter(raw) {
  const text = typeof raw === 'string' ? raw : '';
  const m = FM_RE.exec(text);
  if (!m) return { frontmatter: {}, body: text };
  const body = text.slice(m[0].length);
  const fm = {};
  const lines = m[1].split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    i += 1;
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const kv = /^([A-Za-z0-9_.\- ]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1].trim();
    const rawVal = kv[2].trim();
    if (rawVal === '') {
      // Possible block list — consume following `  - item` lines.
      const list = [];
      while (i < lines.length && /^\s*-\s+/.test(lines[i])) {
        list.push(lines[i].replace(/^\s*-\s+/, '').trim().replace(/^["']|["']$/g, ''));
        i += 1;
      }
      fm[key] = list.length ? list.filter(Boolean) : '';
    } else if (/^\[.*\]$/.test(rawVal)) {
      // Inline flow list: [a, b, c]
      fm[key] = rawVal.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    } else {
      fm[key] = rawVal.replace(/^["']|["']$/g, '');
    }
  }
  return { frontmatter: fm, body };
}

/**
 * Parse an Obsidian note into { title, body, frontmatter, tags }.
 *   title  — front-matter `title` → first `# H1` → filename stem
 *   tags   — front-matter `tags` (list or csv) ∪ inline `#tag`
 *   body   — note text with the front-matter block stripped, trimmed
 */
export function parseMarkdownNote(raw, relPath = '') {
  const { frontmatter, body } = parseFrontmatter(raw);

  let title = typeof frontmatter.title === 'string' ? frontmatter.title : '';
  if (!title) {
    const h1 = /^#\s+(.+)$/m.exec(body);
    if (h1) title = h1[1].trim();
  }
  if (!title && relPath) {
    const base = relPath.split('/').pop() || relPath;
    title = base.replace(/\.md$/i, '');
  }

  const tags = new Set();
  const fmTags = frontmatter.tags;
  if (Array.isArray(fmTags)) {
    for (const t of fmTags) if (t) tags.add(String(t).replace(/^#/, ''));
  } else if (typeof fmTags === 'string' && fmTags) {
    for (const t of fmTags.split(/[,\s]+/)) if (t) tags.add(t.replace(/^#/, ''));
  }
  // Inline #tags: `#` immediately followed by a word char (so `# Heading`
  // and `## Sub` markdown headers — which have a space or another `#` — never match).
  const inline = body.match(/(?:^|\s)#([A-Za-z0-9_][A-Za-z0-9_/-]*)/g) || [];
  for (const t of inline) tags.add(t.trim().replace(/^#/, ''));

  return { title, body: body.trim(), frontmatter, tags: [...tags] };
}
