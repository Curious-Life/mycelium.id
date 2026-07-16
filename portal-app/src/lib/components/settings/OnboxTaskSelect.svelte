<script lang="ts">
	// The on-box task model picker — ONE approvable choice for one on-box task
	// (categorize / enrich). Extracted from AISettings so it is a real unit that can be
	// MOUNTED and driven in a gate: verify:model-consent could otherwise only regex the
	// component source, which still passed with the option commented out (independent
	// review, 2026-07-16). Increment I reuses this as the Understanding function's control.
	//
	// ⚠️ THE APPROVAL IS THE VALUE (design §3.10c). There is no separate consent flag:
	//   ''          → clears settings.taskModels[task] → NOT APPROVED → nothing downloads,
	//                 nothing runs on the device for this task. A supported choice.
	//   recModel    → approves the recommendation; the drainer pulls it (~GBs + the Ollama
	//                 runtime) the first time it is needed, visible in the activity feed.
	//   other       → approves an already-installed local model.
	//
	// `''` used to be the RECOMMENDED option's value, because an unset setting silently fell
	// back to qwen3.5:4b — and that implicit fallback WAS the bug (a fresh vault pulled 3.4GB
	// unasked). Once '' came to mean un-approve, the old markup labelled the disable button
	// "Recommended" and left the recommended model unselectable. Do not reintroduce that:
	// the recommendation must always be REPRESENTABLE, or the consent gate has no off-ramp.
	let {
		value = '',
		recModel,
		options = [],
		disabled = false,
		onpick,
	}: {
		value?: string;
		recModel: string;
		options?: string[];   // installed locals, EXCLUDING recModel (it has its own option)
		disabled?: boolean;
		onpick: (model: string) => void;
	} = $props();
</script>

<select
	class="task-select"
	{disabled}
	{value}
	onchange={(e) => onpick((e.currentTarget as HTMLSelectElement).value)}
>
	<option value="">Off · don’t run this on your device</option>
	<option value={recModel}>Recommended · {recModel}</option>
	{#each options as name}
		<option value={name}>{name}</option>
	{/each}
</select>

<style>
	.task-select {
		font: inherit;
		color: var(--color-text, inherit);
		background: var(--color-surface-2, transparent);
		border: 1px solid var(--color-border, currentColor);
		border-radius: 6px;
		padding: 0.25rem 0.4rem;
		max-width: 22ch;
	}
	.task-select:disabled { opacity: 0.5; }
</style>
