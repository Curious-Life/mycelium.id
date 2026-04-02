/**
 * Multi-Agent Server Library
 *
 * Exports all modules for easy importing:
 *
 * import { runTask, getAgentPaths, logEvent, isSilentReply } from './lib/index.js';
 */

// Re-export everything
export * from './timeouts.js';
export * from './error-classifier.js';
export * from './cooldowns.js';
export * from './lanes.js';
export * from './paths.js';
export * from './model-fallback.js';
export * from './runner.js';
export * from './coalesce.js';
export * from './events.js';
export * from './tokens.js';
export * from './tasks.js';
export * from './delegation.js';
export * from './compaction.js';
export * from './continuation.js';

// Named module imports for default exports
import timeouts from './timeouts.js';
import errorClassifier from './error-classifier.js';
import cooldowns from './cooldowns.js';
import lanes from './lanes.js';
import paths from './paths.js';
import modelFallback from './model-fallback.js';
import runner from './runner.js';
import coalesce from './coalesce.js';
import events from './events.js';
import tokens from './tokens.js';
import tasks from './tasks.js';
import delegation from './delegation.js';
import compaction from './compaction.js';

// Default export as namespace
export default {
  timeouts,
  errorClassifier,
  cooldowns,
  lanes,
  paths,
  modelFallback,
  runner,
  coalesce,
  events,
  tokens,
  tasks,
  delegation,
  compaction,
};
