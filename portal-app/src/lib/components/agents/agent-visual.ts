// agent-visual.ts — where the Agents surface maps agent/event semantics to design
// tokens. Before this, `colorMap` was copy-pasted into three components on this page
// and `rel()` into two, so a token rename had four places to miss.
//
// NOT the repo-wide agent-colour authority: `lib/timeline/utils.ts` already exports
// an `agentColorVar()` for the timeline, with a deliberately narrower map (four keys,
// azure-by-default). Adding a second, silently divergent `agentColorVar` here is
// exactly the drift this file exists to stop, so it does not have one — what the page
// actually needs is the CHANNEL triplet below, which no existing helper provides.
//
// Everything returned here is a CSS custom-property reference, never a hex — the
// D-024 rule (a hardcoded fallback silently pins the page to dark mode).

/** Agent colour key → the RGB *channel triplet* token, so callers can add alpha:
 *  `rgb(var(--agent-rgb) / 0.12)`. This is the mechanism tokens.css documents. */
const COLOR_CHANNELS: Record<string, string> = {
	azure: 'var(--color-accent-rgb)',
	jade: 'var(--color-accent-jade-rgb)',
	coral: 'var(--color-accent-coral-rgb)',
	amethyst: 'var(--color-accent-amethyst-rgb)',
	aurum: 'var(--color-accent-aurum-rgb)',
	teal: 'var(--color-accent-teal-rgb)',
	rose: 'var(--color-accent-rose-rgb)',
};

export function agentColorChannels(key?: string | null): string {
	return COLOR_CHANNELS[key || ''] || 'var(--color-accent-amethyst-rgb)';
}

/** Deterministic avatar, keyed on the agent id. The character page imports these two
 *  so the same agent provably wears the same face on both surfaces — it used to hold a
 *  second copy of the derivation, which made "identical" a comment rather than a fact. */
function hashStr(s: string): number {
	let h = 0;
	for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
	return Math.abs(h);
}
export const avatarHue = (id: string): number => hashStr(id) % 360;
export const avatarGlyph = (id: string): string => String.fromCodePoint(0x1f331 + (hashStr(id) % 8));

/** "just now" / "4m ago" / "3h ago" / "2d ago". */
export function rel(ts: string | null | undefined): string {
	if (!ts) return '—';
	const diff = Date.now() - new Date(ts).getTime();
	if (!Number.isFinite(diff)) return '—';
	if (diff < 60_000) return 'just now';
	if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
	if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
	return `${Math.round(diff / 86_400_000)}d ago`;
}

/** Signed relative day, for a *future* timestamp (next cycle fire). */
export function relWhen(ts?: string | null): string {
	if (!ts) return '—';
	const diff = new Date(ts).getTime() - Date.now();
	if (!Number.isFinite(diff)) return '—';
	if (Math.abs(diff) < 3_600_000) return diff >= 0 ? `in ${Math.max(1, Math.round(diff / 60_000))}m` : `${Math.round(-diff / 60_000)}m ago`;
	if (Math.abs(diff) < 86_400_000) return diff >= 0 ? `in ${Math.round(diff / 3_600_000)}h` : `${Math.round(-diff / 3_600_000)}h ago`;
	const days = Math.round(diff / 86_400_000);
	return days >= 0 ? `in ${days}d` : `${-days}d ago`;
}

/** What woke the agent for this turn. */
export const SOURCE_COLOR: Record<string, string> = {
	chat: 'var(--color-accent-amethyst)',
	channel: 'var(--color-accent)',
	scheduler: 'var(--color-accent-aurum)',
};
export const SOURCE_LABEL: Record<string, string> = {
	chat: 'Chat',
	channel: 'Channels',
	scheduler: 'Cycles',
};

/** How the turn ended. */
export const STATUS_COLOR: Record<string, string> = {
	done: 'var(--color-accent-jade)',
	running: 'var(--color-accent)',
	queued: 'var(--color-text-tertiary)',
	failed: 'var(--color-accent-coral)',
	aborted: 'var(--color-accent-coral)',
	skipped: 'var(--color-text-tertiary)',
};
