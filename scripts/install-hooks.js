#!/usr/bin/env node
// Registra el hook de supervoz en ~/.claude/settings.json
// (Stop, PermissionRequest y UserPromptSubmit, este último para medir cuánto dura cada turno).
// Agrega sin tocar los hooks que ya existen, deja un backup y se puede correr varias veces.
// Con --remove lo saca.

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const HOOK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'claude-hook.js');
const COMMAND = `node "${HOOK}"`;
const EVENTS = ['Stop', 'PermissionRequest', 'UserPromptSubmit'];
const remove = process.argv.includes('--remove');

const settings = existsSync(SETTINGS) ? JSON.parse(readFileSync(SETTINGS, 'utf8')) : {};
if (existsSync(SETTINGS)) copyFileSync(SETTINGS, `${SETTINGS}.supervoz-backup`);
settings.hooks ??= {};

const isOurs = (h) => h.command?.includes('supervoz') && h.command.includes('claude-hook.js');

for (const event of EVENTS) {
  const groups = (settings.hooks[event] ?? [])
    .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h)) }))
    .filter((g) => g.hooks.length > 0);
  if (!remove) groups.push({ hooks: [{ type: 'command', command: COMMAND, timeout: 5 }] });
  if (groups.length) settings.hooks[event] = groups;
  else delete settings.hooks[event];
}

writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
console.log(remove ? 'Hooks de supervoz eliminados.' : `Hooks de supervoz instalados en ${SETTINGS}`);
console.log(`Backup: ${SETTINGS}.supervoz-backup`);
