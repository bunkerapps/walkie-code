// La pregunta de confianza de Claude Code al entrar por primera vez en una carpeta.
//
// Ojo: el menú arranca con "No, exit" seleccionado, así que darle Enter de una cierra Claude Code
// (y el canal se queda en la shell). Hay que mover la selección hasta la opción que corresponde.

const OPCION = /(yes,?\s*i\s*trust\s*this\s*folder|no,?\s*exit)/i;
const ELEGIDA = /^[❯>▶»]/;

export const pideConfianza = (pantalla) => /trust this folder/i.test(String(pantalla));

// Cuántas flechas hay que mandar antes del Enter, según lo que se ve en la terminal.
export function elegirOpcion(pantalla, decision = 'allow') {
  const quiere = decision === 'deny' ? /no,?\s*exit/i : /trust\s*this\s*folder/i;
  const opciones = String(pantalla)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => OPCION.test(l));
  const actual = opciones.findIndex((l) => ELEGIDA.test(l));
  const destino = opciones.findIndex((l) => quiere.test(l));
  if (actual < 0 || destino < 0 || destino === actual) return { dir: null, veces: 0 };
  return { dir: destino > actual ? 'down' : 'up', veces: Math.abs(destino - actual) };
}
