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
