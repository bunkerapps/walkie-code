import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listFolders, safeDir } from '../lib/folders.js';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'walkie-code-test-'));
  await mkdir(path.join(root, 'proyecto-a', '.git'), { recursive: true });
  await mkdir(path.join(root, 'proyecto-b', 'web'), { recursive: true });
  await mkdir(path.join(root, '.oculta'));
  await mkdir(path.join(root, 'node_modules'));
  await symlink(os.tmpdir(), path.join(root, 'afuera'));
  return root;
}

test('lista subcarpetas visibles (sin ocultas, dependencias ni enlaces) y marca git y sesiones activas', async () => {
  const root = await fixture();
  const activeDirs = new Set([path.join(await safeDir(root).then((d) => d.rootReal), 'proyecto-b')]);
  const { folders, parent } = await listFolders(root, '', activeDirs);
  const byName = Object.fromEntries(folders.map((f) => [f.name, f]));
  assert.equal(parent, null);
  assert.deepEqual(Object.keys(byName).sort(), ['proyecto-a', 'proyecto-b']);
  assert.equal(byName['proyecto-a'].git, true);
  assert.equal(byName['proyecto-b'].active, true);
  await rm(root, { recursive: true });
});

test('navega a subcarpetas y sabe volver', async () => {
  const root = await fixture();
  const listing = await listFolders(root, 'proyecto-b');
  assert.equal(listing.name, 'proyecto-b');
  assert.equal(listing.parent, '');
  assert.deepEqual(listing.folders.map((f) => f.rel), [path.join('proyecto-b', 'web')]);
  await rm(root, { recursive: true });
});

test('no deja salir de la raíz, ni con .. ni con enlaces simbólicos', async () => {
  const root = await fixture();
  for (const rel of ['..', '../..', '/etc', 'proyecto-a/../../', 'afuera']) {
    await assert.rejects(safeDir(root, rel), /fuera de la raíz/, rel);
  }
  await rm(root, { recursive: true });
});
