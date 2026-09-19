import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, readFile, rm, mkdtemp } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { SYSTEM_VOICE } from './voices.js';

const run = promisify(execFile);

// La voz se genera en la Mac con `say` y viaja al teléfono como audio.
// La síntesis de voz de Safari en iOS falla demasiado seguido para depender de ella.
const clips = new Map();
const MAX_CLIPS = 12;

// Con la voz del sistema no se pasa `-v`: `say` usa la que esté elegida en Ajustes.
export function sayArgs({ voice, rate, input, output }) {
  const pick = voice && voice !== SYSTEM_VOICE ? ['-v', voice] : [];
  return [...pick, '-r', String(rate), '-f', input, '-o', output, '--data-format=aac'];
}

export async function synthesize(text, { voice, rate }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'walkie-code-'));
  try {
    const input = path.join(dir, 'in.txt');
    const output = path.join(dir, 'out.m4a');
    await writeFile(input, text);
    // Si la voz elegida se desinstaló, `say -v` no falla: lee con la del sistema.
    await run('say', sayArgs({ voice, rate, input, output }), { timeout: 30000 });
    const id = randomUUID();
    clips.set(id, await readFile(output));
    while (clips.size > MAX_CLIPS) clips.delete(clips.keys().next().value);
    return id;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export const getClip = (id) => clips.get(id);

// Ganancia pedida por el teléfono (?g=). Sale de ffmpeg con un limitador para que al subir no sature.
// Sin ffmpeg, o si falla, se sirve el audio original.
const boosted = new Map();

export const parseGain = (value) => {
  const g = Math.round(Number(value) * 10) / 10;
  return g >= 0.2 && g <= 3 && g !== 1 ? g : null;
};

// Para bajar alcanza con el volumen. Para subir no: las voces ya vienen casi al máximo y un limitador
// común aplana lo ganado (x3 daba apenas +7 dB). Se sube más fuerte y se limita rápido, como una radio:
// 150 % ≈ +5 dB, 200 % ≈ +7,5 dB, 300 % ≈ +10 dB.
export function gainFilter(gain) {
  if (gain <= 1) return `volume=${gain}`;
  return `volume=${Math.pow(gain, 1.6).toFixed(2)},alimiter=limit=0.95:attack=1:release=8:level=disabled`;
}

export async function getClipWithGain(id, gain) {
  const clip = clips.get(id);
  if (!clip || !gain) return clip;
  const key = `${id}:${gain}`;
  if (boosted.has(key)) return boosted.get(key);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'walkie-code-'));
  try {
    const input = path.join(dir, 'in.m4a');
    const output = path.join(dir, 'out.m4a');
    await writeFile(input, clip);
    await run('ffmpeg', ['-v', 'error', '-i', input, '-af', gainFilter(gain), '-c:a', 'aac', '-b:a', '96k', output], { timeout: 15000 });
    const out = await readFile(output);
    boosted.set(key, out);
    while (boosted.size > MAX_CLIPS * 2) boosted.delete(boosted.keys().next().value);
    return out;
  } catch {
    return clip;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
