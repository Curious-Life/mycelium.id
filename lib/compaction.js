/**
 * Context Compaction
 *
 * Handles context overflow recovery by compacting/summarizing context.
 * Used when Claude returns "context length exceeded" errors.
 */

import { getAgentPaths, readFile, writeFile } from './paths.js';
import { log as eventLog } from './events.js';

// Maximum context items to keep
const MAX_RECENT_TOPICS = 10;
const MAX_PENDING_THOUGHTS = 5;
const MAX_LAST_INTERACTIONS = 10;
const MAX_CONVERSATION_MESSAGES = 50;

/**
 * Compact agent context to reduce token usage
 * @param {string} agentId - Agent identifier
 * @returns {Promise<Object>} Compaction result
 */
export async function compactContext(agentId) {
  const paths = getAgentPaths(agentId);
  const results = {
    contextsCompacted: 0,
    itemsRemoved: 0,
  };

  console.log(`[Compaction] Starting context compaction for ${agentId}`);

  // Compact context.json
  try {
    const context = await readFile(paths.memory.context, {});

    let changed = false;

    if (context.recentTopics?.length > MAX_RECENT_TOPICS) {
      const removed = context.recentTopics.length - MAX_RECENT_TOPICS;
      context.recentTopics = context.recentTopics.slice(-MAX_RECENT_TOPICS);
      results.itemsRemoved += removed;
      changed = true;
    }

    if (context.pendingThoughts?.length > MAX_PENDING_THOUGHTS) {
      const removed = context.pendingThoughts.length - MAX_PENDING_THOUGHTS;
      context.pendingThoughts = context.pendingThoughts.slice(-MAX_PENDING_THOUGHTS);
      results.itemsRemoved += removed;
      changed = true;
    }

    if (context.lastInteractions?.length > MAX_LAST_INTERACTIONS) {
      const removed = context.lastInteractions.length - MAX_LAST_INTERACTIONS;
      context.lastInteractions = context.lastInteractions.slice(-MAX_LAST_INTERACTIONS);
      results.itemsRemoved += removed;
      changed = true;
    }

    if (changed) {
      context.compactedAt = new Date().toISOString();
      await writeFile(paths.memory.context, context);
      results.contextsCompacted++;
    }
  } catch (error) {
    console.error(`[Compaction] Failed to compact context.json:`, error.message);
  }

  // Compact conversations.json
  try {
    const conversations = await readFile(paths.memory.conversations, { messages: [] });

    if (conversations.messages?.length > MAX_CONVERSATION_MESSAGES) {
      const removed = conversations.messages.length - MAX_CONVERSATION_MESSAGES;

      // Keep first few messages (for context) and most recent
      const keepFirst = 5;
      const keepLast = MAX_CONVERSATION_MESSAGES - keepFirst;

      if (conversations.messages.length > keepFirst + keepLast) {
        const first = conversations.messages.slice(0, keepFirst);
        const last = conversations.messages.slice(-keepLast);

        // Add compaction marker
        conversations.messages = [
          ...first,
          {
            role: 'system',
            content: `[${removed} messages compacted at ${new Date().toISOString()}]`,
            timestamp: new Date().toISOString(),
          },
          ...last,
        ];

        conversations.compactedAt = new Date().toISOString();
        await writeFile(paths.memory.conversations, conversations);

        results.itemsRemoved += removed;
        results.contextsCompacted++;
      }
    }
  } catch (error) {
    console.error(`[Compaction] Failed to compact conversations.json:`, error.message);
  }

  console.log(`[Compaction] Completed for ${agentId}: ${results.contextsCompacted} files, ${results.itemsRemoved} items removed`);
  eventLog.error('context_compaction', { agentId, ...results });

  return results;
}

/**
 * Estimate token count for a string (rough approximation)
 * ~4 chars per token for English text
 */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Truncate text to approximately N tokens
 */
export function truncateToTokens(text, maxTokens) {
  if (!text) return '';
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;

  // Truncate with ellipsis
  return text.substring(0, maxChars - 20) + '\n\n[... truncated ...]';
}

/**
 * Compact a prompt if it's too long
 * @param {string} prompt - Original prompt
 * @param {number} maxTokens - Maximum tokens (default: 100k)
 * @returns {string} Compacted prompt
 */
export function compactPrompt(prompt, maxTokens = 100000) {
  const estimated = estimateTokens(prompt);

  if (estimated <= maxTokens) {
    return prompt;
  }

  console.log(`[Compaction] Prompt too long (${estimated} tokens), compacting to ${maxTokens}`);

  // Strategy: Find sections and truncate the longest ones
  // Look for markdown headers
  const sections = prompt.split(/(?=^#{1,3} )/m);

  if (sections.length <= 1) {
    // No sections, just truncate
    return truncateToTokens(prompt, maxTokens);
  }

  // Calculate tokens per section
  const sectionTokens = sections.map(s => ({
    text: s,
    tokens: estimateTokens(s),
  }));

  // Sort by token count (largest first)
  sectionTokens.sort((a, b) => b.tokens - a.tokens);

  // Truncate largest sections until we fit
  let totalTokens = estimated;
  let i = 0;

  while (totalTokens > maxTokens && i < sectionTokens.length) {
    const section = sectionTokens[i];
    const targetTokens = Math.floor(section.tokens * 0.5); // Reduce by 50%

    section.text = truncateToTokens(section.text, targetTokens);
    totalTokens -= (section.tokens - targetTokens);
    section.tokens = targetTokens;

    i++;
  }

  // Reconstruct in original order
  const originalOrder = sections.map(s => {
    const found = sectionTokens.find(st => st.text.startsWith(s.substring(0, 50)));
    return found ? found.text : s;
  });

  return originalOrder.join('');
}

/**
 * Clear old session files
 * @param {string} agentId - Agent identifier
 * @param {number} keepDays - Days of sessions to keep (default: 7)
 */
export async function cleanupOldSessions(agentId, keepDays = 7) {
  const paths = getAgentPaths(agentId);
  const cutoff = Date.now() - (keepDays * 24 * 60 * 60 * 1000);

  try {
    const fs = await import('fs/promises');
    const files = await fs.readdir(paths.sessions);

    let cleaned = 0;

    for (const file of files) {
      if (!file.endsWith('.jsonl') && !file.endsWith('.json')) continue;

      const filePath = `${paths.sessions}/${file}`;
      const stat = await fs.stat(filePath);

      if (stat.mtimeMs < cutoff) {
        await fs.unlink(filePath);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`[Compaction] Cleaned up ${cleaned} old session files for ${agentId}`);
    }
  } catch (error) {
    // Sessions directory might not exist
  }
}

export default {
  compactContext,
  estimateTokens,
  truncateToTokens,
  compactPrompt,
  cleanupOldSessions,
};
