/**
 * Approximate waveform from raw audio bytes for Discord voice messages.
 * Discord expects ~256 amplitude samples as a base64-encoded byte array.
 * Samples raw OGG bytes — no real Opus decoding needed for visual display.
 *
 * Lifted from packages/server/routes/bots.js.
 */
export function generateWaveform(audioBuffer, numSamples = 256) {
  const samples = Buffer.alloc(numSamples);
  if (!audioBuffer || audioBuffer.length === 0) return samples.toString('base64');

  const headerSkip = Math.min(200, Math.floor(audioBuffer.length * 0.05));
  const audioData = audioBuffer.subarray(headerSkip);
  const chunkSize = Math.max(1, Math.floor(audioData.length / numSamples));

  for (let i = 0; i < numSamples; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, audioData.length);
    if (start >= audioData.length) { samples[i] = 0; continue; }

    let sum = 0;
    let count = 0;
    for (let j = start; j < end; j++) {
      sum += Math.abs(audioData[j] - 128);
      count++;
    }
    samples[i] = Math.min(255, Math.round((count > 0 ? sum / count : 0) * 2));
  }
  return samples.toString('base64');
}
