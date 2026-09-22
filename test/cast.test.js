import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { withLiveReload, resolveRequest, LIVE_SCRIPT, ordenTeclado, TEXTO_TELE_MAX } from '../lib/cast.js';

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

test('la carpeta proyectada no sirve archivos con secretos', () => {
  const root = '/tmp/proyecto';
  assert.ok(resolveRequest(root, '/index.html'));
  assert.ok(resolveRequest(root, '/img/foto.jpg'));
  for (const ruta of ['/.env', '/.git/config', '/node_modules/x/i.js', '/clave.pem', '/app.sqlite', '/sub/.env']) {
    assert.equal(resolveRequest(root, ruta), null, ruta);
  }
});

test('el script de la tele es JavaScript válido', () => {
  const codigo = LIVE_SCRIPT.replace(/^<script>/, '').replace(/<\/script>$/, '');
  assert.doesNotThrow(() => new Function(codigo));
});

test('el teclado solo deja pasar texto corto y teclas conocidas', () => {
  assert.deepEqual(ordenTeclado({ tipo: 'texto', texto: 'hola' }), { tipo: 'texto', texto: 'hola' });
  assert.deepEqual(ordenTeclado({ tipo: 'tecla', tecla: 'Enter', extra: 1 }), { tipo: 'tecla', tecla: 'Enter' });
  assert.equal(ordenTeclado({ tipo: 'texto', texto: '' }), null);
  assert.equal(ordenTeclado({ tipo: 'texto', texto: 'x'.repeat(TEXTO_TELE_MAX + 1) }), null);
  assert.equal(ordenTeclado({ tipo: 'texto', texto: 42 }), null);
  assert.equal(ordenTeclado({ tipo: 'tecla', tecla: 'F5' }), null);
  assert.equal(ordenTeclado({ tipo: 'mover', dx: 3 }), null);
  assert.equal(ordenTeclado(), null);
});

test('los scripts del modo video son JavaScript válido', async () => {
  const { VISOR, EN_LA_PAGINA } = await import('../lib/stream.js');
  const visor = VISOR.slice(VISOR.indexOf('<script>') + 8, VISOR.lastIndexOf('</script>'));
  assert.doesNotThrow(() => new Function(visor));
  assert.doesNotThrow(() => new Function(EN_LA_PAGINA));
});

test('modo video: teclas, puntero y scroll se traducen a eventos de Chrome', async () => {
  const { eventosDeTecla, moverPuntero, ruedaDeScroll, ANCHO, ALTO } = await import('../lib/stream.js');
  const enter = eventosDeTecla('Enter');
  assert.deepEqual(enter.map((e) => e.type), ['keyDown', 'keyUp']);
  assert.equal(enter[0].text, '\r');
  assert.equal(enter[0].windowsVirtualKeyCode, 13);
  const atras = eventosDeTecla('ShiftTab');
  assert.equal(atras[0].key, 'Tab');
  assert.equal(atras[0].modifiers, 8);
  assert.equal(eventosDeTecla('Backspace')[0].type, 'rawKeyDown');
  assert.deepEqual(eventosDeTecla('F5'), []);
  assert.deepEqual(moverPuntero({ x: 10, y: 10 }, -500, 20), { x: 2, y: 30 });
  assert.deepEqual(moverPuntero({ x: ANCHO - 5, y: ALTO - 5 }, 50, 50), { x: ANCHO - 2, y: ALTO - 2 });
  assert.ok(ruedaDeScroll('down') > 0 && ruedaDeScroll('up') < 0);
  assert.ok(ruedaDeScroll('bottom') > ruedaDeScroll('down'));
});
