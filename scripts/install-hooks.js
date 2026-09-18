#!/usr/bin/env node
// Registra el hook de supervoz en ~/.claude/settings.json (Stop, PermissionRequest y UserPromptSubmit).
// Agrega sin tocar los hooks que ya existen, deja un backup y se puede correr varias veces.
// Con --remove lo saca.

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { withSupervozHooks } from '../lib/hook-settings.js';

const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const HOOK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'claude-hook.js');
const COMMAND = `node "${HOOK}"`;
const remove = process.argv.includes('--remove');

const settings = existsSync(SETTINGS) ? JSON.parse(readFileSync(SETTINGS, 'utf8')) : {};
if (existsSync(SETTINGS)) copyFileSync(SETTINGS, `${SETTINGS}.supervoz-backup`);

writeFileSync(SETTINGS, JSON.stringify(withSupervozHooks(settings, COMMAND, { remove }), null, 2) + '\n');
console.log(remove ? 'Hooks de supervoz eliminados.' : `Hooks de supervoz instalados en ${SETTINGS}`);
console.log(`Backup: ${SETTINGS}.supervoz-backup`);
