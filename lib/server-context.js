/**
 * Server Context — shared state container for route handlers.
 *
 * Created once by agent-server.js, passed to each router factory.
 * Avoids module-level mutable state in route files.
 */

/**
 * @typedef {Object} ServerContext
 * @property {string} agentId
 * @property {number} port
 * @property {string} logPrefix
 * @property {object} paths - from getAgentPaths()
 * @property {object|null} runtime - from createRuntimeWithDb()
 * @property {Function} getRuntime - returns runtime (may be null during init)
 * @property {Function} tryGetDb - returns db or null
 * @property {Function} addActivity - (type, content, metadata) => entry
 * @property {object} activity - { buffer, subscribers }
 * @property {Function} storeMessages - (userId, source, user, assistant, time) => void
 * @property {Function} enrichMessages - (rows, userId, agentId) => void
 * @property {Function} requireWorkerSecret - (req, res) => boolean
 * @property {Function} authenticatePortal - (req, res, next) => void
 * @property {object} taskState - { activeCount, lastModelUsed, incrementActive, decrementActive, hasActive, explicitSends }
 * @property {object} limits - autonomous messaging limits
 * @property {object} timeouts - TIMEOUTS from lib/timeouts.js
 * @property {object} agentConfig - from getAgentConfig(agentId)
 */

export const SERVER_CONTEXT_VERSION = 1;
