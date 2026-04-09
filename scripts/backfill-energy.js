#!/usr/bin/env node
/**
 * Backfill Energy Ledger — Parse historical Claude session JSONL files
 * into the energy ledger format (agents/.shared/energy/<date>.jsonl).
 *
 * Discovers Claude config directories by scanning $HOME for directories matching
 * ~/.claude or ~/.claude-*, then reads projects/**.jsonl from each. Extracts
 * token usage from assistant messages and writes energy records grouped by date.
 *
 * Agent ID is inferred from the cwd embedded in the session file (if present).
 * The regex used by the previous version was hardcoded to one strain's directory
 * layout and will return 'unknown' for any other deployment.
 *
 * Security note: this script does NOT record CLAUDE_CONFIG_DIR or any
 * subscription identifier in the output — the ledger is plaintext JSONL and
 * leaking subscription topology on VPS compromise is an unnecessary risk.
 *
 * Usage:
 *   node scripts/backfill-energy.js
 *   node scripts/backfill-energy.js --dry-run            # show counts without writing
 *   node scripts/backfill-energy.js --config-dir=<path>  # override discovery
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';

const AGENTS_ROOT = process.env.AGENTS_ROOT || path.join(os.homedir(), 'agents');
const ENERGY_DIR = path.join(AGENTS_ROOT, '.shared', 'energy');
const DRY_RUN = process.argv.includes('--dry-run');

// Explicit config dirs from CLI (repeatable): --config-dir=/path
const CLI_CONFIG_DIRS = process.argv
  .filter(a => a.startsWith('--config-dir='))
  .map(a => a.slice('--config-dir='.length));

/**
 * Extract the agent ID from a session file's metadata. Claude Code session
 * JSONL files embed the cwd of the running process; the agent ID is usually
 * the last path component (e.g. /home/claude/agents/personal-agent → personal-agent).
 *
 * Falls back to 'unknown' if no cwd can be determined.
 */
function extractAgentFromCwd(cwd) {
  if (!cwd || typeof cwd !== 'string') return 'unknown';
  // Prefer the immediate parent of a /repo/ or /mycelium/ suffix, else basename.
  const parts = cwd.split(path.sep).filter(Boolean);
  const agentsIdx = parts.lastIndexOf('agents');
  if (agentsIdx >= 0 && parts.length > agentsIdx + 1) return parts[agentsIdx + 1];
  return parts[parts.length - 1] || 'unknown';
}

// Map model IDs to short names
function shortModel(model) {
  if (!model) return 'unknown';
  if (model.includes('opus')) return 'opus';
  if (model.includes('sonnet')) return 'sonnet';
  if (model.includes('haiku')) return 'haiku';
  return model;
}

/**
 * Discover Claude Code config directories by scanning $HOME for dirs named
 * .claude or .claude-* that contain a projects/ subdirectory. This is
 * strain-agnostic — any CLAUDE_CONFIG_DIR the user has created will be found.
 */
async function discoverConfigDirs() {
  if (CLI_CONFIG_DIRS.length > 0) return CLI_CONFIG_DIRS;

  const home = os.homedir();
  const found = [];
  let entries;
  try {
    entries = await fs.readdir(home, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name !== '.claude' && !entry.name.startsWith('.claude-')) continue;
    const full = path.join(home, entry.name);
    try {
      const stat = await fs.stat(path.join(full, 'projects'));
      if (stat.isDirectory()) found.push(full);
    } catch { /* no projects dir — skip */ }
  }
  return found;
}

async function findJsonlFiles(configDir) {
  const projectsDir = path.join(configDir, 'projects');
  const files = [];

  async function walk(dir) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.name.endsWith('.jsonl')) {
          files.push(full);
        }
      }
    } catch { /* skip inaccessible dirs */ }
  }

  await walk(projectsDir);
  return files;
}

async function parseSessionFile(filePath) {
  const rl = createInterface({
    input: createReadStream(filePath),
    crlfDelay: Infinity,
  });

  // Accumulate usage per session (sum all assistant messages)
  let sessionId = null;
  let agent = 'unknown';
  const sessionRecords = [];

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const data = JSON.parse(line);

      // Grab session ID
      if (data.session_id) sessionId = data.session_id;

      // Learn the agent ID from whatever cwd metadata the session exposes.
      // Claude Code session records embed cwd in a few different shapes
      // across versions; we check the common ones.
      if (agent === 'unknown') {
        const cwd = data.cwd || data.metadata?.cwd || data.project?.cwd;
        if (cwd) agent = extractAgentFromCwd(cwd);
      }

      // Extract usage from assistant messages
      if (data.type === 'assistant' && data.message?.usage) {
        const u = data.message.usage;
        const ts = data.timestamp || data.message?.created_at;
        if (!ts) continue;

        sessionRecords.push({
          ts,
          agent,
          process: 'session', // can't determine chat/think from JSONL
          model: shortModel(data.message.model || data.model),
          inputTokens: u.input_tokens || 0,
          outputTokens: u.output_tokens || 0,
          cacheRead: u.cache_read_input_tokens || 0,
          cacheCreation: u.cache_creation_input_tokens || 0,
          costUsd: null,
          sessionId: sessionId,
          durationMs: null,
          trigger: 'backfill',
        });
      }
    } catch { /* skip bad lines */ }
  }

  // If we learned the agent ID mid-file, backfill earlier records with it.
  if (agent !== 'unknown') {
    for (const r of sessionRecords) r.agent = agent;
  }

  return sessionRecords;
}

async function writeEnergyRecords(records) {
  // Group by date
  const byDate = {};
  for (const r of records) {
    const date = r.ts.split('T')[0];
    if (!byDate[date]) byDate[date] = [];
    byDate[date].push(r);
  }

  await fs.mkdir(ENERGY_DIR, { recursive: true });

  let totalWritten = 0;
  for (const [date, dateRecords] of Object.entries(byDate).sort()) {
    const file = path.join(ENERGY_DIR, `${date}.jsonl`);
    const lines = dateRecords.map(r => JSON.stringify(r)).join('\n') + '\n';
    await fs.appendFile(file, lines);
    totalWritten += dateRecords.length;
    console.log(`  ${date}: ${dateRecords.length} records`);
  }

  return totalWritten;
}

async function main() {
  console.log(`[backfill-energy] Scanning session files...`);
  if (DRY_RUN) console.log('  (dry run — no files will be written)\n');

  const configDirs = await discoverConfigDirs();
  if (configDirs.length === 0) {
    console.error(`[backfill-energy] No config dirs found. Pass --config-dir=<path> or create ~/.claude*.`);
    process.exit(1);
  }
  console.log(`[backfill-energy] Discovered ${configDirs.length} config dir(s)`);

  let allRecords = [];
  let totalFiles = 0;

  for (const configDir of configDirs) {
    const files = await findJsonlFiles(configDir);
    if (files.length === 0) continue;

    console.log(`\n${configDir}: ${files.length} session files`);
    totalFiles += files.length;

    for (const file of files) {
      try {
        const records = await parseSessionFile(file);
        allRecords.push(...records);
      } catch (err) {
        // Skip files that can't be parsed
      }
    }
  }

  console.log(`\n[backfill-energy] Parsed ${allRecords.length} energy records from ${totalFiles} files`);

  // Summary by agent
  const byAgent = {};
  for (const r of allRecords) {
    if (!byAgent[r.agent]) byAgent[r.agent] = { records: 0, inputTokens: 0, outputTokens: 0 };
    byAgent[r.agent].records++;
    byAgent[r.agent].inputTokens += r.inputTokens;
    byAgent[r.agent].outputTokens += r.outputTokens;
  }

  console.log('\nPer-agent summary:');
  for (const [agent, data] of Object.entries(byAgent).sort((a, b) => b[1].records - a[1].records)) {
    const totalTok = data.inputTokens + data.outputTokens;
    console.log(`  ${agent}: ${data.records} records, ${(totalTok / 1_000_000).toFixed(1)}M tokens`);
  }

  // Date range
  if (allRecords.length > 0) {
    const dates = allRecords.map(r => r.ts).sort();
    console.log(`\nDate range: ${dates[0].split('T')[0]} → ${dates[dates.length - 1].split('T')[0]}`);
  }

  if (DRY_RUN) {
    console.log('\n[dry-run] No files written.');
  } else {
    console.log('\nWriting energy ledger files...');
    const written = await writeEnergyRecords(allRecords);
    console.log(`\n[backfill-energy] Done — ${written} records written to ${ENERGY_DIR}/`);
  }
}

main().catch(err => {
  console.error('[backfill-energy] Fatal:', err.message);
  process.exit(1);
});