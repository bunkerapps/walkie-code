// Qué hacer cuando el canal sintonizado deja de verse.
//
// Claude Code se reinicia solo al aceptar la confianza de una carpeta nueva (y al actualizarse):
// por unos segundos no hay proceso `claude` en esa terminal y el canal desaparece de la lista.
// Mientras la pestaña de iTerm2 siga abierta, el canal se conserva en su lugar, marcado como
// `starting`, así el teléfono no suelta la sintonía y se va al CH01.

export const ESPERA_RECONEXION = 90000;

// `memoria`: { channel, index, sinVerDesde } de la última vez que se vio el canal elegido.
// Devuelve la memoria nueva y si hay que soltar la selección (la pestaña se cerró o no volvió).
export function reconectar({ channels, sessions = [], selectedId, memoria = null, ahora = Date.now(), espera = ESPERA_RECONEXION }) {
  if (!selectedId) return { channels, memoria: null, soltar: false };

  const vivo = channels.find((c) => c.id === selectedId);
  if (vivo) {
    return { channels, memoria: { channel: vivo, index: channels.indexOf(vivo), sinVerDesde: 0 }, soltar: false };
  }

  const pestaña = sessions.find((s) => s.id === selectedId);
  const sinVerDesde = memoria?.sinVerDesde || ahora;
  if (!pestaña || !memoria || ahora - sinVerDesde >= espera) {
    return { channels, memoria: null, soltar: true };
  }

  const salida = channels.slice();
  salida.splice(Math.min(memoria.index, salida.length), 0, {
    ...memoria.channel,
    tty: pestaña.tty || memoria.channel.tty,
    title: pestaña.title ?? memoria.channel.title,
    starting: true,
  });
  return { channels: salida, memoria: { ...memoria, sinVerDesde }, soltar: false };
}

// El orden de los canales no puede salir de iTerm2: `windows` viene en orden de frente, así que
// abrir una ventana nueva (o traer otra al frente) le cambiaba el número a todos los canales.
// Cada canal se queda con el número que le tocó al aparecer y los nuevos van al final.
// `orden`: Map de id de sesión -> número de llegada. Se modifica en el lugar.
export function ordenar(channels, orden = new Map()) {
  let ultimo = 0;
  for (const n of orden.values()) ultimo = Math.max(ultimo, n);
  for (const c of channels) if (!orden.has(c.id)) orden.set(c.id, ++ultimo);
  // Los canales cerrados se olvidan, así el contador no crece para siempre.
  for (const id of [...orden.keys()]) if (!channels.some((c) => c.id === id)) orden.delete(id);
  return channels.slice().sort((a, b) => orden.get(a.id) - orden.get(b.id));
}
