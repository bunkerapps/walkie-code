import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify, inLab, isLabProject, starterPage } from '../lib/projects.js';

test('convierte el nombre hablado en un nombre de carpeta', () => {
  assert.equal(slugify('Paseos de Perros'), 'paseos-de-perros');
  assert.equal(slugify('  ¡Súper Precio 2!  '), 'super-precio-2');
  assert.equal(slugify('///'), '');
  assert.equal(slugify('x'.repeat(60)).length, 40);
});

test('solo el laboratorio es descartable', () => {
  const root = '/Users/d/Development';
  assert.equal(inLab(root, 'laboratorio', '/Users/d/Development/laboratorio/paseos'), true);
  assert.equal(inLab(root, 'laboratorio', '/Users/d/Development/laboratorio'), false);
  assert.equal(inLab(root, 'laboratorio', '/Users/d/Development/superprecio'), false);
  assert.equal(inLab(root, 'laboratorio', '/Users/d/Development/laboratorio/../superprecio'), false);
});

test('un proyecto del laboratorio es una carpeta directa', () => {
  const root = '/Users/d/Development';
  assert.equal(isLabProject(root, 'laboratorio', '/Users/d/Development/laboratorio/paseos'), true);
  assert.equal(isLabProject(root, 'laboratorio', '/Users/d/Development/laboratorio/paseos/css'), false);
});

test('la página inicial lleva el nombre del proyecto', () => {
  assert.ok(starterPage('Paseos de Perros').includes('<h1>Paseos de Perros</h1>'));
});
