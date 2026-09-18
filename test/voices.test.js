import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVoices } from '../lib/voices.js';

const SAY_OUTPUT = `Albert              en_US    # Hello! My name is Albert.
Eddy (Español (España)) es_ES    # ¡Hola! Me llamo Eddy.
Mónica              es_ES    # ¡Hola! Me llamo Mónica.
Paulina (Mejorada)  es_MX    # ¡Hola! Me llamo Paulina.
línea que no es una voz`;

test('filtra por idioma y separa nombre, región y etiqueta', () => {
  const voices = parseVoices(SAY_OUTPUT, 'es');
  assert.deepEqual(voices, [
    { name: 'Eddy (Español (España))', locale: 'es_ES', region: 'ES', label: 'Eddy' },
    { name: 'Mónica', locale: 'es_ES', region: 'ES', label: 'Mónica' },
    { name: 'Paulina (Mejorada)', locale: 'es_MX', region: 'MX', label: 'Paulina (Mejorada)' },
  ]);
});
