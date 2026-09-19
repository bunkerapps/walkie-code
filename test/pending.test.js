import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PendingStore } from '../lib/pending.js';

const tmpFile = () => path.join(mkdtempSync(path.join(os.tmpdir(), 'pending-')), 'pending.json');

test('lo pendiente sobrevive a un reinicio', () => {
  const file = tmpFile();
  const before = new PendingStore(file);
  before.set('/dev/ttys001', { project: 'demo', clientId: 'abc', permission: false, sent: { text: 'hola', at: 1 } });
  before.get('/dev/ttys001').sent = null;
  before.save();

  const after = new PendingStore(file);
  assert.equal(after.get('/dev/ttys001').clientId, 'abc');
  assert.equal(after.get('/dev/ttys001').sent, null);
});

test('lo que se borra no vuelve', () => {
  const file = tmpFile();
  const store = new PendingStore(file);
  store.set('/dev/ttys002', { project: 'demo' });
  store.delete('/dev/ttys002');
  assert.equal(new PendingStore(file).size, 0);
});

test('se descartan las esperas viejas y los archivos rotos', () => {
  const file = tmpFile();
  const now = Date.now();
  writeFileSync(file, JSON.stringify({ viejo: { since: now - 7 * 3600e3 }, nuevo: { since: now - 60e3 } }));
  assert.deepEqual([...new PendingStore(file, now).keys()], ['nuevo']);
  writeFileSync(file, '{roto');
  assert.equal(new PendingStore(file).size, 0);
});
