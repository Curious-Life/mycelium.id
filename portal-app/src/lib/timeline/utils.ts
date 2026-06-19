/**
 * Timeline view helpers — pure, side-effect free, deterministic.
 *
 * The timeline page joins three data streams:
 *   1. messages from /portal/messages (now with channel/sender/replyTo)
 *   2. agent registry from /portal/agents (display name, color, emoji)
 *   3. owner platform IDs from /portal/identity
 *
 * These helpers fold those streams into render-ready shapes so the
 * Svelte template stays declarative. All functions are pure — same
 * input → same output, no DOM, no fetch, no I/O.
 */

export type Source =
  | 'telegram'
  | 'telegram-group'
  | 'discord'
  | 'whatsapp'
  | 'portal'
  | 'unknown';

export interface TimelineMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  source: string;
  agent_id?: string | null;
  created_at: string;
  message_type?: string;
  attachment?: TimelineAttachment;
  // From PR 1's metadata projection:
  channel?: string | null;
  channelId?: string | null;
  senderName?: string | null;
  senderId?: string | null;
  replyTo?: string | null;
}

export interface TimelineAttachment {
  id: string;
  type: 'image' | 'voice' | 'video' | 'file';
  url: string;
  filename?: string | null;
  fileSize?: number | null;
  transcript?: string | null;
  description?: string | null;
}

export interface AgentInfo {
  id: string;
  name: string;
  color?: string | null;
  avatarEmoji?: string | null;
}

export interface OwnerIdentity {
  ownerName: string | null;
  ownerTelegramId: string | null;
  ownerDiscordId: string | null;
}

export interface SourceStyle {
  /** Two-letter badge label: TG, DC, WA, WB. Used as a fallback when
   *  iconPath is not rendered (e.g. very small viewports or screen
   *  readers prefer text). */
  label: string;
  /** SVG path data for the platform's brand mark. Rendered inside a
   *  24x24 viewBox. CC0 / public-domain glyphs from simple-icons.org
   *  (telegram, discord, whatsapp). */
  iconPath: string;
  /** Background colour token (rgba string referencing portal accents). */
  bg: string;
  /** Foreground colour token. */
  text: string;
  /** Long-form display name for tooltips/screen readers. */
  title: string;
}

// Brand glyphs (24x24 viewBox). Sourced from simple-icons.org which
// licenses these as CC0. Inlined to avoid a runtime fetch / extra dep.
const ICON_TELEGRAM =
  'M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.464.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.247-.024c-.105.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z';
const ICON_DISCORD =
  'M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419-.0188 1.3332-.946 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z';
const ICON_WHATSAPP =
  'M.057 24l1.687-6.163c-1.041-1.804-1.588-3.849-1.587-5.946.003-6.556 5.338-11.891 11.893-11.891 3.181.001 6.167 1.24 8.413 3.488 2.245 2.248 3.481 5.236 3.48 8.414-.003 6.557-5.338 11.892-11.893 11.892-1.99-.001-3.951-.5-5.688-1.448L.057 24zm6.597-3.807c1.676.995 3.276 1.591 5.392 1.592 5.448 0 9.886-4.434 9.889-9.885.002-5.462-4.415-9.89-9.881-9.892-5.452 0-9.887 4.434-9.889 9.884-.001 2.225.651 3.891 1.746 5.634l-.999 3.648 3.742-.981zm11.387-5.464c-.074-.124-.272-.198-.57-.347-.297-.149-1.758-.868-2.031-.967-.272-.099-.47-.149-.669.149-.198.297-.768.967-.941 1.165-.173.198-.347.223-.644.074-.297-.149-1.255-.462-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.297-.347.446-.521.151-.172.2-.296.3-.495.099-.198.05-.372-.025-.521-.075-.149-.669-1.611-.916-2.206-.242-.579-.487-.501-.669-.51l-.57-.01c-.198 0-.52.074-.792.372s-1.04 1.016-1.04 2.479 1.065 2.876 1.213 3.074c.149.198 2.095 3.2 5.076 4.487.711.306 1.266.489 1.699.626.714.227 1.363.195 1.879.118.572-.085 1.758-.719 2.006-1.413.248-.695.248-1.29.173-1.414z';
// Lucide-style globe outline for the portal (no brand attribution needed).
const ICON_PORTAL =
  'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 0 1-7.93-7H8v1a2 2 0 0 0 2 2 1 1 0 0 1 1 1v3.93zM18.93 13H15a2 2 0 0 0-2 2v3.93A8 8 0 0 0 18.93 13zM12 4a8 8 0 0 1 6.93 4H17a2 2 0 0 0-2 2v1h-4V9a2 2 0 0 0-2-2H6.93A7.99 7.99 0 0 1 12 4z';
const ICON_UNKNOWN =
  'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-1 15h2v-2h-2v2zm1.6-6.5c-.3.6-.9 1-1.6 1v1h-1c0-.8.2-1.6.6-2.2.4-.6 1-1 1.4-1.3.4-.3.5-.6.5-1a1.5 1.5 0 0 0-3 0H8a3 3 0 1 1 5 2.5z';

const SOURCE_STYLES: Record<Source, SourceStyle> = {
  'telegram':       { label: 'TG', iconPath: ICON_TELEGRAM, bg: 'rgba(74,222,128,0.10)',  text: 'var(--color-accent-jade)',     title: 'Telegram' },
  'telegram-group': { label: 'TG', iconPath: ICON_TELEGRAM, bg: 'rgba(74,222,128,0.18)',  text: 'var(--color-accent-jade)',     title: 'Telegram group' },
  'discord':        { label: 'DC', iconPath: ICON_DISCORD,  bg: 'rgba(167,139,250,0.10)', text: 'var(--color-accent-amethyst)', title: 'Discord' },
  'whatsapp':       { label: 'WA', iconPath: ICON_WHATSAPP, bg: 'rgba(229,184,76,0.10)',  text: 'var(--color-accent-aurum)',    title: 'WhatsApp' },
  'portal':         { label: 'WB', iconPath: ICON_PORTAL,   bg: 'rgba(91,159,232,0.10)',  text: 'var(--color-accent)',          title: 'Portal' },
  'unknown':        { label: '··', iconPath: ICON_UNKNOWN,  bg: 'var(--color-elevated)',  text: 'var(--color-text-tertiary)',   title: 'Unknown source' },
};

/**
 * Classify a raw source string into one of the canonical platforms.
 * Source strings come in many shapes — `telegram`, `telegram-group`,
 * `telegram_<chatId>`, `telegram-group_<id>`, `discord`,
 * `discord_<channelId>`, `whatsapp`, `portal`, `chat`, etc.
 *
 * The numeric/id suffix is dropped from the platform classification but
 * preserved as the second return value for callers that want it.
 */
export function parseSource(source: string | null | undefined): {
  platform: Source;
  id: string | null;
} {
  if (!source || typeof source !== 'string') return { platform: 'unknown', id: null };
  const s = source.trim();
  if (s.startsWith('telegram-group_')) return { platform: 'telegram-group', id: s.slice('telegram-group_'.length) };
  if (s === 'telegram-group')           return { platform: 'telegram-group', id: null };
  if (s.startsWith('telegram_'))        return { platform: 'telegram',       id: s.slice('telegram_'.length) };
  if (s === 'telegram')                  return { platform: 'telegram',       id: null };
  if (s.startsWith('discord_'))         return { platform: 'discord',        id: s.slice('discord_'.length) };
  if (s === 'discord')                   return { platform: 'discord',        id: null };
  if (s === 'whatsapp')                  return { platform: 'whatsapp',       id: null };
  if (s === 'portal' || s === 'chat')   return { platform: 'portal',         id: null };
  return { platform: 'unknown', id: null };
}

/** Look up the colour palette + label for a parsed source. */
export function getSourceStyle(platform: Source): SourceStyle {
  return SOURCE_STYLES[platform] || SOURCE_STYLES.unknown;
}

/**
 * Map an agent's `color` field (from agents/*.json) to a CSS variable.
 * Only the four palette accents (aurum/amethyst/coral/jade) have their
 * own var; everything else (azure, crimson, slate, …) falls back to
 * the default `--color-accent`. Without this fallback, unknown names
 * produce `var(--color-accent-crimson)` which CSS resolves to nothing.
 */
const AGENT_COLOR_VARS = new Set(['aurum', 'amethyst', 'coral', 'jade']);
export function agentColorVar(color: string | null | undefined): string {
  if (color && AGENT_COLOR_VARS.has(color)) return `var(--color-accent-${color})`;
  return 'var(--color-accent)';
}

export type SpeakerKind = 'owner' | 'agent' | 'human' | 'unknown';

export interface Speaker {
  kind: SpeakerKind;
  /** What to display in the row header. Already short, ready to render. */
  label: string;
  /** CSS colour token; defaults to the standard text colour for non-agents. */
  color: string;
  /** Optional emoji prefix (only set for agents that have one configured). */
  emoji: string | null;
}

/**
 * Pick a label + colour for the speaker of a single row.
 *
 * - role=assistant → resolve via the agent registry (display name, color, emoji).
 * - role=user with senderId matching ownerTelegramId / ownerDiscordId → "you" in aurum.
 * - role=user with a senderName but no owner match → real name in neutral text.
 * - role=user with no metadata → falls back to "you" (legacy/imported rows
 *   that pre-date metadata storage; safe default — these are almost
 *   always the operator on a single-user install).
 *
 * `agentMap` and `owner` may be partial / null on first paint; the
 * function tolerates that.
 */
export function classifySpeaker(
  msg: Pick<TimelineMessage, 'role' | 'agent_id' | 'senderName' | 'senderId' | 'source'>,
  owner: OwnerIdentity | null,
  agentMap: Map<string, AgentInfo> | null,
): Speaker {
  if (msg.role === 'assistant') {
    const info = msg.agent_id && agentMap ? agentMap.get(msg.agent_id) : null;
    if (info) {
      return {
        kind: 'agent',
        label: info.name,
        color: agentColorVar(info.color),
        emoji: info.avatarEmoji || null,
      };
    }
    return {
      kind: 'agent',
      label: msg.agent_id || 'agent',
      color: 'var(--color-accent)',
      emoji: null,
    };
  }

  // role === 'user'
  const { platform } = parseSource(msg.source);
  const senderId = msg.senderId ? String(msg.senderId) : null;

  if (senderId && owner) {
    if (
      (platform === 'telegram' || platform === 'telegram-group') &&
      owner.ownerTelegramId &&
      senderId === owner.ownerTelegramId
    ) {
      return {
        kind: 'owner',
        label: 'you',
        color: 'var(--color-accent-aurum)',
        emoji: null,
      };
    }
    if (platform === 'discord' && owner.ownerDiscordId && senderId === owner.ownerDiscordId) {
      return {
        kind: 'owner',
        label: 'you',
        color: 'var(--color-accent-aurum)',
        emoji: null,
      };
    }
  }

  // Non-owner human in a group, or any imported row with a known sender.
  if (msg.senderName) {
    return {
      kind: 'human',
      label: msg.senderName,
      color: 'var(--color-text-primary)',
      emoji: null,
    };
  }

  // No metadata at all — legacy import or a row that pre-dates the
  // metadata storage contract. Default to "you" because on a single-
  // user install the operator is overwhelmingly the inbound role=user.
  return {
    kind: 'owner',
    label: 'you',
    color: 'var(--color-accent-aurum)',
    emoji: null,
  };
}

const REPLY_PREFIX_RE =
  /^\[Replying to ([^']+)'s message:\s*"((?:[^"\\]|\\.)*)"\]\s*\n*/;

const GROUP_PREFIX_RE =
  /^\[Group:\s*"([^"]+)"(?:\s*\|\s*From:\s*([^\]]+))?\]\s*\n*/;

export interface ReplyContext {
  /** Name of the person being replied to (raw, may contain spaces). */
  replyToName: string | null;
  /** Quoted excerpt (already trimmed). */
  quote: string | null;
  /** Group title from `[Group: "..."]` prefix, if present. */
  groupTitle: string | null;
  /** Author identifier from `From:` portion of the group prefix. */
  groupAuthor: string | null;
  /** The remaining body after both prefixes are stripped. */
  body: string;
}

/**
 * Pull `[Replying to X's message: "..."]` and `[Group: "..." | From: ...]`
 * blocks off the front of a message. These come from telegram-bot.js's
 * group-context formatting and don't belong inline in the rendered text —
 * the UI shows them as a separate quote pill.
 */
export function extractReplyContext(content: string | null | undefined): ReplyContext {
  const empty: ReplyContext = {
    replyToName: null, quote: null,
    groupTitle: null, groupAuthor: null,
    body: '',
  };
  if (typeof content !== 'string' || !content) return empty;
  let body = content;
  let replyToName: string | null = null;
  let quote: string | null = null;
  let groupTitle: string | null = null;
  let groupAuthor: string | null = null;

  const replyMatch = body.match(REPLY_PREFIX_RE);
  if (replyMatch) {
    replyToName = replyMatch[1].trim() || null;
    quote = replyMatch[2].replace(/\\"/g, '"').trim() || null;
    body = body.slice(replyMatch[0].length);
  }

  const groupMatch = body.match(GROUP_PREFIX_RE);
  if (groupMatch) {
    groupTitle = groupMatch[1].trim() || null;
    groupAuthor = (groupMatch[2] || '').trim() || null;
    body = body.slice(groupMatch[0].length);
  }

  return {
    replyToName, quote,
    groupTitle, groupAuthor,
    body: body.trimStart(),
  };
}

/**
 * When a row has an attachment we already render (audio player, image,
 * video), the original message body often contains an inline placeholder
 * like `[Audio: voice_xxx.ogg]\nTranscription: ...` that the agent saw
 * in its prompt. We strip that header so the UI doesn't show the file
 * twice (once as a player, once as bracket text).
 *
 * The transcript is preserved in the attachment record itself, so we
 * only need to remove the header.
 */
export function stripAttachmentPlaceholder(
  content: string | null | undefined,
  attachment: TimelineAttachment | null | undefined,
): string {
  if (typeof content !== 'string' || !content) return '';
  if (!attachment) return content;
  if (attachment.type !== 'voice' && attachment.type !== 'video') return content;

  // Two-step strip — handles all observed shapes:
  //   [Audio: voice_xxx.ogg]                     (alone, no newline)
  //   [Audio: voice_xxx.ogg]\n                   (trailing newline only)
  //   [Audio: voice_xxx.ogg]\nTranscription: …   (with transcript)
  //   [Voice: …]\n\nTranscription: …             (extra spacing)
  //
  // The earlier single-regex version required a \n after the bracket and
  // missed bare placeholders, leaving them rendered.
  let body = content;
  // 1. Bracket header + any trailing whitespace/newlines.
  body = body.replace(/^\[(?:Audio|Voice|Video):\s*[^\]]+\]\s*/, '');
  // 2. Transcription block when it directly follows the bracket. Stops at
  //    a blank line or end-of-string. The transcript is preserved in
  //    attachment.transcript and rendered separately under the player.
  body = body.replace(/^Transcription:[^\n]*(?:\n(?!\n)[^\n]*)*\s*/, '');
  return body.trimStart();
}

/**
 * Format a date header for a group of messages: "Today" / "Yesterday" /
 * "Monday, April 27".
 */
export function formatDateHeader(date: Date, now: Date = new Date()): string {
  const today = now.toDateString();
  const yesterday = new Date(now.getTime() - 86400000).toDateString();
  const d = date.toDateString();
  if (d === today) return 'Today';
  if (d === yesterday) return 'Yesterday';
  return date.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  });
}

export function formatTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit',
  });
}

export function formatFileSize(bytes: number | null | undefined): string {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Build the channel label shown after the speaker. Empty string when
 * we have nothing useful — UI omits the separator dot in that case.
 *
 *   #general                 (Discord)
 *   Atmosphere Sense & Tune  (Telegram group)
 *   ''                       (DM, portal)
 */
export function formatChannelLabel(
  source: string,
  channel: string | null | undefined,
): string {
  const { platform } = parseSource(source);
  if (!channel) return '';
  if (platform === 'discord') {
    // Discord channel names already include the # in some metadata
    // shapes; normalise to one leading #.
    const trimmed = channel.replace(/^#+/, '');
    return `#${trimmed}`;
  }
  return channel;
}
