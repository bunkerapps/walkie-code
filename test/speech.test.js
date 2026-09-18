import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toSpeech, cleanTranscript, permissionAnswer } from '../lib/speech.js';

test('anuncia los bloques de código en vez de leerlos', () => {
  const out = toSpeech('Listo, agregué esto:\n\n```js\nconst a = 1;\nconst b = 2;\n```\n\nProbalo.');
  assert.equal(out, 'Listo, agregué esto: Hay un bloque de código de 2 líneas. Probalo.');
});

test('resume tablas por cantidad de filas', () => {
  const out = toSpeech('Resultados:\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n');
  assert.equal(out, 'Resultados: Hay una tabla de 2 filas.');
});

test('acorta rutas y saca markdown', () => {
  const out = toSpeech('## Cambios\n\n- Edité **`/Users/diego/Development/supervoz/lib/speech.js`**\n- Ver [docs](https://example.com)');
  assert.equal(out, 'Cambios. Edité speech.js. Ver docs.');
});

test('las URLs sueltas se nombran como enlace', () => {
  assert.equal(toSpeech('Abrí https://claude.ai/code ahora'), 'Abrí un enlace ahora.');
});

test('corta respuestas largas en una frase', () => {
  const out = toSpeech('Esta es una frase de prueba. '.repeat(100));
  assert.ok(out.length < 1500);
  assert.ok(out.endsWith('La respuesta sigue en la terminal.'));
});

test('descarta alucinaciones de Whisper sobre silencio', () => {
  assert.equal(cleanTranscript(' Subtítulos realizados por la comunidad de Amara.org '), '');
  assert.equal(cleanTranscript('Gracias.'), '');
  assert.equal(cleanTranscript('  corré los   tests '), 'corré los tests');
});

test('reconoce respuestas cortas a un permiso', () => {
  assert.equal(permissionAnswer('Sí.'), 'yes');
  assert.equal(permissionAnswer('dale'), 'yes');
  assert.equal(permissionAnswer('No.'), 'no');
  assert.equal(permissionAnswer('sí, pero antes corré los tests'), null);
});
