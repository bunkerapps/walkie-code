// ¿El usuario está frente a la Mac o le está hablando de lejos por el walkie?
//
// Sirve para que Claude decida: mostrar algo en pantalla solo tiene sentido si lo va a ver.
// La señal es la que ya tiene la Mac: hace cuánto que nadie toca el teclado o el mouse, y si la
// pantalla está bloqueada. Es exacta y no necesita ni Bluetooth ni permisos nuevos.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

// Tocó algo hace menos de esto: está usando la Mac.
export const UMBRAL_COMPU = 90;
// Entre ese valor y este: sigue por ahí, pero no la está mirando.
export const UMBRAL_CERCA = 15 * 60;

// Mientras dicta por el walkie no está tecleando: si el teclado se mueve igual, es otra persona.
export const DICTANDO_RECIENTE = 120;

export const ESTADOS = ['en-la-compu', 'cerca', 'remoto', 'otro-en-la-mac'];

export function clasificar({ inactividadSeg, bloqueada = false, dictandoHaceSeg = Infinity }) {
  if (bloqueada) return 'remoto';
  if (!Number.isFinite(inactividadSeg)) return 'desconocido';
  const dictando = dictandoHaceSeg < DICTANDO_RECIENTE;
  // Nadie dicta y teclea al mismo tiempo: si pasan las dos cosas juntas, hay alguien más en la Mac.
  if (inactividadSeg < UMBRAL_COMPU) return dictando ? 'otro-en-la-mac' : 'en-la-compu';
  if (inactividadSeg < UMBRAL_CERCA) return 'cerca';
  return 'remoto';
}

const minutos = (seg) => Math.round(seg / 60);

// Lo que se le cuenta a Claude junto al mensaje dictado.
export function frasePresencia({ estado, inactividadSeg, bloqueada }) {
  const hace = Number.isFinite(inactividadSeg) ? ` (hace ${minutos(inactividadSeg)} min que no toca el teclado${bloqueada ? ' y la pantalla está bloqueada' : ''})` : '';
  if (estado === 'en-la-compu') {
    return 'El usuario está sentado frente a la Mac y la está usando: podés mostrarle cosas en pantalla, ' +
      'abrir un archivo o dejarle algo a la vista en la terminal.';
  }
  if (estado === 'cerca') {
    return `El usuario está cerca de la Mac pero no la está mirando${hace}: puede acercarse si vale la pena, ` +
      'así que si algo se entiende mejor en pantalla, decíselo en una frase antes de abrirlo.';
  }
  if (estado === 'otro-en-la-mac') {
    return 'Alguien está tocando la Mac justo mientras el usuario te habla por el walkie, así que ' +
      'probablemente no sea él: no des por hecho que ve la pantalla, contale todo hablado.';
  }
  if (estado === 'remoto') {
    return `El usuario le está hablando al walkie de lejos${hace}: no va a ver nada de lo que pase en la pantalla. ` +
      'Contale el resultado hablado, sin mandarlo a mirar la Mac, y dejá lo visual listo para cuando vuelva.';
  }
  return '';
}

// Hace cuánto que nadie toca el teclado ni el mouse. Lo sabe el propio macOS.
async function inactividad() {
  try {
    const { stdout } = await run('ioreg', ['-c', 'IOHIDSystem'], { timeout: 4000 });
    const m = stdout.match(/"HIDIdleTime"\s*=\s*(\d+)/);
    return m ? Math.round(Number(m[1]) / 1e9) : null;
  } catch {
    return null;
  }
}

// La pantalla bloqueada es un "no está" seguro, pero leerla necesita pyobjc: si no está, no pasa nada,
// alcanza con el tiempo de inactividad.
async function pantallaBloqueada() {
  try {
    const { stdout } = await run(
      'python3',
      ['-c', 'import Quartz; d = Quartz.CGSessionCopyCurrentDictionary(); print(1 if d and d.get("CGSSessionScreenIsLocked") else 0)'],
      { timeout: 4000 },
    );
    return stdout.trim() === '1';
  } catch {
    return false;
  }
}

export async function leerPresencia({ dictandoHaceSeg = Infinity } = {}) {
  const [inactividadSeg, bloqueada] = await Promise.all([inactividad(), pantallaBloqueada()]);
  const datos = { inactividadSeg: inactividadSeg ?? NaN, bloqueada, dictandoHaceSeg };
  return { ...datos, estado: clasificar(datos) };
}

// ---------- Vigilancia: alguien despertó la Mac mientras el usuario estaba lejos ----------

// Tocaron algo hace menos de esto: la Mac está despierta ahora mismo.
export const RECIEN_TOCADA = 60;
// No se avisa dos veces seguidas por lo mismo.
export const ESPERA_ENTRE_AVISOS = 10 * 60 * 1000;

// Decide si corresponde avisar al teléfono. Es pura: recibe el antes y el ahora.
//   previo:  la última lectura ('remoto', 'cerca', …) o null la primera vez
//   actual:  { estado, inactividadSeg }
//   ultimoAviso: cuándo se avisó por última vez (ms) o 0
export function despertaronLaMac({ previo, actual, ultimoAviso = 0, ahora = Date.now() }) {
  // Estando lejos no hay a quién avisarle de sí mismo; con "otro en la Mac" el aviso es el importante.
  if (previo !== 'remoto' && actual.estado !== 'otro-en-la-mac') return false;
  if (actual.estado === 'remoto') return false;
  if (!Number.isFinite(actual.inactividadSeg) || actual.inactividadSeg > RECIEN_TOCADA) return false;
  return ahora - ultimoAviso >= ESPERA_ENTRE_AVISOS;
}
