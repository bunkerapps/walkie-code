import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { recapFrom, readTail, projectDir } from '../lib/transcript.js';

const line = (entry) => JSON.stringify(entry);
const user = (content, extra = {}) => line({ type: 'user', message: { content }, timestamp: 't-user', ...extra });
const assistant = (parts) => line({ type: 'assistant', message: { content: parts }, timestamp: 't-claude' });

test('toma el último prompt real y la última respuesta en texto', () => {
  const jsonl = [
    user('pedido viejo'),
    assistant([{ type: 'text', text: 'respuesta vieja' }]),
    user('corré los tests'),
    assistant([{ type: 'thinking', thinking: '...' }, { type: 'tool_use', name: 'Bash' }]),
    user([{ type: 'tool_result', content: 'ok' }]),
    user('<command-name>/clear</command-name>'),
    user('texto interno', { isMeta: true }),
    assistant([{ type: 'text', text: 'Pasan los 74.' }]),
    line({ type: 'system' }),
  ].join('\n');
  const recap = recapFrom(jsonl);
  assert.equal(recap.prompt.text, 'corré los tests');
  assert.equal(recap.reply.text, 'Pasan los 74.');
  assert.equal(recap.working, false);
});

test('si Claude todavía no respondió el último prompt, lo marca como trabajando', () => {
  const jsonl = [
    user('hola'),
    assistant([{ type: 'text', text: 'hola, ¿qué hacemos?' }]),
    user('arreglá el login'),
    assistant([{ type: 'tool_use', name: 'Read' }]),
  ].join('\n');
  const recap = recapFrom(jsonl);
  assert.equal(recap.prompt.text, 'arreglá el login');
  assert.equal(recap.reply, null);
  assert.equal(recap.working, true);
});

test('lee solo el final del archivo y descarta la línea cortada', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'walkie-code-tail-'));
  const file = path.join(dir, 't.jsonl');
  await writeFile(file, `${'x'.repeat(100)}\n${user('último')}\n`);
  const tail = await readTail(file, 120);
  assert.ok(!tail.includes('xxx'));
  assert.equal(recapFrom(tail).prompt.text, 'último');
  await rm(dir, { recursive: true });
});

test('arma la carpeta del proyecto como Claude Code', () => {
  assert.equal(projectDir('/Users/diego/Development/super.precio', '/h'), '/h/.claude/projects/-Users-diego-Development-super-precio');
});
