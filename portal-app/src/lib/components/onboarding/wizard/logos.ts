// Bundled, self-contained SVG marks for the "connect a conversational AI" cards
// (Step 3, Section 2). ⚠️ INLINE ONLY — never an external <img src> / hotlink:
// the app runs under a strict CSP (no external fetch) and these are decorative
// geometric marks (not the vendors' registered logos), rendered via {@html}.
// Each uses currentColor so it inherits the card's theme-aware text colour.

/** ▲ On your device — a private, on-box triangle/chip. */
export const LOGO_ONDEVICE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 3 19h18L12 3Z"/><path d="M12 10v5"/><path d="M9.5 15h5"/></svg>`;

/** ✦ Claude subscription — a four-point radiant spark. */
export const LOGO_CLAUDE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2.5c.4 3.9 2.6 6.1 6.5 6.5-3.9.4-6.1 2.6-6.5 6.5-.4-3.9-2.6-6.1-6.5-6.5 3.9-.4 6.1-2.6 6.5-6.5Z" transform="translate(0 3)"/></svg>`;

/** ◇ OpenRouter — a routed diamond node. */
export const LOGO_OPENROUTER = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4 20 12l-8 8-8-8 8-8Z"/><circle cx="12" cy="12" r="2.4"/></svg>`;

/** ⚙ A cloud API key — a key mark. */
export const LOGO_APIKEY = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="4"/><path d="m11 11 7 7"/><path d="m15.5 15.5 2-2"/><path d="m18 18 2-2"/></svg>`;
