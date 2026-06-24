<script lang="ts">
	// Unlock a passphrase-locked vault. Talks to /api/v1/account/unlock, which is
	// served in "locked mode" (before the vault opens), mirroring setup mode. A
	// forgotten passphrase falls back to the recovery key (/restore), which also
	// turns the passphrase lock off (Keychain ⊻ seal invariant).
	import { onMount } from 'svelte';

	type Mode = 'loading' | 'passphrase' | 'recovery';
	let mode = $state<Mode>('loading');
	let busy = $state(false);
	let error = $state<string | null>(null);
	let passphrase = $state('');
	let recoveryInput = $state('');

	function enterVault() { window.location.assign('/mindscape'); }

	onMount(async () => {
		try {
			const res = await fetch('/api/v1/account/status', { credentials: 'same-origin' });
			if (res.ok) {
				const s = await res.json();
				if (s.open) { enterVault(); return; }
				// Not actually locked (no passphrase, or never created) → the setup flow.
				if (s.needsSetup || !s.passphraseEnabled) { window.location.assign('/setup'); return; }
			}
		} catch { /* show the form regardless */ }
		mode = 'passphrase';
	});

	async function unlock() {
		if (!passphrase) return;
		busy = true; error = null;
		try {
			const res = await fetch('/api/v1/account/unlock', {
				method: 'POST', credentials: 'same-origin',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ passphrase }),
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(data.message || data.error || 'Unlock failed');
			enterVault();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Unlock failed';
		} finally { busy = false; }
	}

	async function restoreWithKey() {
		const key = recoveryInput.trim().replace(/\s+/g, '');
		if (key.length !== 64) { error = 'Enter your 64-character recovery key'; return; }
		busy = true; error = null;
		try {
			const res = await fetch('/api/v1/account/restore', {
				method: 'POST', credentials: 'same-origin',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ recoveryKey: key }),
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(data.message || data.error || 'Restore failed');
			enterVault();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Restore failed';
		} finally { busy = false; }
	}
</script>

<svelte:head><title>Unlock — Mycelium</title></svelte:head>

<div class="min-h-screen flex flex-col bg-[var(--color-bg)]">
	<div class="absolute inset-0 bg-gradient-to-br from-azure/5 via-transparent to-amethyst/5 pointer-events-none"></div>
	<main class="flex-1 flex items-center justify-center p-6 relative overflow-y-auto">
		<div class="w-full max-w-md">
			<div class="text-center mb-6">
				<h1 class="text-3xl font-light text-[var(--color-text-primary)] mb-2 lowercase tracking-wide">mycelium</h1>
				<p class="text-aurum text-3xl font-semibold uppercase" style="letter-spacing: 0.45em; padding-left: 0.45em;">Vault</p>
			</div>

			{#if error}
				<div class="mb-6 p-4 bg-coral/10 border border-coral/30 rounded-lg text-[var(--color-text-primary)] text-sm">{error}</div>
			{/if}

			{#if mode === 'loading'}
				<div class="h-48 flex items-center justify-center text-[var(--color-text-tertiary)] animate-pulse">Loading…</div>

			{:else if mode === 'passphrase'}
				<div class="card-elevated p-8 space-y-6">
					<div class="text-center">
						<h2 class="text-lg font-medium text-[var(--color-text-primary)] mb-2">Unlock your vault</h2>
						<p class="text-sm text-[var(--color-text-secondary)] leading-relaxed">
							Enter your passphrase to open your vault on this Mac.
						</p>
					</div>
					<input bind:value={passphrase} type="password" placeholder="Passphrase"
						autocomplete="current-password"
						onkeydown={(e) => { if (e.key === 'Enter') unlock(); }}
						class="input w-full text-sm" />
					<button onclick={unlock} disabled={busy || !passphrase}
						class="w-full btn btn-primary py-3.5 disabled:opacity-50 disabled:cursor-not-allowed">
						{busy ? 'Unlocking…' : 'Unlock'}
					</button>
					<button onclick={() => { error = null; mode = 'recovery'; }}
						class="w-full text-sm text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] transition-colors py-2">
						Forgot your passphrase? Use your recovery key
					</button>
				</div>

			{:else if mode === 'recovery'}
				<div class="card-elevated p-8 space-y-6">
					<div class="text-center">
						<h2 class="text-lg font-medium text-[var(--color-text-primary)] mb-2">Unlock with your recovery key</h2>
						<p class="text-sm text-[var(--color-text-secondary)] leading-relaxed">
							Paste your 64-character recovery key. This opens the vault and turns the
							passphrase lock off — you can set a new one in Settings.
						</p>
					</div>
					<input bind:value={recoveryInput} type="password" placeholder="Paste your recovery key"
						autocomplete="off" spellcheck="false" data-1p-ignore data-lpignore="true"
						class="input w-full text-sm font-mono tracking-wide" />
					<button onclick={restoreWithKey} disabled={busy || recoveryInput.trim().replace(/\s+/g, '').length < 64}
						class="w-full btn btn-primary py-3.5 disabled:opacity-50 disabled:cursor-not-allowed">
						{busy ? 'Unlocking…' : 'Unlock with recovery key'}
					</button>
					<button onclick={() => { error = null; mode = 'passphrase'; }}
						class="w-full text-sm text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] transition-colors py-2">
						← Back to passphrase
					</button>
				</div>
			{/if}

			<div class="mt-8 text-center">
				<p class="text-xs text-[var(--color-text-tertiary)]"><span class="opacity-40">Encrypted on this device</span> · mycelium.id</p>
			</div>
		</div>
	</main>
</div>
