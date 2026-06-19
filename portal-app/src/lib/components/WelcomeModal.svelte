<script lang="ts">
	import { browser } from '$app/environment';
	import { api } from '$lib/api';

	let {
		open = $bindable(false),
		onComplete = () => {},
	}: {
		open?: boolean;
		onComplete?: () => void;
	} = $props();

	// 4-step progressive reveal (last step = optional handle claim)
	let step = $state(0);
	const totalSteps = 4;

	const steps = [
		{
			eyebrow: 'Welcome',
			title: 'Your Mycelium starts here',
			body: 'In a forest, mycelium is the hidden network beneath the soil — threading between trees, carrying signals, sharing what each needs with the others. Quiet, vast, alive.',
			follow: 'This is the same idea, for your mind.',
		},
		{
			eyebrow: 'What it is',
			title: 'Intelligence that belongs to you',
			body: 'Your conversations, documents, and thinking — encrypted end-to-end with a key only you hold. Your data stays yours. Your agents work for you. No algorithmic feed, no harvesting, no surveillance.',
			follow: 'We can\u2019t read it. Nobody can but you.',
		},
		{
			eyebrow: 'What to do first',
			title: 'Three small steps to grow it',
			body: 'Connect an AI (your mind\u2019s voice). Bring your past conversations (your mind\u2019s memory). Link a messenger (so your agent can reach you).',
			follow: 'We\u2019ll walk you through each. When you\u2019re ready, your Mycelium starts growing.',
		},
		{
			eyebrow: 'Your handle',
			title: 'Claim your handle',
			body: 'Pick a short handle for your profile \u2014 letters, numbers, underscore. You can change it later in Profile, or skip for now.',
			follow: '',
		},
	];

	const current = $derived(steps[step]);
	const isHandleStep = $derived(step === totalSteps - 1);

	// \u2500\u2500 Optional handle claim (last step) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	const HANDLE_RE = /^[a-z0-9][a-z0-9_]{2,29}$/;
	let handleInput = $state('');
	let handleState = $state<'idle' | 'checking' | 'available' | 'taken' | 'invalid'>('idle');
	let handleReason = $state('');
	let handleCheckTimer: ReturnType<typeof setTimeout> | null = null;

	function onHandleInput() {
		const h = handleInput.trim().toLowerCase();
		handleReason = '';
		if (handleCheckTimer) clearTimeout(handleCheckTimer);
		if (!h) { handleState = 'idle'; return; }
		if (!HANDLE_RE.test(h)) { handleState = 'invalid'; handleReason = '3\u201330 chars: a\u2013z, 0\u20139, _ (start alphanumeric)'; return; }
		handleState = 'checking';
		handleCheckTimer = setTimeout(async () => {
			try {
				const res = await api(`/portal/profile/handle/check?handle=${encodeURIComponent(h)}`);
				const d = await res.json().catch(() => ({}));
				if (d.available) { handleState = 'available'; }
				else { handleState = 'taken'; handleReason = d.reason || 'that handle is taken'; }
			} catch { handleState = 'idle'; }
		}, 400);
	}

	async function saveHandleIfAny() {
		const h = handleInput.trim().toLowerCase();
		if (!h || handleState !== 'available') return; // optional; only save a confirmed-available handle
		try {
			await api('/portal/profile', { method: 'PUT', body: JSON.stringify({ handle: h }) });
		} catch { /* non-blocking \u2014 they can set it later in Profile */ }
	}

	async function next() {
		if (step < totalSteps - 1) {
			step++;
		} else {
			await finish();
		}
	}

	function back() {
		if (step > 0) step--;
	}

	async function finish() {
		await saveHandleIfAny(); // optional — no-op unless a confirmed-available handle was entered
		// Mark as seen server-side — idempotent
		if (browser) {
			try {
				await api('/portal/onboarding/welcome-seen', { method: 'POST' });
			} catch {}
		}
		open = false;
		onComplete();
	}

	// Keyboard: Esc to dismiss (also marks as seen), Enter/Space to advance
	function handleKeydown(e: KeyboardEvent) {
		if (!open) return;
		const tag = (e.target as HTMLElement)?.tagName;
		const inField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
		if (e.key === 'Escape') {
			e.preventDefault();
			finish();
		} else if (e.key === 'Enter' || e.key === ' ') {
			// Don't hijack typing (esp. the handle input) — only advance from non-field focus.
			if (!inField && tag !== 'BUTTON') {
				e.preventDefault();
				next();
			}
		} else if (e.key === 'ArrowRight' && !inField) {
			e.preventDefault();
			next();
		} else if (e.key === 'ArrowLeft' && !inField) {
			e.preventDefault();
			back();
		}
	}

	// Focus the primary button when open/step changes
	let primaryBtn = $state<HTMLButtonElement | undefined>();
	$effect(() => {
		if (open && primaryBtn) {
			// Focus on next tick so the button exists
			queueMicrotask(() => primaryBtn?.focus());
		}
		// Re-run on step change
		step;
	});
</script>

<svelte:window onkeydown={handleKeydown} />

{#if open}
	<div class="backdrop" role="dialog" aria-modal="true" aria-labelledby="welcome-title">
		<div class="modal">
			<!-- Progress dots -->
			<div class="dots">
				{#each steps as _, i}
					<span class="dot" class:active={i === step} class:passed={i < step}></span>
				{/each}
			</div>

			<div class="content">
				<div class="eyebrow">{current.eyebrow}</div>
				<h1 id="welcome-title" class="title">{current.title}</h1>
				<p class="body">{current.body}</p>
				{#if current.follow}<p class="follow">{current.follow}</p>{/if}
				{#if isHandleStep}
					<div class="handle-row">
						<span class="handle-at">@</span>
						<input
							class="handle-input"
							type="text"
							bind:value={handleInput}
							oninput={onHandleInput}
							placeholder="yourhandle"
							autocomplete="off"
							data-1p-ignore
							maxlength="30"
						/>
					</div>
					<p class="handle-status" class:ok={handleState === 'available'} class:bad={handleState === 'taken' || handleState === 'invalid'}>
						{#if handleState === 'checking'}Checking…
						{:else if handleState === 'available'}&#10003; available
						{:else if handleState === 'taken' || handleState === 'invalid'}{handleReason}
						{:else}&nbsp;{/if}
					</p>
				{/if}
			</div>

			<div class="actions">
				{#if step > 0}
					<button class="btn-ghost" onclick={back}>Back</button>
				{:else}
					<button class="btn-skip" onclick={finish}>Skip</button>
				{/if}
				<button
					bind:this={primaryBtn}
					class="btn-primary"
					onclick={next}
				>
					{step < totalSteps - 1 ? 'Continue' : 'Begin'}
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
						<line x1="5" y1="12" x2="19" y2="12"/>
						<polyline points="12 5 19 12 12 19"/>
					</svg>
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 1000;
		background: rgba(10, 10, 12, 0.78);
		backdrop-filter: blur(8px);
		-webkit-backdrop-filter: blur(8px);
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 1.5rem;
		animation: fadeIn 0.35s ease-out;
	}

	.modal {
		position: relative;
		max-width: 480px;
		width: 100%;
		background: var(--color-elevated);
		border: 1px solid var(--color-border);
		border-radius: 16px;
		padding: 2.25rem 2.25rem 1.75rem;
		box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(229, 184, 76, 0.06);
		animation: slideUp 0.45s cubic-bezier(0.16, 1, 0.3, 1);
	}

	.dots {
		display: flex;
		gap: 6px;
		justify-content: center;
		margin-bottom: 1.5rem;
	}
	.dot {
		width: 24px;
		height: 3px;
		border-radius: 2px;
		background: var(--color-border);
		transition: background 0.3s ease;
	}
	.dot.active {
		background: var(--color-accent-aurum);
	}
	.dot.passed {
		background: rgba(229, 184, 76, 0.4);
	}

	.content {
		min-height: 190px;
	}

	.eyebrow {
		font-family: var(--font-mono, 'JetBrains Mono', monospace);
		font-size: 0.62rem;
		font-weight: 500;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: var(--color-accent-aurum);
		margin-bottom: 0.75rem;
	}

	.title {
		font-family: var(--font-serif, 'Geist', system-ui, sans-serif);
		font-size: 1.7rem;
		font-weight: 400;
		line-height: 1.15;
		letter-spacing: -0.015em;
		color: var(--color-text-primary);
		margin: 0 0 1rem;
	}

	.body {
		font-size: 0.92rem;
		line-height: 1.65;
		color: var(--color-text-secondary, #9898A3);
		margin: 0 0 0.9rem;
	}

	.follow {
		font-size: 0.88rem;
		line-height: 1.6;
		color: var(--color-text-primary);
		margin: 0;
		font-style: italic;
		opacity: 0.85;
	}

	.handle-row {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		margin-top: 0.5rem;
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: 8px;
		padding: 0.55rem 0.75rem;
	}
	.handle-at {
		color: var(--color-text-secondary, #9898A3);
		font-family: var(--font-mono, 'JetBrains Mono', monospace);
		font-size: 0.9rem;
	}
	.handle-input {
		flex: 1;
		background: transparent;
		border: none;
		outline: none;
		color: var(--color-text-primary);
		font-family: var(--font-mono, 'JetBrains Mono', monospace);
		font-size: 0.9rem;
	}
	.handle-status {
		font-size: 0.72rem;
		margin: 0.4rem 0 0;
		min-height: 1em;
		color: var(--color-text-secondary, #9898A3);
	}
	.handle-status.ok { color: #4ade80; }
	.handle-status.bad { color: #f87171; }

	.actions {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		margin-top: 2rem;
		padding-top: 1.25rem;
		border-top: 1px solid var(--color-border);
	}

	.btn-primary {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.6rem 1.3rem;
		background: var(--color-accent-aurum);
		color: var(--color-bg);
		border: none;
		border-radius: 8px;
		font-family: inherit;
		font-size: 0.85rem;
		font-weight: 500;
		cursor: pointer;
		transition: transform 0.15s ease, box-shadow 0.2s ease;
	}
	.btn-primary:hover {
		transform: translateY(-1px);
		box-shadow: 0 6px 20px rgba(229, 184, 76, 0.25);
	}
	.btn-primary:focus-visible {
		outline: 2px solid var(--color-accent-aurum);
		outline-offset: 3px;
	}

	.btn-ghost,
	.btn-skip {
		background: none;
		border: 1px solid var(--color-border);
		color: var(--color-text-secondary, #9898A3);
		padding: 0.55rem 1.1rem;
		border-radius: 8px;
		font-family: inherit;
		font-size: 0.82rem;
		cursor: pointer;
		transition: all 0.2s ease;
	}
	.btn-ghost:hover,
	.btn-skip:hover {
		border-color: var(--color-text-secondary, #9898A3);
		color: var(--color-text-primary);
	}
	.btn-skip {
		border: none;
	}

	@keyframes fadeIn {
		from { opacity: 0; }
		to { opacity: 1; }
	}
	@keyframes slideUp {
		from {
			opacity: 0;
			transform: translateY(18px) scale(0.98);
		}
		to {
			opacity: 1;
			transform: translateY(0) scale(1);
		}
	}

	@media (max-width: 520px) {
		.modal { padding: 1.75rem 1.5rem 1.5rem; }
		.title { font-size: 1.4rem; }
		.content { min-height: 170px; }
	}
</style>
