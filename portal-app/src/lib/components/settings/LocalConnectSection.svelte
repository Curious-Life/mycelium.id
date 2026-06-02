<!--
	"Connect on this Mac" — the local stdio helper (remote-connect Phase 2, part b).

	Renders a ready-to-paste .mcp.json for Claude Code / Claude Desktop, built from
	GET /api/v1/remote/local-config so it carries THIS machine's real params (node
	path, abs src/index.js, cwd, MYCELIUM_KEY_SOURCE, the ACTUAL keychain account
	names, MYCELIUM_DATA_DIR). A mismatched data dir / keychain account is the #1
	"connected but no data" gotcha (docs/MCP-CONNECT-AND-TEST.md), so we never
	hardcode defaults. Plus a live connection check via GET /api/v1/tools.

	No secrets are shown — only paths + non-secret service names. Pure HTTP via api().
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { api } from '$lib/api';

	type LocalCfg = {
		command: string; args: string[]; cwd: string; keySource: string; dataDir: string;
		keychain: { account: string; userService: string; systemService: string; custom: boolean };
	};

	let cfg = $state<LocalCfg | null>(null);
	let mcpJson = $state('');
	let loading = $state(true);
	let error = $state<string | null>(null);
	let copied = $state(false);

	let checkOk = $state(false);
	let checkMsg = $state('checking…');

	function buildJson(c: LocalCfg): string {
		const env: Record<string, string> = { MYCELIUM_KEY_SOURCE: c.keySource };
		if (c.keychain.custom) {
			env.MYCELIUM_KC_ACCOUNT = c.keychain.account;
			env.MYCELIUM_KC_USER = c.keychain.userService;
			env.MYCELIUM_KC_SYSTEM = c.keychain.systemService;
		}
		env.MYCELIUM_DATA_DIR = c.dataDir;
		env.MYCELIUM_DEBUG = '1';
		return JSON.stringify({ mcpServers: { mycelium: { command: c.command, args: c.args, cwd: c.cwd, env } } }, null, 2);
	}

	async function load() {
		loading = true; error = null;
		try {
			const res = await api('/api/v1/remote/local-config');
			if (!res.ok) throw new Error(`Failed to load (${res.status})`);
			cfg = (await res.json()) as LocalCfg;
			mcpJson = buildJson(cfg);
		} catch (e: any) {
			error = e?.message || 'Failed to load local connect config';
		} finally {
			loading = false;
		}
		// Live check — does the local vault answer with tools right now?
		try {
			const t = await api('/api/v1/tools');
			if (t.ok) {
				const n = ((await t.json()).tools || []).length;
				checkOk = n > 0;
				checkMsg = checkOk ? `${n} tools — your local vault is open and ready` : 'reachable, but no tools yet';
			} else {
				checkOk = false;
				checkMsg = t.status === 503 ? 'vault not open yet — finish setup first' : `not reachable (${t.status})`;
			}
		} catch {
			checkOk = false; checkMsg = 'not reachable';
		}
	}
	onMount(load);

	async function copy() {
		try { await navigator.clipboard.writeText(mcpJson); copied = true; setTimeout(() => (copied = false), 1500); } catch { /* clipboard blocked */ }
	}
</script>

<section class="card p-5">
	<h2 class="text-xs font-medium text-[var(--color-text-tertiary)] uppercase tracking-wider mb-4">Connect on this Mac</h2>
	<p class="text-xs text-[var(--color-text-tertiary)] mb-3">
		Use your vault from <strong>Claude Code</strong> or <strong>Claude Desktop</strong> on this computer — no internet, no tunnel, no password. Paste the config, restart the client, and your 31 tools appear.
	</p>

	<!-- Live connection check -->
	<div class="mb-3 text-[11px] flex items-center gap-2">
		<span class="px-2 py-1 rounded {checkOk ? 'bg-green-500/15 text-green-400' : 'bg-amber-500/15 text-amber-400'}">{checkOk ? '✓ live' : '…'}</span>
		<span class="text-[var(--color-text-tertiary)]">{checkMsg}</span>
	</div>

	{#if loading}
		<div class="text-sm text-[var(--color-text-tertiary)] animate-pulse">Loading…</div>
	{:else if error}
		<div class="text-xs text-red-400 p-2 rounded bg-red-500/10">{error}</div>
	{:else}
		<div class="relative">
			<button onclick={copy} class="absolute top-2 right-2 text-[10px] px-2 py-1 rounded bg-[var(--color-accent)] text-[var(--color-bg)] cursor-pointer">{copied ? 'Copied ✓' : 'Copy'}</button>
			<pre class="text-[10px] leading-relaxed font-mono bg-[var(--color-bg)] border border-[var(--color-border)] rounded p-3 overflow-auto max-h-72 text-[var(--color-text-secondary)]">{mcpJson}</pre>
		</div>
		<p class="text-[10px] text-[var(--color-text-tertiary)] mt-2 leading-relaxed">
			<strong>Claude Code:</strong> save as <code>.mcp.json</code> in your project folder, then approve the server.<br>
			<strong>Claude Desktop:</strong> merge into <code>~/Library/Application Support/Claude/claude_desktop_config.json</code>, then fully quit &amp; reopen. The tools icon should show <em>mycelium / 31 tools</em>.
		</p>
	{/if}
</section>
