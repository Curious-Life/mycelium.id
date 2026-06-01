<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { auth } from '$lib/stores/auth';

	type Status = 'verifying' | 'unbound' | 'error';

	let status = $state<Status>('verifying');
	let errorMessage = $state<string | null>(null);

	/**
	 * Parse Telegram's redirect-back payload.
	 *
	 * Telegram's redirect-flow returns auth fields as a URL fragment in the form
	 *   #tgAuthResult=<base64url-encoded-JSON>
	 * keeping the auth payload out of server access logs.
	 *
	 * Some browser/locale combinations have been observed delivering the same
	 * fields as a regular query string instead. We try both.
	 *
	 * Returns the raw widget fields (id, first_name, ..., auth_date, hash)
	 * untouched — the backend verifier owns all schema validation.
	 */
	function parseTelegramReturn(): Record<string, unknown> | null {
		// Fragment form: #tgAuthResult=<base64>
		const hash = window.location.hash || '';
		if (hash.includes('tgAuthResult=')) {
			const m = hash.match(/tgAuthResult=([^&]+)/);
			if (m) {
				try {
					// Telegram uses standard base64 with possible URL-encoded padding.
					const raw = decodeURIComponent(m[1]);
					// Convert to base64 (handle base64url variant just in case)
					const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
					const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
					const json = atob(b64 + pad);
					const parsed = JSON.parse(json);
					if (parsed && typeof parsed === 'object') return parsed;
				} catch {
					/* fall through to query-string attempt */
				}
			}
		}

		// Query-string form: ?id=...&first_name=...&hash=...
		const params = new URLSearchParams(window.location.search);
		if (params.has('id') && params.has('hash') && params.has('auth_date')) {
			const obj: Record<string, string> = {};
			for (const [k, v] of params.entries()) obj[k] = v;
			return obj;
		}

		return null;
	}

	async function loadSessionAndRedirect() {
		try {
			const r = await fetch('/auth/session', { credentials: 'same-origin' });
			if (r.ok) {
				const { user } = await r.json();
				auth.setUser(user);
			}
		} catch { /* ignore — best-effort store hydration */ }
		goto('/mindscape');
	}

	onMount(async () => {
		const fields = parseTelegramReturn();
		if (!fields) {
			status = 'error';
			errorMessage = 'Telegram returned no authorization data. Try logging in again.';
			return;
		}

		try {
			const res = await fetch('/portal/auth/channel/telegram-widget', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'same-origin',
				body: JSON.stringify({ payload: fields }),
			});
			const data = await res.json().catch(() => ({}));

			if (!res.ok) {
				status = 'error';
				errorMessage =
					typeof data?.error === 'string'
						? `Verification failed: ${data.error}`
						: 'Telegram verification failed.';
				return;
			}

			if (data?.session_kind === 'user') {
				await loadSessionAndRedirect();
				return;
			}

			// session_kind === 'visitor' (or anything other than 'user') — the
			// Telegram account is not linked to a user on this server.
			status = 'unbound';
		} catch (e) {
			status = 'error';
			errorMessage = e instanceof Error ? e.message : 'Telegram verification failed.';
		}
	});
</script>

<svelte:head>
	<title>Telegram — Mycelium</title>
</svelte:head>

<div class="min-h-screen flex flex-col items-center justify-center bg-[var(--color-bg)] p-6">
	<div class="w-full max-w-md">
		<div class="card-elevated p-8 text-center space-y-6">
			{#if status === 'verifying'}
				<svg class="animate-spin w-8 h-8 mx-auto text-aurum" fill="none" viewBox="0 0 24 24">
					<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
					<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
				</svg>
				<h2 class="text-lg font-medium text-[var(--color-text-primary)]">Verifying Telegram…</h2>
				<p class="text-sm text-[var(--color-text-secondary)]">One moment.</p>

			{:else if status === 'unbound'}
				<svg class="w-10 h-10 mx-auto text-[var(--color-text-tertiary)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
				</svg>
				<h2 class="text-lg font-medium text-[var(--color-text-primary)]">Telegram not linked</h2>
				<p class="text-sm text-[var(--color-text-secondary)] leading-relaxed">
					This Telegram account isn't linked to a vault on this server.
					Sign in with your passkey or master key first, then link Telegram from settings.
				</p>
				<a href="/login" class="inline-block btn btn-primary py-2.5 px-6">Back to login</a>

			{:else}
				<svg class="w-10 h-10 mx-auto text-coral" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
				</svg>
				<h2 class="text-lg font-medium text-[var(--color-text-primary)]">Login failed</h2>
				<p class="text-sm text-[var(--color-text-secondary)] leading-relaxed">
					{errorMessage || 'Something went wrong with the Telegram login.'}
				</p>
				<a href="/login" class="inline-block btn btn-primary py-2.5 px-6">Back to login</a>
			{/if}
		</div>

		<p class="text-center text-xs text-[var(--color-text-tertiary)] mt-6">
			<span class="opacity-40">Secured with WebAuthn</span> &middot; mycelium.id &middot; Your rights preserved.
		</p>
	</div>
</div>
