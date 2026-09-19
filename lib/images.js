// Fotos que manda el teléfono para que Claude Code las mire.
// Se guardan en una carpeta propia y en la terminal se escribe la ruta absoluta:
// Claude Code abre las imágenes cuando el mensaje incluye la ruta del archivo.

import { mkdir, writeFile, readdir, stat, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_IMAGE_TEXT = 'Mirá esta imagen';

// Firmas de los formatos que Claude sabe leer. Se mira el contenido, no el Content-Type.
const SIGNATURES = [
  { ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: 'gif', test: (b) => b.subarray(0, 4).toString('latin1') === 'GIF8' },
  { ext: 'webp', test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
];
const EXTS = SIGNATURES.map((s) => s.ext);

const ID_PATTERN = /^[a-f0-9]{16}$/;

const httpError = (status, message) => Object.assign(new Error(message), { status });

export function imageType(buffer) {
  if (!buffer || buffer.length < 12) return null;
  return SIGNATURES.find((s) => s.test(buffer))?.ext || null;
}

// Devuelve la extensión o tira un error con el código HTTP para el teléfono.
export function validateImage(buffer, maxBytes = MAX_IMAGE_BYTES) {
  if (!buffer?.length) throw httpError(422, 'No llegó ninguna foto.');
  if (buffer.length > maxBytes) throw httpError(413, 'La foto es demasiado grande.');
  const ext = imageType(buffer);
  if (!ext) throw httpError(415, 'Solo se aceptan fotos JPEG, PNG, GIF o WebP.');
  return ext;
}

export async function saveImage(dir, buffer) {
  const ext = validateImage(buffer);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const id = randomBytes(8).toString('hex');
  const file = path.join(dir, `supervoz-${id}.${ext}`);
  await writeFile(file, buffer, { mode: 0o600 });
  return { id, file };
}

// La ruta de una foto subida, o null si el id no es válido o ya se borró.
export function findImage(dir, id) {
  if (!ID_PATTERN.test(String(id))) return null;
  for (const ext of EXTS) {
    const file = path.join(dir, `supervoz-${id}.${ext}`);
    if (existsSync(file)) return file;
  }
  return null;
}

// Borra las fotos viejas. Solo toca archivos con el nombre que les pone saveImage.
export async function cleanupImages(dir, maxAgeMs = MAX_IMAGE_AGE_MS, now = Date.now()) {
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!/^supervoz-[a-f0-9]{16}\.\w+$/.test(name)) continue;
    const file = path.join(dir, name);
    try {
      if (now - (await stat(file)).mtimeMs > maxAgeMs) {
        await unlink(file);
        removed++;
      }
    } catch {}
  }
  return removed;
}

// Lo que se escribe en la terminal: lo dictado y la ruta al final, separada por un espacio.
// Todo en una línea, porque el Enter lo manda writeAndSubmit. Los espacios de la ruta
// se escapan como cuando se arrastra un archivo a la terminal.
export function promptWithImage(text, file) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim() || DEFAULT_IMAGE_TEXT;
  return `${clean} ${file.replace(/ /g, '\\ ')}`;
}
