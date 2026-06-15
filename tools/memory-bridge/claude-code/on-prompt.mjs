#!/usr/bin/env node
// Claude Code UserPromptSubmit hook — the PULL half.
//
// Fires before the model runs. Reads the hook payload on stdin ({prompt,
// session_id, …}), pulls vault context for this turn, and injects it via
// `hookSpecificOutput.additionalContext` (the only injection channel for
// UserPromptSubmit). Capture is NOT done here — it happens in on-stop.mjs, which
// has stable transcript `uuid`s for both roles (avoids double-capturing the user
// turn under two ids).
//
// Fail-open: any error → exit 0 with no output, so the turn proceeds with no
// injected context. Never blocks. UserPromptSubmit has a ~30s hook timeout; the
// bridge's own request timeout (default 4s) keeps this well under it.
import { context, readStdin } from '../bridge.mjs';

try {
  const payload = JSON.parse((await readStdin()) || '{}');
  const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
  const text = await context({ query: prompt, maxChars: 4000 });
  if (text && text.trim()) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: `# Mycelium memory (your vault)\n\n${text}`,
      },
    }));
  }
} catch {
  // fail-open — proceed with no context
}
process.exit(0);
