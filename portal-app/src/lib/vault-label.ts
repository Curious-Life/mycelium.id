// The vault's display LABEL — what the vault is CALLED in the UI (the sidebar
// footer, Settings → Your vault). ONE centralized chain so it can never drift
// across the sites that render it (ONBOARDING-WIZARD-DESIGN reconciliation #4:
// before this, only Sidebar derived the label inline and "My Mycelium" existed
// nowhere in code).
//
// The chain is HANDLE-FIRST: a claimed handle IS the vault's name; with no handle
// the vault takes the default **"My Mycelium"** (the Step-1-skipped default).
//
// ⚠️ DISTINCT from the avatar-INITIAL chain (R2-AVATAR / U2.5: displayName →
// @handle → '?', displayName-FIRST). These answer two different questions — what
// the vault is CALLED vs. which letter to show in the avatar — and must NOT be
// collapsed onto one ordering. Do not route the avatar initial through this helper.

/** The default vault name shown until a handle is claimed. */
export const DEFAULT_VAULT_LABEL = 'My Mycelium';

/**
 * The vault's display label from the (public profile) handle.
 * Handle-first: `@<handle>` when claimed, else "My Mycelium".
 */
export function vaultDisplayLabel(handle: string | null | undefined): string {
	const h = (handle || '').trim();
	return h ? `@${h}` : DEFAULT_VAULT_LABEL;
}

// ── Reading the handle off GET /portal/profile ───────────────────────────────
// ⚠️ THE SHAPE IS NESTED, AND GETTING IT WRONG IS SILENT. The route replies
// `{ profile: { handle, avatar_url, … } }` (portal-compat.js:436 — `ok(res, { profile:
// await readProfile() })`, and `ok` is `res.json(body)` verbatim, so nothing unwraps it).
//
// Sidebar read `d?.handle` — the TOP level — so `userHandle` was ALWAYS null and the footer
// showed "My Mycelium" no matter what handle the user had claimed. The same line read
// `d?.avatar_url`, so a user's avatar never appeared either. Both failed SILENTLY: optional
// chaining on a missing key is indistinguishable from "no handle set", which is exactly the
// state the fallback is designed for. Reported by the operator on v0.1.14: "even after i have
// set a handle it still shows my mycelium".
//
// These accessors exist so the shape is stated ONCE, next to the label chain that consumes
// it, and can be driven by a gate — a path hand-written at each call site is a path that
// drifts from the route the moment either side moves.

/** The profile response as the route actually sends it. */
export interface ProfileResponse {
	profile?: { handle?: string | null; avatar_url?: string | null } | null;
}

/** The claimed handle from GET /portal/profile, or null. Tolerates a missing/failed body. */
export function handleFromProfileResponse(d: ProfileResponse | null | undefined): string | null {
	return (d?.profile?.handle || '').trim() || null;
}

/** The avatar URL from GET /portal/profile, or null. */
export function avatarFromProfileResponse(d: ProfileResponse | null | undefined): string | null {
	return (d?.profile?.avatar_url || '').trim() || null;
}
