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
