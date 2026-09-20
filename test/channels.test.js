import test from 'node:test';
import assert from 'node:assert/strict';
import { reconectar, ordenar, ESPERA_RECONEXION } from '../lib/channels.js';

const canal = (id, extra = {}) => ({ id, tty: `/dev/tty${id}`, project: `p${id}`, title: 'claude', ...extra });

test('sin canal elegido no toca nada', () => {
  const channels = [canal('a')];
  const r = reconectar({ channels, sessions: [], selectedId: null });
  assert.equal(r.soltar, false);
  assert.equal(r.memoria, null);
  assert.deepEqual(r.channels, channels);
});

test('con el canal a la vista guarda su lugar', () => {
  const channels = [canal('a'), canal('b')];
  const r = reconectar({ channels, sessions: channels, selectedId: 'b' });
  assert.equal(r.soltar, false);
  assert.equal(r.memoria.index, 1);
  assert.equal(r.memoria.channel.id, 'b');
});

test('mientras Claude Code se reinicia, el canal se queda en su lugar', () => {
  const antes = [canal('a'), canal('b'), canal('c')];
  const memoria = reconectar({ channels: antes, sessions: antes, selectedId: 'b' }).memoria;

  // Ya no hay proceso claude en esa terminal, pero la pestaña de iTerm2 sigue abierta.
  const ahora = Date.now();
  const r = reconectar({
    channels: [canal('a'), canal('c')],
    sessions: [canal('a'), { id: 'b', tty: '/dev/ttyb', title: 'zsh' }, canal('c')],
    selectedId: 'b',
    memoria,
    ahora,
  });

  assert.equal(r.soltar, false);
  assert.deepEqual(r.channels.map((c) => c.id), ['a', 'b', 'c']);
  assert.equal(r.channels[1].starting, true);
  assert.equal(r.channels[1].project, 'pb', 'conserva el nombre del canal');
  assert.equal(r.memoria.sinVerDesde, ahora);
});

test('cuando Claude Code vuelve, deja de estar arrancando', () => {
  const antes = [canal('a'), canal('b')];
  let memoria = reconectar({ channels: antes, sessions: antes, selectedId: 'b' }).memoria;
  memoria = reconectar({ channels: [canal('a')], sessions: antes, selectedId: 'b', memoria }).memoria;

  const r = reconectar({ channels: antes, sessions: antes, selectedId: 'b', memoria });
  assert.equal(r.channels.some((c) => c.starting), false);
  assert.equal(r.memoria.sinVerDesde, 0);
});

test('si la pestaña se cerró, suelta la sintonía', () => {
  const antes = [canal('a'), canal('b')];
  const memoria = reconectar({ channels: antes, sessions: antes, selectedId: 'b' }).memoria;

  const r = reconectar({ channels: [canal('a')], sessions: [canal('a')], selectedId: 'b', memoria });
  assert.equal(r.soltar, true);
  assert.equal(r.memoria, null);
  assert.deepEqual(r.channels.map((c) => c.id), ['a']);
});

test('si Claude no vuelve en un minuto y medio, suelta la sintonía', () => {
  const antes = [canal('a'), canal('b')];
  const memoria = reconectar({ channels: antes, sessions: antes, selectedId: 'b' }).memoria;
  const sessions = [canal('a'), { id: 'b', tty: '/dev/ttyb', title: 'zsh' }];
  const inicio = Date.now();

  const esperando = reconectar({ channels: [canal('a')], sessions, selectedId: 'b', memoria, ahora: inicio });
  assert.equal(esperando.soltar, false);

  const tarde = reconectar({
    channels: [canal('a')],
    sessions,
    selectedId: 'b',
    memoria: esperando.memoria,
    ahora: inicio + ESPERA_RECONEXION,
  });
  assert.equal(tarde.soltar, true);
});

test('los canales conservan su número y el nuevo va al final', () => {
  const orden = new Map();
  const primeros = [canal('a'), canal('b'), canal('c')];
  assert.deepEqual(ordenar(primeros, orden).map((c) => c.id), ['a', 'b', 'c']);

  // iTerm2 pone la ventana nueva adelante: el canal nuevo igual tiene que quedar último.
  const conNuevo = [canal('d'), canal('a'), canal('b'), canal('c')];
  assert.deepEqual(ordenar(conNuevo, orden).map((c) => c.id), ['a', 'b', 'c', 'd']);

  // Traer otra ventana al frente tampoco mueve los números.
  const otroFrente = [canal('c'), canal('d'), canal('a'), canal('b')];
  assert.deepEqual(ordenar(otroFrente, orden).map((c) => c.id), ['a', 'b', 'c', 'd']);
});

test('al cerrarse un canal, el próximo que se abre va al final igual', () => {
  const orden = new Map();
  ordenar([canal('a'), canal('b'), canal('c')], orden);
  ordenar([canal('a'), canal('c')], orden); // se cerró el b
  assert.deepEqual(ordenar([canal('d'), canal('a'), canal('c')], orden).map((c) => c.id), ['a', 'c', 'd']);
  assert.equal(orden.has('b'), false, 'los canales cerrados se olvidan');
});
