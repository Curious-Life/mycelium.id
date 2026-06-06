/**
 * ffmpeg helpers for TTS audio post-processing.
 *
 *   remuxToTelegramSpec  — force mono / 48kHz / 32kbps Opus (Telegram voice
 *                          spec). Required because providers return varying
 *                          formats (OpenAI=opus, ElevenLabs=mp3 by default,
 *                          Cartesia=wav). Telegram is strict about voice-
 *                          message audio, and uploading raw provider output
 *                          has historically been unreliable.
 *
 *   concatOggBuffers     — concat multiple OGG/Opus chunks into one file
 *                          (Discord voice messages are a single audio file
 *                          with a duration; Telegram sends one message per
 *                          chunk, so it doesn't need this).
 *
 * Both fail-soft: if ffmpeg is missing or errors, callers receive the raw
 * input. This matches existing admin behavior.
 */

import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { writeFile, readFile, mkdtemp, stat, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const execFileAsync = promisify(execFile);

/**
 * Remux raw audio Buffer to the exact codec spec Telegram requires.
 * Returns { path, dir, size } where `path` points to the remuxed file
 * and `dir` is a temp directory the caller must clean up.
 *
 * On ffmpeg failure, returns the raw input written to disk and logs a
 * warning — same behavior as the original telegram-bot.js implementation.
 *
 * @param {Buffer} rawAudio
 * @param {object} [opts]
 * @param {string} [opts.inputExt='.ogg']  hint for the temp filename;
 *                                         ffmpeg auto-detects format
 *                                         from content, but a sensible
 *                                         extension helps debugging.
 * @param {(msg: string) => void} [opts.warn=console.warn]
 * @param {(msg: string) => void} [opts.log=console.log]
 */
export async function remuxToTelegramSpec(rawAudio, opts = {}) {
  const { inputExt = '.ogg', warn = console.warn, log = console.log } = opts;
  const dir = await mkdtemp(join(tmpdir(), 'tts-'));
  const inFile = join(dir, `in${inputExt}`);
  const outFile = join(dir, 'out.ogg');

  await writeFile(inFile, rawAudio);
  try {
    await execFileAsync('ffmpeg', [
      '-y', '-i', inFile,
      '-c:a', 'libopus',
      '-b:a', '32k',
      '-ac', '1',
      '-ar', '48000',
      '-application', 'voip',
      '-vn',
      outFile,
    ], { timeout: 30000 });
    const st = await stat(outFile);
    log(`[TTS] Remuxed ${rawAudio.length}B → ${st.size}B at ${outFile}`);
    return { path: outFile, dir, size: st.size };
  } catch (ffmpegErr) {
    warn(`[TTS] ffmpeg remux failed (${ffmpegErr.message?.slice(0, 100)}) — using raw audio`);
    return { path: inFile, dir, size: rawAudio.length };
  }
}

/**
 * Concatenate multiple OGG/Opus buffers into a single buffer using
 * ffmpeg's concat demuxer. Single-buffer input is returned as-is.
 *
 * Caller responsibility: buffers must be the same codec (all OGG/Opus).
 * If providers other than OpenAI/Worker enter the picture, route them
 * through `remuxToTelegramSpec` first to normalize, then concat.
 *
 * @param {Buffer[]} buffers
 * @returns {Promise<Buffer>}
 */
export async function concatOggBuffers(buffers) {
  if (!Array.isArray(buffers) || buffers.length === 0) {
    throw new TypeError('concatOggBuffers: requires non-empty Buffer[]');
  }
  if (buffers.length === 1) return buffers[0];
  const dir = await mkdtemp(join(tmpdir(), 'tts-'));
  try {
    const chunkPaths = [];
    for (let i = 0; i < buffers.length; i++) {
      const p = join(dir, `chunk${i}.ogg`);
      await writeFile(p, buffers[i]);
      chunkPaths.push(p);
    }
    const listFile = join(dir, 'list.txt');
    await writeFile(listFile, chunkPaths.map(p => `file '${p}'`).join('\n'));
    const outFile = join(dir, 'combined.ogg');
    await new Promise((resolve, reject) => {
      const proc = spawn('ffmpeg', ['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', outFile], { stdio: 'pipe' });
      proc.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`)));
      proc.on('error', reject);
    });
    return await readFile(outFile);
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
