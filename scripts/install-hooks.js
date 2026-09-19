#!/usr/bin/env node
// Registra el hook de walkie-code en ~/.claude/settings.json (Stop, PermissionRequest y UserPromptSubmit).
// Agrega sin tocar los hooks que ya existen, deja un backup y se puede correr varias veces.
// Con --remove lo saca.

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { withWalkieHooks, withWalkieStatusLine } from '../lib/hook-settings.js';

const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const HOOK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'claude-hook.js');
const COMMAND = `node "${HOOK}"`;
const STATUS_LINE = `node "${path.join(path.dirname(HOOK), 'statusline.js')}"`;
const remove = process.argv.includes('--remove');

const settings = existsSync(SETTINGS) ? JSON.parse(readFileSync(SETTINGS, 'utf8')) : {};
if (existsSync(SETTINGS)) copyFileSync(SETTINGS, `${SETTINGS}.walkie-code-backup`);

const withStatus = withWalkieStatusLine(withWalkieHooks(settings, COMMAND, { remove }), STATUS_LINE, { remove });
writeFileSync(SETTINGS, JSON.stringify(withStatus.settings, null, 2) + '\n');
console.log(remove ? 'Hooks de walkie-code eliminados.' : `Hooks de walkie-code instalados en ${SETTINGS}`);
if (!remove && !withStatus.installed) {
  console.log('Ya tenés otra barra de estado: la barra de vida del teléfono necesita que tu script');
  console.log(`le pase el mismo JSON a ${STATUS_LINE}.`);
}
console.log(`Backup: ${SETTINGS}.walkie-code-backup`);
