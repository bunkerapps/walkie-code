import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { withLiveReload, resolveRequest, LIVE_SCRIPT } from '../lib/cast.js';

test('agrega el script de recarga antes de cerrar el body', () => {
  const out = withLiveReload('<html><body><h1>Hola</h1></body></html>');
  assert.ok(out.includes(LIVE_SCRIPT));
  assert.ok(out.indexOf(LIVE_SCRIPT) < out.indexOf('</body>'));
});

test('si no hay body, lo agrega al final', () => {
  assert.ok(withLiveReload('<h1>Hola</h1>').endsWith(LIVE_SCRIPT));
});

test('no deja salir de la carpeta publicada', () => {
  const root = path.resolve('/tmp/sitio');
  assert.equal(resolveRequest(root, '/'), path.join(root, 'index.html'));
  assert.equal(resolveRequest(root, '/css/estilo.css'), path.join(root, 'css/estilo.css'));
  assert.equal(resolveRequest(root, '/index.html?v=2'), path.join(root, 'index.html'));
  assert.equal(resolveRequest(root, '/../secreto.txt'), null);
  assert.equal(resolveRequest(root, '/%2e%2e/%2e%2e/etc/passwd'), null);
});
