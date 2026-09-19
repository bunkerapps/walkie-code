#!/usr/bin/env node
// Registra el hook de walkie-code en ~/.claude/settings.json (Stop, PermissionRequest y UserPromptSubmit).
// Agrega sin tocar los hooks que ya existen, deja un backup y se puede correr varias veces.
// Con --remove lo saca.

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { withWalkieHooks } from '../lib/hook-settings.js';

const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const HOOK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'claude-hook.js');
const COMMAND = `node "${HOOK}"`;
const remove = process.argv.includes('--remove');

const settings = existsSync(SETTINGS) ? JSON.parse(readFileSync(SETTINGS, 'utf8')) : {};
if (existsSync(SETTINGS)) copyFileSync(SETTINGS, `${SETTINGS}.walkie-code-backup`);

writeFileSync(SETTINGS, JSON.stringify(withWalkieHooks(settings, COMMAND, { remove }), null, 2) + '\n');
console.log(remove ? 'Hooks de walkie-code eliminados.' : `Hooks de walkie-code instalados en ${SETTINGS}`);
console.log(`Backup: ${SETTINGS}.walkie-code-backup`);
