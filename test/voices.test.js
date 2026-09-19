import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVoices, sortVoices, voiceQuality, SYSTEM_VOICE, VOICE_SETTINGS_URL } from '../lib/voices.js';
import { sayArgs } from '../lib/tts.js';

const SAY_OUTPUT = `Albert              en_US    # Hello! My name is Albert.
Eddy (Español (España)) es_ES    # ¡Hola! Me llamo Eddy.
Mónica              es_ES    # ¡Hola! Me llamo Mónica.
Paulina (Mejorada)  es_MX    # ¡Hola! Me llamo Paulina.
línea que no es una voz`;

test('filtra por idioma y separa nombre, región, etiqueta y calidad', () => {
  const voices = parseVoices(SAY_OUTPUT, 'es');
  assert.deepEqual(voices, [
    { name: 'Eddy (Español (España))', locale: 'es_ES', region: 'ES', label: 'Eddy', quality: 'estandar' },
    { name: 'Mónica', locale: 'es_ES', region: 'ES', label: 'Mónica', quality: 'estandar' },
    { name: 'Paulina (Mejorada)', locale: 'es_MX', region: 'MX', label: 'Paulina', quality: 'mejorada' },
  ]);
});

test('reconoce la calidad en español y en inglés', () => {
  assert.equal(voiceQuality('Mónica (Premium)'), 'premium');
  assert.equal(voiceQuality('Jorge (premium)'), 'premium');
  assert.equal(voiceQuality('Paulina (Mejorada)'), 'mejorada');
  assert.equal(voiceQuality('Samantha (Enhanced)'), 'mejorada');
  assert.equal(voiceQuality('Paulina'), 'estandar');
  assert.equal(voiceQuality('Eddy (Español (México))'), 'estandar');
});

test('ordena premium, mejorada y estándar, con las Eloquence al final', () => {
  const output = `Eddy (Español (España)) es_ES    # ¡Hola!
Mónica              es_ES    # ¡Hola!
Paulina (Mejorada)  es_MX    # ¡Hola!
Flo (Español (México)) es_MX    # ¡Hola!
Paulina             es_MX    # ¡Hola!
Mónica (Premium)    es_ES    # ¡Hola!
Jorge (Mejorada)    es_ES    # ¡Hola!`;
  const names = sortVoices(parseVoices(output, 'es')).map((v) => v.name);
  assert.deepEqual(names, [
    'Mónica (Premium)',
    'Paulina (Mejorada)',
    'Jorge (Mejorada)',
    'Mónica',
    'Paulina',
    'Eddy (Español (España))',
    'Flo (Español (México))',
  ]);
});

test('ordenar no modifica la lista original', () => {
  const voices = parseVoices(SAY_OUTPUT, 'es');
  const copy = structuredClone(voices);
  sortVoices(voices);
  assert.deepEqual(voices, copy);
});

test('la voz del sistema no le pasa -v a say', () => {
  const base = { rate: 190, input: 'in.txt', output: 'out.m4a' };
  assert.deepEqual(sayArgs({ ...base, voice: 'Paulina (Mejorada)' }).slice(0, 2), ['-v', 'Paulina (Mejorada)']);
  assert.ok(!sayArgs({ ...base, voice: SYSTEM_VOICE }).includes('-v'));
  assert.ok(!sayArgs({ ...base, voice: '' }).includes('-v'));
});

test('el panel de voces se abre con una URL fija de Ajustes', () => {
  assert.match(VOICE_SETTINGS_URL, /^x-apple\.systempreferences:com\.apple\.preference\.universalaccess\?TextToSpeech$/);
});
