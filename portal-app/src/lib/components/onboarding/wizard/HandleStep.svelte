<script lang="ts">
	// Wizard Step 1 — Claim your handle (U1.2). The handle IS the user's identity,
	// their private home, AND the vault name (no separate vault-name step). Reuses
	// the live availability check + save the legacy welcome modal used.
	//
	// ⚠️ NO PREFILL (locked decision 2). The field starts EMPTY — no OS-name seed,
	// no ghost text, no suggestion chip. The handle is PUBLIC; an OS-derived value
	// sitting in the field could be claimed by accident.
	import { api } from '$lib/api';

	let { onNext }: { onNext: () => void } = $props();

	// DNS-safe rule mirrors identity.js for the live hint; the SERVER is the
	// authority on save. 2–32 chars, must start/end alphanumeric.
	const HANDLE_RE = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/;

	let handleInput = $state(''); // ⚠️ empty — never prefilled (decision 2)
	let handleState = $state<'idle' | 'checking' | 'available' | 'taken' | 'invalid'>('idle');
	let saving = $state(false);
	let saveErr = $state('');
	let handleTimer: ReturnType<typeof setTimeout> | null = null;

	async function getJSON(path: string): Promise<any | null> {
		try { const r = await api(path); return r.ok ? await r.json() : null; } catch { return null; }
	}

	function onInput() {
		handleState = 'idle';
		saveErr = '';
		if (handleTimer) clearTimeout(handleTimer);
		const h = handleInput.trim().toLowerCase();
		if (!h) return;
		if (!HANDLE_RE.test(h)) { handleState = 'invalid'; return; }
		handleState = 'checking';
		handleTimer = setTimeout(async () => {
			const d = await getJSON(`/portal/profile/handle/check?handle=${encodeURIComponent(h)}`);
			handleState = d ? (d.available ? 'available' : 'taken') : 'idle';
		}, 400);
	}

	async function claim() {
		const h = handleInput.trim().toLowerCase();
		if (!h || handleState !== 'available' || saving) return;
		saving = true; saveErr = '';
		try {
			const res = await api('/portal/profile', { method: 'PUT', body: JSON.stringify({ handle: h }) });
			if (!res.ok) { saveErr = 'Could not claim that handle — try another, or do this later.'; return; }
			onNext();
		} catch {
			saveErr = 'Could not claim that handle — try another, or do this later.';
		} finally { saving = false; }
	}

	const typed = $derived(handleInput.trim().toLowerCase());
</script>

<div class="step-body">
	<h1 class="title">Claim your handle</h1>
	<p class="lede">It's your name here, your private home, and how people connect to you.</p>

	<div class="handle-field" class:invalid={handleState === 'invalid' || handleState === 'taken'} class:ok={handleState === 'available'}>
		<span class="at">@</span>
		<input
			class="handle-input"
			type="text"
			maxlength="32"
			bind:value={handleInput}
			oninput={onInput}
			onkeydown={(e) => { if (e.key === 'Enter') claim(); }}
			placeholder="yourname"
			aria-label="Handle"
			autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" />
		<span class="suffix">.mycelium.id</span>
	</div>

	{#if handleState !== 'idle'}
		<p class="handle-hint {handleState === 'available' ? 'ok' : handleState === 'checking' ? '' : 'bad'}">
			{handleState === 'checking' ? 'checking…'
				: handleState === 'available' ? 'available ✓'
				: handleState === 'taken' ? 'that handle is taken'
				: 'use a–z, 0–9 and dashes'}
		</p>
	{/if}
	{#if saveErr}<p class="handle-hint bad">{saveErr}</p>{/if}

	<div class="actions">
		<button class="primary" disabled={handleState !== 'available' || saving} onclick={claim}>
			{saving ? 'Claiming…' : typed && handleState === 'available' ? `Claim @${typed}` : 'Claim handle'}
		</button>
	</div>
</div>

<style>
	.step-body { display: flex; flex-direction: column; }
	.title {
		font-family: var(--font-serif, 'Geist', system-ui, sans-serif);
		font-size: 1.55rem; font-weight: 400; line-height: 1.15; letter-spacing: -0.015em;
		color: var(--color-text-primary); margin: 0 0 0.6rem;
	}
	.lede { font-size: 0.92rem; line-height: 1.55; color: var(--color-text-secondary); margin: 0 0 1.4rem; }
	.handle-field {
		display: flex; align-items: center; gap: 0.15rem;
		padding: 0.6rem 0.8rem; border-radius: 11px;
		background: var(--glass-input-bg, rgba(0, 0, 0, 0.2));
		border: 1px solid var(--glass-input-border, rgba(255, 255, 255, 0.14));
		transition: border-color 0.15s ease;
	}
	.handle-field.ok { border-color: var(--color-accent-aurum, #e5b84c); }
	.handle-field.invalid { border-color: var(--color-coral, #e5736b); }
	.at { color: var(--color-text-tertiary); font-size: 0.95rem; }
	.handle-input {
		flex: 1; min-width: 0; border: none; outline: none; background: transparent;
		font-family: inherit; font-size: 0.95rem; color: var(--color-text-primary);
	}
	.handle-input::placeholder { color: var(--color-text-tertiary); }
	.suffix { color: var(--color-text-tertiary); font-size: 0.9rem; white-space: nowrap; }
	.handle-hint { font-size: 0.76rem; margin: 0.5rem 0 0; color: var(--color-text-tertiary); }
	.handle-hint.ok { color: var(--color-accent-aurum, #e5b84c); }
	.handle-hint.bad { color: var(--color-coral, #e5736b); }
	.actions { margin-top: 1.6rem; }
	.primary {
		display: inline-flex; align-items: center; gap: 0.5rem;
		padding: 0.6rem 1.3rem; border-radius: 9px; border: none;
		background: var(--color-accent-aurum, #e5b84c); color: #0a0a0c;
		font-family: inherit; font-size: 0.88rem; font-weight: 500; cursor: pointer;
		transition: transform 0.15s ease, box-shadow 0.2s ease, opacity 0.15s ease;
	}
	.primary:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 6px 20px rgba(229, 184, 76, 0.25); }
	.primary:disabled { opacity: 0.5; cursor: default; }
</style>
