import test from 'node:test';
import assert from 'node:assert/strict';
import { clasificar, frasePresencia, UMBRAL_COMPU, UMBRAL_CERCA } from '../lib/presencia.js';

test('tocando el teclado recién: está en la compu', () => {
  assert.equal(clasificar({ inactividadSeg: 5 }), 'en-la-compu');
  assert.equal(clasificar({ inactividadSeg: UMBRAL_COMPU - 1 }), 'en-la-compu');
});

test('un rato sin tocar nada: sigue cerca', () => {
  assert.equal(clasificar({ inactividadSeg: UMBRAL_COMPU }), 'cerca');
  assert.equal(clasificar({ inactividadSeg: UMBRAL_CERCA - 1 }), 'cerca');
});

test('mucho rato sin tocar nada: está lejos', () => {
  assert.equal(clasificar({ inactividadSeg: UMBRAL_CERCA }), 'remoto');
  assert.equal(clasificar({ inactividadSeg: 4 * 3600 }), 'remoto');
});

test('la pantalla bloqueada gana siempre', () => {
  assert.equal(clasificar({ inactividadSeg: 2, bloqueada: true }), 'remoto');
});

test('sin dato de inactividad no se inventa nada', () => {
  assert.equal(clasificar({ inactividadSeg: NaN }), 'desconocido');
  assert.equal(frasePresencia({ estado: 'desconocido' }), '');
});

test('cada estado le dice a Claude algo distinto sobre la pantalla', () => {
  assert.match(frasePresencia({ estado: 'en-la-compu' }), /pantalla/i);
  assert.match(frasePresencia({ estado: 'remoto', inactividadSeg: 600 }), /no va a ver/i);
  assert.match(frasePresencia({ estado: 'remoto', inactividadSeg: 600 }), /10 min/);
  assert.match(frasePresencia({ estado: 'remoto', inactividadSeg: 600, bloqueada: true }), /bloqueada/);
});

// ---------- Aviso de que alguien tocó la Mac ----------

import { despertaronLaMac, ESPERA_ENTRE_AVISOS } from '../lib/presencia.js';

test('avisa cuando tocan la Mac y el usuario estaba lejos', () => {
  const actual = { estado: 'en-la-compu', inactividadSeg: 3 };
  assert.equal(despertaronLaMac({ previo: 'remoto', actual }), true);
});

test('no avisa si el usuario ya estaba en la compu o cerca', () => {
  const actual = { estado: 'en-la-compu', inactividadSeg: 3 };
  assert.equal(despertaronLaMac({ previo: 'en-la-compu', actual }), false);
  assert.equal(despertaronLaMac({ previo: 'cerca', actual }), false);
  assert.equal(despertaronLaMac({ previo: null, actual }), false);
});

test('no avisa si nadie la tocó de verdad', () => {
  assert.equal(despertaronLaMac({ previo: 'remoto', actual: { estado: 'remoto', inactividadSeg: 3000 } }), false);
  assert.equal(despertaronLaMac({ previo: 'remoto', actual: { estado: 'cerca', inactividadSeg: 300 } }), false);
});

test('no repite el aviso antes de diez minutos', () => {
  const actual = { estado: 'en-la-compu', inactividadSeg: 3 };
  const ahora = Date.now();
  assert.equal(despertaronLaMac({ previo: 'remoto', actual, ultimoAviso: ahora - 1000, ahora }), false);
  assert.equal(despertaronLaMac({ previo: 'remoto', actual, ultimoAviso: ahora - ESPERA_ENTRE_AVISOS, ahora }), true);
});

// ---------- Otra persona en la Mac ----------

import { DICTANDO_RECIENTE } from '../lib/presencia.js';

test('si el usuario está dictando y el teclado se mueve, es otra persona', () => {
  assert.equal(clasificar({ inactividadSeg: 5, dictandoHaceSeg: 10 }), 'otro-en-la-mac');
  assert.match(frasePresencia({ estado: 'otro-en-la-mac' }), /no sea él/i);
});

test('dictar hace rato no cambia nada', () => {
  assert.equal(clasificar({ inactividadSeg: 5, dictandoHaceSeg: DICTANDO_RECIENTE }), 'en-la-compu');
  assert.equal(clasificar({ inactividadSeg: 5 }), 'en-la-compu');
});

test('el aviso sale aunque el usuario no figurara lejos, si hay otro en la Mac', () => {
  const actual = { estado: 'otro-en-la-mac', inactividadSeg: 4 };
  assert.equal(despertaronLaMac({ previo: 'cerca', actual }), true);
});
