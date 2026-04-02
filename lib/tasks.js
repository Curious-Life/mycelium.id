/**
 * Task Management
 *
 * Handles task file creation, validation, and lifecycle.
 * Tasks are stored as JSON files in tasks/queue/, tasks/active/, etc.
 */

import fs from 'fs/promises';
import path from 'path';
import { getAgentPaths, exists, readFile, writeFile } from './paths.js';
import { log as eventLog } from './events.js';

// Task priorities
export const TaskPriority = {
  URGENT: 'urgent',
  HIGH: 'high',
  NORMAL: 'normal',
  LOW: 'low',
};

// Task statuses
export const TaskStatus = {
  PENDING: 'pending',
  ACTIVE: 'active',
  COMPLETED: 'completed',
  BLOCKED: 'blocked',
  CANCELLED: 'cancelled',
};

// Task types
export const TaskType = {
  RESEARCH: 'research',
  BUILD: 'build',
  CHAT: 'chat',
  ANALYSIS: 'analysis',
  DOCUMENTATION: 'documentation',
  OTHER: 'other',
};

/**
 * Create a new task
 * @param {string} agentId - Agent to assign task to
 * @param {Object} taskData - Task data
 * @returns {Promise<Object>} Created task
 */
export async function createTask(agentId, taskData) {
  const paths = getAgentPaths(agentId);
  const taskId = `task-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  const task = {
    id: taskId,
    name: taskData.name || taskData.description?.substring(0, 50) || 'Unnamed task',
    description: taskData.description || '',
    type: taskData.type || TaskType.OTHER,
    priority: taskData.priority || TaskPriority.NORMAL,
    status: TaskStatus.PENDING,

    // Source tracking
    createdAt: new Date().toISOString(),
    createdBy: taskData.createdBy || 'system',
    channel: taskData.channel || null,

    // Context
    context: taskData.context || {},

    // Delegation
    delegatedFrom: taskData.delegatedFrom || null,
    delegatedTo: null,

    // Timing
    startedAt: null,
    completedAt: null,
    dueAt: taskData.dueAt || null,

    // Results
    result: null,
    error: null,
  };

  // Write to queue directory
  const taskFile = path.join(paths.tasks.queue, `${taskId}.json`);
  await writeFile(taskFile, task);

  console.log(`[Tasks] Created task ${taskId} for ${agentId}: ${task.name}`);
  eventLog.taskCreated(agentId, taskId, task.description);

  return task;
}

/**
 * List tasks in a directory
 * @param {string} agentId - Agent identifier
 * @param {string} status - Status directory (queue, active, completed, blocked)
 * @returns {Promise<Array>} Array of tasks
 */
export async function listTasks(agentId, status = 'queue') {
  const paths = getAgentPaths(agentId);
  const taskDir = paths.tasks[status] || paths.tasks.queue;

  const tasks = [];

  try {
    const files = await fs.readdir(taskDir);

    for (const file of files.filter(f => f.endsWith('.json'))) {
      try {
        const task = await readFile(path.join(taskDir, file));
        if (task) tasks.push(task);
      } catch {
        // Skip invalid files
      }
    }
  } catch {
    // Directory doesn't exist
  }

  // Sort by priority then by creation time
  const priorityOrder = { urgent: 0, high: 1, normal: 2, low: 3 };
  tasks.sort((a, b) => {
    const pA = priorityOrder[a.priority] ?? 2;
    const pB = priorityOrder[b.priority] ?? 2;
    if (pA !== pB) return pA - pB;
    return new Date(a.createdAt) - new Date(b.createdAt);
  });

  return tasks;
}

/**
 * Get a specific task
 * @param {string} agentId - Agent identifier
 * @param {string} taskId - Task ID
 * @returns {Promise<Object|null>} Task or null if not found
 */
export async function getTask(agentId, taskId) {
  const paths = getAgentPaths(agentId);

  // Check all directories
  for (const status of ['queue', 'active', 'completed', 'blocked']) {
    const taskFile = path.join(paths.tasks[status], `${taskId}.json`);
    if (await exists(taskFile)) {
      return await readFile(taskFile);
    }
  }

  return null;
}

/**
 * Update task status (moves file between directories)
 * @param {string} agentId - Agent identifier
 * @param {string} taskId - Task ID
 * @param {string} newStatus - New status
 * @param {Object} updates - Additional updates
 * @returns {Promise<Object|null>} Updated task
 */
export async function updateTaskStatus(agentId, taskId, newStatus, updates = {}) {
  const paths = getAgentPaths(agentId);
  const task = await getTask(agentId, taskId);

  if (!task) {
    console.error(`[Tasks] Task ${taskId} not found`);
    return null;
  }

  const oldStatus = task.status;

  // Find current file
  let currentFile = null;
  for (const status of ['queue', 'active', 'completed', 'blocked']) {
    const testFile = path.join(paths.tasks[status], `${taskId}.json`);
    if (await exists(testFile)) {
      currentFile = testFile;
      break;
    }
  }

  if (!currentFile) {
    console.error(`[Tasks] Task file for ${taskId} not found`);
    return null;
  }

  // Update task
  const updatedTask = {
    ...task,
    ...updates,
    status: newStatus,
    updatedAt: new Date().toISOString(),
  };

  // Add timing
  if (newStatus === TaskStatus.ACTIVE && !updatedTask.startedAt) {
    updatedTask.startedAt = new Date().toISOString();
  }
  if (newStatus === TaskStatus.COMPLETED && !updatedTask.completedAt) {
    updatedTask.completedAt = new Date().toISOString();
  }

  // Determine new directory
  const statusDirMap = {
    [TaskStatus.PENDING]: 'queue',
    [TaskStatus.ACTIVE]: 'active',
    [TaskStatus.COMPLETED]: 'completed',
    [TaskStatus.BLOCKED]: 'blocked',
    [TaskStatus.CANCELLED]: 'completed', // Cancelled tasks go to completed
  };

  const newDir = statusDirMap[newStatus] || 'queue';
  const newFile = path.join(paths.tasks[newDir], `${taskId}.json`);

  // Move file if directory changed
  if (currentFile !== newFile) {
    await fs.mkdir(path.dirname(newFile), { recursive: true });
    await writeFile(newFile, updatedTask);
    await fs.unlink(currentFile);
    console.log(`[Tasks] Moved task ${taskId} from ${oldStatus} to ${newStatus}`);
  } else {
    await writeFile(newFile, updatedTask);
  }

  if (newStatus === TaskStatus.COMPLETED) {
    eventLog.taskComplete(agentId, taskId);
  }

  return updatedTask;
}

/**
 * Mark task as active
 */
export async function startTask(agentId, taskId) {
  return updateTaskStatus(agentId, taskId, TaskStatus.ACTIVE);
}

/**
 * Mark task as completed
 */
export async function completeTask(agentId, taskId, result = null) {
  return updateTaskStatus(agentId, taskId, TaskStatus.COMPLETED, { result });
}

/**
 * Mark task as blocked
 */
export async function blockTask(agentId, taskId, reason = null) {
  return updateTaskStatus(agentId, taskId, TaskStatus.BLOCKED, { error: reason });
}

/**
 * Cancel a task
 */
export async function cancelTask(agentId, taskId, reason = null) {
  return updateTaskStatus(agentId, taskId, TaskStatus.CANCELLED, {
    error: reason,
    cancelledAt: new Date().toISOString(),
  });
}

/**
 * Get task summary for prompts
 * @param {string} agentId - Agent identifier
 * @returns {Promise<string>} Markdown summary of pending tasks
 */
export async function getTaskSummary(agentId) {
  const pending = await listTasks(agentId, 'queue');
  const active = await listTasks(agentId, 'active');
  const blocked = await listTasks(agentId, 'blocked');

  if (pending.length === 0 && active.length === 0 && blocked.length === 0) {
    return '*No pending tasks*';
  }

  const lines = [];

  if (active.length > 0) {
    lines.push('### Active');
    for (const t of active) {
      lines.push(`- **${t.name}** (started: ${t.startedAt})`);
      if (t.description) lines.push(`  ${t.description.substring(0, 100)}`);
    }
  }

  if (pending.length > 0) {
    lines.push('### Pending');
    for (const t of pending) {
      const priority = t.priority !== 'normal' ? ` [${t.priority}]` : '';
      lines.push(`- **${t.name}**${priority}`);
      if (t.description) lines.push(`  ${t.description.substring(0, 100)}`);
    }
  }

  if (blocked.length > 0) {
    lines.push('### Blocked');
    for (const t of blocked) {
      lines.push(`- **${t.name}**: ${t.error || 'Unknown reason'}`);
    }
  }

  return lines.join('\n');
}

/**
 * Also check legacy pending-tasks.json format
 * @param {string} agentId - Agent identifier
 * @returns {Promise<Array>} Combined tasks from both sources
 */
export async function getAllPendingTasks(agentId) {
  const paths = getAgentPaths(agentId);

  // Get file-based tasks
  const fileTasks = await listTasks(agentId, 'queue');

  // Check legacy format
  const legacyData = await readFile(paths.knowledge.pendingTasks, { tasks: [] });
  const legacyTasks = (legacyData.tasks || [])
    .filter(t => t.status === 'pending')
    .map(t => ({
      ...t,
      source: 'legacy',
    }));

  // Combine (file-based tasks first)
  return [...fileTasks, ...legacyTasks];
}

export default {
  TaskPriority,
  TaskStatus,
  TaskType,
  createTask,
  listTasks,
  getTask,
  updateTaskStatus,
  startTask,
  completeTask,
  blockTask,
  cancelTask,
  getTaskSummary,
  getAllPendingTasks,
};
