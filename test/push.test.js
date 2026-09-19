import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openPushStore, isValidSubscription, createPresence, pushTargets, pushMessage, shorten, PRESENCE_TTL_MS } from '../lib/push.js';

const sub = (n) => ({ endpoint: `https://web.push.apple.com/${n}`, keys: { p256dh: `p${n}`, auth: `a${n}` } });
const tmpFile = () => path.join(mkdtempSync(path.join(os.tmpdir(), 'supervoz-push-')), 'push.json');

test('genera las claves VAPID una sola vez y las guarda privadas', () => {
  const file = tmpFile();
  const first = openPushStore(file);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(openPushStore(file).vapid, first.vapid);
});

test('guarda, reemplaza y borra suscripciones en disco', () => {
  const file = tmpFile();
  const store = openPushStore(file);
  store.save(sub(1), 'cliente-a', 'iPhone');
  store.save(sub(2), 'cliente-b', 'iPad');
  // El mismo teléfono con un endpoint nuevo reemplaza al anterior.
  store.save(sub(3), 'cliente-a', 'iPhone');
  const saved = openPushStore(file).list().map((s) => [s.endpoint.split('/').pop(), s.clientId]);
  assert.deepEqual(saved, [['2', 'cliente-b'], ['3', 'cliente-a']]);
  store.remove(sub(2).endpoint);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).subscriptions.map((s) => s.clientId), ['cliente-a']);
});

test('rechaza suscripciones sin HTTPS o sin claves', () => {
  assert.equal(isValidSubscription(sub(1)), true);
  assert.equal(isValidSubscription({ ...sub(1), endpoint: 'http://127.0.0.1:8787/api/hook' }), false);
  assert.equal(isValidSubscription({ endpoint: 'https://x.y/z' }), false);
  assert.equal(isValidSubscription(null), false);
  assert.throws(() => openPushStore(tmpFile()).save({ endpoint: 'file:///etc/passwd' }, 'c'), /inválida/);
});

test('la presencia vence sola si el teléfono no avisó que se ocultó', () => {
  let now = 0;
  const presence = createPresence(() => now);
  presence.touch('a');
  assert.equal(presence.isVisible('a'), true);
  assert.equal(presence.isVisible('b'), false);
  now = PRESENCE_TTL_MS + 1;
  assert.equal(presence.isVisible('a'), false);
  presence.touch('a');
  presence.touch('a', false);
  assert.equal(presence.isVisible('a'), false);
  assert.equal(presence.isVisible(null), false);
});

test('avisa solo al que habló, y solo si no tiene la app a la vista', () => {
  const subs = [{ ...sub(1), clientId: 'a' }, { ...sub(2), clientId: 'b' }];
  const visible = new Set();
  const targets = (to) => pushTargets(subs, to, (id) => visible.has(id)).map((s) => s.clientId);
  assert.deepEqual(targets('a'), ['a']);
  assert.deepEqual(targets(null), ['a', 'b'], 'si no se sabe quién habló, a todos');
  visible.add('a');
  assert.deepEqual(targets('a'), []);
  assert.deepEqual(targets(null), ['b']);
});

test('texto del aviso: respuesta en texto plano y recortada', () => {
  const long = `## Listo\n\nArreglé el **bug** en \`src/lib/precios.js\` y corrí los tests.\n\n\`\`\`js\nconst x = 1;\n\`\`\`\n${'Además revisé todo el flujo de carga. '.repeat(5)}`;
  const msg = pushMessage({ kind: 'reply', text: long, project: 'superprecio' });
  assert.equal(msg.title, 'CLAUDE · superprecio');
  assert.ok(msg.body.startsWith('Listo. Arreglé el bug en precios.js y corrí los tests.'), msg.body);
  assert.ok(msg.body.length <= 140);
  assert.ok(msg.body.endsWith('…'));
  assert.equal(msg.tag, 'supervoz-superprecio');
  assert.equal(pushMessage({ kind: 'reply', text: '', project: 'x' }).body, 'Listo.');
});

test('texto del aviso: pedido de permiso', () => {
  assert.equal(pushMessage({ kind: 'permission', tool: 'Bash', project: 'superprecio' }).body, 'Claude necesita permiso para usar Bash');
  assert.equal(pushMessage({ kind: 'permission', project: 'x' }).body, 'Claude necesita permiso para seguir');
});

test('recorta en un límite de palabra', () => {
  assert.equal(shorten('hola   mundo'), 'hola mundo');
  assert.equal(shorten('uno dos tres cuatro cinco', 16), 'uno dos tres…');
  // Si el último espacio queda muy atrás, se corta la palabra: mejor que un aviso casi vacío.
  assert.equal(shorten('uno dos tres cuatro', 12), 'uno dos tre…');
  assert.equal(shorten('x'.repeat(20), 10), `${'x'.repeat(9)}…`);
});
