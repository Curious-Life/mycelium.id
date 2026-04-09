# Spores — Evolution Space

Spores are user-created extensions that run on the mycelium infrastructure. Each spore is a self-contained module — a bot, daemon, receiver, or service — that imports from `lib/` and runs as its own process.

In mycology, spores are the reproductive units released by fruiting bodies. They carry the genetic blueprint of the parent mycelium but grow independently in their own substrate. This directory is where that independent growth happens.

## Opt-in by design

The spores framework is **disabled unless `SPORES_ENABLED=1` is set in the environment**. This applies to both the portal route loader (in `agent-server.js`) and the PM2 process loader (in `ecosystem.config.cjs`). Rationale: spores are user code that lands as a running process on the VPS. Having the framework enabled by default would mean any directory with a valid `manifest.json` that ends up in `spores/` becomes a running process on the next deploy — that's too much implicit privilege. Operators must explicitly opt in.

## Creating a Spore

1. Create a directory: `spores/my-spore/`
2. Add a `manifest.json`:

```json
{
  "id": "my-spore",
  "name": "My Extension",
  "description": "What it does",
  "version": "0.1.0"
}
```

3. Add your code (scripts, routes, etc.)
4. Set `SPORES_ENABLED=1` in the PM2 env, restart PM2

## Manifest Schema

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Unique identifier |
| `name` | string | yes | Display name |
| `description` | string | no | What the spore does |
| `version` | string | no | Semver version |
| `routes` | string | no | Express router file to mount at `/portal/<id>/*` |
| `pm2` | array | no | PM2 process definitions (auto-loaded by ecosystem.config.cjs) |
| `hooks` | object | no | Hook registrations (e.g., `{ "runner.afterRun": true }`) |
| `envAllow` | array | no | Allowlist of `SHARED_AGENT_ENV` keys the spore needs (see Security) |

## Security — Environment Isolation

Spore PM2 processes do NOT inherit the full `SHARED_AGENT_ENV`. The shared agent env contains secrets and operational config (`KMS_URL`, `USER_ID`, `MYA_WORKER_URL`, `AGENT_SCOPES`, `SENTRY_DSN`, etc.) that would grant a spore access to encrypted data and the Swiss KEK server.

By default a spore process receives only `NODE_ENV`. If your spore needs more, declare it explicitly:

```json
{
  "id": "my-spore",
  "envAllow": ["MYA_WORKER_URL"],
  "pm2": [{ "name": "my-daemon", "script": "daemon.js" }]
}
```

This makes the privilege request auditable at review time: anyone reading the manifest can see exactly which environment values the spore touches. **Never add `KMS_URL`, `ENCRYPTION_MASTER_KEY`, or agent tokens to `envAllow`** — these are always off-limits because a spore is untrusted user code by definition, regardless of who wrote it.

Spore-declared non-secret env (ports, flags) goes under `pm2[].env` as usual.

## Importing from the Mycelium

Spores can import any `lib/` module:

```js
import { runClaudeCode } from '../../lib/runner.js';
import { tryGetDb } from '../../lib/db.js';
import { captureError } from '../../lib/error-classifier.js';
```

## PM2 Processes

If your spore needs a long-running process, define it in `manifest.json`:

```json
{
  "pm2": [{
    "name": "my-daemon",
    "script": "daemon.js",
    "env": {
      "MY_PORT": "3015"
    }
  }]
}
```

The spore loader (`spores/loader.cjs`) reads these entries and adds them to the PM2 ecosystem. The `cwd` is automatically set to your spore directory.

## Portal Routes

If your spore has a web interface, export an Express router:

```js
// routes.js
import { Router } from 'express';
const router = Router();
router.get('/data', (req, res) => res.json({ ok: true }));
export default router;
```

Set `"routes": "routes.js"` in your manifest. The loader mounts it at `/portal/<spore-id>/*`.

## Git Boundary

- `spores/README.md` and `spores/_example/` are committed to the main repo (they define the pattern)
- `spores/*/` (actual spores) are gitignored — they are strain-specific
- When a spore is ready for the world, extract it into a PR to the main repo

## Absorption

When a spore proves universally useful:

1. **Germination** — you create it to solve a personal problem
2. **Growth** — it matures, handles edge cases, becomes reliable
3. **Extraction** — move from `spores/` into `lib/` or root
4. **Absorption** — PR to upstream. The spore becomes part of the shared genome.
5. **Decomposition** — spore directory deleted. The code lives in the mycelium now.

## Port Allocation

Core mycelium uses ports 3000-3015 and 5000-5029. Spores should use:
- `3015+` for HTTP APIs
- `5030+` for additional services

Declare your ports in the manifest and avoid collisions with other spores.