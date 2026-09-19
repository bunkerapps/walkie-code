#!/usr/bin/env node
// Genera los sonidos públicos del walkie (public/sounds) desde cero, sin grabaciones de terceros.
// Para usar sonidos propios sin publicarlos, ponelos en ~/.walkie-code/sounds/ con el mismo nombre.
//   node scripts/make-sounds.js   (necesita ffmpeg)

import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'sounds');
const RATE = 44100;

// WAV mono de 16 bits a partir de una función de la muestra en el tiempo t (en segundos).
function wav(file, seconds, fn) {
  const n = Math.round(seconds * RATE);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(RATE, 24);
  buf.writeUInt32LE(RATE * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, fn(i / RATE)));
    buf.writeInt16LE(Math.round(v * 32000), 44 + i * 2);
  }
  writeFileSync(file, buf);
}

const square = (f, t) => Math.sign(Math.sin(2 * Math.PI * f * t)) * 0.6 + Math.sin(2 * Math.PI * f * t) * 0.4;
const fade = (t, total, attack = 0.004, release = 0.03) => Math.min(1, t / attack, (total - t) / release);

let seed = 7;
const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
let smooth = 0;

const SOUNDS = {
  // Al apretar el PTT: dos tonos que suben, el "chirp" de un handy al transmitir.
  ptt: [0.12, (t) => 0.5 * square(t < 0.05 ? 1150 : 1650, t) * fade(t, 0.12)],
  // Al soltar: "roger beep", dos tonos que bajan.
  release: [0.18, (t) => 0.45 * square(t < 0.07 ? 1500 : 1050, t) * fade(t, 0.18)],
  // Cuando llega una respuesta: ráfaga corta de ruido (squelch) que se apaga.
  rx: [0.22, (t) => {
    smooth = 0.55 * smooth + 0.45 * noise();
    return 0.9 * smooth * Math.exp(-9 * t) * fade(t, 0.22, 0.003, 0.05);
  }],
};

const tmp = mkdtempSync(path.join(os.tmpdir(), 'walkie-sounds-'));
try {
  for (const [name, [seconds, fn]] of Object.entries(SOUNDS)) {
    const source = path.join(tmp, `${name}.wav`);
    wav(source, seconds, fn);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', source, '-af', 'lowpass=f=5000', '-ac', '1', '-c:a', 'aac', '-b:a', '96k', path.join(OUT, `${name}.m4a`)]);
    console.log(`public/sounds/${name}.m4a`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
