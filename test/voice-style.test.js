import { test } from 'node:test';
import assert from 'node:assert/strict';
import { garbledTail, voiceContext, VOICE_STYLE, PROMPT_TTL_MS, isDictated, promptContextOutput } from '../lib/voice-style.js';
import { withWalkieHooks, EVENTS } from '../lib/hook-settings.js';

const now = 1_000_000_000;
const sent = (text, ago = 1000) => ({ text, at: now - ago });

test('reconoce el prompt dictado aunque cambien espacios y mayúsculas', () => {
  assert.ok(isDictated(sent('Corré los tests'), '  corré   los tests\n', now));
});

test('lo dictado puede sumarse a algo que estaba escrito a medias', () => {
  assert.ok(isDictated(sent('y después hacé commit'), 'arreglá el bug y después hacé commit', now));
});

test('un mensaje tipeado en la Mac no se toma como dictado', () => {
  assert.equal(isDictated(sent('corré los tests'), 'mostrame el diff', now), false);
  assert.equal(isDictated(null, 'corré los tests', now), false);
  assert.equal(isDictated(sent(''), 'lo que sea', now), false);
});

test('lo dictado hace mucho ya no cuenta', () => {
  assert.equal(isDictated(sent('corré los tests', PROMPT_TTL_MS + 1), 'corré los tests', now), false);
});

test('la salida del hook tiene el formato de UserPromptSubmit', () => {
  const out = JSON.parse(promptContextOutput(VOICE_STYLE));
  assert.deepEqual(out, { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: VOICE_STYLE } });
});

const CMD = 'node "/Users/x/Development/walkie-code/hooks/claude-hook.js"';
const ajeno = { type: 'command', command: 'afplay /System/Library/Sounds/Glass.aiff' };

test('el instalador registra los tres eventos sin tocar hooks ajenos', () => {
  const settings = { model: 'opus', hooks: { Stop: [{ hooks: [ajeno] }], PreToolUse: [{ matcher: 'Bash', hooks: [ajeno] }] } };
  const out = withWalkieHooks(settings, CMD);
  assert.equal(out.model, 'opus');
  assert.deepEqual(out.hooks.PreToolUse, settings.hooks.PreToolUse);
  assert.deepEqual(out.hooks.Stop[0], { hooks: [ajeno] });
  for (const event of Object.keys(EVENTS)) {
    const ours = out.hooks[event].flatMap((g) => g.hooks).filter((h) => h.command === CMD);
    assert.equal(ours.length, 1, event);
  }
  assert.equal(out.hooks.UserPromptSubmit.at(-1).hooks[0].timeout, 3);
});

test('instalar dos veces da lo mismo, y --remove deja solo lo ajeno', () => {
  const settings = { hooks: { Stop: [{ hooks: [ajeno] }] } };
  const once = withWalkieHooks(settings, CMD);
  assert.deepEqual(withWalkieHooks(once, CMD), once);
  assert.deepEqual(withWalkieHooks(once, CMD, { remove: true }), settings);
});

test('reemplaza una versión vieja del hook que estaba en otro grupo', () => {
  const viejo = { type: 'command', command: 'node "/otra/ruta/walkie-code/hooks/claude-hook.js"', timeout: 5 };
  const out = withWalkieHooks({ hooks: { Stop: [{ hooks: [ajeno, viejo] }] } }, CMD);
  assert.deepEqual(out.hooks.Stop, [{ hooks: [ajeno] }, { hooks: [{ type: 'command', command: CMD, timeout: 5 }] }]);
});

test('garbledTail encuentra la cola alucinada en otro idioma', () => {
  assert.equal(garbledTail('Sí, þá er það með.'), 'þá er það með.');
  assert.equal(garbledTail('Perfecto, la právi vita að fungina því.'), 'að fungina því.');
});

test('garbledTail no marca español normal, números ni signos', () => {
  for (const text of ['¿Podés subirlo? Sí, ahora.', 'Pingüino, año 2026: 50 % — listo…', '']) {
    assert.equal(garbledTail(text), null, text);
  }
  assert.equal(garbledTail('þá', 'en'), null); // otros idiomas: sin heurística
});

test('voiceContext suma el aviso solo si hay una parte dudosa', () => {
  assert.equal(voiceContext('Subilo a GitHub', 'es'), VOICE_STYLE);
  assert.match(voiceContext('Sí, þá er það með.', 'es'), /«þá er það með\.»/);
});
