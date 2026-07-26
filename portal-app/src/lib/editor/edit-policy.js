/**
 * Edit-session policy — the DECISIONS the library document editor makes about
 * when it may edit, resume, leave, or give up on a buffer.
 *
 * WHY THIS IS ITS OWN MODULE (D-052, round-2 review)
 * These decisions used to live inline in LibraryView.svelte, where a gate can
 * only assert their *shape* — "the guard is called at N sites", "the token
 * appears in this function". An adversarial review then gutted
 * `canLeaveOpenDoc()` to `if (true) return true`, restoring the original
 * fail-open blocker verbatim, and the gate stayed green: the check named the
 * guard but never tested that the guard guards. Ten such mutations passed.
 *
 * Moving the predicates here makes them executable, so `verify:editor-autosave`
 * drives them over full truth tables. The component keeps only the binding —
 * reading state and acting on the verdict — and the gate separately asserts that
 * it defers to these functions rather than re-deriving the logic inline.
 *
 * Every function here is PURE: same inputs, same verdict, no I/O.
 */

/**
 * May this document be edited at all?
 *
 * FAIL CLOSED. A library list row carries no content, so `selectedDoc.content`
 * is the empty-string PLACEHOLDER until the detail GET lands (and stays that way
 * forever if it fails). Editing the placeholder makes the buffer look like an
 * empty document, and the first save writes '' over the real text. Only content
 * we actually received is editable.
 *
 * @param {{ contentLoadedPath: string | null, openPath: string | null | undefined }} s
 */
export function canEditDoc({ contentLoadedPath, openPath }) {
	if (!openPath) return false;
	if (!contentLoadedPath) return false;
	return contentLoadedPath === openPath;
}

/**
 * Does the edit buffer still legitimately own this document's content?
 *
 * The gate on every write. Guards two distinct hazards at once:
 *  - the buffer belongs to a DIFFERENT document (a save scheduled for doc A must
 *    never land on doc B after a switch), and
 *  - the content we would diff against is an unloaded placeholder.
 *
 * @param {{ editBufferPath: string | null, openPath: string | null | undefined, contentLoadedPath: string | null }} s
 */
export function bufferOwnsDoc({ editBufferPath, openPath, contentLoadedPath }) {
	if (!openPath || !editBufferPath) return false;
	if (editBufferPath !== openPath) return false;
	return canEditDoc({ contentLoadedPath, openPath });
}

/**
 * On (re-)entering the editor: resume the existing buffer, or seed a fresh one
 * from the persisted content?
 *
 * Resume ONLY when this document's buffer is still owed to the server — i.e. the
 * user never successfully left. Re-seeding then would replace their text with the
 * older persisted text. But a buffer that is NOT owed must never be resumed: a
 * clean exit releases the buffer, and resuming a released one could write text
 * that predates an agent's rewrite back over the agent's work.
 *
 * @param {{ editBufferPath: string | null, openPath: string | null | undefined, dirty: boolean }} s
 */
export function shouldResumeBuffer({ editBufferPath, openPath, dirty }) {
	if (!openPath || !editBufferPath) return false;
	if (editBufferPath !== openPath) return false;
	return dirty === true;
}

/**
 * May we close/switch away from the open document?
 *
 * FAIL CLOSED. Closing unpins the buffer, which turns any armed retry into a
 * no-op — so leaving while text is still owed is a silent loss. Callers must
 * flush FIRST and pass the post-flush dirtiness.
 *
 * @param {{ editing: boolean, dirtyAfterFlush: boolean }} s
 */
export function canLeaveDoc({ editing, dirtyAfterFlush }) {
	if (!editing) return true;
	return dirtyAfterFlush !== true;
}

/**
 * Is the save stuck badly enough to show the escape hatch (Copy text / Discard)?
 *
 * Two triggers, because neither alone is sufficient:
 *  - `failures >= threshold` catches a quiet, sustained outage; but the failure
 *    count is zeroed by every keystroke, so a user typing steadily can be refused
 *    an exit while never reaching the threshold.
 *  - `leaveRefused` LATCHES the first time an exit is actually denied. Once
 *    tripped it must stay tripped for this buffer — otherwise typing starves the
 *    hatch and the refusal becomes a door with no handle.
 *
 * @param {{ failures: number, threshold: number, leaveRefused: boolean }} s
 */
export function isSaveStuck({ failures, threshold, leaveRefused }) {
	if (leaveRefused === true) return true;
	return Number(failures) >= Number(threshold);
}

/**
 * Classify a save response so a PERMANENT rejection isn't retried forever.
 *
 * A transport failure or a 5xx is worth retrying indefinitely — the text is fine,
 * the vault is briefly unreachable. A 4xx means the server will keep refusing
 * this request no matter how often we resend it, so retrying just resubmits the
 * user's plaintext every 10s with no terminal state. 408 (timeout) and 429
 * (rate-limited) are the exceptions: both explicitly invite a retry.
 *
 * 'permanent' does NOT mean discard — the buffer is always kept and the escape
 * hatch is shown. It means stop resending and tell the user.
 *
 * @param {{ ok: boolean, status?: number | null }} r
 * @returns {'ok' | 'transient' | 'permanent'}
 */
export function classifySaveResult({ ok, status }) {
	if (ok) return 'ok';
	const code = Number(status);
	if (!Number.isFinite(code) || code <= 0) return 'transient'; // network / no response
	if (code === 408 || code === 429) return 'transient';
	if (code >= 400 && code < 500) return 'permanent';
	return 'transient';
}
