<script lang="ts">
	// Curious Life — the aspirational surface. Your data as a record of becoming,
	// and the beginning of a compass: see where your paths have led, and choose
	// the next true step toward who you are reaching to be.
	//
	// Aesthetic note: pure-CSS atmosphere only (drifting radial gradients + faint
	// motes). NO WebGL and NO backdrop-filter — both misbehave in the desktop
	// WKWebView shell (see app.css `html.is-tauri`).
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { navigationState } from '$lib/stores/navigation';

	// Reflect this view in the chrome even on a direct URL load.
	onMount(() => navigationState.setPrimaryView('curious-life'));

	function toMindscape() {
		navigationState.setPrimaryView('mindscape');
		goto('/mindscape');
	}

	const stations = [
		{
			key: 'behind',
			label: 'The path behind you',
			body: 'Every question you have asked is a footprint. Threaded together, they trace a path you were walking long before you knew its name.'
		},
		{
			key: 'here',
			label: 'The ground beneath you',
			body: 'Your attention has a shape. It gathers into realms and territories — some luminous from tending, some gone quiet from neglect. This is the country you actually live in.'
		},
		{
			key: 'ahead',
			label: 'The self ahead',
			body: 'Name the one you are reaching toward. Let your days lean, gently and on purpose, in their direction — not to flee who you are, but to arrive there fully.'
		}
	];
</script>

<svelte:head><title>Curious Life · Mycelium</title></svelte:head>

<div class="curious-page">
	<div class="aurora" aria-hidden="true">
		<span class="blob b1"></span>
		<span class="blob b2"></span>
		<span class="blob b3"></span>
		<span class="motes"></span>
	</div>

	<div class="inner">
		<header class="hero">
			<p class="overline">Curious Life</p>
			<h1 class="title">Become who you are.</h1>
			<p class="lede">
				Your conversations are the record of a life thinking itself into being —
				and the beginning of a compass for where it goes next.
			</p>
		</header>

		<blockquote class="epigraph">
			<p>“Wouldst thou into the infinite stride?<br />Then walk the finite to every side.”</p>
			<cite>— Goethe</cite>
		</blockquote>

		<section class="traverse" aria-label="The traverse">
			<div class="thread" aria-hidden="true"></div>
			{#each stations as s, i}
				<article class="station st-{s.key}" style="--i:{i}">
					<span class="node" aria-hidden="true"></span>
					<span class="station-icon" aria-hidden="true">
						{#if s.key === 'behind'}
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
								<path d="M3 18c3.5 0 4.2-9 8-9s4.5 6 9 6" />
								<circle cx="20" cy="15" r="1.1" fill="currentColor" stroke="none" />
							</svg>
						{:else if s.key === 'here'}
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4">
								<circle cx="12" cy="12" r="9" opacity="0.35" stroke-dasharray="2 3" />
								<circle cx="12" cy="12" r="5" opacity="0.7" />
								<circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
							</svg>
						{:else}
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
								<path d="M12 2.5l1.9 6 6 1.9-6 1.9-1.9 6-1.9-6-6-1.9 6-1.9z" />
							</svg>
						{/if}
					</span>
					<h2 class="station-label">{s.label}</h2>
					<p class="station-body">{s.body}</p>
				</article>
			{/each}
		</section>

		<footer class="closing">
			<p class="invocation">
				Most maps tell you where things are. This one is learning to tell you who
				you are becoming — and to help you take the next true step toward it.
			</p>
			<p class="horizon">
				Soon: name a desired state of being, and watch your attention reorganise
				toward it. For now, begin where every path begins — with where you have
				already been.
			</p>
			<div class="actions">
				<button class="walk" onclick={toMindscape}>
					See where your paths have led
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
						<path d="M5 12h14" /><path d="m13 6 6 6-6 6" />
					</svg>
				</button>
			</div>
		</footer>
	</div>
</div>

<style>
	.curious-page {
		position: relative;
		height: 100%;
		overflow-y: auto;
		overflow-x: hidden;
		background: var(--color-bg);
		color: var(--color-text-primary);
	}

	/* ── Atmosphere ───────────────────────────────────────────────────────── */
	.aurora {
		position: absolute;
		inset: 0;
		overflow: hidden;
		pointer-events: none;
		z-index: 0;
	}
	.blob {
		position: absolute;
		width: 60vmax;
		height: 60vmax;
		border-radius: 50%;
		opacity: 0.5;
		will-change: transform;
		/* radial-gradients have naturally soft edges — no blur filter needed
		   (keeps the WKWebView compositor happy). */
	}
	.b1 {
		top: -22vmax; left: -14vmax;
		background: radial-gradient(circle at center, rgb(var(--color-accent-rgb) / 0.20), transparent 60%);
		animation: drift1 34s ease-in-out infinite;
	}
	.b2 {
		bottom: -26vmax; right: -16vmax;
		background: radial-gradient(circle at center, rgb(var(--color-accent-amethyst-rgb) / 0.20), transparent 60%);
		animation: drift2 42s ease-in-out infinite;
	}
	.b3 {
		top: 28%; left: 38%;
		width: 44vmax; height: 44vmax;
		background: radial-gradient(circle at center, rgb(var(--color-accent-aurum-rgb) / 0.12), transparent 62%);
		animation: drift3 50s ease-in-out infinite;
	}
	/* faint star/mote field — two layers of soft dots, slowly rising */
	.motes {
		position: absolute;
		inset: -10% 0 -10% 0;
		background-image:
			radial-gradient(1.4px 1.4px at 20% 30%, rgb(var(--color-accent-aurum-rgb) / 0.5), transparent 60%),
			radial-gradient(1.2px 1.2px at 70% 65%, rgb(var(--color-accent-amethyst-rgb) / 0.5), transparent 60%),
			radial-gradient(1px 1px at 45% 80%, rgb(var(--color-accent-rgb) / 0.5), transparent 60%),
			radial-gradient(1px 1px at 85% 20%, rgb(var(--color-text-primary) / 0.18), transparent 60%),
			radial-gradient(1.3px 1.3px at 12% 70%, rgb(var(--color-accent-amethyst-rgb) / 0.4), transparent 60%);
		background-repeat: repeat;
		background-size: 100% 100%;
		opacity: 0.7;
		animation: rise 60s linear infinite;
	}

	/* ── Content ──────────────────────────────────────────────────────────── */
	.inner {
		position: relative;
		z-index: 1;
		max-width: 60rem;
		margin: 0 auto;
		padding: clamp(2.5rem, 7vh, 6rem) clamp(1.25rem, 5vw, 3rem) 4rem;
		display: flex;
		flex-direction: column;
		gap: clamp(2rem, 5vh, 3.5rem);
	}

	.hero { text-align: center; max-width: 40rem; margin: 0 auto; }
	.overline {
		font-family: var(--font-mono);
		font-size: 0.7rem;
		letter-spacing: 0.42em;
		text-transform: uppercase;
		color: var(--color-accent-aurum);
		margin-bottom: 1.1rem;
		opacity: 0;
		animation: fade-up 0.9s var(--ease-out) 0.05s forwards;
	}
	.title {
		font-size: clamp(2.4rem, 6vw, 4rem);
		line-height: 1.04;
		letter-spacing: -0.025em;
		font-weight: 600;
		background: linear-gradient(112deg, var(--color-text-emphasis) 18%, var(--color-accent-aurum) 64%, var(--color-accent-amethyst) 100%);
		-webkit-background-clip: text;
		background-clip: text;
		color: transparent;
		opacity: 0;
		animation: fade-up 0.9s var(--ease-out) 0.14s forwards;
	}
	.lede {
		margin-top: 1.4rem;
		font-size: clamp(1rem, 1.6vw, 1.2rem);
		line-height: 1.7;
		color: var(--color-text-secondary);
		opacity: 0;
		animation: fade-up 0.9s var(--ease-out) 0.26s forwards;
	}

	.epigraph {
		margin: 0 auto;
		max-width: 34rem;
		text-align: center;
		opacity: 0;
		animation: fade-up 1s var(--ease-out) 0.4s forwards;
	}
	.epigraph p {
		font-size: clamp(1.1rem, 2vw, 1.4rem);
		line-height: 1.6;
		font-style: italic;
		font-weight: 300;
		color: var(--color-text-primary);
		letter-spacing: 0.01em;
	}
	.epigraph cite {
		display: block;
		margin-top: 1rem;
		font-style: normal;
		font-size: 0.78rem;
		letter-spacing: 0.18em;
		text-transform: uppercase;
		color: var(--color-text-tertiary);
	}

	/* ── The traverse (three stations) ────────────────────────────────────── */
	.traverse {
		position: relative;
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: clamp(1.25rem, 3vw, 2.5rem);
		padding-top: 1rem;
	}
	.thread {
		position: absolute;
		top: calc(1rem + 13px);
		left: 8%;
		right: 8%;
		height: 1px;
		background: linear-gradient(90deg,
			rgb(var(--color-accent-aurum-rgb) / 0.05),
			rgb(var(--color-accent-aurum-rgb) / 0.5) 30%,
			rgb(var(--color-accent-amethyst-rgb) / 0.5) 72%,
			rgb(var(--color-accent-amethyst-rgb) / 0.9));
	}
	.station {
		position: relative;
		text-align: center;
		padding: 1.75rem 1rem 0;
		opacity: 0;
		transform: translateY(14px);
		animation: rise-in 0.8s var(--ease-out) forwards;
		animation-delay: calc(0.55s + var(--i) * 0.16s);
	}
	.node {
		position: absolute;
		top: -1px;
		left: 50%;
		width: 11px;
		height: 11px;
		margin-left: -5.5px;
		border-radius: 50%;
		background: var(--color-bg);
		box-shadow: 0 0 0 2px rgb(var(--color-accent-aurum-rgb) / 0.8), 0 0 14px rgb(var(--color-accent-aurum-rgb) / 0.5);
	}
	.st-ahead .node { box-shadow: 0 0 0 2px rgb(var(--color-accent-amethyst-rgb) / 0.85), 0 0 16px rgb(var(--color-accent-amethyst-rgb) / 0.6); }
	.st-here .node { box-shadow: 0 0 0 2px rgb(var(--color-accent-rgb) / 0.85), 0 0 14px rgb(var(--color-accent-rgb) / 0.5); }

	.station-icon {
		display: inline-flex;
		width: 2.4rem;
		height: 2.4rem;
		margin-top: 1.25rem;
		margin-bottom: 1rem;
		color: var(--color-accent-aurum);
	}
	.st-here .station-icon { color: var(--color-accent); }
	.st-ahead .station-icon { color: var(--color-accent-amethyst); }
	.station-icon :global(svg) { width: 100%; height: 100%; }

	.station-label {
		font-size: 0.72rem;
		font-weight: 600;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--color-text-secondary);
		margin-bottom: 0.7rem;
	}
	.station-body {
		font-size: 0.95rem;
		line-height: 1.65;
		color: var(--color-text-secondary);
		max-width: 22rem;
		margin: 0 auto;
	}

	/* ── Closing ──────────────────────────────────────────────────────────── */
	.closing {
		text-align: center;
		max-width: 40rem;
		margin: 0 auto;
		opacity: 0;
		animation: fade-up 1s var(--ease-out) 1.1s forwards;
	}
	.invocation {
		font-size: clamp(1.05rem, 1.8vw, 1.3rem);
		line-height: 1.7;
		color: var(--color-text-primary);
	}
	.horizon {
		margin-top: 1.1rem;
		font-size: 0.92rem;
		line-height: 1.65;
		color: var(--color-text-tertiary);
	}
	.actions { margin-top: 2rem; }
	.walk {
		display: inline-flex;
		align-items: center;
		gap: 0.6rem;
		padding: 0.8rem 1.5rem;
		border-radius: var(--radius-full);
		border: 1px solid rgb(var(--color-accent-aurum-rgb) / 0.4);
		background: linear-gradient(100deg, rgb(var(--color-accent-aurum-rgb) / 0.12), rgb(var(--color-accent-amethyst-rgb) / 0.12));
		color: var(--color-text-emphasis);
		font-size: 0.92rem;
		font-weight: 500;
		cursor: pointer;
		transition: transform var(--duration-fast) var(--ease-out), border-color var(--duration-fast) var(--ease-out), box-shadow var(--duration-fast) var(--ease-out);
	}
	.walk svg { width: 1.05rem; height: 1.05rem; transition: transform var(--duration-fast) var(--ease-out); }
	.walk:hover {
		transform: translateY(-1px);
		border-color: rgb(var(--color-accent-aurum-rgb) / 0.7);
		box-shadow: 0 8px 28px rgb(var(--color-accent-aurum-rgb) / 0.18);
	}
	.walk:hover svg { transform: translateX(3px); }
	.walk:focus-visible { outline: 2px solid var(--color-focus-ring); outline-offset: 3px; }

	/* ── Motion ───────────────────────────────────────────────────────────── */
	@keyframes drift1 { 0%,100% { transform: translate(0,0) scale(1); } 50% { transform: translate(6vmax, 4vmax) scale(1.08); } }
	@keyframes drift2 { 0%,100% { transform: translate(0,0) scale(1); } 50% { transform: translate(-5vmax, -3vmax) scale(1.1); } }
	@keyframes drift3 { 0%,100% { transform: translate(0,0) scale(1); } 50% { transform: translate(-4vmax, 5vmax) scale(0.92); } }
	@keyframes rise { from { background-position: 0 0; } to { background-position: 0 -1000px; } }
	@keyframes fade-up { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
	@keyframes rise-in { to { opacity: 1; transform: translateY(0); } }

	@media (max-width: 760px) {
		.traverse { grid-template-columns: 1fr; gap: 0; }
		.thread {
			top: 1rem; bottom: 1rem; left: calc(50% - 0.5px); right: auto;
			width: 1px; height: auto;
			background: linear-gradient(180deg,
				rgb(var(--color-accent-aurum-rgb) / 0.5),
				rgb(var(--color-accent-amethyst-rgb) / 0.9));
		}
		.station { padding: 1.5rem 1rem 2rem; }
		.node { top: 1.5rem; }
	}

	@media (prefers-reduced-motion: reduce) {
		.blob, .motes { animation: none; }
		.overline, .title, .lede, .epigraph, .station, .closing { animation: none; opacity: 1; transform: none; }
	}
</style>
