#!/usr/bin/env node
/**
 * gen-samples.mjs — offline synthesis of the v1 instrument sample set (§9.4).
 *
 * Writes 16-bit PCM mono 44.1 kHz .wav files plus §9.1/§9.2 manifests into
 * public/instruments/<id>/, so the real manifest code path is exercised
 * end to end without any binary assets being hand-sourced.
 *
 * Deterministic: every random source is a seeded PRNG keyed off the sample
 * name, so re-running produces byte-identical output (idempotent).
 *
 * No dependencies beyond node builtins.  Run: pnpm gen:samples
 */

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SR = 44100;
const BITS = 16;
const CHANNELS = 1;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_ROOT = path.join(ROOT, 'public', 'instruments');

// ---------------------------------------------------------------------------
// Deterministic RNG
// ---------------------------------------------------------------------------

/** FNV-1a — stable string → uint32 seed. */
function hashSeed(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32 — small, fast, fully deterministic. */
function rng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform noise in [-1, 1). */
function noise(rand) {
  return rand() * 2 - 1;
}

// ---------------------------------------------------------------------------
// DSP helpers
// ---------------------------------------------------------------------------

const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);

function onePoleLP(buf, cutoffHz) {
  const dt = 1 / SR;
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const a = dt / (rc + dt);
  let y = 0;
  for (let i = 0; i < buf.length; i++) {
    y += a * (buf[i] - y);
    buf[i] = y;
  }
  return buf;
}

function onePoleHP(buf, cutoffHz) {
  const dt = 1 / SR;
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const a = rc / (rc + dt);
  let yPrev = 0;
  let xPrev = 0;
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i];
    const y = a * (yPrev + x - xPrev);
    xPrev = x;
    yPrev = y;
    buf[i] = y;
  }
  return buf;
}

/** RBJ biquad. type: 'lp' | 'hp' | 'bp' (constant 0 dB peak gain). */
function biquad(buf, type, freq, q) {
  const w0 = (2 * Math.PI * Math.min(freq, SR * 0.45)) / SR;
  const cw = Math.cos(w0);
  const sw = Math.sin(w0);
  const alpha = sw / (2 * q);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'lp') {
    b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2;
    a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
  } else if (type === 'hp') {
    b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2;
    a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
  } else {
    b0 = alpha; b1 = 0; b2 = -alpha;
    a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
  }
  b0 /= a0; b1 /= a0; b2 /= a0; a1 /= a0; a2 /= a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i];
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    buf[i] = y;
  }
  return buf;
}

const softClip = (x) => Math.tanh(x);

/** Raised-cosine attack ramp value at time t (seconds). */
function attackGain(t, attackSec) {
  if (t >= attackSec) return 1;
  if (t <= 0) return 0;
  return 0.5 - 0.5 * Math.cos((Math.PI * t) / attackSec);
}

/** Exponential decay whose -60 dB point lands at t60 seconds. */
function expDecay(t, t60) {
  return Math.exp((-6.907755278982137 * t) / t60);
}

function makeBuf(seconds) {
  return new Float64Array(Math.max(1, Math.round(seconds * SR)));
}

function peakOf(buf) {
  let p = 0;
  for (let i = 0; i < buf.length; i++) {
    const a = Math.abs(buf[i]);
    if (a > p) p = a;
  }
  return p;
}

function normalize(buf, target) {
  const p = peakOf(buf);
  if (p <= 0) return buf;
  const g = target / p;
  for (let i = 0; i < buf.length; i++) buf[i] *= g;
  return buf;
}

// ---------------------------------------------------------------------------
// Click-proofing (§8.2): start on a zero crossing, fade the tail to true zero
// ---------------------------------------------------------------------------

const ZERO_EPS = 1e-9;

/**
 * Trim any leading samples before the first zero crossing, then pin the first
 * sample to exact zero.  Our envelopes all start at silence, so this is
 * normally a no-op — but it is asserted rather than assumed.
 */
function trimToZeroCrossing(buf) {
  if (buf.length === 0) return buf;
  let start = 0;
  if (Math.abs(buf[0]) > ZERO_EPS) {
    const limit = Math.min(buf.length - 1, Math.round(SR * 0.02));
    for (let i = 0; i < limit; i++) {
      if (buf[i] === 0 || Math.sign(buf[i]) !== Math.sign(buf[i + 1])) {
        start = i + (buf[i] === 0 ? 0 : 1);
        break;
      }
    }
  }
  const out = start === 0 ? buf : buf.slice(start);
  out[0] = 0;
  return out;
}

/** Cut the inaudible tail: last sample above -60 dBFS relative to peak. */
function trimTail(buf, minSeconds = 0.02) {
  const p = peakOf(buf);
  if (p <= 0) return buf.slice(0, Math.round(minSeconds * SR));
  const floor = p * 0.001;
  let end = buf.length;
  while (end > 1 && Math.abs(buf[end - 1]) < floor) end--;
  end = Math.max(end, Math.round(minSeconds * SR));
  end = Math.min(end, buf.length);
  return buf.slice(0, end);
}

/** Half-cosine fade of the final `ms` milliseconds down to exact zero. */
function fadeOut(buf, ms = 6) {
  const n = Math.min(buf.length, Math.round((ms / 1000) * SR));
  if (n < 2) {
    buf[buf.length - 1] = 0;
    return buf;
  }
  const start = buf.length - n;
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1);
    buf[start + i] *= 0.5 + 0.5 * Math.cos(Math.PI * x);
  }
  buf[buf.length - 1] = 0;
  return buf;
}

/** Full finishing chain applied to every rendered sample. */
function finish(buf, targetPeak) {
  let b = trimToZeroCrossing(buf);
  b = trimTail(b);
  normalize(b, targetPeak);
  b = fadeOut(b, 6);
  b[0] = 0;
  return b;
}

// ---------------------------------------------------------------------------
// WAV encode / decode
// ---------------------------------------------------------------------------

function encodeWav(samples) {
  const dataBytes = samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);              // PCM fmt chunk size
  buf.writeUInt16LE(1, 20);               // audioFormat = PCM
  buf.writeUInt16LE(CHANNELS, 22);
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE((SR * CHANNELS * BITS) / 8, 28); // byteRate
  buf.writeUInt16LE((CHANNELS * BITS) / 8, 32);      // blockAlign
  buf.writeUInt16LE(BITS, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) {
    let v = Math.round(samples[i] * 32767);
    if (v > 32767) v = 32767;
    if (v < -32768) v = -32768;
    buf.writeInt16LE(v, 44 + i * 2);
  }
  return buf;
}

/** Independent re-parse of a written file; throws on any mismatch. */
function verifyWav(file, expectedSamples) {
  const buf = readFileSync(file);
  const fail = (msg) => {
    throw new Error(`${path.relative(ROOT, file)}: ${msg}`);
  };
  if (buf.length < 44) fail('shorter than a WAV header');
  if (buf.toString('ascii', 0, 4) !== 'RIFF') fail('missing RIFF magic');
  if (buf.toString('ascii', 8, 12) !== 'WAVE') fail('missing WAVE magic');
  const riffSize = buf.readUInt32LE(4);
  if (riffSize !== buf.length - 8) {
    fail(`RIFF size ${riffSize} != fileSize-8 ${buf.length - 8}`);
  }

  let pos = 12;
  let fmt = null;
  let dataSize = null;
  let dataOffset = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (body + size > buf.length) fail(`chunk "${id}" overruns the file`);
    if (id === 'fmt ') {
      fmt = {
        audioFormat: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        byteRate: buf.readUInt32LE(body + 8),
        blockAlign: buf.readUInt16LE(body + 12),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      dataSize = size;
      dataOffset = body;
    }
    pos = body + size + (size % 2); // chunks are word-aligned
  }

  if (!fmt) fail('no fmt chunk');
  if (dataSize === null) fail('no data chunk');
  if (fmt.audioFormat !== 1) fail(`audioFormat ${fmt.audioFormat} != 1 (PCM)`);
  if (fmt.channels !== CHANNELS) fail(`channels ${fmt.channels} != ${CHANNELS}`);
  if (fmt.sampleRate !== SR) fail(`sampleRate ${fmt.sampleRate} != ${SR}`);
  if (fmt.bitsPerSample !== BITS) fail(`bits ${fmt.bitsPerSample} != ${BITS}`);
  if (fmt.blockAlign !== (CHANNELS * BITS) / 8) fail(`blockAlign ${fmt.blockAlign} wrong`);
  if (fmt.byteRate !== (SR * CHANNELS * BITS) / 8) fail(`byteRate ${fmt.byteRate} wrong`);
  if (dataSize % fmt.blockAlign !== 0) fail(`data size ${dataSize} not a whole number of frames`);
  if (dataOffset + dataSize !== buf.length) {
    fail(`data chunk end ${dataOffset + dataSize} != file size ${buf.length}`);
  }
  const frames = dataSize / fmt.blockAlign;
  if (frames !== expectedSamples) fail(`data frames ${frames} != rendered ${expectedSamples}`);

  // Click-proofing assertions (§8.2).
  if (buf.readInt16LE(dataOffset) !== 0) fail('first sample is not zero');
  if (buf.readInt16LE(dataOffset + dataSize - 2) !== 0) fail('last sample is not zero');

  return { bytes: buf.length, frames, seconds: frames / SR };
}

// ---------------------------------------------------------------------------
// Voices
// ---------------------------------------------------------------------------

/**
 * Additive piano: inharmonic partials, per-partial exponential decay (higher
 * partials die faster), soft ~5 ms attack, slight per-partial detune so the
 * pairs beat against each other.
 */
function renderPiano(midi, name) {
  const rand = rng(hashSeed(`piano:${name}`));
  const f0 = midiToFreq(midi);
  // Longer tails low, shorter high — also keeps the low notes from dominating
  // the byte budget for no audible gain.
  const t60Base = 2.5 * Math.pow(261.6255653005986 / f0, 0.35);
  const dur = Math.min(2.6, t60Base + 0.15);
  const buf = makeBuf(dur);
  const attack = 0.005;
  const B = 0.0004 + 0.0006 * Math.pow(f0 / 523.25, 1.2); // inharmonicity
  const nyq = SR * 0.45;

  for (let n = 1; n <= 16; n++) {
    const fn = f0 * n * Math.sqrt(1 + B * n * n);
    if (fn > nyq) break;
    const amp = Math.pow(n, -1.35) * (0.85 + 0.3 * rand());
    const t60 = (t60Base / Math.pow(n, 0.55)) * (0.9 + 0.2 * rand());
    // Two detuned components per partial → slow beating.
    const beat = (0.12 + 0.55 * rand()) * (1 + n * 0.05);
    const ph1 = rand() * Math.PI * 2;
    const ph2 = rand() * Math.PI * 2;
    const w1 = (2 * Math.PI * (fn - beat / 2)) / SR;
    const w2 = (2 * Math.PI * (fn + beat / 2)) / SR;
    for (let i = 0; i < buf.length; i++) {
      const t = i / SR;
      const decay = expDecay(t, t60);
      if (t > attack && decay < 1e-5) break; // partial is inaudible from here on
      const env = attackGain(t, attack) * decay;
      buf[i] += amp * env * 0.5 * (Math.sin(w1 * i + ph1) + Math.sin(w2 * i + ph2));
    }
  }

  // Hammer thump: a few ms of lowpassed noise under the onset.
  const thumpLen = Math.round(SR * 0.012);
  const thump = new Float64Array(thumpLen);
  for (let i = 0; i < thumpLen; i++) thump[i] = noise(rand);
  onePoleLP(thump, Math.min(1800, f0 * 6));
  for (let i = 0; i < thumpLen; i++) {
    const t = i / SR;
    buf[i] += thump[i] * 0.35 * attackGain(t, 0.001) * expDecay(t, 0.02);
  }

  return finish(buf, 0.86);
}

/**
 * Karplus-Strong plucked string with a one-zero lowpass plus a one-pole
 * damper in the feedback loop.  Delay length compensates both filters' phase
 * delay so the pitch lands where it should.
 */
function karplusStrong({ f0, dur, t60, s, damp, exciteHz, rand }) {
  const phaseDelay = s + (damp > 0 ? damp / (1 - damp) : 0);
  const D = Math.max(2, SR / f0 - phaseDelay);
  const Di = Math.floor(D);
  const frac = D - Di;
  const L = Di + 2;
  const line = new Float64Array(L);

  // Excitation: noise, lowpassed to taste (dull for bass, bright for guitar).
  const ex = new Float64Array(L);
  for (let i = 0; i < L; i++) ex[i] = noise(rand);
  onePoleLP(ex, exciteHz);
  onePoleHP(ex, f0 * 0.5);
  const exPeak = peakOf(ex) || 1;
  for (let i = 0; i < L; i++) line[i] = ex[i] / exPeak;

  // Per-sample feedback gain for the requested T60.
  const g = Math.pow(10, -3 / (t60 * f0));
  const out = makeBuf(dur);
  let idx = 0;
  let zPrev = 0;
  let lp = 0;
  for (let i = 0; i < out.length; i++) {
    const r0 = (idx - Di + L) % L;
    const r1 = (idx - Di - 1 + L) % L;
    const delayed = line[r0] * (1 - frac) + line[r1] * frac;
    // one-zero lowpass
    const oz = (1 - s) * delayed + s * zPrev;
    zPrev = delayed;
    // one-pole damper
    lp = (1 - damp) * oz + damp * lp;
    const y = g * lp;
    line[idx] = y;
    idx = (idx + 1) % L;
    out[i] = y;
  }
  return out;
}

function renderBass(midi, name) {
  const rand = rng(hashSeed(`bass:${name}`));
  const f0 = midiToFreq(midi);
  const dur = 1.5;
  const string = karplusStrong({
    f0, dur, t60: 1.7, s: 0.5, damp: 0.42, exciteHz: 1200, rand,
  });

  const buf = makeBuf(dur);
  for (let i = 0; i < buf.length; i++) buf[i] = string[i] * 0.9;

  // A little sub sine on the fundamental for weight.
  const w = (2 * Math.PI * f0) / SR;
  for (let i = 0; i < buf.length; i++) {
    const t = i / SR;
    buf[i] += 0.42 * attackGain(t, 0.004) * expDecay(t, 0.85) * Math.sin(w * i);
  }

  onePoleLP(buf, 3200);
  for (let i = 0; i < buf.length; i++) buf[i] = softClip(buf[i] * 1.1) * 0.9;
  onePoleHP(buf, 12); // DC blocker — the damped loop leaves a small offset
  return finish(buf, 0.9);
}

function renderGuitar(midi, name) {
  const rand = rng(hashSeed(`guitar:${name}`));
  const f0 = midiToFreq(midi);
  const dur = 2.0;
  const string = karplusStrong({
    f0, dur, t60: 2.4, s: 0.28, damp: 0.16, exciteHz: 6500, rand,
  });

  const buf = makeBuf(dur);
  for (let i = 0; i < buf.length; i++) buf[i] = string[i];

  // Pick-noise burst at the onset.
  const pickLen = Math.round(SR * 0.006);
  const pick = new Float64Array(pickLen);
  for (let i = 0; i < pickLen; i++) pick[i] = noise(rand);
  biquad(pick, 'hp', 2200, 0.8);
  for (let i = 0; i < pickLen; i++) {
    const t = i / SR;
    buf[i] += pick[i] * 0.5 * attackGain(t, 0.0006) * expDecay(t, 0.008);
  }

  onePoleHP(buf, 70);
  return finish(buf, 0.86);
}

function renderKick() {
  const rand = rng(hashSeed('kit:kick'));
  const dur = 0.45;
  const buf = makeBuf(dur);
  const fStart = 110;
  const fEnd = 45;
  const pitchTau = 0.035;
  let phase = 0;
  for (let i = 0; i < buf.length; i++) {
    const t = i / SR;
    const f = fEnd + (fStart - fEnd) * Math.exp(-t / pitchTau);
    phase += (2 * Math.PI * f) / SR;
    const env = attackGain(t, 0.002) * expDecay(t, 0.32);
    buf[i] = Math.sin(phase) * env;
  }
  // Beater click.
  const clickLen = Math.round(SR * 0.004);
  const click = new Float64Array(clickLen);
  for (let i = 0; i < clickLen; i++) click[i] = noise(rand);
  biquad(click, 'hp', 1500, 0.7);
  for (let i = 0; i < clickLen; i++) {
    const t = i / SR;
    buf[i] += click[i] * 0.35 * attackGain(t, 0.0004) * expDecay(t, 0.005);
  }
  for (let i = 0; i < buf.length; i++) buf[i] = softClip(buf[i] * 1.4);
  return finish(buf, 0.95);
}

function renderSnare() {
  const rand = rng(hashSeed('kit:snare'));
  const dur = 0.32;
  const n = makeBuf(dur);
  for (let i = 0; i < n.length; i++) n[i] = noise(rand);
  biquad(n, 'bp', 1900, 0.55);
  biquad(n, 'hp', 320, 0.7);

  const buf = makeBuf(dur);
  let p1 = 0;
  let p2 = 0;
  const w1 = (2 * Math.PI * 180) / SR;
  const w2 = (2 * Math.PI * 262) / SR;
  for (let i = 0; i < buf.length; i++) {
    const t = i / SR;
    p1 += w1;
    p2 += w2;
    const body = (Math.sin(p1) * 0.8 + Math.sin(p2) * 0.35)
      * attackGain(t, 0.001) * expDecay(t, 0.12);
    const rattle = n[i] * attackGain(t, 0.0008) * expDecay(t, 0.19);
    buf[i] = body * 0.55 + rattle * 0.85;
  }
  for (let i = 0; i < buf.length; i++) buf[i] = softClip(buf[i] * 1.15);
  return finish(buf, 0.88);
}

function renderHat(nameKey, t60, targetPeak) {
  const rand = rng(hashSeed(`kit:${nameKey}`));
  const dur = t60 + 0.03;
  const buf = makeBuf(dur);
  for (let i = 0; i < buf.length; i++) buf[i] = noise(rand);
  // Metallic-ish: two bandpasses on top of a steep highpass.
  biquad(buf, 'hp', 7000, 0.7);
  biquad(buf, 'hp', 7000, 0.7);
  const ring = Float64Array.from(buf);
  biquad(ring, 'bp', 9400, 6);
  for (let i = 0; i < buf.length; i++) buf[i] += ring[i] * 0.5;
  for (let i = 0; i < buf.length; i++) {
    const t = i / SR;
    buf[i] *= attackGain(t, 0.0005) * expDecay(t, t60);
  }
  return finish(buf, targetPeak);
}

function renderCrash() {
  const rand = rng(hashSeed('kit:crash'));
  const t60 = 1.5;
  const dur = 1.55;
  const buf = makeBuf(dur);
  for (let i = 0; i < buf.length; i++) buf[i] = noise(rand);
  biquad(buf, 'hp', 2600, 0.6);
  const shimmer = Float64Array.from(buf);
  biquad(shimmer, 'bp', 6200, 2.5);
  for (let i = 0; i < buf.length; i++) buf[i] += shimmer[i] * 0.6;
  for (let i = 0; i < buf.length; i++) {
    const t = i / SR;
    // Fast initial splash over a slow, near-exponential wash.
    const env = 0.55 * expDecay(t, 0.09) + expDecay(t, t60);
    buf[i] *= attackGain(t, 0.001) * env;
  }
  return finish(buf, 0.7);
}

function renderTom(nameKey, fStart, fEnd, t60) {
  const rand = rng(hashSeed(`kit:${nameKey}`));
  const dur = t60 + 0.05;
  const buf = makeBuf(dur);
  let phase = 0;
  for (let i = 0; i < buf.length; i++) {
    const t = i / SR;
    const f = fEnd + (fStart - fEnd) * Math.exp(-t / 0.08);
    phase += (2 * Math.PI * f) / SR;
    buf[i] = Math.sin(phase) * attackGain(t, 0.0015) * expDecay(t, t60);
  }
  const hitLen = Math.round(SR * 0.03);
  const hit = new Float64Array(hitLen);
  for (let i = 0; i < hitLen; i++) hit[i] = noise(rand);
  biquad(hit, 'bp', fStart * 3, 1.1);
  for (let i = 0; i < hitLen; i++) {
    const t = i / SR;
    buf[i] += hit[i] * 0.4 * attackGain(t, 0.0005) * expDecay(t, 0.03);
  }
  for (let i = 0; i < buf.length; i++) buf[i] = softClip(buf[i] * 1.2);
  return finish(buf, 0.82);
}

// ---------------------------------------------------------------------------
// Instrument definitions (drive both the .wav render and the manifests)
// ---------------------------------------------------------------------------

const PIANO_NOTES = [
  [36, 'C2'], [48, 'C3'], [60, 'C4'], [72, 'C5'], [84, 'C6'],
];
const BASS_NOTES = [[28, 'E1'], [40, 'E2'], [52, 'E3']];
const GUITAR_NOTES = [[40, 'E2'], [52, 'E3'], [64, 'E4'], [76, 'E5']];

const KIT_PIECES = [
  { midi: 36, label: 'Kick', sample: 'kick', render: () => renderKick() },
  { midi: 38, label: 'Snare', sample: 'snare', render: () => renderSnare() },
  { midi: 41, label: 'Low Tom', sample: 'tom-low', render: () => renderTom('tom-low', 130, 82, 0.55) },
  { midi: 42, label: 'HH Cl', sample: 'hh-closed', render: () => renderHat('hh-closed', 0.06, 0.55) },
  { midi: 45, label: 'Mid Tom', sample: 'tom-mid', render: () => renderTom('tom-mid', 175, 112, 0.48) },
  { midi: 46, label: 'HH Op', sample: 'hh-open', render: () => renderHat('hh-open', 0.35, 0.58) },
  { midi: 48, label: 'High Tom', sample: 'tom-high', render: () => renderTom('tom-high', 232, 150, 0.42) },
  { midi: 49, label: 'Crash', sample: 'crash', render: () => renderCrash() },
];

const INSTRUMENTS = [
  {
    id: 'ph-piano-1',
    name: 'PepperHorn Piano',
    kind: 'pitched',
    gmProgram: 0,
    notes: PIANO_NOTES,
    render: renderPiano,
  },
  {
    id: 'ph-guitar-1',
    name: 'PepperHorn Guitar',
    kind: 'pitched',
    gmProgram: 25,
    notes: GUITAR_NOTES,
    render: renderGuitar,
  },
  {
    id: 'ph-bass-1',
    name: 'PepperHorn Bass',
    kind: 'pitched',
    gmProgram: 33,
    notes: BASS_NOTES,
    render: renderBass,
  },
  {
    id: 'ph-kit-1',
    name: 'PepperHorn Kit',
    kind: 'kit',
    gmBasis: true,
    pieces: KIT_PIECES,
  },
];

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return readFileSync(file).length;
}

function main() {
  const rows = [];
  let totalBytes = 0;

  const record = (file, bytes, extra) => {
    totalBytes += bytes;
    rows.push({ file: path.relative(ROOT, file), bytes, ...extra });
  };

  for (const inst of INSTRUMENTS) {
    const dir = path.join(OUT_ROOT, inst.id);
    mkdirSync(dir, { recursive: true });

    let manifest;
    if (inst.kind === 'pitched') {
      const samples = {};
      for (const [midi, sampleName] of inst.notes) {
        const audio = inst.render(midi, sampleName);
        const file = path.join(dir, `${sampleName}.wav`);
        writeFileSync(file, encodeWav(audio));
        const info = verifyWav(file, audio.length);
        record(file, info.bytes, { seconds: info.seconds });
        samples[String(midi)] = sampleName; // EXTENSION-LESS (§9.1)
      }
      manifest = {
        id: inst.id,
        name: inst.name,
        kind: inst.kind,
        gmProgram: inst.gmProgram,
        samples,
        baseUrl: `/instruments/${inst.id}`,
        formats: ['wav'],
      };
    } else {
      const pieces = [];
      for (const piece of inst.pieces) {
        const audio = piece.render();
        const file = path.join(dir, `${piece.sample}.wav`);
        writeFileSync(file, encodeWav(audio));
        const info = verifyWav(file, audio.length);
        record(file, info.bytes, { seconds: info.seconds });
        pieces.push({ midi: piece.midi, label: piece.label, sample: piece.sample });
      }
      manifest = {
        id: inst.id,
        name: inst.name,
        kind: inst.kind,
        gmBasis: true,
        baseUrl: `/instruments/${inst.id}`,
        formats: ['wav'],
        pieces,
      };
    }

    const mf = path.join(dir, 'manifest.json');
    record(mf, writeJson(mf, manifest), {});
  }

  const indexFile = path.join(OUT_ROOT, 'index.json');
  record(
    indexFile,
    writeJson(indexFile, INSTRUMENTS.map(({ id, name, kind }) => ({ id, name, kind }))),
    {},
  );

  // ---- summary table -------------------------------------------------------
  const wCol = Math.max(4, ...rows.map((r) => r.file.length));
  const line = (a, b, c) => `${a.padEnd(wCol)}  ${b.padStart(10)}  ${c.padStart(8)}`;
  console.log(`\n  ${line('file', 'bytes', 'seconds')}`);
  console.log(`  ${'-'.repeat(wCol)}  ${'-'.repeat(10)}  ${'-'.repeat(8)}`);
  for (const r of rows) {
    console.log(`  ${line(
      r.file,
      r.bytes.toLocaleString('en-US'),
      r.seconds === undefined ? '-' : r.seconds.toFixed(3),
    )}`);
  }
  console.log(`  ${'-'.repeat(wCol)}  ${'-'.repeat(10)}  ${'-'.repeat(8)}`);
  console.log(`  ${line(`${rows.length} files`, totalBytes.toLocaleString('en-US'), '')}`);
  console.log(`\n  total: ${(totalBytes / 1024 / 1024).toFixed(2)} MiB — all headers verified `
    + `(PCM, ${CHANNELS}ch, ${SR} Hz, ${BITS}-bit, data length matches)\n`);
}

main();
