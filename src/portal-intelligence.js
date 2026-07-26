// src/portal-intelligence.js — the first-run bundle orchestrator (Intelligence redesign
// Part I, the Intelligence-screen redesign §4.3).
//
// Two routes, both COMPOSITION over shipped parts — no new catalog, no new write path,
// no new download path (§3.10d):
//
//   GET  /intelligence/bundle        — the proposed set: per-row size, aggregate total,
//                                      installed/assigned state, free-disk headroom (W4).
//   POST /intelligence/bundle/apply  — fans out the FUNCTION writes through the ONE
//                                      task-model write path (applyTaskModelWrite —
//                                      portal-providers.js, the consent mechanism itself),
//                                      then nudges the enrichment drainer so an approved
//                                      model is picked up NOW (#206 retry-means-now).
//                                      Downloads are NOT started here: the client starts
//                                      them through the routes that already exist and
//                                      already own their progress/consent semantics
//                                      (POST /hardware/pull — installs Ollama first, SSE;
//                                      POST /transcription/download — persists the choice
//                                      itself). Growing a server-side parallel download
//                                      path would fork the #206 backoff/feed semantics the
//                                      design forbids forking.
//
// CONSENT: the tap on "[ Set everything up · N GB ]" IS the consent (§3.10c choosing-is-
// approving, P5): every approval this route writes goes through applyTaskModelWrite, the
// same function the Intelligence screen's own controls execute — value written = approved,
// nothing written = not approved, fail-closed. This route never invents a default.
//
// DISK (W4, fail-closed): apply refuses with a structured `disk_low` BEFORE any write when
// the bundle's bytes cannot fit alongside the vault's own headroom (db/disk-guard.js — the
// same guard the job spawners ride). Never mid-download.
//
// §1 ZERO-PLAINTEXT: everything served here is counts, sizes, hardware facts and model /
// preset identifiers. No user content is readable from this module.
//
// PARTIAL FAILURE IS FIRST-CLASS (§3.10d-b): each item reports its own outcome
// ('approved' / 'already-set' / 'skipped:no-provider' / 'error'); one failing item never
// rejects the rest. `skipped:no-provider` is the honest cold-vault answer for Descriptions
// (an EU cloud needs a key no tap can paste) — the summary's "needs you" line carries it.

import express from 'express';
import { detectHardware } from './hardware/detect.js';
import { createOllamaClient } from './hardware/ollama.js';
import { CATALOG } from './hardware/catalog.js';
import { ROLE_RECOMMENDATIONS } from './inference/role-models.js';
import { jurisdictionForBaseUrl } from './inference/presets.js';
import { applyTaskModelWrite } from './portal-providers.js';
import { WHISPER_CATALOG, recommendedWhisperModel } from './portal-transcription.js';
import { vaultDiskHeadroom } from './db/disk-guard.js';
import { resetPullBackoff, nudgeEnrichDrainer } from './enrich/drainer.js';
import { getModelState as voiceModelState, hasVoiceSample, defaultVariant, DEFAULT_VOICE_MODEL } from './tts/qwen3-tts-model.js';
import { getEmbedderHealth } from './embed/supervisor.js';

// The embedder health states that mean "the bundled Nomic weights did NOT load and a
// retry is the fix" — a failed/absent HF download, or a governor-halted service. Kept in
// lockstep with readiness.js's DOWN set (the pipeline slice's embedder_down trigger).
const EMBEDDER_RETRYABLE = new Set(['down', 'error', 'deps_missing', 'unavailable']);
// …and the states that mean "the download/load is in flight — wait, don't retry".
const EMBEDDER_LOADING = new Set(['loading', 'starting', 'downloading']);

const GiB = 2 ** 30;
const round1 = (n) => Math.round(n * 10) / 10;

// A subscription row (auth_type 'oauth') — same one-discriminator rule as portal-providers.
const isSubscriptionRow = (r) => String(r?.auth_type || '').toLowerCase() === 'oauth';

// EXACT-tag installed check (ollama-tag-semantics: a base match reports ready while every
// call 404s; tag-less names resolve as :latest ONLY).
const isInstalled = (installed, model) => {
  const want = String(model).includes(':') ? String(model) : `${model}:latest`;
  return Array.isArray(installed) && installed.some((n) => n === want);
};

/**
 * Compose the proposed bundle for this vault. Pure composition of shipped parts; exported
 * so the gate can drive it without HTTP.
 */
export async function composeBundle({
  db, userId, detect = detectHardware, listInstalled, dbPath = null, headroom = vaultDiskHeadroom,
  // Embedder health seam — injectable so the gate can drive the failed/loading/ok states of the
  // bundled Nomic model without a live :8091. Defaults to the real supervisor health.
  embedderHealth = getEmbedderHealth,
  // Voice seams — injectable so the gate can drive BOTH the runnable and not-runnable states
  // offline. `voiceState` reports whether the Qwen3-TTS model is downloaded (sync); `voiceRunnable`
  // is hasVoiceSample() — now REAL per #234 (async: does the personal agent have a recorded voice
  // sample?), so voice becomes one-click-downloadable the moment the owner records one on the
  // character page, and stays gated out until then (W2 executability).
  voiceState = voiceModelState, voiceRunnable = hasVoiceSample,
}) {
  const hardware = await detect();
  let localInstalled = [];
  try { localInstalled = (await listInstalled?.()) || []; } catch { /* daemon down/asleep → nothing installed */ }
  const settings = (await db.users?.getSettings?.(userId)) || {};
  const taskModels = settings.taskModels || {};
  let providers = [];
  try { providers = (await db.providers.list(userId)) || []; } catch { /* fail-soft: rows read as not-connected */ }

  // ── Understanding — the on-box labeling model (one approval, both tasks) ──
  const labelModel = ROLE_RECOMMENDATIONS.labeling.model;
  const labelSizeGb = CATALOG.find((m) => m.name === labelModel)?.sizeGb || 0;
  const labelInstalled = isInstalled(localInstalled, labelModel);
  // Assigned means BOTH tasks — a half-assigned Understanding is the dormancy bug, and the
  // gap-fill must offer to finish it, not report it done.
  const understandingAssigned = Boolean(taskModels.categorize?.model && taskModels.enrich?.model);

  // ── Transcription — the RAM-chosen whisper (its own catalog + route) ──
  const whisperModel = recommendedWhisperModel(hardware?.totalRamGb ?? null);
  const whisperSizeGb = round1((WHISPER_CATALOG.find((c) => c.model === whisperModel)?.sizeMB || 0) / 1000);
  const whisperAssigned = Boolean(settings.transcribeModel);

  // ── Descriptions — an EU-ZDR cloud (§4g: never US). Server-side jurisdiction, the ONE
  // shared parser — the same authority publicRow ships to clients. ──
  const euProvider = providers.find((p) => jurisdictionForBaseUrl(p.base_url, p.provider) === 'eu-zdr') || null;
  const descriptionsAssigned = Boolean(taskModels.narrate?.providerId);

  // ── Voice — Qwen3-TTS (its OWN catalog + route). GATED ON RUNNABLE (W2 executability): a
  // downloaded Qwen3-TTS still needs a reference sample to speak (§2.2/§5), so the one-click
  // bundle DOWNLOADS it only when hasVoiceSample() is true. Until then it is adjacent info the
  // panel and apply can see, with downloadGb = 0 so it never inflates the "set everything up"
  // total, and apply skips it honestly (skipped:not-runnable). Now that #234's character page has
  // shipped, "runnable" means the owner has recorded a voice sample — so voice joins the one-click
  // download the moment they do, with NO further change here (operator decision: "gate on
  // runnable", 2026-07-18). ──
  const voiceVariant = defaultVariant();
  const voiceModel = DEFAULT_VOICE_MODEL;
  const voiceInstalled = (() => { try { return voiceState()?.phase === 'ready'; } catch { return false; } })();
  // ⚠️ AWAIT — hasVoiceSample() is ASYNC (it decrypt-validates the personal agent's recorded
  // sample, #234). A synchronous `Boolean(voiceRunnable())` returns Boolean(Promise) === true,
  // which silently defeats the whole gate (voice always "runnable"). This bit on the merge with
  // main, where #234 shipped the real per-agent sample check the stub used to fake.
  let voiceRunnableNow = false;
  try { voiceRunnableNow = Boolean(await voiceRunnable()); } catch { voiceRunnableNow = false; }
  const voiceSizeGb = round1((voiceVariant?.sizeMB || 0) / 1000);

  // ── Conversation — adjacent connect chip (§4.1a W2), never a bundle row ──
  const subRow = providers.find(isSubscriptionRow) || null;
  const conversationAssigned = Boolean(taskModels.chat?.providerId);

  const rows = [
    {
      key: 'understanding', model: labelModel, runs: 'on-device',
      installed: labelInstalled, assigned: understandingAssigned,
      downloadGb: labelInstalled ? 0 : labelSizeGb,
      // The Ollama RUNTIME itself may also download (hardware/pull installs it first) —
      // stated as a flag, not folded into the number (its size isn't ours to invent).
      needsRuntime: !labelInstalled,
    },
    // Search (Nomic) SHIPS with the app, but its ONNX weights download from HuggingFace at first
    // load — so `included` is the healthy-case fact, and `embedder` carries the REAL health so the
    // wizard/settings can show a failed/loading state + a Retry (→ POST /portal/embed/retry) instead
    // of a fake ✓ that strands a fresh user at "Processing 0/N". Fail-soft: a throwing/absent health
    // read reads as 'unknown' (benign — treated as included, never a false retry prompt).
    (() => {
      const emb = (() => { try { return embedderHealth?.() || null; } catch { return null; } })();
      const embStatus = emb?.status || 'unknown';
      return {
        key: 'search', model: 'nomic-v1.5', runs: 'on-device', included: true, installed: true, assigned: true, downloadGb: 0,
        embedder: {
          status: embStatus,
          message: emb?.message ?? null,
          detail: emb?.detail ?? null,
          // retryable ⇒ show a Retry button; loading ⇒ show the in-flight state (no ✓, no button).
          retryable: EMBEDDER_RETRYABLE.has(embStatus),
          loading: EMBEDDER_LOADING.has(embStatus),
        },
      };
    })(),
    {
      key: 'transcription', model: whisperModel, runs: 'on-device',
      installed: whisperAssigned, assigned: whisperAssigned,
      downloadGb: whisperAssigned ? 0 : whisperSizeGb,
    },
    {
      key: 'descriptions', presetId: ROLE_RECOMMENDATIONS.descriptions.presetId, runs: 'eu-cloud',
      connected: Boolean(euProvider), providerId: euProvider?.id ?? null,
      providerLabel: euProvider ? (euProvider.label || euProvider.provider) : null,
      assigned: descriptionsAssigned, downloadGb: 0,
    },
  ];
  const totalDownloadGb = round1(rows.reduce((s, r) => s + (r.downloadGb || 0), 0));

  // W4 — disk honesty. Free space from the vault volume; the bundle fits iff the bytes fit
  // ON TOP of the vault's own operating headroom (the same fail-closed guard large jobs use).
  let disk = { freeGb: null, ok: true, shortfallGb: 0 };
  if (dbPath) {
    const h = headroom(dbPath);
    if (!h.unmeasured) {
      const needBytes = h.needBytes + totalDownloadGb * GiB;
      disk = {
        freeGb: h.freeGb,
        ok: h.freeBytes >= needBytes,
        shortfallGb: h.freeBytes >= needBytes ? 0 : round1((needBytes - h.freeBytes) / GiB),
      };
    }
  }

  return {
    hardware: {
      // Human facts for "your Mac (M1, 16 GB)" — names and numbers only.
      cpuName: hardware?.cpuName || null, arch: hardware?.arch || null,
      platform: hardware?.platform || null, totalRamGb: hardware?.totalRamGb ?? null,
      hasGpu: Boolean(hardware?.hasGpu), backend: hardware?.backend || 'cpu',
    },
    rows, totalDownloadGb, disk,
    adjacent: {
      conversation: { subscriptionConnected: Boolean(subRow), providerId: subRow?.id ?? null, assigned: conversationAssigned },
      // Voice is ADJACENT, never a bundle row (§4.1a W3, same as conversation): it stays out of
      // the "set everything up" total/rows because a downloaded Qwen3-TTS can't speak without a
      // reference sample (W2). `runnable` = hasVoiceSample(); when true, the one-click apply adds
      // its download (operator: "gate on runnable", 2026-07-18) — an adjacent item, not a row.
      voice: { model: voiceModel, runnable: voiceRunnableNow, installed: voiceInstalled, sizeGb: voiceSizeGb, assigned: voiceInstalled },
    },
  };
}

/**
 * @param {object} deps
 * @param {object} deps.db          assembled vault DAL (users + providers)
 * @param {string} [deps.userId]
 * @param {string} [deps.dbPath]    vault path for the disk guard (W4)
 * @param {string} [deps.ollamaUrl]
 * @param {typeof fetch} [deps.fetch]
 * @param {Function} [deps.detect]        injectable detectHardware (tests)
 * @param {Function} [deps.listInstalled] injectable installed-models probe (tests)
 * @param {Function} [deps.onApplied]     called once after a successful apply — production
 *                                        wires the #206 retry-means-now pair
 *                                        (resetPullBackoff + nudgeEnrichDrainer).
 */
export function portalIntelligenceRouter({
  db, userId = 'local-user', dbPath = null, ollamaUrl, fetch = globalThis.fetch,
  detect = detectHardware, listInstalled = null, headroom = vaultDiskHeadroom,
  // Voice seams (default to the real TTS module) — injectable so the gate can drive both the
  // not-yet-runnable (main) and runnable (post character-page) states offline.
  voiceState = voiceModelState, voiceRunnable = hasVoiceSample,
  onApplied = () => { resetPullBackoff(); nudgeEnrichDrainer(); },
} = {}) {
  if (!db?.users || !db?.providers) throw new Error('portalIntelligenceRouter: db.users + db.providers required');
  const router = express.Router();
  // Construct the client at USE time so a no-ollamaUrl mount follows an alt-port self-heal via
  // createOllamaClient's env-aware default (process.env.OLLAMA_URL after a heal, else :11434).
  const probeInstalled = listInstalled || (() => createOllamaClient({ baseUrl: ollamaUrl, fetch }).listInstalled());
  const compose = () => composeBundle({ db, userId, detect, listInstalled: probeInstalled, dbPath, headroom, voiceState, voiceRunnable });

  router.get('/intelligence/bundle', async (_req, res) => {
    try {
      res.json({ ok: true, ...(await compose()) });
    } catch { res.status(500).json({ ok: false, error: 'bundle composition failed' }); }
  });

  // POST /intelligence/bundle/apply { functions?: string[] } — scope defaults to every
  // assignable recommended row that is not already set (STATE A applies everything; the
  // W6 gap-fill sends the missing subset — one orchestrator, opposite polarity).
  router.post('/intelligence/bundle/apply', async (req, res) => {
    try {
      const bundle = await compose();
      const requested = Array.isArray(req.body?.functions) && req.body.functions.length
        ? req.body.functions.map(String)
        : ['understanding', 'transcription', 'descriptions', 'conversation', 'voice'];
      const scope = new Set(requested);

      // W4 — refuse BEFORE any write when the scoped bytes cannot fit. Structured, so the
      // UI can say "Free up N GB" (the disk_low shape the job spawners already taught it).
      // Voice is adjacent (not a row) but a real download when runnable — count it so the disk
      // guard stays honest the day it lights up (0 today, hasVoiceSample() false).
      const av = bundle.adjacent.voice;
      const voiceGb = (scope.has('voice') && av.runnable && !av.installed) ? (av.sizeGb || 0) : 0;
      const scopedGb = round1(bundle.rows
        .filter((r) => scope.has(r.key))
        .reduce((s, r) => s + (r.downloadGb || 0), 0) + voiceGb);
      if (dbPath && scopedGb > 0) {
        const h = headroom(dbPath);
        if (!h.unmeasured && h.freeBytes < h.needBytes + scopedGb * GiB) {
          return res.status(409).json({
            ok: false, error: 'disk_low',
            freeGb: h.freeGb, shortfallGb: round1((h.needBytes + scopedGb * GiB - h.freeBytes) / GiB),
          });
        }
      }

      const results = {};
      const downloads = [];

      // Understanding — approve BY FUNCTION through the one write path (atomic: both tasks).
      if (scope.has('understanding')) {
        const row = bundle.rows.find((r) => r.key === 'understanding');
        if (row.assigned) results.understanding = 'already-set';
        else {
          try {
            const w = await applyTaskModelWrite({ db, userId, body: { function: 'understanding', model: row.model } });
            results.understanding = w.ok ? 'approved' : 'error';
          } catch { results.understanding = 'error'; }
        }
        if (results.understanding !== 'error' && !row.installed) {
          downloads.push({ key: 'understanding', model: row.model, route: '/portal/hardware/pull' });
        }
      }

      // Transcription — the CLIENT calls POST /transcription/download, which persists the
      // choice itself (its route is the one writer of transcribeModel — one write path).
      if (scope.has('transcription')) {
        const row = bundle.rows.find((r) => r.key === 'transcription');
        if (row.assigned) results.transcription = 'already-set';
        else {
          results.transcription = 'download-required';
          downloads.push({ key: 'transcription', model: row.model, route: '/portal/transcription/download' });
        }
      }

      // Descriptions — assign the connected EU provider, or say honestly that none exists.
      if (scope.has('descriptions')) {
        const row = bundle.rows.find((r) => r.key === 'descriptions');
        if (row.assigned) results.descriptions = 'already-set';
        else if (!row.providerId) results.descriptions = 'skipped:no-provider';
        else {
          try {
            const w = await applyTaskModelWrite({ db, userId, body: { function: 'descriptions', providerId: row.providerId } });
            results.descriptions = w.ok ? 'approved' : 'error';
          } catch { results.descriptions = 'error'; }
        }
      }

      // Voice — Qwen3-TTS, GATED ON RUNNABLE (operator decision 2026-07-18). Same download-
      // required pattern as transcription (the /settings/tts route owns the bytes + the choice),
      // but only when the model can actually SPEAK: a downloaded voice with no reference sample
      // yet (hasVoiceSample() false) is `skipped:not-runnable` — honest, never a 2.9 GB download
      // that answers 501. When the character page ships this lights up with no code change here.
      if (scope.has('voice')) {
        const v = bundle.adjacent.voice;
        if (v.installed) results.voice = 'already-set';
        else if (!v.runnable) results.voice = 'skipped:not-runnable';
        else {
          results.voice = 'download-required';
          downloads.push({ key: 'voice', model: v.model, route: '/portal/settings/tts/qwen/download' });
        }
      }

      // Conversation — ONLY when the connect chip completed (§4.1a: tapping Connect was the
      // choice; a vault with no subscription is skipped, never prompted here).
      if (scope.has('conversation')) {
        const conv = bundle.adjacent.conversation;
        if (conv.assigned) results.conversation = 'already-set';
        else if (!conv.subscriptionConnected) results.conversation = 'skipped:no-provider';
        else {
          try {
            const w = await applyTaskModelWrite({ db, userId, body: { function: 'conversation', providerId: conv.providerId } });
            results.conversation = w.ok ? 'approved' : 'error';
          } catch { results.conversation = 'error'; }
        }
      }

      // #206 retry-means-now: an approval the drainer can act on is acted on NOW — clear the
      // pull backoff and kick a cycle. (No-op when nothing is pending; the drainer's own
      // consent gate still rules.)
      try { onApplied(); } catch { /* never fail the apply on the nudge */ }

      res.json({ ok: true, results, downloads });
    } catch { res.status(500).json({ ok: false, error: 'bundle apply failed' }); }
  });

  return router;
}

export default portalIntelligenceRouter;
