#!/usr/bin/env node
// Barra de estado de Claude Code: guarda los límites de uso para la barra de vida del teléfono
// (~/.walkie-code/usage.json) y muestra en la terminal cuánto se usó.

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { HOME_DIR } from '../lib/config.js';
import { usageFrom, usageLine } from '../lib/usage.js';

let usage = null;
try {
  usage = usageFrom(JSON.parse(readFileSync(0, 'utf8')));
  if (usage) {
    mkdirSync(HOME_DIR, { recursive: true });
    const file = path.join(HOME_DIR, 'usage.json');
    writeFileSync(`${file}.tmp`, JSON.stringify(usage));
    renameSync(`${file}.tmp`, file);
  }
} catch {}
process.stdout.write(usageLine(usage));
