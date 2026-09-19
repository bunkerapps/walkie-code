import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGain } from '../lib/tts.js';

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
