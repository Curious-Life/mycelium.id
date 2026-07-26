<!--
	Engine (harness) selector — the FUNCTIONAL native ↔ Claude Code switch.
	"Which engine runs your chat agent": Mycelium native (default; runs on your
	configured providers) or Claude Code (runs your agent on your Claude
	subscription). Persists settings.harnessMode via GET/PUT /portal/providers/harness.

	QA6 · recoverability P1 — THE DEAD CLICK. Claude Code used to render as a
	`disabled` button whenever it wasn't usable. A disabled control eats the click
	(no handler fires, and `title` tooltips don't render on disabled buttons in
	several browsers), so the whole explanation was one 0.62rem grey line — the
	operator's "clicking it does nothing, no reason given". Now the card is ALWAYS
	clickable: when it isn't selectable, clicking OPENS an actionable panel that
	names the blocker and gives the next step (install/update command with a copy
	button + docs link + Re-check, or a jump to the subscription connect flow).
	Every click either selects the engine or explains, visibly, why it can't.

	The three CLI facts (installed? which version? is it current?) come from
	src/inference/claude-cli-status.js via GET /portal/providers/harness. The
	"latest version" is best-effort: offline it is null and the copy degrades to
	"installed, v2.1.198" — never a wall, and it never gates selection.
	See the harness-CLI design.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { api } from '$lib/api';

	type ClaudeCli = {
		installed: boolean;
		version: string | null;
		versionOk: boolean | null;
		minVersion: string;
		latestVersion: string | null;
		updateAvailable: boolean;
		usable: boolean;
		reason: 'ok' | 'not_installed' | 'outdated';
		action: { message: string; command: string | null; docsUrl: string };
	};

	let mode = $state<'native' | 'cli'>('native');
	let subscriptionConnected = $state(false);
	let claudeAvailable = $state(false);
	let engineReady = $state(false);   // is the cli engine actually wired (C2 shipped)?
	let claude = $state<ClaudeCli | null>(null);
	let busy = $state<'native' | 'cli' | null>(null);
	let loaded = $state(false);
	let rechecking = $state(false);
	let panelOpen = $state(false);     // the "why can't I pick this" panel
	let copied = $state(false);
	// D-002 (operator reframe) — install/update the CLI FROM the app, not homework.
	let installing = $state(false);
	let updating = $state(false);
	let cliActionErr = $state<string | null>(null);

	// Claude Code is selectable only when the engine is shipped AND both gates pass.
	// The reason is ordered most-fundamental-first so the card never implies it's
	// usable when it isn't (engine not shipped ⇒ "coming soon", never "Ready").
	const cliEligible = $derived(engineReady && subscriptionConnected && claudeAvailable);
	// What is actually blocking, as a machine-readable enum — the copy below is derived
	// from this so the headline, the command and the button can never disagree.
	const blocker = $derived(
		!engineReady ? 'engine'
			: !claudeAvailable ? 'cli'
			: !subscriptionConnected ? 'subscription'
			: '',
	);
	// D-002 (↻1) — THE CONCEPTUAL GAP. The operator connected a Claude SUBSCRIPTION and
	// expected "Claude Code" to work; selecting it reverted to Mycelium. That revert is
	// CORRECT (the engine can't run without the local `claude` binary), but "Claude Code
	// isn't installed" reads as a bug to someone who believes they just connected Claude.
	// A connected subscription is NOT the Claude Code engine: the engine is a separate
	// command-line program that also has to be on this machine. When the subscription is
	// connected but the binary is missing, the copy must say that OUT LOUD — otherwise the
	// selection silently falls back to Mycelium with a reason the user can't reconcile.
	const subConnectedButNoCli = $derived(blocker === 'cli' && subscriptionConnected);
	// Install vs update: a MISSING CLI gets an Install action; an installed-but-too-old
	// one gets an Update action; a usable CLI with a newer published version gets an
	// optional Update. All three run in-app (POST /providers/harness/cli/{install,update}).
	const cliMissing = $derived(blocker === 'cli' && !(claude?.installed));
	const cliOutdated = $derived(blocker === 'cli' && claude?.installed === true);
	const cliUpdatable = $derived(cliEligible && claude?.updateAvailable === true);
	// PERSISTENCE REMEDY (operator req 3): the stored engine is 'cli' but it can't run
	// right now. The selection is NOT downgraded to native (mode stays 'cli' — see load);
	// instead we surface a persistent, click-free note with the remedy, so a restart into
	// a transiently-blocked state reads as "your engine is blocked, here's the fix", never
	// a silent revert.
	const storedCliButBlocked = $derived(loaded && mode === 'cli' && !cliEligible);

	// The one-line status under the card name. Honest in every state, including the
	// offline one (latestVersion null ⇒ we simply don't mention "latest").
	const cliReason = $derived(
		blocker === 'engine' ? 'Coming soon'
			: blocker === 'cli'
				? (claude && claude.installed
					? `Claude Code v${claude.version ?? '?'} is too old — needs v${claude.minVersion}+`
					: subConnectedButNoCli
						? 'Subscription connected — the Claude Code CLI still isn’t on this machine'
						: 'Claude Code isn’t installed on this machine')
				: blocker === 'subscription' ? 'Connect your Claude subscription'
				: '',
	);
	// The full, actionable explanation shown in the panel. `claude.action.message` is
	// the server's own copy (one source of truth with the version gate) — but when a
	// subscription IS connected we lead with the distinction the user is missing.
	const panelMessage = $derived(
		blocker === 'engine'
			? 'The Claude Code engine isn’t shipped in this build yet. Nothing to install — it will appear here when it lands.'
			: blocker === 'cli'
				? (subConnectedButNoCli
					? 'Your Claude subscription is connected — but that’s a different thing from the Claude Code engine. The engine runs your agent through the `claude` command-line program, which also has to be installed on this machine, and it isn’t yet. Install it below, then re-check — your subscription stays connected.'
					: (claude?.action?.message
						?? 'Claude Code isn’t installed on this machine. Install it, then re-check.'))
				: blocker === 'subscription'
					? 'Claude Code runs on your Claude Pro/Max subscription, and none is connected to this vault yet. Connect it below, then pick this engine.'
					: '',
	);
	// The panel HEADLINE — names, in one line, why the click didn't switch the engine.
	// This is what turns the "it doesn't save, falls back to Mycelium" silent revert into
	// an explained one.
	const panelHeadline = $derived(
		!loaded || cliEligible ? ''
			: blocker === 'engine' ? 'Claude Code isn’t available yet — the engine stayed on Mycelium.'
			: 'Claude Code can’t be selected yet — the engine stayed on Mycelium. Here’s what’s missing:',
	);
	const panelCommand = $derived(blocker === 'cli' ? (claude?.action?.command ?? 'npm i -g @anthropic-ai/claude-code') : null);
	const docsUrl = $derived(claude?.action?.docsUrl ?? 'https://docs.claude.com/en/docs/claude-code/setup');

	async function load() {
		try {
			const r = await api('/portal/providers/harness');
			if (r.ok) {
				const j = await r.json();
				mode = j.harnessMode === 'cli' ? 'cli' : 'native';
				subscriptionConnected = j.subscriptionConnected === true;
				claudeAvailable = j.claudeAvailable === true;
				engineReady = j.engineReady === true;
				claude = (j.claude && typeof j.claude === 'object') ? j.claude as ClaudeCli : null;
			}
		} catch { /* leave defaults (native) */ }
		finally { loaded = true; }
	}

	// "Re-check" — the user just ran the install/update command in a terminal and wants
	// this screen to notice WITHOUT a reload. Visible busy state, so the button is never
	// itself a dead click.
	async function recheck() {
		rechecking = true;
		try { await load(); } finally { rechecking = false; }
	}

	// Install the CLI FROM the app (operator req 1). Runs the official native installer
	// server-side; the endpoint RE-PROBES and only reports ok when a usable `claude`
	// appears, so we can trust its verdict. Reload the full status either way so the
	// card + panel reflect reality without a page refresh.
	async function installCli() {
		if (installing || updating) return;
		installing = true; cliActionErr = null;
		try {
			const r = await api('/portal/providers/harness/cli/install', { method: 'POST' });
			const j = await r.json().catch(() => ({}));
			await load();
			if (!(r.ok && j?.ok)) cliActionErr = errText(j?.error) || 'Install didn’t complete — you can still run the command below yourself.';
		} catch { cliActionErr = 'Install couldn’t start — run the command below yourself.'; }
		finally { installing = false; }
	}
	// Update the CLI FROM the app (operator req 2) — `claude update`, any install type.
	async function updateCli() {
		if (installing || updating) return;
		updating = true; cliActionErr = null;
		try {
			const r = await api('/portal/providers/harness/cli/update', { method: 'POST' });
			const j = await r.json().catch(() => ({}));
			await load();
			if (!(r.ok && j?.ok)) cliActionErr = errText(j?.error) || 'Update didn’t complete — try again, or update from a terminal.';
		} catch { cliActionErr = 'Update couldn’t start — try from a terminal.'; }
		finally { updating = false; }
	}
	// Machine reason code → one honest human line (never the raw stderr — §1).
	function errText(code: unknown): string | null {
		const c = String(code ?? '');
		if (!c) return null;
		if (c === 'not-installed') return 'Claude Code isn’t installed yet — install it first.';
		if (c === 'timed-out') return 'It took too long and was stopped. Check your connection and try again.';
		if (c === 'installed-but-not-usable') return 'It installed, but the version still isn’t usable — try updating it.';
		if (c.startsWith('spawn-failed')) return 'Couldn’t launch the installer on this machine.';
		return 'It didn’t complete. You can run the command below yourself.';
	}

	async function copyCommand() {
		if (!panelCommand) return;
		try {
			await navigator.clipboard.writeText(panelCommand);
			copied = true;
			setTimeout(() => { copied = false; }, 1600);
		} catch { /* the command is selectable text right there — copy is a convenience */ }
	}

	// The subscription connect flow lives in AISettings, a sibling under the same
	// Customize disclosure. Ask it to open + scroll itself into view rather than
	// telling the user to go hunting for it.
	function goConnectSubscription() {
		try { window.dispatchEvent(new CustomEvent('mycelium:connect-claude-sub')); } catch { /* */ }
	}

	async function pick(next: 'native' | 'cli') {
		if (next === mode) return;
		// NOT a no-op: an ineligible pick opens the panel that says why + what to do.
		if (next === 'cli' && !cliEligible) { panelOpen = true; return; }
		panelOpen = false;
		busy = next;
		const prev = mode;
		mode = next;                       // optimistic
		try {
			const r = await api('/portal/providers/harness', { method: 'PUT', body: JSON.stringify({ harnessMode: next }) });
			if (r.ok) { mode = (await r.json()).harnessMode === 'cli' ? 'cli' : 'native'; }
			else mode = prev;
		} catch { mode = prev; }
		finally { busy = null; }
	}

	onMount(load);

	// EN-1: the harness gates (subscription connected · `claude` installed · engine shipped)
	// can change WHILE this screen stays open — the user connects their subscription through a
	// browser PKCE tab, or installs Claude Code in a terminal, both of which blur then refocus
	// this window. Without a re-check, Claude Code only lights up after a full page reload.
	// Re-run load() when the window regains focus / the tab becomes visible again. Event-driven
	// (zero idle cost — no poll), matching the codebase idiom (MindscapeInvite/MindscapeView).
	$effect(() => {
		if (typeof window === 'undefined') return;
		const onFocus = () => { load(); };
		const onVisible = () => { if (document.visibilityState === 'visible') load(); };
		window.addEventListener('focus', onFocus);
		document.addEventListener('visibilitychange', onVisible);
		return () => {
			window.removeEventListener('focus', onFocus);
			document.removeEventListener('visibilitychange', onVisible);
		};
	});
</script>

<div class="engine">
	<div class="engine-head">
		<span class="engine-title">Engine</span>
		<span class="engine-sub">Which engine runs your chat agent.</span>
	</div>
	<div class="engine-cards" role="radiogroup" aria-label="Agent engine">
		<button
			class="engine-card"
			class:sel={mode === 'native'}
			role="radio"
			aria-checked={mode === 'native'}
			disabled={busy !== null}
			onclick={() => pick('native')}
		>
			<span class="ec-top"><span class="ec-name">Mycelium</span>{#if mode === 'native'}<span class="ec-tick">✓</span>{/if}</span>
			<span class="ec-blurb">Native engine. Runs on the models &amp; providers you configure below.</span>
			<span class="ec-tag">Default · always available</span>
		</button>

		<!-- NEVER `disabled` for ineligibility — see the header note. `busy` alone
		     disables it, and that state is transient + visible. -->
		<button
			class="engine-card"
			class:sel={mode === 'cli'}
			class:blocked={loaded && !cliEligible}
			role="radio"
			aria-checked={mode === 'cli'}
			aria-disabled={loaded && !cliEligible}
			disabled={busy !== null}
			onclick={() => pick('cli')}
		>
			<span class="ec-top"><span class="ec-name">Claude Code</span>{#if mode === 'cli'}<span class="ec-tick">✓</span>{/if}</span>
			<span class="ec-blurb">Runs your agent on your Claude Pro/Max subscription, with your vault as its tools.</span>
			{#if cliEligible}
				<!-- State the VERSION when we know it: "Ready" alone told the user nothing
				     about what is actually installed. Offline (latestVersion null) this is
				     still a complete sentence. -->
				<span class="ec-tag ok">Ready{claude?.version ? ` · Claude Code v${claude.version}` : ''}</span>
				{#if cliUpdatable && claude?.latestVersion}
					<!-- Usable, but a newer version exists — the in-app Update action lives OUTSIDE
					     this radio button (a <button> cannot nest inside a <button>); see the
					     .ec-update-row sibling below the cards. -->
					<span class="ec-tag muted">v{claude.latestVersion} available — update below</span>
				{/if}
			{:else if loaded}
				<span class="ec-tag muted">{cliReason} · <span class="ec-why">why?</span></span>
			{/if}
		</button>
	</div>

	<!-- In-app UPDATE for a usable-but-outdated CLI (operator req 2). A SIBLING of the
	     radio cards — never nested inside the <button> (invalid HTML / hydration break). -->
	{#if cliUpdatable && claude?.latestVersion}
		<div class="ec-update-row">
			<span>Claude Code v{claude.latestVersion} is available.</span>
			<button type="button" class="ec-inline-btn" disabled={updating || installing} onclick={updateCli}>{updating ? 'Updating…' : 'Update Claude Code'}</button>
		</div>
	{/if}

	<!-- PERSISTENCE REMEDY (operator req 3). The stored engine is Claude Code but it
	     can't run right now (e.g. re-opened the app on a box where the CLI isn't ready).
	     The selection is NOT reverted to Mycelium — it stays 'cli' above — and this
	     click-free banner says so + opens the remedy, so a restart into a blocked state
	     is explained, never a silent downgrade. Hidden once the panel is open (no dupe). -->
	{#if storedCliButBlocked && !panelOpen}
		<button type="button" class="ec-blocked-note" onclick={() => (panelOpen = true)}>
			Claude Code is your selected engine but can’t run right now — {cliReason}. Tap for the fix.
		</button>
	{/if}

	<!-- The dead click's replacement: an honest, actionable panel. Opens on a click
	     the card can't honour, and every branch ends in something the user can DO. -->
	{#if panelOpen && loaded && !cliEligible}
		<div class="ec-panel" role="status">
			{#if panelHeadline}<p class="ecp-head">{panelHeadline}</p>{/if}
			<p class="ecp-msg">{panelMessage}</p>
			<div class="ecp-actions">
				{#if blocker === 'subscription'}
					<button type="button" class="ecp-btn primary" onclick={goConnectSubscription}>Connect your Claude subscription</button>
				{/if}
				{#if blocker === 'cli'}
					<!-- The REAL action (operator req 1/2): install or update FROM the app,
					     not a command the user runs in a terminal. Busy state, honest error. -->
					{#if cliMissing}
						<button type="button" class="ecp-btn primary" disabled={installing || updating} onclick={installCli}>{installing ? 'Installing…' : 'Install Claude Code'}</button>
					{:else if cliOutdated}
						<button type="button" class="ecp-btn primary" disabled={installing || updating} onclick={updateCli}>{updating ? 'Updating…' : 'Update Claude Code'}</button>
					{/if}
					<button type="button" class="ecp-btn" disabled={rechecking} onclick={recheck}>{rechecking ? 'Re-checking…' : 'Re-check'}</button>
					<a class="ecp-link" href={docsUrl} target="_blank" rel="noreferrer noopener">Install guide ↗</a>
				{/if}
				<button type="button" class="ecp-btn ghost" onclick={() => (panelOpen = false)}>Dismiss</button>
			</div>
			{#if cliActionErr}<p class="ecp-err">{cliActionErr}</p>{/if}
			{#if panelCommand}
				<!-- Manual fallback: still offer the exact command for anyone who'd rather
				     run it themselves, or when the in-app install couldn't complete. -->
				<p class="ecp-note">Prefer to do it yourself? Run:</p>
				<div class="ecp-cmd">
					<code>{panelCommand}</code>
					<button type="button" class="ecp-btn" onclick={copyCommand}>{copied ? '✓ Copied' : 'Copy'}</button>
				</div>
			{/if}
			{#if blocker === 'cli' && claude && !claude.latestVersion}
				<!-- Offline / update-check opted out. Say so plainly instead of implying
				     the version story is incomplete because something is broken. -->
				<p class="ecp-note">Couldn’t check the latest published version (offline or update checks are off) — that doesn’t block anything.</p>
			{/if}
		</div>
	{/if}
</div>

<style>
	.engine { margin-bottom: 1.1rem; }
	.engine-head { display: flex; align-items: baseline; gap: 0.5rem; margin-bottom: 0.5rem; }
	.engine-title { font-size: 0.9rem; font-weight: 600; color: var(--color-text-primary); }
	.engine-sub { font-size: 0.7rem; color: var(--color-text-tertiary); }
	.engine-cards { display: grid; grid-template-columns: 1fr 1fr; gap: 0.6rem; }
	@media (max-width: 560px) { .engine-cards { grid-template-columns: 1fr; } }
	.engine-card {
		display: flex; flex-direction: column; gap: 0.3rem; text-align: left;
		padding: 0.75rem 0.85rem; border-radius: 13px; cursor: pointer;
		background: var(--color-surface, rgba(255,255,255,0.03));
		border: 1px solid var(--color-border, rgba(255,255,255,0.1));
		transition: border-color 0.15s, background 0.15s;
		font-family: inherit;
	}
	.engine-card:hover:not(:disabled) { border-color: var(--color-accent, #e5b84c); }
	.engine-card.sel { border-color: var(--color-accent, #e5b84c); background: var(--color-elevated, rgba(255,255,255,0.06)); }
	/* `blocked` is DIMMED, not dead: still hoverable, still clickable, and the click
	   opens the explanation panel. (The old `.disabled` + `disabled` attr ate it.) */
	.engine-card.blocked { opacity: 0.62; }
	.engine-card.blocked:hover { opacity: 0.85; }
	.engine-card:disabled { cursor: default; }
	.ec-why { text-decoration: underline; text-underline-offset: 2px; }

	.ec-panel {
		margin-top: 0.6rem; padding: 0.7rem 0.8rem; border-radius: 11px;
		background: var(--color-elevated, rgba(255,255,255,0.05));
		border: 1px solid var(--color-border, rgba(255,255,255,0.1));
	}
	.ecp-head { font-size: 0.72rem; font-weight: 600; line-height: 1.45; color: var(--color-text-primary); margin: 0 0 0.4rem; }
	.ecp-msg { font-size: 0.7rem; line-height: 1.5; color: var(--color-text-secondary); margin: 0 0 0.5rem; }
	.ecp-note { font-size: 0.62rem; color: var(--color-text-tertiary); margin: 0.5rem 0 0.35rem; line-height: 1.45; }
	.ecp-err { font-size: 0.66rem; color: #f0a4a4; margin: 0.5rem 0 0; line-height: 1.45; }
	.ec-inline-btn {
		font-family: inherit; font-size: 0.6rem; padding: 0.05rem 0.4rem; border-radius: 5px;
		border: 1px solid var(--color-border, rgba(255,255,255,0.16)); background: none;
		color: var(--color-accent, #e5b84c); cursor: pointer;
	}
	.ec-inline-btn:disabled { opacity: 0.55; cursor: default; }
	.ec-update-row {
		display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; margin-top: 0.5rem;
		font-size: 0.66rem; color: var(--color-text-secondary);
	}
	.ec-blocked-note {
		display: block; width: 100%; text-align: left; margin-top: 0.5rem;
		padding: 0.5rem 0.7rem; border-radius: 10px; cursor: pointer; font-family: inherit;
		font-size: 0.66rem; line-height: 1.45; color: var(--color-text-secondary);
		background: color-mix(in srgb, var(--color-accent, #e5b84c) 10%, transparent);
		border: 1px solid color-mix(in srgb, var(--color-accent, #e5b84c) 35%, transparent);
	}
	.ecp-cmd {
		display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.55rem;
		padding: 0.35rem 0.5rem; border-radius: 7px; background: rgba(0,0,0,0.25);
	}
	.ecp-cmd code {
		flex: 1; min-width: 0; font-family: var(--font-mono); font-size: 0.66rem;
		color: var(--color-text-primary); overflow-x: auto; white-space: nowrap;
		user-select: all;
	}
	.ecp-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem; }
	.ecp-btn {
		padding: 0.32rem 0.7rem; border-radius: 7px; font-family: inherit;
		font-size: 0.66rem; cursor: pointer;
		border: 1px solid var(--color-border, rgba(255,255,255,0.14));
		background: none; color: var(--color-text-secondary);
	}
	.ecp-btn.primary { background: var(--color-accent, #e5b84c); color: var(--color-bg, #12120f); border-color: transparent; font-weight: 500; }
	.ecp-btn.ghost { color: var(--color-text-tertiary); border-color: transparent; }
	.ecp-btn:disabled { opacity: 0.55; cursor: default; }
	.ecp-link { font-size: 0.66rem; color: var(--color-accent, #e5b84c); text-decoration: none; }
	.ec-top { display: flex; align-items: center; justify-content: space-between; }
	.ec-name { font-size: 0.82rem; font-weight: 600; color: var(--color-text-primary); }
	.ec-tick { font-size: 0.75rem; color: var(--color-accent, #e5b84c); }
	.ec-blurb { font-size: 0.68rem; color: var(--color-text-secondary); line-height: 1.4; }
	.ec-tag { font-size: 0.62rem; color: var(--color-text-tertiary); margin-top: 0.15rem; }
	.ec-tag.ok { color: #6ee7a8; }
	.ec-tag.muted { color: var(--color-text-tertiary); }
</style>
