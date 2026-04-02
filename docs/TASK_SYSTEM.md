# Agent Task System

Agents can commit to tasks that take longer than a chat response. Tasks are stored in the database and processed asynchronously.

## How It Works

### 1. User Asks for Something
User: "Can you research what our competitors are charging?"

### 2. Agent Commits to the Task
Agent response: "I'll dig into that. Give me a bit."

The agent creates a task via `task-queue.js`:
```js
import { createTask } from './task-queue.js';
await createTask(agentId, 'research', 'Research competitor pricing', 'high');
```

This writes to the `agent_tasks` table in D1.

### 3. Task Processing

During the next think cycle (scheduled by `lib/scheduler.js`), the agent:
1. Checks for pending tasks via `getPendingTasks(agentId)`
2. Picks the highest priority one
3. Marks it as in-progress via `startTask(taskId)`
4. Works on it using Claude Code + MCP tools
5. Marks it complete via `completeTask(taskId, result, summary)`
6. Reports back to the user (Discord/Telegram)

### 4. Agent Reports Back
Agent proactively messages: "Hey, I looked into competitor pricing. Here's what I found: [summary]."

## Task Schema

Tasks are stored in the `agent_tasks` table:

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT | Auto-generated hex ID |
| `agent_id` | TEXT | Which agent owns this task |
| `type` | TEXT | research, build, analyze, write |
| `description` | TEXT | What needs to be done |
| `status` | TEXT | pending, in_progress, completed, failed |
| `priority` | TEXT | low, normal, high, urgent |
| `result` | TEXT | Full result (JSON) |
| `summary` | TEXT | Brief result for messaging |
| `error` | TEXT | Error message if failed |
| `created_at` | TEXT | When the task was created |
| `started_at` | TEXT | When work began |
| `completed_at` | TEXT | When it finished |
| `reported_at` | TEXT | When the user was notified |

## Task Queue API

`task-queue.js` exposes:

```js
createTask(agentId, type, description, priority)  // Create a new task
getPendingTasks(agentId, limit)                    // Get pending tasks
getInProgressTasks(agentId)                        // Get active tasks
startTask(taskId)                                  // Mark as in_progress
completeTask(taskId, result, summary)              // Mark as completed
failTask(taskId, errorMessage)                     // Mark as failed
getTasksToReport(agentId)                          // Get unreported completed tasks
markTaskReported(taskId)                           // Mark as reported to user
```

## Response Time

- **Chat responses**: Up to 60 minutes (long-running Claude Code sessions)
- **Task work**: No limit — agent works until done
- **Think cycles**: Scheduled via `lib/scheduler.js` (see docs/AUTONOMOUS.md)

## The Human Touch

The agent should feel natural:
- "I'll look into that and get back to you"
- "Let me think about this for a bit"
- "I need to dig deeper - I'll report back soon"

Not robotic acknowledgments, but genuine commitment to follow through.
