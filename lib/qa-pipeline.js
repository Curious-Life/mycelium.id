/**
 * QA Pipeline — Self-modification engine for the Mycelium agent system.
 *
 * Provides:
 * - Programmatic test runner (wraps node --test)
 * - Enhanced Sentry prompt with test-before-commit gate
 * - Test report formatting for Discord
 *
 * Used by the QA agent (qa-agent) for automatic bug detection → fix → verify → commit.
 * Other agents can also import runTests() for pre-commit verification.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * Run the smoke test suite programmatically.
 *
 * @param {string} [cwd] — repo root (defaults to mycelium root)
 * @param {object} [opts]
 * @param {number} [opts.timeout=60000] — max ms before killing
 * @returns {Promise<{passed: boolean, total: number, failed: number, output: string}>}
 */
export async function runTests(cwd, opts = {}) {
  const timeout = opts.timeout || 60_000;
  const testCwd = cwd || REPO_ROOT;

  try {
    const { stdout, stderr } = await execFileP(
      'node',
      ['--test', 'tests/**/*.test.js'],
      { cwd: testCwd, timeout, env: { ...process.env, NODE_ENV: 'test' } },
    );

    const output = (stdout || '') + (stderr || '');
    return parseTestOutput(output, true);
  } catch (err) {
    // node --test exits non-zero when tests fail
    const output = (err.stdout || '') + (err.stderr || '') + (err.message || '');
    return parseTestOutput(output, false);
  }
}

/**
 * Parse node:test TAP-like output into structured results.
 */
function parseTestOutput(output, processExitedCleanly) {
  const passMatch = output.match(/# pass (\d+)/);
  const failMatch = output.match(/# fail (\d+)/);

  const total = (passMatch ? parseInt(passMatch[1]) : 0)
              + (failMatch ? parseInt(failMatch[1]) : 0);
  const failed = failMatch ? parseInt(failMatch[1]) : 0;
  const passed = processExitedCleanly && failed === 0;

  return {
    passed,
    total,
    failed,
    output: output.slice(-3000), // last 3000 chars for context
  };
}

/**
 * Format test results as a compact Discord-friendly string.
 */
export function formatTestReport(results) {
  const icon = results.passed ? '\u2705' : '\u274c';
  const lines = [
    `${icon} **Test Results**: ${results.passed ? 'PASS' : 'FAIL'}`,
    `  Tests: ${results.total - results.failed} passed, ${results.failed} failed, ${results.total} total`,
  ];

  if (!results.passed && results.output) {
    // Extract failure lines (last 500 chars of output)
    const snippet = results.output.slice(-500).trim();
    lines.push('```', snippet, '```');
  }

  return lines.join('\n');
}

/**
 * Build the enhanced Sentry auto-fix prompt with test verification gate.
 *
 * Key difference from the basic Sentry prompt: the agent MUST run tests
 * before and after fixing, and only commits if tests don't regress.
 *
 * @param {Array<{title, level, count, userCount, culprit, firstSeen, lastSeen, tags, stacktrace, sentryLink}>} issues
 * @param {object} config
 * @param {string} config.reportsChannelId — Discord channel for bug reports
 * @param {number} config.agentPort — agent-server port for /discord/send
 * @param {string} config.repoCwd — repo root path
 * @returns {string}
 */
export function buildSentryFixPrompt(issues, config) {
  const { reportsChannelId, agentPort, repoCwd } = config;

  const issueBlocks = issues.map(issue => {
    const tags = issue.tags || 'none';
    return [
      `### ${issue.title}`,
      `- **Level:** ${issue.level} | **Count:** ${issue.count} | **Users affected:** ${issue.userCount}`,
      `- **Culprit:** ${issue.culprit || 'unknown'}`,
      `- **First seen:** ${issue.firstSeen} | **Last seen:** ${issue.lastSeen}`,
      `- **Tags:** ${tags}`,
      `- **Sentry link:** ${issue.sentryLink}`,
      issue.stacktrace ? `- **Stacktrace (last 8 frames):**\n\`\`\`\n${issue.stacktrace}\n\`\`\`` : '',
    ].filter(Boolean).join('\n');
  });

  return `## Sentry Alert: ${issues.length} new error${issues.length > 1 ? 's' : ''} detected

${issueBlocks.join('\n\n')}

## Your Task — Fix with Test Verification

Follow this exact sequence:

### Step 1: Baseline
Run the test suite FIRST to establish a baseline:
\`\`\`bash
node --test 'tests/**/*.test.js'
\`\`\`
Note which tests pass and fail BEFORE you make any changes.

### Step 2: Investigate
For each error, find the source code location and understand the root cause.
Read the relevant files. Trace the execution path.

### Step 3: Fix
Edit the code to fix the bug. Be surgical — change only what's needed.
If the fix is non-trivial, add a test case to \`tests/smoke.test.js\` that would have caught this error.

### Step 4: Verify
Run the test suite AGAIN:
\`\`\`bash
node --test 'tests/**/*.test.js'
\`\`\`

**CRITICAL**: Compare results to your baseline.
- If tests pass (same or better than baseline) → proceed to commit
- If NEW test failures appeared → your fix broke something. Revert and try again (up to 3 attempts)
- If you cannot fix without breaking tests → do NOT commit. Report the issue as unresolvable.

### Step 5: Commit (only if tests pass)
\`\`\`bash
git add -A && git commit -m "fix: <description of what was fixed>

Resolves Sentry error(s). Verified with test suite (all passing).

Co-Authored-By: QA Agent <qa@mycelium.local>"
\`\`\`

### Step 6: Report
Post your findings to #bug-reports:
\`\`\`bash
curl -X POST http://localhost:${agentPort}/discord/send -H "Content-Type: application/json" -d '{"channelId":"${reportsChannelId || ''}","content":"your report here"}'
\`\`\`

Your report must include:
- What the error was
- Root cause analysis
- What you fixed (file + line)
- Test results (before and after)
- Commit hash (or "NOT COMMITTED" if tests failed)

If you cannot fix an error (external service issue, test regression), explain why in your report.

Respond with NO_REPLY after posting to #bug-reports.`;
}

/**
 * Build a prompt for delegation-triggered test verification.
 * Other agents delegate "verify my changes" tasks to QA.
 *
 * @param {string} task — description of what to verify
 * @param {string} context — additional context from delegating agent
 * @param {object} config
 * @returns {string}
 */
export function buildVerifyPrompt(task, context, config) {
  const { reportsChannelId, agentPort } = config;

  return `## QA Verification Request

**Task:** ${task}
${context ? `**Context:** ${context}` : ''}

## Your Task

### Step 1: Run Tests
\`\`\`bash
node --test 'tests/**/*.test.js'
\`\`\`

### Step 2: Analyze Results
- If all tests pass: report success
- If tests fail: investigate whether failures are related to the described changes
- Check for obvious code issues (lint, type errors) if applicable

### Step 3: Report
Post results to #bug-reports:
\`\`\`bash
curl -X POST http://localhost:${agentPort}/discord/send -H "Content-Type: application/json" -d '{"channelId":"${reportsChannelId || ''}","content":"your report here"}'
\`\`\`

Report: what was verified, test results, pass/fail verdict, any issues found.

Respond with NO_REPLY after posting.`;
}
