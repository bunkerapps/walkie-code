#!/usr/bin/env node
// Cambia el token del walkie desde la Mac y muestra el enlace nuevo.
//
//   node scripts/token.js            cambia el token
//   node scripts/token.js --ver      solo muestra el enlace actual
//
// El enlace viejo deja de servir en el acto y todos los teléfonos tienen que volver a entrar.

import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig, saveConfig } from '../lib/config.js';

const run = promisify(execFile);
const cfg = loadConfig({ create: false });

if (!cfg.token) {
  console.error('Falta la configuración: arrancá walkie-code al menos una vez.');
  process.exit(1);
}

// El nombre de la Mac en el tailnet: es por donde entra el teléfono.
async function direccion() {
  try {
    const { stdout } = await run('tailscale', ['serve', 'status'], { timeout: 5000 });
    const m = stdout.match(/https:\/\/[^\s]+/);
    if (m) return m[0].replace(/\/$/, '');
  } catch {}
  return `http://127.0.0.1:${cfg.port}`;
}

const ver = process.argv.includes('--ver');
const token = ver ? cfg.token : randomBytes(16).toString('hex');

if (!ver) {
  saveConfig({ token });
  console.log('Token cambiado. Los enlaces viejos ya no sirven.');
}

const base = await direccion();
console.log(`\n  ${base}/?t=${token}\n`);

if (!ver) {
  console.log('Abrí ese enlace en el teléfono y volvé a agregar la app a la pantalla de inicio.');
  console.log('Si el servidor está corriendo, reiniciálo para que lo tome: ./scripts/service.sh restart');
}
