// El candado del walkie: qué credencial de Face ID está registrada y qué teléfonos están desbloqueados.
//
// El token deja entrar al servidor; el candado decide si además se puede escribir en la terminal.
// Las sesiones se guardan en disco para que reiniciar el servidor no obligue a poner la cara de nuevo.

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const DURACION_SESION_MS = 12 * 60 * 60 * 1000;
export const VIDA_DESAFIO_MS = 2 * 60 * 1000;

const hash = (valor) => createHash('sha256').update(String(valor)).digest('hex');

export class Cerrojo {
  constructor(file) {
    this.file = file;
    this.credencial = null; // { credencial, jwk, signCount, alta }
    this.sesiones = new Map(); // hash de la llave -> vence (ms)
    this.desafios = new Map(); // desafío -> vence (ms)
    try {
      const datos = JSON.parse(readFileSync(file, 'utf8'));
      this.credencial = datos.credencial || null;
      for (const [llave, vence] of Object.entries(datos.sesiones || {})) {
        if (vence > Date.now()) this.sesiones.set(llave, vence);
      }
    } catch {}
  }

  get activo() {
    return Boolean(this.credencial);
  }

  guardar() {
    try {
      const sesiones = Object.fromEntries([...this.sesiones].filter(([, vence]) => vence > Date.now()));
      writeFileSync(this.file, JSON.stringify({ credencial: this.credencial, sesiones }), { mode: 0o600 });
    } catch {}
  }

  // ---------- Desafíos ----------

  nuevoDesafio(valor, ahora = Date.now()) {
    for (const [viejo, vence] of this.desafios) if (vence <= ahora) this.desafios.delete(viejo);
    this.desafios.set(valor, ahora + VIDA_DESAFIO_MS);
    return valor;
  }

  // Un desafío sirve una sola vez: así una captura de la pantalla no se puede reusar.
  usarDesafio(valor, ahora = Date.now()) {
    const vence = this.desafios.get(valor);
    this.desafios.delete(valor);
    return Boolean(vence && vence > ahora);
  }

  // ---------- Credencial ----------

  registrar(credencial) {
    this.credencial = { ...credencial, alta: Date.now() };
    this.guardar();
  }

  // Sacar el candado deja al walkie como antes: con el token alcanza.
  olvidar() {
    this.credencial = null;
    this.sesiones.clear();
    this.guardar();
  }

  // ---------- Sesiones ----------

  abrirSesion(ahora = Date.now()) {
    const llave = randomBytes(32).toString('base64url');
    this.sesiones.set(hash(llave), ahora + DURACION_SESION_MS);
    this.guardar();
    return llave;
  }

  desbloqueado(llave, ahora = Date.now()) {
    if (!llave) return false;
    const buscado = hash(llave);
    for (const [guardada, vence] of this.sesiones) {
      if (vence <= ahora) {
        this.sesiones.delete(guardada);
        continue;
      }
      const a = Buffer.from(guardada);
      const b = Buffer.from(buscado);
      if (a.length === b.length && timingSafeEqual(a, b)) return true;
    }
    return false;
  }

  cerrarTodo() {
    this.sesiones.clear();
    this.guardar();
  }
}

// Qué pedidos necesitan la cara. Lo que viene de la propia Mac (los hooks) nunca la necesita:
// ahí ya se está sentado frente a la máquina.
const LIBRES = [/^GET \/api\/lock/, /^POST \/api\/lock/, /^POST \/api\/hook$/, /^GET \/api\/push$/];

export function necesitaCara({ route, local }) {
  if (local) return false;
  if (!route.startsWith('GET /api') && !route.startsWith('POST /api')) return false;
  return !LIBRES.some((libre) => libre.test(route));
}
