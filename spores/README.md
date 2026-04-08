# Spores — Evolution Space

Spores are user-created extensions that run on the mycelium infrastructure. Each spore is a self-contained module — a bot, daemon, receiver, or service — that imports from `lib/` and runs as its own process.

In mycology, spores are the reproductive units released by fruiting bodies. They carry the genetic blueprint of the parent mycelium but grow independently in their own substrate. This directory is where that independent growth happens.

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
4. Restart PM2 — the spore loader auto-discovers it

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