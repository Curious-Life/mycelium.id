<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { browser } from '$app/environment';
	import { api } from '$lib/api';

	interface AgentSummary {
		runs: number; inputTokens: number; outputTokens: number;
		cacheRead: number; cacheCreation: number; costUsd: number;
		models: Record<string, number>;
	}
	interface DateBucket {
		runs: number; inputTokens: number; outputTokens: number; cacheRead: number;
		agents: Record<string, { runs: number; tokens: number }>;
	}
	interface Flow { source: string; target: string; tokens: number; runs: number; }
	interface Summary {
		totals: { runs: number; inputTokens: number; outputTokens: number; cacheRead: number; cacheCreation: number; costUsd: number };
		byAgent: Record<string, AgentSummary>;
		byModel: Record<string, { runs: number; inputTokens: number; outputTokens: number }>;
		byDate: Record<string, DateBucket>;
		flows: Flow[];
		flowsOut: Flow[];
	}
	interface EnergyRecord {
		ts: string; agent: string; process: string; model: string;
		inputTokens: number; outputTokens: number; cacheRead: number;
		cacheCreation: number; costUsd: number | null; durationMs: number | null;
	}

	const AC: Record<string, string> = {
		alpha: '#60A5FA', beta: '#34D399', gamma: '#A78BFA', delta: '#FBBF24',
		lambda: '#C084FC', jup: '#F97316', eta: '#FB923C', kappa: '#F472B6', unknown: '#4a5568',
	};
	const MC: Record<string, string> = { opus: '#ef4444', sonnet: '#3b82f6', haiku: '#10b981' };

	let loading = $state(true);
	let summary = $state<Summary | null>(null);
	let records = $state<EnergyRecord[]>([]);
	let days = $state(7);
	let tab = $state<'flow' | 'time' | 'records'>('flow');
	let selectedAgent = $state<string | null>(null);
	let selectedModel = $state<string | null>(null);
	let refreshTimer: ReturnType<typeof setInterval> | null = null;
	let tick = $state(0);

	let timelineEl: HTMLDivElement;
	let charts: any[] = [];

	// Animation tick
	let animFrame: number;
	function animate() { tick++; animFrame = requestAnimationFrame(animate); }

	onMount(() => { loadData(); refreshTimer = setInterval(loadData, 120_000); animate(); });
	onDestroy(() => {
		if (refreshTimer) clearInterval(refreshTimer);
		if (animFrame) cancelAnimationFrame(animFrame);
		charts.forEach(c => c?.dispose());
	});

	// Computed: sorted agents by total tokens
	const agentsSorted = $derived.by(() => {
		if (!summary) return [];
		return Object.entries(summary.byAgent)
			.map(([id, d]) => ({ id, total: d.inputTokens + d.outputTokens, input: d.inputTokens, output: d.outputTokens, runs: d.runs, models: d.models }))
			.sort((a, b) => b.total - a.total);
	});

	const modelsSorted = $derived.by(() => {
		if (!summary) return [];
		return Object.entries(summary.byModel)
			.map(([id, d]) => ({ id, total: d.inputTokens + d.outputTokens, runs: d.runs }))
			.sort((a, b) => b.total - a.total);
	});

	// Radial layout computations
	const CX = 450;
	const CY = 300;
	const R_MODEL = 100;  // model ring radius
	const R_AGENT = 240;  // agent ring radius
	const R_OUTPUT = 340; // output ring radius

	const modelPositions = $derived.by(() => {
		return modelsSorted.map((m, i) => {
			const angle = -Math.PI/2 + (i / Math.max(1, modelsSorted.length)) * 2 * Math.PI;
			return { ...m, x: CX + R_MODEL * Math.cos(angle), y: CY + R_MODEL * Math.sin(angle), angle };
		});
	});

	const agentPositions = $derived.by(() => {
		return agentsSorted.map((a, i) => {
			const angle = -Math.PI/2 + (i / Math.max(1, agentsSorted.length)) * 2 * Math.PI;
			return { ...a, x: CX + R_AGENT * Math.cos(angle), y: CY + R_AGENT * Math.sin(angle), angle };
		});
	});

	// Flows: model → agent with positions
	const flowLines = $derived.by(() => {
		if (!summary?.flows) return [];
		const maxTok = Math.max(1, ...summary.flows.map(f => f.tokens));
		return summary.flows.map(f => {
			const mp = modelPositions.find(m => m.id === f.source);
			const ap = agentPositions.find(a => a.id === f.target);
			if (!mp || !ap) return null;
			const highlight = (!selectedAgent && !selectedModel) ||
				selectedAgent === f.target || selectedModel === f.source;
			return { ...f, x1: mp.x, y1: mp.y, x2: ap.x, y2: ap.y, weight: f.tokens / maxTok, highlight };
		}).filter(Boolean) as any[];
	});

	const filteredRecords = $derived(
		records.filter(r => r.model !== '<synthetic>'
			&& (!selectedAgent || r.agent === selectedAgent)
			&& (!selectedModel || r.model === selectedModel))
	);

	async function loadData() {
		try {
			const p = new URLSearchParams({ days: String(days) });
			const [sRes, rRes] = await Promise.all([
				api(`/portal/energy/summary?${p}`), api(`/portal/energy?${p}`)
			]);
			if (sRes.ok) summary = await sRes.json();
			if (rRes.ok) { const d = await rRes.json(); records = d.records || []; }
		} catch {}
		loading = false;
		if (browser && summary && tab === 'time') requestAnimationFrame(renderTimeline);
	}

	async function renderTimeline() {
		if (!timelineEl || !summary?.byDate) return;
		const echarts = await import('echarts');
		charts.forEach(c => c?.dispose()); charts = [];
		const chart = echarts.init(timelineEl, undefined, { renderer: 'canvas' });
		charts.push(chart);
		const dates = Object.keys(summary.byDate).sort();
		const agents = agentsSorted.map(a => a.id);
		chart.setOption({
			backgroundColor: 'transparent',
			tooltip: { trigger: 'axis', backgroundColor: '#0c0c14', borderColor: '#1a1a2e',
				textStyle: { color: '#c8cad0', fontSize: 11, fontFamily: 'monospace' } },
			legend: { data: agents, textStyle: { color: '#3a3e50', fontSize: 10, fontFamily: 'monospace' }, top: 0, itemWidth: 10, itemHeight: 6 },
			grid: { left: 55, right: 12, top: 34, bottom: 24 },
			xAxis: { type: 'category', data: dates.map(d => d.slice(5)),
				axisLine: { lineStyle: { color: '#141420' } },
				axisLabel: { color: '#3a3e50', fontSize: 9, fontFamily: 'monospace' } },
			yAxis: { type: 'value', axisLine: { show: false },
				splitLine: { lineStyle: { color: '#0e0e18' } },
				axisLabel: { color: '#3a3e50', fontSize: 9, fontFamily: 'monospace',
					formatter: (v: number) => v >= 1e6 ? (v/1e6).toFixed(1)+'M' : v >= 1e3 ? (v/1e3).toFixed(0)+'K' : String(v) } },
			series: agents.map(agent => ({
				name: agent, type: 'bar', stack: 'total', barWidth: '65%',
				itemStyle: { color: AC[agent] || '#3a3e50' },
				emphasis: { focus: 'series' },
				data: dates.map(d => summary!.byDate[d]?.agents?.[agent]?.tokens || 0),
			})),
		});
		new ResizeObserver(() => chart.resize()).observe(timelineEl);
	}

	function fmt(n: number): string {
		if (n >= 1e9) return (n/1e9).toFixed(2) + 'B';
		if (n >= 1e6) return (n/1e6).toFixed(2) + 'M';
		if (n >= 1e3) return (n/1e3).toFixed(1) + 'K';
		return String(n);
	}
	function fmtTime(d: string) { return new Date(d).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }); }
	function fmtDate(d: string) { return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); }
	function fmtDur(ms: number|null) { if (!ms) return '--'; return ms < 1000 ? ms+'ms' : (ms/1000).toFixed(1)+'s'; }
	function setDays(d: number) { days = d; loading = true; loadData(); }
	function toggleAgent(a: string) { selectedAgent = selectedAgent === a ? null : a; selectedModel = null; }
	function toggleModel(m: string) { selectedModel = selectedModel === m ? null : m; selectedAgent = null; }

	$effect(() => { if (tab === 'time' && summary && browser) requestAnimationFrame(renderTimeline); });
</script>

<svelte:head><title>Energy — Mycelium</title></svelte:head>

<div class="flex flex-col h-full" style="background: #060710; font-family: 'Inter', -apple-system, sans-serif;">

	<!-- Top Bar -->
	<div class="flex items-center gap-4 px-5 py-2.5" style="border-bottom: 1px solid #0e0f1a;">
		<div class="flex items-center gap-2">
			<div style="width: 6px; height: 6px; background: #f59e0b; clip-path: polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%);"></div>
			<span style="color: #5a5e78; font-size: 11px; font-weight: 600; letter-spacing: 0.1em;">ENERGY</span>
		</div>
		<div class="flex" style="border: 1px solid #0e0f1a;">
			{#each [{ id: 'flow', label: 'FLOW' }, { id: 'time', label: 'TIME' }, { id: 'records', label: 'LOG' }] as t}
				<button style="font-size: 9px; padding: 3px 14px; letter-spacing: 0.1em;
					{tab === t.id ? 'background: #0e0f1a; color: #8890a8;' : 'color: #2a2d40;'}"
					onclick={() => { tab = t.id as any; }}>{t.label}</button>
			{/each}
		</div>
		<div class="ml-auto flex" style="border: 1px solid #0e0f1a;">
			{#each [{ d: 1, l: '24H' }, { d: 7, l: '7D' }, { d: 30, l: '30D' }] as o}
				<button style="font-size: 9px; padding: 3px 10px; letter-spacing: 0.08em; font-family: monospace;
					{days === o.d ? 'background: #0e0f1a; color: #8890a8;' : 'color: #2a2d40;'}"
					onclick={() => setDays(o.d)}>{o.l}</button>
			{/each}
		</div>
	</div>

	{#if loading}
		<div class="flex-1 flex items-center justify-center" style="color: #2a2d40; font-size: 10px; letter-spacing: 0.15em;">LOADING</div>
	{:else}

		<!-- Metrics -->
		{#if summary}
			<div class="flex" style="border-bottom: 1px solid #0e0f1a;">
				{#each [
					{ l: 'RUNS', v: fmt(summary.totals.runs) },
					{ l: 'IN', v: fmt(summary.totals.inputTokens) },
					{ l: 'OUT', v: fmt(summary.totals.outputTokens) },
					{ l: 'CACHE.R', v: fmt(summary.totals.cacheRead) },
					{ l: 'CACHE.W', v: fmt(summary.totals.cacheCreation) },
				] as m, i}
					<div class="flex-1 py-2.5 px-4" style="{i > 0 ? 'border-left: 1px solid #0e0f1a;' : ''}">
						<div style="font-size: 8px; color: #2a2d40; letter-spacing: 0.15em;">{m.l}</div>
						<div style="font-size: 17px; color: #b0b4c8; font-family: 'JetBrains Mono', monospace; font-weight: 300;">{m.v}</div>
					</div>
				{/each}
			</div>
		{/if}

		{#if tab === 'flow'}
			<div class="flex-1 overflow-y-auto">

				<!-- Radial Energy Flow -->
				{#if summary}
					<div style="padding: 20px; display: flex; justify-content: center;">
						<svg viewBox="0 0 900 600" style="max-width: 900px; width: 100%; height: auto;">
							<defs>
								<radialGradient id="core-glow">
									<stop offset="0%" stop-color="#f59e0b" stop-opacity="0.15" />
									<stop offset="70%" stop-color="#f59e0b" stop-opacity="0.02" />
									<stop offset="100%" stop-color="#f59e0b" stop-opacity="0" />
								</radialGradient>
								<filter id="glow">
									<feGaussianBlur stdDeviation="2" result="blur" />
									<feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
								</filter>
							</defs>

							<!-- Background rings -->
							<circle cx={CX} cy={CY} r={R_OUTPUT + 20} fill="none" stroke="#0a0b14" stroke-width="0.5" />
							<circle cx={CX} cy={CY} r={R_AGENT} fill="none" stroke="#0a0b14" stroke-width="0.5" stroke-dasharray="2 4" />
							<circle cx={CX} cy={CY} r={R_MODEL} fill="none" stroke="#0e0f1a" stroke-width="0.5" stroke-dasharray="2 4" />

							<!-- Core glow -->
							<circle cx={CX} cy={CY} r="80" fill="url(#core-glow)" />

							<!-- Flow lines: model → agent -->
							{#each flowLines as fl}
								{@const opacity = fl.highlight ? 0.12 + fl.weight * 0.25 : 0.02}
								{@const width = 0.5 + fl.weight * 6}
								<line x1={fl.x1} y1={fl.y1} x2={fl.x2} y2={fl.y2}
									stroke={MC[fl.source] || '#1a1a2e'} stroke-width={width} opacity={opacity} />
								<!-- Animated particle -->
								{#if fl.highlight}
									{@const progress = ((tick * (0.3 + fl.weight * 0.7)) % 200) / 200}
									{@const px = fl.x1 + (fl.x2 - fl.x1) * progress}
									{@const py = fl.y1 + (fl.y2 - fl.y1) * progress}
									<circle cx={px} cy={py} r={1 + fl.weight * 2} fill={MC[fl.source] || '#3a3e50'}
										opacity={0.4 + fl.weight * 0.4} filter="url(#glow)" />
								{/if}
							{/each}

							<!-- Output rays: agent → outward -->
							{#each agentPositions as ap}
								{@const outAngle = ap.angle}
								{@const ox = CX + R_OUTPUT * Math.cos(outAngle)}
								{@const oy = CY + R_OUTPUT * Math.sin(outAngle)}
								{@const highlight = !selectedAgent || selectedAgent === ap.id}
								{@const outRatio = ap.output / Math.max(1, ap.total)}
								<line x1={ap.x} y1={ap.y} x2={ox} y2={oy}
									stroke={AC[ap.id]} stroke-width={0.5 + outRatio * 3} opacity={highlight ? 0.15 : 0.02} />
								{#if highlight && ap.output > 0}
									{@const p2 = ((tick * 0.4 + agentPositions.indexOf(ap) * 30) % 150) / 150}
									{@const px2 = ap.x + (ox - ap.x) * p2}
									{@const py2 = ap.y + (oy - ap.y) * p2}
									<circle cx={px2} cy={py2} r={1 + outRatio * 2.5} fill={AC[ap.id]} opacity={0.5} filter="url(#glow)" />
								{/if}
								<!-- Output label -->
								{#if highlight}
									<text x={ox + (ox > CX ? 8 : -8)} y={oy + 3} text-anchor={ox > CX ? 'start' : 'end'}
										fill="#2a2d40" font-size="8" style="font-family: monospace;">{fmt(ap.output)}</text>
								{/if}
							{/each}

							<!-- Central source -->
							<polygon points="{CX},{CY-28} {CX+24},{CY} {CX},{CY+28} {CX-24},{CY}"
								fill="#060710" stroke="#f59e0b" stroke-width="0.8" opacity="0.8" />
							<polygon points="{CX},{CY-16} {CX+14},{CY} {CX},{CY+16} {CX-14},{CY}"
								fill="#f59e0b" opacity="0.08" />
							<text x={CX} y={CY - 2} text-anchor="middle" fill="#f59e0b" font-size="7"
								style="font-family: monospace; letter-spacing: 0.15em; font-weight: 600;">CLAUDE</text>
							<text x={CX} y={CY + 8} text-anchor="middle" fill="#7a6530" font-size="7"
								style="font-family: monospace;">{fmt(summary.totals.inputTokens + summary.totals.outputTokens)}</text>

							<!-- Model nodes -->
							{#each modelPositions as mp}
								{@const active = !selectedModel || selectedModel === mp.id}
								{@const hexPts = [0,1,2,3,4,5].map(i => { const a = Math.PI/3*i - Math.PI/6; return `${mp.x + 18*Math.cos(a)},${mp.y + 18*Math.sin(a)}`; }).join(' ')}
								<!-- svelte-ignore a11y_click_events_have_key_events -->
								<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
								<g style="cursor: pointer;" onclick={() => toggleModel(mp.id)}>
									<polygon points={hexPts}
										fill={active ? MC[mp.id] + '15' : '#060710'} stroke={active ? MC[mp.id] : '#0e0f1a'}
										stroke-width={active ? 1 : 0.5} />
									<text x={mp.x} y={mp.y + 1} text-anchor="middle" fill={active ? MC[mp.id] : '#2a2d40'}
										font-size="7" style="font-family: monospace; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em;">{mp.id}</text>
									<text x={mp.x} y={mp.y + 12} text-anchor="middle" fill={active ? '#3a3e50' : '#1a1d2e'}
										font-size="6" style="font-family: monospace;">{fmt(mp.total)}</text>
								</g>
							{/each}

							<!-- Agent nodes -->
							{#each agentPositions as ap}
								{@const active = !selectedAgent || selectedAgent === ap.id}
								{@const lx = CX + (R_AGENT + 22) * Math.cos(ap.angle)}
								{@const ly = CY + (R_AGENT + 22) * Math.sin(ap.angle)}
								<!-- svelte-ignore a11y_click_events_have_key_events -->
								<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
								<g style="cursor: pointer;" onclick={() => toggleAgent(ap.id)}>
									<polygon points="{ap.x},{ap.y - 14} {ap.x + 14},{ap.y} {ap.x},{ap.y + 14} {ap.x - 14},{ap.y}"
										fill={active ? AC[ap.id] + '12' : '#060710'} stroke={active ? AC[ap.id] : '#0e0f1a'}
										stroke-width={active ? 1 : 0.5} />
									<text x={ap.x} y={ap.y + 3} text-anchor="middle" fill={active ? AC[ap.id] : '#2a2d40'}
										font-size="7" style="font-family: monospace; font-weight: 700; text-transform: uppercase;">{ap.id.slice(0,3)}</text>
									<text x={lx} y={ly - 4} text-anchor={lx > CX ? 'start' : 'end'}
										fill={active ? AC[ap.id] : '#1a1d2e'} font-size="9"
										style="font-family: monospace; font-weight: 600;">{ap.id}</text>
									<text x={lx} y={ly + 6} text-anchor={lx > CX ? 'start' : 'end'}
										fill={active ? '#3a3e50' : '#141620'} font-size="7"
										style="font-family: monospace;">{fmt(ap.total)} · {ap.runs}r</text>
								</g>
							{/each}

							<!-- Ring labels -->
							<text x={CX + R_MODEL + 30} y={CY - R_MODEL + 8} fill="#1a1d2e" font-size="7"
								style="font-family: monospace; letter-spacing: 0.1em;">MODELS</text>
							<text x={CX + R_AGENT + 5} y={CY - R_AGENT + 8} fill="#1a1d2e" font-size="7"
								style="font-family: monospace; letter-spacing: 0.1em;">AGENTS</text>
						</svg>
					</div>

					<!-- Agent Detail Cards -->
					<div style="padding: 0 20px 20px; display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 1px; background: #0e0f1a;">
						{#each agentsSorted as a}
							<button
								style="background: {selectedAgent === a.id ? AC[a.id] + '08' : '#060710'}; padding: 14px 16px; text-align: left;
									border-top: 2px solid {selectedAgent === a.id ? AC[a.id] : 'transparent'};"
								onclick={() => toggleAgent(a.id)}
							>
								<div class="flex items-center gap-2">
									<div style="width: 5px; height: 5px; clip-path: polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%); background: {AC[a.id]};"></div>
									<span style="font-size: 10px; color: {AC[a.id]}; font-weight: 600; font-family: monospace; text-transform: uppercase;">{a.id}</span>
								</div>
								<div style="font-size: 18px; color: #b0b4c8; font-family: 'JetBrains Mono', monospace; font-weight: 300; margin-top: 6px;">{fmt(a.total)}</div>
								<div style="display: flex; gap: 8px; margin-top: 4px;">
									<span style="font-size: 8px; color: #ef4444; font-family: monospace;">IN {fmt(a.input)}</span>
									<span style="font-size: 8px; color: #3b82f6; font-family: monospace;">OUT {fmt(a.output)}</span>
								</div>
								<div style="font-size: 8px; color: #1a1d2e; font-family: monospace; margin-top: 3px;">{a.runs} runs ·
									{#each Object.entries(a.models).filter(([m]) => m !== '<synthetic>') as [m, c], i}{#if i > 0} · {/if}<span style="color: {MC[m] || '#2a2d40'}">{m} {c}</span>{/each}
								</div>
							</button>
						{/each}
					</div>
				{/if}
			</div>

		{:else if tab === 'time'}
			<div class="flex-1 overflow-y-auto p-5">
				<div style="border: 1px solid #0e0f1a; background: #080910; padding: 16px;">
					<div bind:this={timelineEl} style="height: 380px; width: 100%;"></div>
				</div>
			</div>

		{:else}
			<div class="flex-1 overflow-auto">
				{#if filteredRecords.length === 0}
					<div style="padding: 60px; text-align: center; color: #1a1d2e; font-size: 10px; letter-spacing: 0.15em;">NO RECORDS</div>
				{:else}
					<table class="w-full" style="font-size: 11px; border-collapse: collapse;">
						<thead>
							<tr style="border-bottom: 1px solid #0e0f1a;">
								{#each ['TIME', 'AGENT', 'TYPE', 'MODEL', 'IN', 'OUT', 'CACHE', 'DUR'] as h, i}
									<th style="padding: 8px 12px; text-align: {i >= 4 ? 'right' : 'left'}; color: #1a1d2e; font-size: 8px; letter-spacing: 0.15em; font-weight: 600;">{h}</th>
								{/each}
							</tr>
						</thead>
						<tbody>
							{#each filteredRecords.slice().reverse().slice(0, 200) as r, i}
								<tr style="border-bottom: 1px solid #0a0b12; background: {i % 2 === 0 ? '#060710' : '#080910'};">
									<td style="padding: 5px 12px; color: #1a1d2e; font-family: monospace; white-space: nowrap; font-size: 10px;">{fmtDate(r.ts)} {fmtTime(r.ts)}</td>
									<td style="padding: 5px 12px; color: {AC[r.agent] || '#4a5568'}; font-weight: 600; font-family: monospace; font-size: 10px;">{r.agent}</td>
									<td style="padding: 5px 12px; color: #2a2d40; font-size: 10px;">{r.process}</td>
									<td style="padding: 5px 12px; color: {MC[r.model] || '#2a2d40'}; font-family: monospace; font-size: 10px;">{r.model}</td>
									<td style="padding: 5px 12px; color: #3a3e50; font-family: monospace; text-align: right; font-size: 10px;">{fmt(r.inputTokens)}</td>
									<td style="padding: 5px 12px; color: #6a6e80; font-family: monospace; text-align: right; font-size: 10px;">{fmt(r.outputTokens)}</td>
									<td style="padding: 5px 12px; color: #1a1d2e; font-family: monospace; text-align: right; font-size: 10px;">{fmt(r.cacheRead)}</td>
									<td style="padding: 5px 12px; color: #1a1d2e; font-family: monospace; text-align: right; font-size: 10px;">{fmtDur(r.durationMs)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				{/if}
			</div>
		{/if}
	{/if}
</div>