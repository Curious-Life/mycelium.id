// portal-app/src/lib/streams/sources.ts — CLIENT presentation map for the Streams
// source spectrum. The server (src/streams/source-registry.js) owns classification
// (source → kind + canonical key); this owns *presentation* (label, brand colour,
// monogram) so every source is identifiable at a glance. Unknown sources get a
// neutral default — never a void.
//
// Colours: prefer the app's accent tokens; brand-specific sources use a literal
// brand hue (a brand registry, not theming) so Gmail/Linear/Obsidian read true.

export type StreamKind = 'messaging' | 'connector' | 'knowledge' | 'agent' | 'device' | 'portal' | 'task' | 'other';

export interface SourcePresentation {
  title: string;   // human label
  mono: string;    // 2-char monogram for the chip badge
  color: string;   // CSS colour (token var or brand hex)
}

// Faint group headers, in display order.
export const KIND_ORDER: StreamKind[] = ['messaging', 'connector', 'agent', 'knowledge', 'device', 'portal', 'task', 'other'];
export const KIND_LABEL: Record<StreamKind, string> = {
  messaging: 'Messaging', connector: 'Connectors', agent: 'Agents',
  knowledge: 'Knowledge', device: 'Devices', portal: 'Portal', task: 'Tasks', other: 'Other',
};

const MAP: Record<string, SourcePresentation> = {
  telegram: { title: 'Telegram', mono: 'TG', color: 'var(--color-accent-jade)' },
  whatsapp: { title: 'WhatsApp', mono: 'WA', color: 'var(--color-accent-aurum)' },
  discord: { title: 'Discord', mono: 'DC', color: 'var(--color-accent-amethyst)' },
  gmail: { title: 'Gmail', mono: 'GM', color: '#EA4335' },
  linear: { title: 'Linear', mono: 'LN', color: '#5E6AD2' },
  obsidian: { title: 'Obsidian', mono: 'OB', color: '#9B87F5' },
  'claude-import': { title: 'Claude', mono: 'CL', color: 'var(--color-accent-coral)' },
  'chatgpt-import': { title: 'ChatGPT', mono: 'GP', color: 'var(--color-accent-teal)' },
  import: { title: 'Import', mono: 'IM', color: 'var(--color-text-secondary)' },
  upload: { title: 'Uploads', mono: 'UP', color: 'var(--color-accent-teal)' },
  'claude-code': { title: 'Claude Code', mono: 'CC', color: 'var(--color-accent-teal)' },
  gateway: { title: 'Gateway', mono: 'GW', color: 'var(--color-accent-teal)' },
  opencode: { title: 'opencode', mono: 'OC', color: 'var(--color-accent-teal)' },
  openclaw: { title: 'openclaw', mono: 'OW', color: 'var(--color-accent-teal)' },
  hermes: { title: 'Hermes', mono: 'HM', color: 'var(--color-accent-teal)' },
  bridge: { title: 'Bridge', mono: 'BR', color: 'var(--color-accent-teal)' },
  mcp: { title: 'MCP', mono: 'MC', color: 'var(--color-accent-teal)' },
  apple: { title: 'Apple', mono: 'AP', color: '#E0A3C0' },
  apple_health: { title: 'Apple Health', mono: 'HK', color: '#E0A3C0' },
  portal: { title: 'Portal', mono: 'WB', color: 'var(--color-accent)' },
  api: { title: 'API', mono: 'AP', color: 'var(--color-accent)' },
  task: { title: 'Tasks', mono: 'TK', color: 'var(--color-accent-aurum)' },
  unknown: { title: 'Unknown', mono: '··', color: 'var(--color-text-tertiary)' },
};

const DEFAULT: SourcePresentation = { title: '', mono: '··', color: 'var(--color-text-secondary)' };

/** Presentation for a canonical source key (as returned by the spectrum). */
export function sourcePresentation(source: string): SourcePresentation {
  if (MAP[source]) return MAP[source];
  // #10 namespaced connector instance ids (http-poll:<uuid>, webhook:<uuid>).
  if (source.startsWith('http-poll:') || source.startsWith('webhook:') || source.startsWith('connector:')) {
    return { title: source.split(':')[0], mono: 'API', color: 'var(--color-accent)' };
  }
  // Fall back to a titled default derived from the raw key.
  const title = source.charAt(0).toUpperCase() + source.slice(1);
  return { ...DEFAULT, title, mono: source.slice(0, 2).toUpperCase() };
}

// Mirror of the server canonicalSource (src/streams/source-registry.js): fold a
// raw message `source` to the spectrum's canonical key so a chip can filter the
// river. Strips per-chat id suffixes (telegram_123 → telegram) + variant names.
const SUFFIXED_HEADS = new Set(['telegram', 'telegram-group', 'discord', 'discord-thread']);
const CANONICAL: Record<string, string> = {
  'telegram-group': 'telegram', 'discord-thread': 'discord', 'inference:chat': 'portal',
  'apple-health': 'apple_health', 'portal-chat': 'portal',
};
export function canonicalClientSource(raw: string | null | undefined): string {
  if (!raw) return 'unknown';
  const s = String(raw).trim();
  let base = s;
  const us = s.indexOf('_');
  if (us > 0 && SUFFIXED_HEADS.has(s.slice(0, us))) base = s.slice(0, us);
  // Sub-source paths fold to their head ('claude-code/subagent' → 'claude-code').
  const slash = base.indexOf('/');
  if (slash > 0) base = base.slice(0, slash);
  return CANONICAL[base] || base;
}

/** Colour for a status dot. */
export function statusColor(status: string): string {
  switch (status) {
    case 'live': return 'var(--color-accent-jade)';
    case 'synced': return 'var(--color-accent)';
    case 'error': return 'var(--color-accent-coral)';
    default: return 'var(--color-text-tertiary)'; // idle
  }
}

/** "2m ago" / "3d ago" / "—" from an ISO timestamp. */
export function relativeTime(iso: string | null): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}
