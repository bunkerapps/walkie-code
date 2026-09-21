import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { verificarDesbloqueo, parseAuthData, derACrudo, base64url } from '../lib/webauthn.js';

const RP = 'walkie.test';
const ORIGEN = 'https://walkie.test';

// Arma un authenticatorData como el que manda el teléfono.
function authData({ rp = RP, uv = true, signCount = 7 } = {}) {
  const buf = Buffer.alloc(37);
  createHash('sha256').update(rp).digest().copy(buf, 0);
  buf[32] = 0x01 | (uv ? 0x04 : 0);
  buf.writeUInt32BE(signCount, 33);
  return buf;
}

// Los 64 bytes de la Web Crypto, en el DER que usa WebAuthn.
function crudoADer(cruda) {
  const entero = (b) => {
    let v = Buffer.from(b);
    while (v.length > 1 && v[0] === 0) v = v.subarray(1);
    if (v[0] & 0x80) v = Buffer.concat([Buffer.from([0]), v]);
    return Buffer.concat([Buffer.from([0x02, v.length]), v]);
  };
  const cuerpo = Buffer.concat([entero(cruda.subarray(0, 32)), entero(cruda.subarray(32))]);
  return Buffer.concat([Buffer.from([0x30, cuerpo.length]), cuerpo]);
}

async function firmar({ uv = true, signCount = 7, desafio = 'abc', origen = ORIGEN } = {}) {
  const par = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await webcrypto.subtle.exportKey('jwk', par.publicKey);
  const auth = authData({ uv, signCount });
  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: desafio, origin: origen }));
  const firmado = Buffer.concat([auth, createHash('sha256').update(clientDataJSON).digest()]);
  const cruda = Buffer.from(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, par.privateKey, firmado));
  return {
    credencial: 'cred-1',
    authenticatorData: base64url(auth),
    clientDataJSON,
    signature: base64url(crudoADer(cruda)),
    guardada: { credencial: 'cred-1', jwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, signCount: 1 },
    desafio,
    origen: ORIGEN,
    rpId: RP,
  };
}

test('una firma buena desbloquea', async () => {
  const { signCount } = await verificarDesbloqueo(await firmar());
  assert.equal(signCount, 7);
});

test('sin Face ID ni código no desbloquea', async () => {
  await assert.rejects(verificarDesbloqueo(await firmar({ uv: false })), /cara, la huella/i);
});

test('un desafío viejo no sirve', async () => {
  const datos = await firmar({ desafio: 'viejo' });
  await assert.rejects(verificarDesbloqueo({ ...datos, desafio: 'nuevo' }), /desafío/i);
});

test('una credencial de otro sitio no sirve', async () => {
  const datos = await firmar({ origen: 'https://otro.test' });
  await assert.rejects(verificarDesbloqueo(datos), /Origen/i);
});

test('el contador que no avanza delata una copia', async () => {
  const datos = await firmar({ signCount: 1 });
  await assert.rejects(verificarDesbloqueo(datos), /contador/i);
});

test('la firma de otra clave no pasa', async () => {
  const datos = await firmar();
  const otra = await firmar();
  await assert.rejects(verificarDesbloqueo({ ...datos, signature: otra.signature }), /firma|formato/i);
});

test('lee las banderas del authenticatorData', () => {
  const datos = parseAuthData(authData({ uv: false }));
  assert.equal(datos.presente, true);
  assert.equal(datos.verificado, false);
  assert.equal(datos.signCount, 7);
});

test('convierte la firma DER a los 64 bytes crudos', () => {
  const cruda = Buffer.alloc(64, 9);
  assert.deepEqual(derACrudo(crudoADer(cruda)), cruda);
});
