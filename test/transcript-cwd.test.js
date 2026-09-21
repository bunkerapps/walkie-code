import test from 'node:test';
import assert from 'node:assert/strict';
import { cwdFrom } from '../lib/transcript.js';

const linea = (o) => JSON.stringify(o);

test('saca la carpeta de la última entrada que la tenga', () => {
  const jsonl = [
    linea({ type: 'user', cwd: '/Users/d/Development/viejo', message: { content: 'hola' } }),
    linea({ type: 'assistant', cwd: '/Users/d/Development/walkie-code', message: { content: 'chau' } }),
  ].join('\n');
  assert.equal(cwdFrom(jsonl), '/Users/d/Development/walkie-code');
});

test('aguanta líneas cortadas o sin carpeta', () => {
  const jsonl = ['{"type":"user"', linea({ type: 'user', cwd: '/Users/d/Development' }), '{"rot'].join('\n');
  assert.equal(cwdFrom(jsonl), '/Users/d/Development');
});

test('sin carpeta a la vista devuelve null', () => {
  assert.equal(cwdFrom('{"type":"user"}'), null);
  assert.equal(cwdFrom(''), null);
});
