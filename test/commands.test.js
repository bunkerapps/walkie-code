import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalize,
  compact,
  parseNumber,
  parseChannelCommand as parse,
  editDistance,
  matchLevel,
  phonetic,
  findChannel,
  missSpeech,
} from '../lib/commands.js';

// Canales como los arma channelsPayload en server.js.
const CHANNELS = [
  { id: 'a', number: 1, project: 'SuperPrecio', folder: 'superprecio-api', title: 'Arreglar el scraper de Coto' },
  { id: 'b', number: 2, project: 'bunkerapps-landing', folder: 'bunkerapps-landing', title: 'Nueva sección de precios' },
  { id: 'c', number: 3, project: 'supervoz', folder: 'supervoz', title: 'Comandos de voz' },
  { id: 'd', number: 4, project: 'supervoz·2', folder: 'supervoz', title: 'Revisar el README' },
  { id: 'e', number: 5, project: 'Quickway Panel', folder: 'orders-dashboard', title: 'Tabla de pedidos' },
];

const find = (text) => findChannel(parse(text), CHANNELS);
const idOf = (text) => find(text).channel?.id ?? null;

test('normaliza mayúsculas, acentos, guiones y puntuación', () => {
  assert.equal(normalize('¡Canal Súper-Precio!'), 'canal super precio');
  assert.equal(normalize('  Pasame a  BunkerApps. '), 'pasame a bunkerapps');
  assert.equal(normalize('supervoz·2'), 'supervoz 2');
  assert.equal(compact('Super Precio'), 'superprecio');
  assert.equal(compact('super-precio'), 'superprecio');
});

test('entiende números en dígitos y en letras hasta treinta', () => {
  assert.equal(parseNumber('3'), 3);
  assert.equal(parseNumber('03'), 3);
  assert.equal(parseNumber('tres'), 3);
  assert.equal(parseNumber('uno'), 1);
  assert.equal(parseNumber('un'), 1);
  assert.equal(parseNumber('diez'), 10);
  assert.equal(parseNumber('once'), 11);
  assert.equal(parseNumber('dieciséis'), 16);
  assert.equal(parseNumber('diez y seis'), 16);
  assert.equal(parseNumber('diecinueve'), 19);
  assert.equal(parseNumber('veinte'), 20);
  assert.equal(parseNumber('veintitrés'), 23);
  assert.equal(parseNumber('veinte y tres'), 23);
  assert.equal(parseNumber('veintiún'), 21);
  assert.equal(parseNumber('treinta'), 30);
  assert.equal(parseNumber('0'), null);
  assert.equal(parseNumber('superprecio'), null);
  assert.equal(parseNumber('tres cosas'), null);
});

const NAMES = ['uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez',
  'once', 'doce', 'trece', 'catorce', 'quince', 'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve', 'veinte'];

test('"canal N" con los números del 1 al 20 en letras y en dígitos', () => {
  NAMES.forEach((word, i) => {
    assert.equal(parse(`Canal ${word}.`)?.number, i + 1, word);
    assert.equal(parse(`canal ${i + 1}`)?.number, i + 1, String(i + 1));
  });
});

test('reconoce las formas de pedir un canal', () => {
  const cases = {
    'canal superprecio': 'superprecio',
    'Canal SuperPrecio.': 'superprecio',
    'Canal, superprecio.': 'superprecio',
    'canal super precio': 'super precio',
    'Canal número 3': '3',
    'canal el tres': 'tres',
    'Cambiá al canal de la landing.': 'landing',
    'cambia al canal 2': '2',
    'Pasá al canal de bunkerapps': 'bunkerapps',
    'pasame al canal supervoz': 'supervoz',
    'Ir al canal 4': '4',
    'Andá al canal del proyecto quickway': 'quickway',
    'Poné el canal dos': 'dos',
    'Sintonizá superprecio': 'superprecio',
    'Sintonizame el canal 5': '5',
    'CH03': '03',
    'ch 3': '3',
    'canal 3, por favor': '3',
  };
  for (const [text, query] of Object.entries(cases)) {
    const cmd = parse(text);
    assert.ok(cmd, text);
    assert.equal(cmd.query, query, text);
    assert.equal(cmd.strong, true, text);
  }
});

test('los verbos sin la palabra canal son un pedido débil', () => {
  for (const text of ['Pasame a bunkerapps', 'pasá a superprecio', 'Cambiá a supervoz.', 'Andá al tres', 'ir a quickway']) {
    const cmd = parse(text);
    assert.ok(cmd, text);
    assert.equal(cmd.strong, false, text);
  }
});

test('lo que no empieza con un comando va a Claude', () => {
  for (const text of [
    'corré los tests',
    'Arreglá el canal de audio del reproductor',
    'Agregá un canal nuevo en el selector',
    'el canal 3 no anda',
    'canal 3 no anda',
    'Al canal le falta el volumen',
    'canales',
    'Canal.',
    'Canal de ventas está roto, arreglalo ya mismo por favor',
    'volvé a correr los tests',
    'vamos a probar esto',
    'pasame el archivo de config',
    'cambiá el nombre de la función',
    'sí',
    'chequeá el build',
    'Canal 3 y decile que corra los tests de nuevo',
  ]) {
    assert.equal(parse(text), null, text);
  }
});

test('distancia de edición', () => {
  assert.equal(editDistance('superprecio', 'superprecio'), 0);
  assert.equal(editDistance('superprezio', 'superprecio'), 1);
  assert.equal(editDistance('bonker', 'bunker'), 1);
  assert.equal(editDistance('', 'abc'), 3);
});

test('clave fonética para nombres que Whisper escribe de oído', () => {
  assert.equal(phonetic('Super Bos'), phonetic('supervoz'));
  assert.equal(phonetic('Kiosko'), phonetic('quiosco'));
  assert.equal(matchLevel('Kick Way', 'Quickway Panel'), 1);
  assert.equal(matchLevel('super bos', 'supervoz'), 1);
});

test('niveles de coincidencia: exacto > empieza con > contiene > parecido', () => {
  assert.equal(matchLevel('super precio', 'SuperPrecio'), 4);
  assert.equal(matchLevel('bunker', 'bunkerapps-landing'), 3);
  assert.equal(matchLevel('landing', 'bunkerapps-landing'), 2);
  assert.equal(matchLevel('superprezio', 'SuperPrecio'), 1);
  assert.equal(matchLevel('bonker', 'bunkerapps-landing'), 1);
  assert.equal(matchLevel('xyz', 'SuperPrecio'), 0);
  assert.equal(matchLevel('ab', 'ab-test'), 3);
  assert.equal(matchLevel('ap', 'superprecio-api'), 0); // muy corto para "contiene"
});

test('encuentra el canal por proyecto, carpeta, título o número', () => {
  assert.equal(idOf('canal superprecio'), 'a');
  assert.equal(idOf('Canal Súper Precio.'), 'a');
  assert.equal(idOf('canal super prezio'), 'a'); // Whisper se equivocó en una letra
  assert.equal(idOf('canal de la landing'), 'b'); // contiene
  assert.equal(idOf('Cambiá al canal de la landing'), 'b');
  assert.equal(idOf('canal bunker'), 'b'); // empieza con
  assert.equal(idOf('canal bonker'), 'b'); // parecido
  assert.equal(idOf('canal quickway'), 'e'); // nombre propio
  assert.equal(idOf('Canal Kick Way.'), 'e'); // así lo transcribió Whisper
  assert.equal(idOf('Pásame a Bunker Apps.'), 'b');
  assert.equal(idOf('Cambia al canal Super Voz 2.'), 'd');
  assert.equal(idOf('Anda al canal 5.'), 'e');
  assert.equal(idOf('canal orders dashboard'), 'e'); // carpeta
  assert.equal(idOf('canal scraper'), 'a'); // título de la tarea
  assert.equal(idOf('canal tres'), 'c');
  assert.equal(idOf('Canal 3.'), 'c');
  assert.equal(idOf('CH05'), 'e');
  assert.equal(idOf('canal supervoz 2'), 'd');
  assert.equal(idOf('Pasame a Bunkerapps.'), 'b');
  assert.equal(idOf('pasame a super precio'), 'a');
  assert.equal(idOf('andá al cinco'), 'e');
});

test('el proyecto le gana al título a igual coincidencia', () => {
  const channels = [
    { id: 'x', number: 1, project: 'api', folder: 'api', title: 'Refactor' },
    { id: 'y', number: 2, project: 'web', folder: 'web', title: 'Api' },
  ];
  assert.equal(findChannel(parse('canal api'), channels).channel.id, 'x');
});

test('si hay empate no elige', () => {
  const result = find('canal supervoz');
  assert.equal(result.channel, undefined);
  assert.deepEqual(result.candidates.map((c) => c.id), ['c', 'd']);

  const twins = find('canal super');
  assert.deepEqual(twins.candidates.map((c) => c.id), ['a', 'c', 'd']);
});

test('sin coincidencia devuelve lista vacía', () => {
  assert.deepEqual(find('canal fotografía'), { candidates: [] });
  assert.deepEqual(find('canal 9'), { candidates: [] });
});

test('el pedido débil exige que el nombre empiece igual y no mira el título', () => {
  assert.deepEqual(find('cambiá a TypeScript el archivo'), { candidates: [] });
  assert.deepEqual(find('pasame a scraper'), { candidates: [] }); // está en el título, no en el nombre
  assert.deepEqual(find('pasá a landing'), { candidates: [] }); // solo "contiene"
  assert.deepEqual(find('pasá a bonker'), { candidates: [] }); // solo "parecido"
  assert.equal(idOf('pasá a bunker'), 'b');
});

test('lo que se dice cuando no se puede cambiar', () => {
  assert.equal(missSpeech(parse('canal fotografía'), { candidates: [] }, 5), 'No encontré el canal fotografia.');
  assert.equal(missSpeech(parse('canal nueve'), { candidates: [] }, 5), 'No hay canal 9. Hay 5 canales.');
  assert.equal(missSpeech(parse('canal dos'), { candidates: [] }, 1), 'No hay canal 2. Hay un solo canal.');
  assert.equal(
    missSpeech(parse('canal supervoz'), find('canal supervoz'), 5),
    'Hay dos canales parecidos: canal 3, supervoz; canal 4, supervoz 2. Decí el número.',
  );
});

test('las muletillas del principio no tapan el cambio de canal', () => {
  assert.equal(parse('Bien, cámbiame al canal 4.').number, 4);
  assert.equal(parse('Dale, canal superprecio').query, 'superprecio');
  assert.equal(parse('Bueno, a ver, pasame al canal dos').number, 2);
  assert.equal(parse('Bien, el canal 3 no anda'), null);
  assert.equal(parse('Bueno, volvé a correr los tests'), null);
});
