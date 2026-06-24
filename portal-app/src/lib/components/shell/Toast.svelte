<script lang="ts">
	import { toasts } from '$lib/stores/toast';
	import { fly, fade } from 'svelte/transition';
</script>

{#if $toasts.length > 0}
	<div class="toast-container">
		{#each $toasts as toast (toast.id)}
			<div
				class="toast toast-{toast.type}"
				in:fly={{ y: 20, duration: 250 }}
				out:fade={{ duration: 150 }}
			>
				<span class="toast-icon">
					{#if toast.type === 'success'}&#10003;{:else if toast.type === 'error'}&#10007;{:else}&#8505;{/if}
				</span>
				<span class="toast-message">{toast.message}</span>
				<button class="toast-close" onclick={() => toasts.remove(toast.id)}>&times;</button>
			</div>
		{/each}
	</div>
{/if}

<style>
	.toast-container {
		position: fixed;
		bottom: 1.5rem;
		left: 50%;
		transform: translateX(-50%);
		z-index: 100000;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		pointer-events: none;
		max-width: 420px;
		width: calc(100vw - 2rem);
	}

	.toast {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.625rem 1rem;
		border-radius: 0.5rem;
		font-size: 0.8125rem;
		line-height: 1.4;
		pointer-events: auto;
		backdrop-filter: blur(12px);
		-webkit-backdrop-filter: blur(12px);
		border: 1px solid rgba(255, 255, 255, 0.1);
		box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
	}

	.toast-info {
		background: rgba(30, 30, 35, 0.9);
		color: var(--color-text-primary);
	}

	.toast-success {
		background: rgba(16, 42, 32, 0.9);
		color: #6ee7b7;
		border-color: rgba(110, 231, 183, 0.2);
	}

	.toast-error {
		background: rgba(50, 20, 20, 0.9);
		color: #fca5a5;
		border-color: rgba(252, 165, 165, 0.2);
	}

	:global([data-theme='light']) .toast-info {
		background: rgba(255, 255, 255, 0.95);
		color: var(--color-text-primary);
		border-color: rgba(0, 0, 0, 0.1);
		box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1);
	}

	:global([data-theme='light']) .toast-success {
		background: rgba(240, 253, 244, 0.95);
		color: #166534;
		border-color: rgba(22, 101, 52, 0.15);
	}

	:global([data-theme='light']) .toast-error {
		background: rgba(254, 242, 242, 0.95);
		color: #991b1b;
		border-color: rgba(153, 27, 27, 0.15);
	}

	.toast-icon {
		flex-shrink: 0;
		font-size: 0.875rem;
	}

	.toast-message {
		flex: 1;
	}

	.toast-close {
		flex-shrink: 0;
		background: none;
		border: none;
		color: inherit;
		opacity: 0.5;
		cursor: pointer;
		font-size: 1rem;
		padding: 0 0.25rem;
		line-height: 1;
	}

	.toast-close:hover {
		opacity: 1;
	}
</style>
