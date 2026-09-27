import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { withLiveReload, resolveRequest, LIVE_SCRIPT, ordenTeclado, ordenNavegar, TEXTO_TELE_MAX, parseEscuchando, paginas, newestPage } from '../lib/cast.js';

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

test('atrás y adelante: solo esas dos acciones, y la página las traduce al historial', () => {
  assert.deepEqual(ordenNavegar({ tipo: 'navegar', accion: 'atras', extra: 1 }), { tipo: 'navegar', accion: 'atras' });
  assert.deepEqual(ordenNavegar({ tipo: 'navegar', accion: 'adelante' }), { tipo: 'navegar', accion: 'adelante' });
  assert.equal(ordenNavegar({ tipo: 'navegar', accion: 'recargar' }), null);
  assert.equal(ordenNavegar({ tipo: 'scroll', accion: 'atras' }), null);
  assert.equal(ordenNavegar(), null);
  assert.match(LIVE_SCRIPT, /history\.back\(\)/);
  assert.match(LIVE_SCRIPT, /history\.forward\(\)/);
});

test('modo video: atrás y adelante eligen la entrada del historial sin salirse', async () => {
  const { entradaDeHistorial } = await import('../lib/stream.js');
  assert.equal(entradaDeHistorial(2, 4, 'atras'), 1);
  assert.equal(entradaDeHistorial(2, 4, 'adelante'), 3);
  assert.equal(entradaDeHistorial(0, 4, 'atras'), -1);
  assert.equal(entradaDeHistorial(3, 4, 'adelante'), -1);
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

test('scroll con dos dedos: la distancia llega tal cual, las teclas siguen mandando su acción', async () => {
  const { rueda, ruedaDeScroll } = await import('../lib/stream.js');
  assert.deepEqual(rueda({ dx: -3, dy: 40 }), { deltaX: -3, deltaY: 40 });
  assert.deepEqual(rueda({ accion: 'down', dy: 40 }), { deltaX: 0, deltaY: ruedaDeScroll('down') });
  assert.deepEqual(rueda({}), { deltaX: 0, deltaY: 0 });
  assert.match(LIVE_SCRIPT, /caja\.scrollBy\(c\.dx/, 'en espejo se scrollea la caja bajo el puntero');
});

test('en modo video solo se inyecta la recarga, no un segundo puntero', () => {
  const html = '<html><body>hola</body></html>';
  const conControl = withLiveReload(html);
  const soloRecarga = withLiveReload(html, { soloRecarga: true });
  assert.match(conControl, /data-walkie-cursor/, 'el modo directo dibuja el puntero');
  assert.doesNotMatch(soloRecarga, /data-walkie-cursor/, 'el modo video no dibuja ninguno');
  assert.match(soloRecarga, /__walkie-live/, 'pero sigue recargando sola');
});

test('lee los servidores que escuchan, un renglón por puerto y sin repetir', () => {
  const salida = ['p501', 'cnode', 'f22', 'n*:3333', 'f23', 'n[::1]:3333', 'p777', 'cruby', 'f9', 'n127.0.0.1:5173', ''].join('\n');
  assert.deepEqual(parseEscuchando(salida), [
    { pid: 501, comando: 'node', puerto: 3333 },
    { pid: 777, comando: 'ruby', puerto: 5173 },
  ]);
  assert.deepEqual(parseEscuchando(''), []);
});

test('lista las páginas de la más nueva a la más vieja, sin node_modules', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tele-'));
  await mkdir(path.join(dir, 'docs'));
  await mkdir(path.join(dir, 'node_modules'));
  const vieja = path.join(dir, 'index.html');
  const nueva = path.join(dir, 'docs', 'informe.html');
  await writeFile(vieja, '<h1>vieja</h1>');
  await writeFile(nueva, '<h1>nueva</h1>');
  await writeFile(path.join(dir, 'node_modules', 'x.html'), '');
  await utimes(vieja, new Date(1000), new Date(1000));
  const lista = await paginas(dir);
  assert.deepEqual(lista.map((p) => p.file), [nueva, vieja]);
  assert.equal(await newestPage(dir), nueva);
});
