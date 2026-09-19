import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideNotice, noticeSpeech, durationLabel, projectFromCwd, clampSeconds } from '../lib/notices.js';

const now = 1_000_000_000;
const base = { event: 'Stop', pending: false, now, enabled: true, afterSeconds: 60 };
const ago = (seconds) => now - seconds * 1000;

test('avisa cuando un turno largo termina en un canal al que no se le habló', () => {
  assert.deepEqual(decideNotice({ ...base, startedAt: ago(125) }), { kind: 'done', seconds: 125 });
});

test('no avisa las respuestas cortas', () => {
  assert.equal(decideNotice({ ...base, startedAt: ago(59) }), null);
  assert.deepEqual(decideNotice({ ...base, startedAt: ago(60) }), { kind: 'done', seconds: 60 });
});

test('no avisa si no se sabe cuándo empezó el turno', () => {
  assert.equal(decideNotice({ ...base, startedAt: null }), null);
});

test('los canales a los que se les habló desde el teléfono no son avisos', () => {
  assert.equal(decideNotice({ ...base, pending: true, startedAt: ago(600) }), null);
  assert.equal(decideNotice({ ...base, event: 'PermissionRequest', kind: 'permission', pending: true }), null);
});

test('los permisos se avisan siempre, aunque el turno recién empiece', () => {
  assert.deepEqual(decideNotice({ ...base, event: 'PermissionRequest', kind: 'permission', startedAt: ago(3) }), { kind: 'permission', seconds: 3 });
  assert.deepEqual(decideNotice({ ...base, event: 'PermissionRequest', kind: 'permission', startedAt: null }), { kind: 'permission', seconds: null });
});

test('apagados no avisan nada', () => {
  assert.equal(decideNotice({ ...base, enabled: false, startedAt: ago(600) }), null);
  assert.equal(decideNotice({ ...base, enabled: false, event: 'PermissionRequest', kind: 'permission' }), null);
});

test('otras notificaciones no avisan', () => {
  assert.equal(decideNotice({ ...base, event: 'Notification', kind: 'idle_prompt', startedAt: ago(600) }), null);
});

test('el umbral se respeta y se acota', () => {
  assert.equal(decideNotice({ ...base, afterSeconds: 300, startedAt: ago(200) }), null);
  assert.equal(clampSeconds(1), 10);
  assert.equal(clampSeconds(99999), 3600);
  assert.equal(clampSeconds('abc', 60), 60);
  assert.equal(clampSeconds('120'), 120);
});

test('la voz del aviso es corta', () => {
  assert.equal(noticeSpeech('superprecio', { kind: 'done' }), 'Terminó superprecio.');
  assert.equal(noticeSpeech('superprecio', { kind: 'permission' }, 'Bash'), 'superprecio necesita permiso para usar Bash.');
  assert.equal(noticeSpeech('superprecio', { kind: 'permission' }), 'superprecio necesita permiso para seguir.');
});

test('duración legible para la pantalla', () => {
  assert.equal(durationLabel(null), '');
  assert.equal(durationLabel(45), '45 S');
  assert.equal(durationLabel(240), '4 MIN');
  assert.equal(durationLabel(4800), '1 H 20 MIN');
  assert.equal(durationLabel(3600), '1 H');
});

test('nombre del proyecto por carpeta, con nombre propio si lo tiene', () => {
  assert.equal(projectFromCwd('/Users/d/Development/superprecio'), 'superprecio');
  assert.equal(projectFromCwd('/Users/d/Development/sp', { '/Users/d/Development/sp': 'Súper' }), 'Súper');
  assert.equal(projectFromCwd(''), 'Claude');
});
