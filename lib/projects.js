// Crear un proyecto nuevo desde el teléfono: la carpeta, una página inicial y su canal de Claude Code.
//
// Los proyectos nacen en la carpeta "laboratorio": ahí todo es descartable y se puede borrar (a la
// Papelera). Si uno vale la pena, se asciende y pasa a ser un proyecto de verdad, fuera del laboratorio.

import path from 'node:path';

export function slugify(name) {
  return String(name)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

// Página inicial: sirve para que el modo tele tenga algo que mostrar desde el minuto cero.
export const starterPage = (name) => `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name}</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #14160f; color: #e6e9dc;
         font-family: -apple-system, Helvetica, Arial, sans-serif; text-align: center; padding: 6vh 6vw; }
  h1 { font-size: clamp(2rem, 6vw, 4rem); margin: 0 0 0.4em; }
  .marca { color: #ff5b1a; }
  p { font-size: clamp(1rem, 2.2vw, 1.4rem); opacity: 0.85; margin: 0.4em 0; }
</style>
</head>
<body>
  <main>
    <h1>${name}</h1>
    <p>Proyecto nuevo, listo para empezar.</p>
    <p class="marca">Creado por voz desde Walkie-Code</p>
  </main>
</body>
</html>
`;

// ¿Esta carpeta está dentro del laboratorio? Solo ahí el walkie puede borrar o ascender.
export function inLab(root, lab, dir) {
  const labRoot = path.join(path.resolve(root), lab);
  const full = path.resolve(dir);
  return full !== labRoot && full.startsWith(labRoot + path.sep);
}

// Un proyecto del laboratorio es una carpeta directa: laboratorio/<proyecto>.
export const isLabProject = (root, lab, dir) =>
  inLab(root, lab, dir) && path.dirname(path.resolve(dir)) === path.join(path.resolve(root), lab);
