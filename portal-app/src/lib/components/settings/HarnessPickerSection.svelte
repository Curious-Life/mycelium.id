<!--
	Harness picker — "pick the agent harness you use, get its recipe."
	A curated card menu over Mycelium's two doors (memory /mcp + model /v1). Each
	card expands to a copy-paste recipe; openclaw carries the scam-safety note.
	Read-only: reuses GET /api/v1/remote/status for the public base URL (when a
	relay handle is claimed) — no new backend. Full per-harness detail lives in
	docs/HARNESS-RECIPES.md; the "Custom" card points at ConnectYourAISection below.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { api } from '$lib/api';

	const LOCAL = 'http://127.0.0.1:4711';
	const MODEL = 'mycelium-auto';

	let publicBaseUrl = $state<string | null>(null);
	let selected = $state<string | null>(null);
	let copied = $state<string | null>(null);

	async function loadRemote() {
		try {
			const res = await api('/api/v1/remote/status');
			if (res.ok) { const s = await res.json(); publicBaseUrl = s?.publicBaseUrl || null; }
		} catch { /* remote not configured — local-only is fine */ }
	}
	onMount(loadRemote);

	async function copy(label: string, text: string) {
		try {
			await navigator.clipboard.writeText(text);
			copied = label;
			setTimeout(() => { if (copied === label) copied = null; }, 1200);
		} catch { /* clipboard blocked */ }
	}

	type Door = 'memory' | 'model';
	type Harness = {
		id: string; name: string; blurb: string; doors: Door[];
		recipe: string | null; note?: string; docId: string;
	};

	const MCP = `${LOCAL}/mcp`;

	const harnesses: Harness[] = [
		{
			id: 'mycelium', name: 'Mycelium-native', doors: [],
			blurb: 'No external harness — talk to your vault directly in the portal. Sovereign and local.',
			recipe: null, docId: 'mycelium-native'
		},
		{
			id: 'claude', name: 'Claude Desktop / Code', doors: ['memory'],
			blurb: 'The lowest-friction local path — stdio, no token. (Generated for your machine in "Connect on this Mac" above.)',
			recipe: `claude mcp add mycelium -- node /ABSOLUTE/PATH/TO/mycelium.id/src/index.js`,
			docId: 'claude-desktop--claude-code-memory-door-stdio'
		},
		{
			id: 'opencode', name: 'opencode', doors: ['memory', 'model'],
			blurb: 'The coding harness (the Claude Code mirror). Uses both doors — memory over MCP, model over the gateway.',
			recipe: `// opencode.json
{
  "mcp": {
    "mycelium": {
      "type": "remote",
      "url": "${MCP}",
      "enabled": true,
      "headers": { "Authorization": "Bearer <MYCELIUM_MCP_BEARER>" },
      "oauth": false
    }
  }
}`,
			docId: 'opencode-memory--model'
		},
		{
			id: 'openclaw', name: 'openclaw', doors: ['memory'],
			blurb: 'Omni-channel personal assistant. Connects over streamable-http MCP.',
			note: 'Heavily impersonated by scams — trust only the openclaw/openclaw repo and openclaw.ai. It never asks you to connect a crypto wallet.',
			recipe: `openclaw mcp set mycelium '{"url":"${MCP}","transport":"streamable-http","headers":{"Authorization":"Bearer <MYCELIUM_MCP_BEARER>"}}'`,
			docId: 'openclaw-memory-door'
		},
		{
			id: 'hermes', name: 'hermes-agent', doors: ['memory'],
			blurb: 'Self-improving personal agent (MCP-native). The agent, not the Hermes LLM family.',
			recipe: `# hermes config (YAML)
mcp_servers:
  mycelium:
    url: "${MCP}"
    headers:
      Authorization: "Bearer <MYCELIUM_MCP_BEARER>"`,
			docId: 'hermes-agent-memory-door'
		},
		{
			id: 'custom', name: 'Custom — any MCP / OpenAI client', doors: ['memory', 'model'],
			blurb: 'Goose, Cline, Continue, Codex, OpenHands, Cursor… any spec-compliant harness. Use the raw endpoints below.',
			recipe: `Memory (MCP)   : ${MCP}     (OAuth 2.1 or Bearer <MYCELIUM_MCP_BEARER>)
Model base URL : ${LOCAL}/v1      (API key = the bearer)
Model id       : ${MODEL}`,
			docId: 'custom--any-mcp-or-openai-compatible-client'
		}
	];

	const doorLabel: Record<Door, string> = { memory: 'memory', model: 'model' };
	const RECIPES_DOC = 'docs/HARNESS-RECIPES.md';

	function toggle(id: string) { selected = selected === id ? null : id; }
</script>

<section class="card p-5">
	<h2 class="text-xs font-medium text-[var(--color-text-tertiary)] uppercase tracking-wider mb-4">Pick your harness</h2>
	<p class="text-xs text-[var(--color-text-tertiary)] mb-4">
		Choose the agent you use — Mycelium becomes its <span class="text-[var(--color-text-secondary)]">memory</span> (over MCP) and, optionally, its <span class="text-[var(--color-text-secondary)]">model</span> (over the gateway). Full per-harness setup: <span class="font-mono">{RECIPES_DOC}</span>.
	</p>

	{#if !publicBaseUrl}
		<div class="mb-4 text-[10px] px-2 py-1 rounded bg-amber-500/10 text-amber-400 inline-block">
			Local-only today — remote (your relay handle) is coming soon. These recipes use loopback.
		</div>
	{/if}

	<div class="space-y-2">
		{#each harnesses as h (h.id)}
			<div class="rounded border border-[var(--color-border)] overflow-hidden">
				<button
					class="w-full flex items-center gap-2 p-3 text-left cursor-pointer hover:bg-[var(--color-elevated)]"
					onclick={() => toggle(h.id)}
				>
					<span class="text-xs font-medium text-[var(--color-text-primary)]">{h.name}</span>
					<span class="flex gap-1">
						{#each h.doors as d (d)}
							<span class="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-[var(--color-elevated)] text-[var(--color-text-tertiary)]">{doorLabel[d]}</span>
						{/each}
					</span>
					<span class="ml-auto text-[10px] text-[var(--color-text-tertiary)]">{selected === h.id ? '−' : '+'}</span>
				</button>

				{#if selected === h.id}
					<div class="p-3 pt-0 space-y-2">
						<p class="text-[11px] text-[var(--color-text-tertiary)]">{h.blurb}</p>

						{#if h.note}
							<p class="text-[11px] text-amber-400 p-2 rounded bg-amber-500/10">⚠️ {h.note}</p>
						{/if}

						{#if h.recipe}
							<div class="relative">
								<button class="absolute top-2 right-2 text-[10px] text-aurum cursor-pointer" onclick={() => copy(h.id, h.recipe!)}>{copied === h.id ? '✓ copied' : 'Copy'}</button>
								<pre class="font-mono text-[10px] bg-[var(--color-bg)] p-3 pr-14 rounded overflow-x-auto text-[var(--color-text-secondary)]">{h.recipe}</pre>
							</div>
							<p class="text-[10px] text-[var(--color-text-tertiary)]">
								Auth: set <span class="font-mono">MYCELIUM_MCP_BEARER</span> and restart the gateway (see the "Connect your AI" card below). Browser MCP clients can use OAuth instead.
							</p>
						{:else}
							<p class="text-[11px] text-[var(--color-text-tertiary)]">Open the portal and use Mycelium directly — nothing to configure.</p>
						{/if}

						<a class="text-[10px] text-aurum" href={`/${RECIPES_DOC}`} target="_blank" rel="noopener">Full recipe →</a>
					</div>
				{/if}
			</div>
		{/each}
	</div>
</section>
