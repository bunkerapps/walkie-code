import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describePermission, permissionSpeech, canAlways, decisionOutput } from '../lib/permissions.js';

test('describe lo que quiere hacer Claude', () => {
  assert.deepEqual(describePermission('Bash', { command: 'git push origin main', description: 'Subir los cambios' }),
    { detail: 'git push origin main', summary: 'Subir los cambios' });
  assert.deepEqual(describePermission('Edit', { file_path: '/p/server.js' }), { detail: '/p/server.js', summary: 'modificar server.js' });
  assert.deepEqual(describePermission('WebFetch', { url: 'https://x.dev' }), { detail: 'https://x.dev', summary: 'abrir una página web' });
  assert.equal(describePermission('Bash', { command: 'x'.repeat(900) }).detail.length, 600);
});

test('lo que se dice por voz', () => {
  assert.equal(permissionSpeech({ tool: 'Bash', summary: 'Subir los cambios' }),
    'Claude quiere subir los cambios. ¿Lo aprobás? Decí sí o no, o tocá un botón.');
  assert.equal(permissionSpeech({ from: 'Desde vecinos. ', tool: 'Edit', summary: 'modificar app.js' }),
    'Desde vecinos. Claude quiere modificar app.js. ¿Lo aprobás? Decí sí o no, o tocá un botón.');
});

test('arma la decisión en el formato de Claude Code', () => {
  const rules = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }], behavior: 'allow', destination: 'localSettings' }];
  assert.deepEqual(JSON.parse(decisionOutput('allow')), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  assert.deepEqual(JSON.parse(decisionOutput('always', [...rules, { type: 'setMode', mode: 'bypassPermissions' }])).hookSpecificOutput.decision,
    { behavior: 'allow', updatedPermissions: rules });
  assert.equal(JSON.parse(decisionOutput('deny')).hookSpecificOutput.decision.behavior, 'deny');
  assert.equal(decisionOutput(null), null);
  assert.equal(canAlways(rules), true);
  assert.equal(canAlways([{ type: 'setMode' }]), false);
});
