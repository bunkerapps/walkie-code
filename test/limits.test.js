import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resetTime, limitMessage, failureSpeech } from '../lib/limits.js';

test('saca la hora de renovación en formato de 24 horas', () => {
  assert.equal(resetTime("You've hit your session limit · resets 11:10pm (America/Cordoba)"), '23:10');
  assert.equal(resetTime('resets 12am'), '00:00');
  assert.equal(resetTime('resets at 9:05am'), '09:05');
  assert.equal(resetTime('resets 18:30'), '18:30');
  assert.equal(resetTime('sin hora'), null);
});

test('encuentra el mensaje de límite al final de la transcripción', () => {
  const jsonl = [
    JSON.stringify({ type: 'user', message: { content: 'corré los tests' } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: "You've hit your session limit · resets 11:10pm (America/Cordoba)" }] } }),
  ].join('\n');
  assert.equal(resetTime(limitMessage(jsonl)), '23:10');
  assert.equal(limitMessage('{"type":"user"}'), null);
});

test('arma lo que se dice según el error', () => {
  assert.equal(failureSpeech('rate_limit', 'superprecio', '23:10'),
    'Claude llegó al límite de uso y se renueva a las 23:10. Lo de superprecio quedó sin terminar.');
  assert.equal(failureSpeech('rate_limit', 'superprecio', null),
    'Claude llegó al límite de uso. Lo de superprecio quedó sin terminar.');
  assert.equal(failureSpeech('overloaded', 'vecinos'), 'Claude se cortó en vecinos: los servidores de Claude están sobrecargados.');
  assert.equal(failureSpeech('algo_nuevo', 'vecinos'), 'Claude se cortó en vecinos: hubo un error de la API.');
});
