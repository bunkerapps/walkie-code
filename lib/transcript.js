import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// Lo último que pasó en una sesión de Claude Code, leído de su transcripción (JSONL),
// aunque se haya escrito desde la Mac y no desde el teléfono.

const TAIL_BYTES = 768 * 1024;

// Solo el final del archivo: una transcripción larga pesa varios MB.
export async function readTail(file, bytes = TAIL_BYTES) {
  const fh = await open(file, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - bytes);
    const { buffer, bytesRead } = await fh.read(Buffer.alloc(size - start), 0, size - start, start);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    // Si se cortó a la mitad de una línea, esa primera línea no sirve.
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    await fh.close();
  }
}

// Texto de una entrada; null si no es texto escrito por alguien (resultados de herramientas, etc.).
function entryText(entry) {
  const content = entry.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content) || content.some((p) => p.type === 'tool_result')) return null;
  const text = content.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
  return text || null;
}

// Un prompt de verdad: ni mensajes internos ni comandos como "<command-name>…".
const isRealPrompt = (entry, text) => !entry.isMeta && text && !text.trimStart().startsWith('<');

// El último prompt del usuario y la última respuesta en texto de Claude.
// `working` = Claude todavía no respondió a ese prompt.
export function recapFrom(jsonl) {
  let prompt = null;
  let reply = null;
  const lines = jsonl.trim().split('\n');
  for (let i = lines.length - 1; i >= 0 && !(prompt && reply); i--) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const text = entryText(entry);
    if (!text) continue;
    if (entry.type === 'assistant' && !reply && !prompt) reply = { text, at: entry.timestamp || null };
    if (entry.type === 'user' && !prompt && isRealPrompt(entry, text)) prompt = { text, at: entry.timestamp || null };
  }
  return { prompt, reply, working: Boolean(prompt && !reply) };
}

// Carpeta donde Claude Code guarda las transcripciones de un proyecto:
// la ruta con todo lo que no es letra o número cambiado por "-".
export const projectDir = (cwd, home = os.homedir()) =>
  path.join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));

// Solo se leen transcripciones de Claude Code: un .jsonl dentro de ~/.claude/projects.
// Así el hook (o quien tenga el token) no puede hacerle leer al servidor cualquier archivo.
export function isTranscriptPath(file, home = os.homedir()) {
  if (typeof file !== 'string' || !file.endsWith('.jsonl')) return false;
  const resolved = path.resolve(file);
  return resolved === path.normalize(file) && resolved.startsWith(path.join(home, '.claude', 'projects') + path.sep);
}

// Si ningún hook dijo todavía cuál es la transcripción de esa terminal, la más reciente del proyecto.
export async function newestTranscript(cwd) {
  const dir = projectDir(cwd);
  try {
    const files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'));
    const withTimes = await Promise.all(files.map(async (f) => ({ f, t: (await stat(path.join(dir, f))).mtimeMs })));
    withTimes.sort((a, b) => b.t - a.t);
    return withTimes[0] ? path.join(dir, withTimes[0].f) : null;
  } catch {
    return null;
  }
}

export async function recapOf(file) {
  const jsonl = await readTail(file);
  return { ...recapFrom(jsonl), cwd: cwdFrom(jsonl) };
}

// En qué carpeta corre la sesión de esa transcripción. Sirve para no mostrar en un canal la charla de
// otro: varios Claude Code abiertos en la misma carpeta comparten el directorio de transcripciones, y
// los ttys se reciclan entre sesiones.
export function cwdFrom(jsonl) {
  const lines = String(jsonl).trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const { cwd } = JSON.parse(lines[i]);
      if (cwd) return cwd;
    } catch {}
  }
  return null;
}
