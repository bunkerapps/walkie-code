import test from 'node:test';
import assert from 'node:assert/strict';
import { elegirOpcion, pideConfianza } from '../lib/trust.js';

// La pantalla tal cual la muestra Claude Code al entrar por primera vez en una carpeta.
const PANTALLA = `
 Accessing workspace:
 /Users/diegopacheco/Development/portfolio
 Quick safety check: Is this a project you created or one you trust?
 Claude Code'll be able to read, edit, and execute files here.
 Security guide
 ❯ No, exit
   Yes, I trust this folder
 Enter to confirm · Esc to cancel
`;

test('reconoce la pregunta de confianza', () => {
  assert.equal(pideConfianza(PANTALLA), true);
  assert.equal(pideConfianza('Bash(ls) ¿Permitir?'), false);
});

test('para confiar baja una opción: el menú arranca en "No, exit"', () => {
  assert.deepEqual(elegirOpcion(PANTALLA, 'allow'), { dir: 'down', veces: 1 });
});

test('para no abrir no hace falta moverse', () => {
  assert.deepEqual(elegirOpcion(PANTALLA, 'deny'), { dir: null, veces: 0 });
});

test('si el orden de las opciones cambia, se mueve al revés', () => {
  const alReves = PANTALLA.replace(' ❯ No, exit\n   Yes, I trust this folder', '   No, exit\n ❯ Yes, I trust this folder');
  assert.deepEqual(elegirOpcion(alReves, 'allow'), { dir: null, veces: 0 });
  assert.deepEqual(elegirOpcion(alReves, 'deny'), { dir: 'up', veces: 1 });
});

test('sin menú a la vista no manda flechas', () => {
  assert.deepEqual(elegirOpcion('otra cosa', 'allow'), { dir: null, veces: 0 });
});
