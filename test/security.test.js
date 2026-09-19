import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTranscriptPath } from '../lib/transcript.js';
import { cleanForTerminal } from '../lib/iterm.js';

test('solo acepta transcripciones de Claude Code', () => {
  assert.equal(isTranscriptPath('/h/.claude/projects/-a/x.jsonl', '/h'), true);
  assert.equal(isTranscriptPath('/h/.claude/projects/../../etc/passwd.jsonl', '/h'), false);
  assert.equal(isTranscriptPath('/etc/passwd', '/h'), false);
  assert.equal(isTranscriptPath('/h/.claude/projects/-a/x.txt', '/h'), false);
  assert.equal(isTranscriptPath('relativo/x.jsonl', '/h'), false);
  assert.equal(isTranscriptPath(null, '/h'), false);
});

test('lo que se escribe en la terminal no lleva caracteres de control', () => {
  const esc = String.fromCharCode(27);
  const ctrlC = String.fromCharCode(3);
  assert.equal(cleanForTerminal(`hola\rrm -rf${esc}[A${ctrlC} chau`), 'hola rm -rf [A chau');
  assert.equal(cleanForTerminal('  corré los tests\n'), 'corré los tests');
  assert.equal(cleanForTerminal('acentos ñ ¿ok?'), 'acentos ñ ¿ok?');
});
