import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, utimes, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  imageType, validateImage, saveImage, findImage, cleanupImages, promptWithImage, DEFAULT_IMAGE_TEXT,
} from '../lib/images.js';

const pad = (head) => Buffer.concat([Buffer.from(head), Buffer.alloc(32)]);
const JPEG = pad([0xff, 0xd8, 0xff, 0xe0]);
const PNG = pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(20)]);

const tmp = () => mkdtemp(path.join(os.tmpdir(), 'walkie-code-img-'));

test('reconoce el formato por el contenido', () => {
  assert.equal(imageType(JPEG), 'jpg');
  assert.equal(imageType(PNG), 'png');
  assert.equal(imageType(pad([...Buffer.from('GIF89a')])), 'gif');
  assert.equal(imageType(WEBP), 'webp');
  assert.equal(imageType(pad([...Buffer.from('<html>')])), null);
  assert.equal(imageType(Buffer.from([0xff, 0xd8])), null);
});

test('rechaza fotos vacías, enormes o que no son imágenes', () => {
  assert.throws(() => validateImage(Buffer.alloc(0)), { status: 422 });
  assert.throws(() => validateImage(JPEG, 10), { status: 413 });
  assert.throws(() => validateImage(pad([...Buffer.from('%PDF-1.7')])), { status: 415 });
  // HEIC: Claude no lo lee; el teléfono tiene que convertirla a JPEG antes.
  assert.throws(() => validateImage(pad([0, 0, 0, 0x18, ...Buffer.from('ftypheic')])), { status: 415 });
  assert.equal(validateImage(PNG), 'png');
});

test('guarda la foto con la extensión real y la encuentra por id', async () => {
  const dir = path.join(await tmp(), 'uploads');
  const { id, file } = await saveImage(dir, PNG);
  assert.match(id, /^[a-f0-9]{16}$/);
  assert.equal(file, path.join(dir, `walkie-code-${id}.png`));
  assert.equal(findImage(dir, id), file);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test('no resuelve ids inventados ni rutas con trampa', async () => {
  const dir = await tmp();
  assert.equal(findImage(dir, '0123456789abcdef'), null);
  assert.equal(findImage(dir, '../../etc/passwd'), null);
  assert.equal(findImage(dir, undefined), null);
});

test('la limpieza borra solo fotos propias y viejas', async () => {
  const dir = await tmp();
  const now = Date.now();
  const old = new Date(now - 10 * 24 * 3600 * 1000);
  const { file: viejo } = await saveImage(dir, JPEG);
  const { file: nuevo } = await saveImage(dir, JPEG);
  const ajeno = path.join(dir, 'notas.txt');
  await writeFile(ajeno, 'no tocar');
  await utimes(viejo, old, old);
  await utimes(ajeno, old, old);

  assert.equal(await cleanupImages(dir, 7 * 24 * 3600 * 1000, now), 1);
  assert.deepEqual((await readdir(dir)).sort(), [path.basename(nuevo), 'notas.txt'].sort());
});

test('la limpieza no falla si la carpeta no existe', async () => {
  assert.equal(await cleanupImages(path.join(await tmp(), 'nada')), 0);
});

test('arma el mensaje con lo dictado y la ruta al final', () => {
  assert.equal(promptWithImage('¿Qué error es este?', '/u/d/.walkie-code/uploads/a.jpg'), '¿Qué error es este? /u/d/.walkie-code/uploads/a.jpg');
  assert.equal(promptWithImage('  dos\nlíneas  ', '/a.jpg'), 'dos líneas /a.jpg');
});

test('sin texto usa el mensaje por defecto y escapa espacios de la ruta', () => {
  assert.equal(promptWithImage('', '/a.png'), `${DEFAULT_IMAGE_TEXT} /a.png`);
  assert.equal(promptWithImage(null, '/Users/Mi Mac/x.png'), `${DEFAULT_IMAGE_TEXT} /Users/Mi\\ Mac/x.png`);
});

test('con varias fotos, las rutas van todas al final', async () => {
  const { promptWithImages } = await import('../lib/images.js');
  assert.equal(promptWithImages('mirá esto', ['/a/uno.jpg', '/a/dos con espacio.jpg']),
    'mirá esto /a/uno.jpg /a/dos\\ con\\ espacio.jpg');
  assert.equal(promptWithImages('', ['/a/uno.jpg']), 'Mirá esta imagen /a/uno.jpg');
  assert.equal(promptWithImages('', ['/a/uno.jpg', '/a/dos.jpg']), 'Mirá estas imágenes /a/uno.jpg /a/dos.jpg');
});
