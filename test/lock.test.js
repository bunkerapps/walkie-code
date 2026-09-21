import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Cerrojo, necesitaCara, DURACION_SESION_MS, VIDA_DESAFIO_MS } from '../lib/lock.js';

const nuevo = () => new Cerrojo(path.join(mkdtempSync(path.join(tmpdir(), 'walkie-lock-')), 'lock.json'));

test('sin credencial el candado está abierto', () => {
  assert.equal(nuevo().activo, false);
});

test('registrar y olvidar la credencial', () => {
  const c = nuevo();
  c.registrar({ credencial: 'abc', jwk: {}, signCount: 3 });
  assert.equal(c.activo, true);
  c.olvidar();
  assert.equal(c.activo, false);
});

test('una sesión abierta desbloquea y otra llave no', () => {
  const c = nuevo();
  const llave = c.abrirSesion();
  assert.equal(c.desbloqueado(llave), true);
  assert.equal(c.desbloqueado('otra'), false);
  assert.equal(c.desbloqueado(''), false);
});

test('la sesión vence', () => {
  const c = nuevo();
  const ahora = Date.now();
  const llave = c.abrirSesion(ahora);
  assert.equal(c.desbloqueado(llave, ahora + DURACION_SESION_MS - 1), true);
  assert.equal(c.desbloqueado(llave, ahora + DURACION_SESION_MS + 1), false);
});

test('las sesiones sobreviven al reinicio del servidor', () => {
  const c = nuevo();
  const llave = c.abrirSesion();
  const otra = new Cerrojo(c.file);
  assert.equal(otra.desbloqueado(llave), true);
});

test('cerrar todo echa a todos los teléfonos', () => {
  const c = nuevo();
  const llave = c.abrirSesion();
  c.cerrarTodo();
  assert.equal(c.desbloqueado(llave), false);
});

test('el desafío sirve una sola vez y vence', () => {
  const c = nuevo();
  const ahora = Date.now();
  c.nuevoDesafio('uno', ahora);
  assert.equal(c.usarDesafio('uno', ahora), true);
  assert.equal(c.usarDesafio('uno', ahora), false, 'no se puede repetir');
  c.nuevoDesafio('dos', ahora);
  assert.equal(c.usarDesafio('dos', ahora + VIDA_DESAFIO_MS + 1), false, 'vencido');
});

test('los hooks de la Mac nunca piden la cara', () => {
  assert.equal(necesitaCara({ route: 'POST /api/hook', local: true }), false);
  assert.equal(necesitaCara({ route: 'POST /api/talk', local: true }), false);
});

test('desde el teléfono, hablar pide la cara; desbloquear no', () => {
  assert.equal(necesitaCara({ route: 'POST /api/talk', local: false }), true);
  assert.equal(necesitaCara({ route: 'GET /api/channels', local: false }), true);
  assert.equal(necesitaCara({ route: 'POST /api/lock/entrar', local: false }), false);
  assert.equal(necesitaCara({ route: 'GET /app.js', local: false }), false);
});

test('cambiar el token no es algo que cualquiera pueda tocar', () => {
  // Desde la Mac siempre; desde el teléfono, la ruta existe pero el servidor exige candado puesto.
  assert.equal(necesitaCara({ route: 'POST /api/token/rotar', local: true }), false);
  assert.equal(necesitaCara({ route: 'POST /api/token/rotar', local: false }), true);
});
