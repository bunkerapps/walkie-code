import { readdir, stat, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const SKIP = new Set(['node_modules', 'dist', 'build', 'vendor', 'target']);

// Resuelve una ruta relativa que manda el teléfono y verifica que no se salga de la raíz,
// ni con "..", ni con enlaces simbólicos.
export async function safeDir(root, rel = '') {
  const rootReal = await realpath(root);
  let full;
  try {
    full = await realpath(path.resolve(rootReal, rel));
  } catch {
    throw Object.assign(new Error('Esa carpeta no existe.'), { status: 404 });
  }
  if (full !== rootReal && !full.startsWith(rootReal + path.sep)) {
    throw Object.assign(new Error('Carpeta fuera de la raíz permitida.'), { status: 400 });
  }
  if (!(await stat(full)).isDirectory()) throw Object.assign(new Error('No es una carpeta.'), { status: 400 });
  return { rootReal, full, rel: path.relative(rootReal, full) };
}

// Subcarpetas de `rel`, las modificadas más recientemente primero.
// `activeDirs` son las carpetas donde ya corre Claude Code.
export async function listFolders(root, rel, activeDirs = new Set(), names = {}, lab = '') {
  const { rootReal, full, rel: cleanRel } = await safeDir(root, rel);
  const entries = await readdir(full, { withFileTypes: true });
  const folders = await Promise.all(
    entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name))
      .map(async (e) => {
        const dir = path.join(full, e.name);
        const { mtimeMs } = await stat(dir).catch(() => ({ mtimeMs: 0 }));
        return {
          name: e.name,
          rel: path.relative(rootReal, dir),
          git: existsSync(path.join(dir, '.git')),
          active: activeDirs.has(dir),
          alias: names[dir] || null,
          // Lo del laboratorio es descartable: se puede borrar (a la Papelera) o ascender.
          lab: Boolean(lab) && path.basename(path.dirname(dir)) === lab,
          mtimeMs,
        };
      }),
  );
  folders.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return {
    lab: Boolean(lab) && path.basename(path.dirname(full)) === lab,
    rel: cleanRel,
    name: cleanRel ? path.basename(full) : path.basename(rootReal),
    parent: cleanRel ? path.dirname(cleanRel).replace(/^\.$/, '') : null,
    active: activeDirs.has(full),
    folders: folders.map(({ mtimeMs, ...f }) => f),
  };
}
