import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, createPublicKey, verify } from 'node:crypto';
import { encryptPayload, decryptPayload, generateVapidKeys, vapidJwt, buildPushRequest, sendPush, MAX_PAYLOAD } from '../lib/webpush.js';

// Vectores de la RFC 8291, sección 5 y apéndice A.
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  message:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

// Un "teléfono" de mentira: su par de claves y el secreto de autenticación.
function fakePhone() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    keys: { p256dh: ecdh.getPublicKey('base64url'), auth: Buffer.from('0123456789abcdef').toString('base64url') },
    privateKey: ecdh.getPrivateKey('base64url'),
  };
}

test('cifra igual que el ejemplo de la RFC 8291', () => {
  const out = encryptPayload(RFC.plaintext, { p256dh: RFC.uaPublic, auth: RFC.auth }, {
    salt: Buffer.from(RFC.salt, 'base64url'),
    asPrivate: RFC.asPrivate,
  });
  assert.equal(out.toString('base64url'), RFC.message);
});

test('descifra el mensaje de la RFC con la clave del teléfono', () => {
  const text = decryptPayload(Buffer.from(RFC.message, 'base64url'), { privateKey: RFC.uaPrivate, auth: RFC.auth });
  assert.equal(text, RFC.plaintext);
});

test('ida y vuelta con claves efímeras, acentos y emojis', () => {
  const phone = fakePhone();
  const payload = JSON.stringify({ title: 'CLAUDE · superprecio', body: 'Listo, ya está el commit ✅ ñandú' });
  const a = encryptPayload(payload, phone.keys);
  const b = encryptPayload(payload, phone.keys);
  assert.notDeepEqual(a, b, 'cada mensaje lleva sal y claves nuevas');
  assert.equal(decryptPayload(a, { privateKey: phone.privateKey, auth: phone.keys.auth }), payload);
});

test('rechaza mensajes que no entran en un solo registro', () => {
  const phone = fakePhone();
  assert.equal(encryptPayload('x'.repeat(MAX_PAYLOAD), phone.keys).length, 4096);
  assert.throws(() => encryptPayload('x'.repeat(MAX_PAYLOAD + 1), phone.keys), /demasiado largo/);
});

test('las claves VAPID generadas son un par P-256 válido', () => {
  const { publicKey, privateKey } = generateVapidKeys();
  assert.equal(Buffer.from(publicKey, 'base64url').length, 65);
  assert.equal(Buffer.from(privateKey, 'base64url').length, 32);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(Buffer.from(privateKey, 'base64url'));
  assert.equal(ecdh.getPublicKey('base64url'), publicKey);
});

test('el JWT VAPID es ES256, apunta al origen del endpoint y verifica con la clave pública', () => {
  const vapid = generateVapidKeys();
  const now = Date.UTC(2026, 8, 18, 12);
  const jwt = vapidJwt('https://web.push.apple.com/QGuQyavXutnMH/abc?x=1', vapid, 'https://bunkerapps.net', now);
  const [h, c, s] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { typ: 'JWT', alg: 'ES256' });
  assert.deepEqual(JSON.parse(Buffer.from(c, 'base64url')), {
    aud: 'https://web.push.apple.com',
    exp: now / 1000 + 12 * 3600,
    sub: 'https://bunkerapps.net',
  });

  const pub = Buffer.from(vapid.publicKey, 'base64url');
  const key = createPublicKey({
    format: 'jwk',
    key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') },
  });
  const signature = Buffer.from(s, 'base64url');
  assert.equal(signature.length, 64, 'firma cruda r||s, no DER');
  assert.ok(verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, signature));
});

test('arma el pedido con los encabezados que exige el servicio de push', () => {
  const vapid = generateVapidKeys();
  const phone = fakePhone();
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: phone.keys };
  const { url, init } = buildPushRequest(sub, { title: 'hola' }, { vapid, subject: 'mailto:a@b.c' });
  assert.equal(url, sub.endpoint);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['Content-Encoding'], 'aes128gcm');
  assert.equal(init.headers.TTL, '3600');
  assert.equal(init.headers.Urgency, 'high');
  assert.match(init.headers.Authorization, new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${vapid.publicKey}$`));
  const payload = decryptPayload(init.body, { privateKey: phone.privateKey, auth: phone.keys.auth });
  assert.deepEqual(JSON.parse(payload), { title: 'hola' });
});

test('sendPush marca como muertas las suscripciones con 404 o 410', async () => {
  const vapid = generateVapidKeys();
  const sub = { endpoint: 'https://web.push.apple.com/x', keys: fakePhone().keys };
  const opts = { vapid, subject: 's' };
  const fakeFetch = (status) => async () => new Response(status === 201 ? null : 'chau', { status });
  assert.deepEqual(await sendPush(sub, {}, opts, fakeFetch(201)), { status: 201, ok: true, gone: false, detail: '' });
  assert.equal((await sendPush(sub, {}, opts, fakeFetch(410))).gone, true);
  assert.equal((await sendPush(sub, {}, opts, fakeFetch(404))).gone, true);
  const forbidden = await sendPush(sub, {}, opts, fakeFetch(403));
  assert.deepEqual([forbidden.ok, forbidden.gone, forbidden.detail], [false, false, 'chau']);
});
