import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

// SUPERVOZ_HOME permite levantar una segunda instancia de prueba sin tocar la configuración real.
export const HOME_DIR = process.env.SUPERVOZ_HOME || path.join(os.homedir(), '.supervoz');
export const CONFIG_PATH = path.join(HOME_DIR, 'config.json');

const DEFAULTS = {
  port: 8787,
  whisperPort: 8788,
  language: 'es',
  // Voz de `say` para las respuestas (`say -v '?'` lista las disponibles) y palabras por minuto.
  voice: 'Paulina',
  rate: 190,
  // Desde el teléfono solo se pueden abrir sesiones nuevas dentro de esta carpeta.
  projectsRoot: path.join(os.homedir(), 'Development'),
  claudeCommand: 'claude',
  model: path.join(HOME_DIR, 'models', 'ggml-large-v3-turbo-q5_0.bin'),
  // Vocabulario que Whisper suele transcribir mal en una charla de programación.
  // Contacto que va en la firma VAPID de los avisos push (Apple lo exige: mailto: o https:).
  pushSubject: 'https://bunkerapps.net',
  whisperPrompt: 'Claude Code, commit, push, deploy, branch, merge, React, Node, npm, TypeScript, endpoint, API, bug, test, refactor.',
};

// Guarda cambios hechos desde el teléfono (por ahora, la voz y su velocidad).
export function saveConfig(changes) {
  const current = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) : {};
  writeFileSync(CONFIG_PATH, JSON.stringify({ ...current, ...changes }, null, 2) + '\n', { mode: 0o600 });
}

// Lee ~/.supervoz/config.json y genera el token la primera vez.
// Lo usan tanto el servidor como el hook de Claude Code.
export function loadConfig({ create = true } = {}) {
  let cfg = {};
  if (existsSync(CONFIG_PATH)) cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  cfg = { ...DEFAULTS, ...cfg };
  if (!cfg.token && create) {
    cfg.token = randomBytes(16).toString('hex');
    mkdirSync(HOME_DIR, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  }
  return cfg;
}
