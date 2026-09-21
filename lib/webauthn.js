// Candado con Face ID (WebAuthn), sin librerías: solo node:crypto.
//
// El token alcanza para hablar con el servidor, pero cualquiera que llegue al teléfono desbloqueado
// lo tiene. Con esto, las rutas que escriben en la terminal piden además una sesión desbloqueada con
// la cara o la huella, verificada del lado de la Mac: el token solo ya no alcanza.

import { createHash, createVerify, randomBytes, webcrypto } from 'node:crypto';

export const base64url = (buf) => Buffer.from(buf).toString('base64url');
export const fromBase64url = (text) => Buffer.from(String(text), 'base64url');

export const nuevoDesafio = () => base64url(randomBytes(32));

// ---------- CBOR: solo lo que aparece en WebAuthn ----------
//
// El attestationObject y la clave pública vienen en CBOR. Se decodifican los tipos que usan:
// enteros, negativos, bytes, texto, listas y mapas.

function leerCbor(buf, i = 0) {
  const byte = buf[i];
  const mayor = byte >> 5;
  const menor = byte & 0x1f;
  i += 1;

  let largo = menor;
  if (menor === 24) (largo = buf[i]), (i += 1);
  else if (menor === 25) (largo = buf.readUInt16BE(i)), (i += 2);
  else if (menor === 26) (largo = buf.readUInt32BE(i)), (i += 4);
  else if (menor === 27) (largo = Number(buf.readBigUInt64BE(i))), (i += 8);
  else if (menor > 27) throw new Error('CBOR no soportado');

  if (mayor === 0) return [largo, i];
  if (mayor === 1) return [-1 - largo, i];
  if (mayor === 2) return [buf.subarray(i, i + largo), i + largo];
  if (mayor === 3) return [buf.subarray(i, i + largo).toString('utf8'), i + largo];
  if (mayor === 4) {
    const lista = [];
    for (let n = 0; n < largo; n++) {
      const [valor, siguiente] = leerCbor(buf, i);
      lista.push(valor);
      i = siguiente;
    }
    return [lista, i];
  }
  if (mayor === 5) {
    const mapa = new Map();
    for (let n = 0; n < largo; n++) {
      const [clave, trasClave] = leerCbor(buf, i);
      const [valor, trasValor] = leerCbor(buf, trasClave);
      mapa.set(clave, valor);
      i = trasValor;
    }
    return [mapa, i];
  }
  if (mayor === 7) return [largo === 20 ? false : largo === 21 ? true : null, i];
  throw new Error('CBOR no soportado');
}

export const decodeCbor = (buf) => leerCbor(Buffer.from(buf))[0];

// ---------- authenticatorData ----------

export function parseAuthData(buf) {
  const data = Buffer.from(buf);
  const rpIdHash = data.subarray(0, 32);
  const flags = data[32];
  const signCount = data.readUInt32BE(33);
  const datos = {
    rpIdHash,
    flags,
    signCount,
    presente: Boolean(flags & 0x01), // el usuario tocó el aparato
    verificado: Boolean(flags & 0x04), // Face ID, huella o código
    credencial: null,
    clave: null,
  };
  if (flags & 0x40) {
    const largoId = data.readUInt16BE(53);
    datos.credencial = base64url(data.subarray(55, 55 + largoId));
    datos.clave = decodeCbor(data.subarray(55 + largoId));
  }
  return datos;
}

// La clave pública viene como mapa COSE; para verificar hace falta en formato JWK.
export function coseAJwk(cose) {
  const kty = cose.get(1);
  const alg = cose.get(3);
  if (kty !== 2 || alg !== -7) throw new Error('Solo se admiten claves P-256 (ES256).');
  return {
    kty: 'EC',
    crv: 'P-256',
    x: base64url(cose.get(-2)),
    y: base64url(cose.get(-3)),
  };
}

// ---------- Comprobaciones comunes ----------

function revisarCliente({ clientDataJSON, desafio, origen, tipoEsperado }) {
  const datos = JSON.parse(Buffer.from(clientDataJSON).toString('utf8'));
  if (datos.type !== tipoEsperado) throw new Error('Tipo de operación inesperado.');
  if (datos.challenge !== desafio) throw new Error('El desafío no coincide.');
  if (datos.origin !== origen) throw new Error(`Origen inesperado: ${datos.origin}`);
  return datos;
}

const hashRp = (rpId) => createHash('sha256').update(rpId).digest();

// ---------- Alta de la credencial ----------

export function verificarRegistro({ attestationObject, clientDataJSON, desafio, origen, rpId }) {
  revisarCliente({ clientDataJSON, desafio, origen, tipoEsperado: 'webauthn.create' });
  const attestation = decodeCbor(fromBase64url(attestationObject));
  const auth = parseAuthData(attestation.get('authData'));
  if (!auth.rpIdHash.equals(hashRp(rpId))) throw new Error('La credencial es de otro sitio.');
  if (!auth.verificado) throw new Error('El teléfono no verificó al usuario (Face ID o código).');
  if (!auth.credencial) throw new Error('La credencial vino incompleta.');
  return { credencial: auth.credencial, jwk: coseAJwk(auth.clave), signCount: auth.signCount };
}

// ---------- Desbloqueo ----------

// La firma cubre el authenticatorData seguido del hash del clientDataJSON.
export async function verificarDesbloqueo({ credencial, authenticatorData, clientDataJSON, signature, guardada, desafio, origen, rpId }) {
  if (!guardada || guardada.credencial !== credencial) throw new Error('Esa credencial no está registrada.');
  revisarCliente({ clientDataJSON, desafio, origen, tipoEsperado: 'webauthn.get' });

  const auth = parseAuthData(fromBase64url(authenticatorData));
  if (!auth.rpIdHash.equals(hashRp(rpId))) throw new Error('La credencial es de otro sitio.');
  if (!auth.verificado) throw new Error('Faltó la cara, la huella o el código.');

  const firmado = Buffer.concat([
    fromBase64url(authenticatorData),
    createHash('sha256').update(Buffer.from(clientDataJSON)).digest(),
  ]);

  const clave = await webcrypto.subtle.importKey(
    'jwk',
    { ...guardada.jwk, ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  // WebAuthn firma en DER; la Web Crypto espera los dos números pelados.
  const cruda = derACrudo(fromBase64url(signature));
  const ok = await webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, clave, cruda, firmado);
  if (!ok) throw new Error('La firma no verifica.');

  // Un contador que retrocede delata una credencial clonada.
  if (guardada.signCount && auth.signCount && auth.signCount <= guardada.signCount) {
    throw new Error('El contador de la credencial no avanzó.');
  }
  return { signCount: auth.signCount };
}

// DER (SEQUENCE de dos INTEGER) a los 64 bytes que espera la Web Crypto.
export function derACrudo(der) {
  const buf = Buffer.from(der);
  if (buf[0] !== 0x30) throw new Error('Firma con formato inesperado.');
  let i = 2;
  if (buf[1] & 0x80) i = 2 + (buf[1] & 0x7f);
  const leer = () => {
    if (buf[i] !== 0x02) throw new Error('Firma con formato inesperado.');
    const largo = buf[i + 1];
    let valor = buf.subarray(i + 2, i + 2 + largo);
    i += 2 + largo;
    while (valor.length > 32 && valor[0] === 0) valor = valor.subarray(1);
    return Buffer.concat([Buffer.alloc(32 - valor.length), valor]);
  };
  return Buffer.concat([leer(), leer()]);
}
