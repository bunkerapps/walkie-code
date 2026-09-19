import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGain, gainFilter } from '../lib/tts.js';

test('parseGain acepta ganancias entre 20 y 300 %, redondeadas a décimas', () => {
  assert.equal(parseGain('1.5'), 1.5);
  assert.equal(parseGain('0.2'), 0.2);
  assert.equal(parseGain('3'), 3);
  assert.equal(parseGain('1.44'), 1.4);
});

test('parseGain descarta el 100 % y lo inválido', () => {
  for (const value of [null, '', '1', 'abc', '0', '0.1', '3.5', '-2', 'Infinity']) {
    assert.equal(parseGain(value), null, String(value));
  }
});

test('para bajar usa solo volumen; para subir, más ganancia con limitador rápido', () => {
  assert.equal(gainFilter(0.5), 'volume=0.5');
  assert.match(gainFilter(2), /^volume=3\.03,alimiter=limit=0\.95:attack=1:release=8/);
  assert.match(gainFilter(3), /^volume=5\.80,/);
});
