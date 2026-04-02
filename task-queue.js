/**
 * Task Queue for Async Agent Work
 *
 * Allows the agent to commit to tasks, work on them asynchronously,
 * and report back when done. Tasks persist via the db abstraction layer.
 */

import { tryGetDb } from './lib/db.js';

function db() {
  const d = tryGetDb();
  if (!d) console.error('[TaskQueue] Database not initialized');
  return d;
}

/**
 * Task statuses:
 * - pending: Queued, waiting to be picked up
 * - in_progress: Agent is working on it
 * - completed: Done, result available
 * - failed: Something went wrong
 */

/**
 * Create a new task
 * @param {object} params
 * @param {string} params.agentId - Which agent owns this task
 * @param {string} params.type - Task type (research, build, analyze, etc.)
 * @param {string} params.description - What needs to be done
 * @param {string} params.requestedBy - Who requested it (discord user id)
 * @param {string} params.channelId - Where to report back
 * @param {object} params.context - Additional context (message history, etc.)
 * @param {string} params.priority - 'low', 'normal', 'high', 'urgent'
 */
export async function createTask({
  agentId,
  type,
  description,
  requestedBy,
  channelId,
  context = {},
  priority = 'normal'
}) {
  const d = db();
  if (!d) return null;

  try {
    const data = await d.agentTasks.create({
      agent_id: agentId,
      type,
      description,
      requested_by: requestedBy,
      channel_id: channelId,
      context,
      priority,
      status: 'pending',
      created_at: new Date().toISOString(),
    });

    console.log(`[TaskQueue] Created task ${data.id}: ${type} - ${description.substring(0, 50)}...`);
    return data.id;
  } catch (error) {
    console.error('[TaskQueue] Failed to create task:', error.message);
    return null;
  }
}

/**
 * Get pending tasks for an agent
 */
export async function getPendingTasks(agentId, limit = 10) {
  const d = db();
  if (!d) return [];

  try {
    return await d.agentTasks.getPending(agentId, limit);
  } catch (error) {
    console.error('[TaskQueue] Failed to get tasks:', error.message);
    return [];
  }
}

/**
 * Get in-progress tasks for an agent
 */
export async function getInProgressTasks(agentId) {
  const d = db();
  if (!d) return [];

  try {
    return await d.agentTasks.getInProgress(agentId);
  } catch (error) {
    console.error('[TaskQueue] Failed to get in-progress tasks:', error.message);
    return [];
  }
}

/**
 * Start working on a task
 */
export async function startTask(taskId) {
  const d = db();
  if (!d) return false;

  try {
    await d.agentTasks.start(taskId);
    console.log(`[TaskQueue] Started task ${taskId}`);
    return true;
  } catch (error) {
    console.error('[TaskQueue] Failed to start task:', error.message);
    return false;
  }
}

/**
 * Complete a task with result
 */
export async function completeTask(taskId, result, summary = null) {
  const d = db();
  if (!d) return false;

  try {
    await d.agentTasks.complete(taskId, result, summary);
    console.log(`[TaskQueue] Completed task ${taskId}`);
    return true;
  } catch (error) {
    console.error('[TaskQueue] Failed to complete task:', error.message);
    return false;
  }
}

/**
 * Fail a task with error
 */
export async function failTask(taskId, errorMessage) {
  const d = db();
  if (!d) return false;

  try {
    await d.agentTasks.fail(taskId, errorMessage);
    console.log(`[TaskQueue] Failed task ${taskId}: ${errorMessage}`);
    return true;
  } catch (error) {
    console.error('[TaskQueue] Failed to fail task:', error.message);
    return false;
  }
}

/**
 * Get completed tasks that need reporting
 */
export async function getTasksToReport(agentId) {
  const d = db();
  if (!d) return [];

  try {
    return await d.agentTasks.getToReport(agentId);
  } catch (error) {
    console.error('[TaskQueue] Failed to get tasks to report:', error.message);
    return [];
  }
}

/**
 * Mark task as reported
 */
export async function markTaskReported(taskId) {
  const d = db();
  if (!d) return false;

  try {
    await d.agentTasks.markReported(taskId);
    return true;
  } catch (error) {
    console.error('[TaskQueue] Failed to mark task reported:', error.message);
    return false;
  }
}

export default {
  createTask,
  getPendingTasks,
  getInProgressTasks,
  startTask,
  completeTask,
  failTask,
  getTasksToReport,
  markTaskReported,
};
