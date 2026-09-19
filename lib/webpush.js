// Web Push sin dependencias: cifrado del mensaje (RFC 8291, aes128gcm) y firma VAPID (RFC 8292).
// Es poco código y se prueba contra los vectores de la RFC, así que no vale la pena sumar `web-push`
// (y sus dependencias) a un repo que hasta ahora no tiene ninguna.

import { createECDH, createCipheriv, createDecipheriv, createPrivateKey, hkdfSync, randomBytes, sign } from 'node:crypto';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(s, 'base64url');

const RECORD_SIZE = 4096;
const TAG_LENGTH = 16;
// Los servicios de push aceptan hasta 4096 bytes de cuerpo: se descuentan el encabezado (86),
// el tag de AES-GCM y el delimitador de relleno.
export const MAX_PAYLOAD = RECORD_SIZE - TAG_LENGTH - 1 - 86;

const hkdf = (ikm, salt, info, length) => Buffer.from(hkdfSync('sha256', ikm, salt, info, length));

// Claves VAPID del servidor: un par P-256. La pública va al teléfono para suscribirse.
export function generateVapidKeys() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}

// Deriva la clave y el nonce de contenido a partir del secreto ECDH (RFC 8291, sección 3.4).
function deriveKeys({ ecdhSecret, authSecret, uaPublic, asPublic, salt }) {
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hkdf(ecdhSecret, authSecret, keyInfo, 32);
  return {
    cek: hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16),
    nonce: hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12),
  };
}

// Cifra el mensaje para una suscripción ({ p256dh, auth } en base64url).
// `salt` y `asPrivate` solo se pasan en los tests, para reproducir los vectores de la RFC;
// en uso real cada mensaje lleva una sal y un par de claves efímero nuevos.
export function encryptPayload(plaintext, { p256dh, auth }, { salt = randomBytes(16), asPrivate } = {}) {
  const data = Buffer.from(plaintext);
  if (data.length > MAX_PAYLOAD) throw new Error(`mensaje push demasiado largo (${data.length} bytes)`);

  const ecdh = createECDH('prime256v1');
  if (asPrivate) ecdh.setPrivateKey(fromB64u(asPrivate));
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const uaPublic = fromB64u(p256dh);
  const { cek, nonce } = deriveKeys({ ecdhSecret: ecdh.computeSecret(uaPublic), authSecret: fromB64u(auth), uaPublic, asPublic, salt });

  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);

  // Un solo registro: el delimitador 0x02 marca que es el último y no lleva más relleno.
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([data, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  return Buffer.concat([header, asPublic, body]);
}

// Lo inverso, del lado del teléfono. Solo lo usan los tests para verificar que el mensaje se abre.
export function decryptPayload(message, { privateKey, auth }) {
  const salt = message.subarray(0, 16);
  const idLength = message.readUInt8(20);
  const asPublic = message.subarray(21, 21 + idLength);
  const record = message.subarray(21 + idLength);

  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(fromB64u(privateKey));
  const { cek, nonce } = deriveKeys({
    ecdhSecret: ecdh.computeSecret(asPublic),
    authSecret: fromB64u(auth),
    uaPublic: ecdh.getPublicKey(),
    asPublic,
    salt,
  });
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(record.subarray(-TAG_LENGTH));
  const padded = Buffer.concat([decipher.update(record.subarray(0, -TAG_LENGTH)), decipher.final()]);
  return padded.subarray(0, padded.lastIndexOf(2)).toString('utf8');
}

// La clave privada VAPID guardada como 32 bytes crudos, convertida a algo que `sign` entienda.
function vapidKeyObject({ publicKey, privateKey }) {
  const pub = fromB64u(publicKey);
  return createPrivateKey({
    format: 'jwk',
    key: { kty: 'EC', crv: 'P-256', d: privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
  });
}

// JWT ES256 para el servicio de push (Apple, Google, Mozilla): prueba que somos los dueños de la clave
// con la que se suscribió el teléfono. `aud` es el origen del endpoint; dura 12 horas (el máximo es 24).
export function vapidJwt(endpoint, vapid, subject, now = Date.now()) {
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject }));
  const unsigned = `${header}.${claims}`;
  const signature = sign('sha256', Buffer.from(unsigned), { key: vapidKeyObject(vapid), dsaEncoding: 'ieee-p1363' });
  return `${unsigned}.${b64u(signature)}`;
}

// Arma el pedido HTTP al servicio de push, sin mandarlo (así se puede probar).
export function buildPushRequest(subscription, payload, { vapid, subject, ttl = 3600, urgency = 'high' }) {
  return {
    url: subscription.endpoint,
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        TTL: String(ttl),
        Urgency: urgency,
        Authorization: `vapid t=${vapidJwt(subscription.endpoint, vapid, subject)}, k=${vapid.publicKey}`,
      },
      body: encryptPayload(JSON.stringify(payload), subscription.keys),
    },
  };
}

// Manda el push. Devuelve el status: 201 es éxito; 404 y 410 quieren decir que la suscripción murió.
export async function sendPush(subscription, payload, options, fetchImpl = fetch) {
  const { url, init } = buildPushRequest(subscription, payload, options);
  const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(10000) });
  const detail = res.ok ? '' : await res.text().catch(() => '');
  return { status: res.status, ok: res.ok, gone: res.status === 404 || res.status === 410, detail };
}
