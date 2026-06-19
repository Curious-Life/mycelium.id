// portal-app/src/lib/import/catalog.ts — the ONE catalog of "what you can bring
// into Mycelium", shown in onboarding ("Bring your data in") and under Streams →
// Sources. Honest status per source (we never imply something imports when it
// can't): 'upload' (drop a file/folder now), 'connect' (live connector), 'soon'
// (planned — shown so people know it's coming, with how to prepare). Logos are
// inline SVG (the portal's convention — no icon lib); brand colours mirror
// $lib/streams/sources.ts so a source reads true at a glance.

export type ImportStatus = 'upload' | 'connect' | 'soon';

export interface SourceEntry {
	id: string;
	name: string;
	status: ImportStatus;
	blurb: string; // one short line — minimal text
	howto: string; // how to get the data (export path / connect step)
	color: string; // brand hue
	logo: string;  // inline SVG (24×24 viewBox), brand-filled where iconic
}

/** Public docs page describing every source + how to export it, in detail. */
export const DOCS_URL = 'https://mycelium.id/docs/handbook/bring-your-data';

export const STATUS_LABEL: Record<ImportStatus, string> = {
	upload: 'Upload now',
	connect: 'Connect',
	soon: 'Coming soon',
};

// ── Inline-SVG logos (24×24). Iconic brands get a recognisable glyph in brand
//    colour; abstract AI brands + data types get a clean mark. `fill="C"` is a
//    sentinel the component swaps for the entry colour so one glyph theming. ──
const L = {
	claude: `<svg viewBox="0 0 24 24" fill="none"><path d="M5 17 9.7 6h1.6L16 17h-2.1l-1-2.5H8.1L7 17H5Zm3.7-4.2h3.6L10.5 8.2 8.7 12.8Z" fill="C"/></svg>`,
	chatgpt: `<svg viewBox="0 0 24 24" fill="none" stroke="C" stroke-width="1.6"><circle cx="12" cy="12" r="7"/><path d="M12 5v14M5 8.5l14 7M19 8.5l-14 7" stroke-width="1.1" opacity=".55"/></svg>`,
	grok: `<svg viewBox="0 0 24 24" fill="none" stroke="C" stroke-width="1.7" stroke-linecap="round"><path d="M6 18 18 6M9 6h9v9"/></svg>`,
	claudecode: `<svg viewBox="0 0 24 24" fill="none" stroke="C" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m8 8-4 4 4 4M16 8l4 4-4 4M13 5l-2 14"/></svg>`,
	googledrive: `<svg viewBox="0 0 24 24"><path d="M8.6 3 3 13l2.8 5 5.6-10L8.6 3Z" fill="#0066DA"/><path d="M15.4 3H8.6l5.6 10h6.8L15.4 3Z" fill="#00AC47"/><path d="M21 18 18.2 13H6.8L9.6 18H21Z" fill="#FFBA00"/></svg>`,
	whatsapp: `<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 0 0-7.7 13.6L3 21l4.5-1.2A9 9 0 1 0 12 3Zm0 16.3a7.3 7.3 0 0 1-3.7-1l-.3-.2-2.7.7.7-2.6-.2-.3A7.3 7.3 0 1 1 12 19.3Zm4.1-5.5c-.2-.1-1.3-.7-1.5-.7-.2-.1-.4-.1-.5.1l-.7.8c-.1.2-.3.2-.5.1a6 6 0 0 1-3-2.6c-.2-.4.2-.4.5-1 .1-.2 0-.4 0-.5l-.7-1.6c-.2-.4-.4-.4-.5-.4h-.5c-.2 0-.5.1-.7.3-.8.8-.9 1.8-.4 2.9a9 9 0 0 0 3.6 3.9c1.6.8 2.3.8 3.1.7.5-.1 1.3-.6 1.5-1.1.2-.5.2-1 .1-1.1l-.6-.3Z" fill="#25D366"/></svg>`,
	telegram: `<svg viewBox="0 0 24 24"><path d="M21 4 2.6 11.1c-.9.4-.9 1.5 0 1.8l4.6 1.4 1.8 5.4c.2.6.9.7 1.3.3l2.6-2.4 4.6 3.4c.6.4 1.4.1 1.6-.6L22.5 5.3c.2-.9-.6-1.6-1.5-1.3ZM9.6 14.3l8-5.6-6.6 6.4-.2 3.2-1.2-4Z" fill="#2AABEE"/></svg>`,
	gmail: `<svg viewBox="0 0 24 24"><path d="M4 6h16v12H4z" fill="#fff"/><path d="M4 6v12h2.5V9.3L12 13l5.5-3.7V18H20V6h-2L12 10 6 6H4Z" fill="#EA4335"/></svg>`,
	obsidian: `<svg viewBox="0 0 24 24"><path d="m13 3 6 7-5 11-6-3-4-6 9-9Z" fill="#7C3AED"/><path d="m13 3 1.5 6L19 10l-5 11-1-9 0-9Z" fill="#9B87F5"/></svg>`,
	linkedin: `<svg viewBox="0 0 24 24"><rect x="2" y="2" width="20" height="20" rx="3" fill="#0A66C2"/><path d="M7 9.5V18M7 6.7v.1M11 18v-4.4c0-2.4 3-2.6 3 0V18" stroke="#fff" stroke-width="1.8" stroke-linecap="round" fill="none"/></svg>`,
	mycelium: `<svg viewBox="0 0 24 24" fill="none" stroke="C" stroke-width="1.7" stroke-linecap="round"><path d="M12 21v-7"/><path d="M4 11a8 8 0 0 1 16 0c0 1.5-3.6 2.5-8 2.5S4 12.5 4 11Z"/></svg>`,
	documents: `<svg viewBox="0 0 24 24" fill="none" stroke="C" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h6"/></svg>`,
	photos: `<svg viewBox="0 0 24 24" fill="none" stroke="C" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10" r="1.5"/><path d="m21 16-5-5L5 19"/></svg>`,
	audio: `<svg viewBox="0 0 24 24" fill="none" stroke="C" stroke-width="1.6" stroke-linecap="round"><path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2"/></svg>`,
	notes: `<svg viewBox="0 0 24 24" fill="none" stroke="C" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h14v12l-4 4H5z"/><path d="M15 20v-4h4M9 9h6M9 13h4"/></svg>`,
};

// Order: upload-now first (what people can do this minute), then connectors,
// then coming-soon. Within each, the most-asked-for first.
export const SOURCE_CATALOG: SourceEntry[] = [
	// ── Upload now ──
	{ id: 'claude', name: 'Claude', status: 'upload', color: '#D97757', logo: L.claude,
		blurb: 'Your Claude conversations & projects.',
		howto: 'claude.ai → Settings → Account → Export data. Drop the .zip here.' },
	{ id: 'chatgpt', name: 'ChatGPT', status: 'upload', color: '#10A37F', logo: L.chatgpt,
		blurb: 'Your full ChatGPT history.',
		howto: 'ChatGPT → Settings → Data controls → Export. Drop the .zip or conversations.json.' },
	{ id: 'obsidian', name: 'Obsidian', status: 'upload', color: '#9B87F5', logo: L.obsidian,
		blurb: 'Your whole vault — notes become documents.',
		howto: 'Choose your vault folder — every .md note + its images import. No export needed.' },
	{ id: 'documents', name: 'Documents', status: 'upload', color: 'var(--color-accent)', logo: L.documents,
		blurb: 'PDFs, Word, Markdown, text.',
		howto: 'Drop .pdf / .docx / .md / .txt — each becomes a readable document.' },
	{ id: 'notes', name: 'Notes', status: 'upload', color: 'var(--color-accent-aurum)', logo: L.notes,
		blurb: 'Loose notes & journals.',
		howto: 'Drop .md or .txt files (or a folder of them).' },
	{ id: 'photos', name: 'Photos', status: 'upload', color: 'var(--color-accent-teal)', logo: L.photos,
		blurb: 'Images — captioned on your device.',
		howto: 'Drop images; a local vision model captions them privately.' },
	{ id: 'audio', name: 'Audio', status: 'upload', color: 'var(--color-accent-amethyst)', logo: L.audio,
		blurb: 'Voice notes & recordings.',
		howto: 'Drop .mp3 / .m4a / .wav — stored encrypted, searchable by filename.' },
	{ id: 'mycelium', name: 'Mycelium vault', status: 'upload', color: 'var(--color-accent-jade)', logo: L.mycelium,
		blurb: 'Bring a whole vault home.',
		howto: 'Export from another Mycelium (Settings → Export) and drop the .zip — everything, re-encrypted here.' },
	// ── Connect (live sync) ──
	{ id: 'telegram', name: 'Telegram', status: 'connect', color: '#2AABEE', logo: L.telegram,
		blurb: 'Chat with your mind from Telegram.',
		howto: 'Connect a bot in Settings → Channels (token from @BotFather).' },
	{ id: 'email', name: 'Email (Gmail)', status: 'connect', color: '#EA4335', logo: L.gmail,
		blurb: 'Your inbox, synced.',
		howto: 'Connect Gmail in Settings → Connectors (OAuth).' },
	// ── Coming soon ──
	{ id: 'whatsapp', name: 'WhatsApp', status: 'soon', color: '#25D366', logo: L.whatsapp,
		blurb: 'Your chat history.',
		howto: 'WhatsApp chat export (.zip) support is coming — meanwhile drop the exported .txt as a document.' },
	{ id: 'google-drive', name: 'Google Drive', status: 'soon', color: '#00AC47', logo: L.googledrive,
		blurb: 'Docs & files from Drive.',
		howto: 'A Drive connector is coming — meanwhile download files and drop them here.' },
	{ id: 'claude-code', name: 'Claude Code', status: 'upload', color: 'var(--color-accent-teal)', logo: L.claudecode,
		blurb: 'Your coding sessions & transcripts.',
		howto: 'Run “Scan this Mac” to import your local sessions — clean (conversations only) or full (with tool calls).' },
	{ id: 'grok', name: 'Grok', status: 'soon', color: 'var(--color-text-secondary)', logo: L.grok,
		blurb: 'Your Grok conversations.',
		howto: 'Grok export support is coming — meanwhile paste/export as text and drop it.' },
	{ id: 'linkedin', name: 'LinkedIn', status: 'soon', color: '#0A66C2', logo: L.linkedin,
		blurb: 'Connections & messages.',
		howto: 'LinkedIn export parsing is coming — the export is detected but not yet ingested.' },
];
