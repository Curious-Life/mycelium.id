// src/inference/errors.js — shared error type for the inference router.
//
// Standalone module so local.js / cloud.js / router.js can all import it
// without an import cycle. Carries enough context to route a failure (backend,
// HTTP status) WITHOUT ever embedding the prompt or model response — inference
// inputs/outputs are user plaintext and must never land in an error string,
// log, or stack (CLAUDE.md §1: zero plaintext leakage).

export class InferenceError extends Error {
  constructor(message, { cause, status, backend, code } = {}) {
    super(message);
    this.name = "InferenceError";
    if (cause !== undefined) this.cause = cause;
    if (status !== undefined) this.status = status;
    if (backend !== undefined) this.backend = backend;
    // Stable machine-readable reason, when a caller must distinguish failure KINDS
    // rather than just report one (e.g. 'no-approved-local-model' — a refusal, not an
    // outage). A code is a constant, never derived from a prompt or a response.
    if (code !== undefined) this.code = code;
  }
}

export default InferenceError;
