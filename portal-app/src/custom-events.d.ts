// Register custom bubbling DOM events so `on<event>` handlers on plain elements
// type-check. `illuminate` is dispatched by Mindscape3D / MindscapeDetail as a
// bubbling CustomEvent<string> (the focused month) and caught on a wrapper <div>.
declare namespace svelteHTML {
	interface HTMLAttributes<T> {
		'onilluminate'?: (event: CustomEvent<string>) => void;
	}
}
