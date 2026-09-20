#!/usr/bin/env node
// Manda una página a la tele (Chromecast) y la deja recargándose sola mientras se la edita.
//
//   node scripts/cast.js <archivo.html> [--device "Nombre"]   proyecta (y publica la carpeta)
//   node scripts/cast.js --stop                               la saca de la tele
//   node scripts/cast.js --devices                            lista lo que hay en la red
//   node scripts/cast.js --status                             qué se está proyectando
//
// Solo dentro de `projectsRoot` (por defecto ~/Development).

import path from 'node:path';
import { loadConfig } from '../lib/config.js';

const cfg = loadConfig({ create: false });
if (!cfg.token) {
  console.error('Falta ~/.walkie-code/config.json: arrancá walkie-code al menos una vez.');
  process.exit(1);
}

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1] ?? true;
};

async function api(route, options = {}) {
  const res = await fetch(`http://127.0.0.1:${cfg.port}${route}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'X-Walkie-Token': cfg.token, ...options.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `error ${res.status}`);
  return body;
}

try {
  if (args.includes('--devices')) {
    const { devices, preferido } = await api('/api/cast/devices');
    for (const d of devices) console.log(`${d.name === preferido ? '*' : ' '} ${d.name.padEnd(22)} ${d.model} (${d.address})`);
  } else if (args.includes('--stop')) {
    await api('/api/cast/stop', { method: 'POST' });
    console.log('Fuera de la tele.');
  } else if (args.includes('--status')) {
    const { casting, device } = await api('/api/cast');
    console.log(casting ? `${path.basename(casting.file)} en ${casting.device} (${casting.url})` : `nada en la tele (preferido: ${device})`);
  } else {
    const file = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--device');
    if (!file) {
      console.error('Falta el archivo. Probá: node scripts/cast.js pagina.html');
      process.exit(1);
    }
    const body = { path: path.resolve(file), ...(flag('--device') ? { device: flag('--device') } : {}) };
    const out = await api('/api/cast', { method: 'POST', body: JSON.stringify(body) });
    console.log(`${path.basename(out.file)} en ${out.device}: ${out.url}`);
    console.log('Se recarga sola en la tele con cada cambio. Para sacarla: node scripts/cast.js --stop');
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
