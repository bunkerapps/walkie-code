import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usageFrom, usageLine } from '../lib/usage.js';

test('usageFrom toma las dos ventanas y normaliza la hora de renovación', () => {
  const usage = usageFrom({
    rate_limits: {
      five_hour: { used_percentage: 34.2, resets_at: 1790000000 },
      seven_day: { used_percentage: 12, resets_at: '2026-09-22T10:00:00Z' },
    },
  }, 0);
  assert.equal(usage.fiveHour.used, 34.2);
  assert.equal(usage.fiveHour.resetsAt, new Date(1790000000 * 1000).toISOString());
  assert.equal(usage.sevenDay.resetsAt, '2026-09-22T10:00:00.000Z');
  assert.equal(usageLine(usage), '📻 5h 34% · 7d 12%');
});

test('usageFrom devuelve null sin límites (API key, versiones viejas)', () => {
  assert.equal(usageFrom({}), null);
  assert.equal(usageFrom({ rate_limits: { five_hour: {} } }), null);
  assert.equal(usageLine(null), '');
});

test('usageFrom recorta porcentajes fuera de rango', () => {
  assert.equal(usageFrom({ rate_limits: { five_hour: { used_percentage: 130 } } }).fiveHour.used, 100);
});

import { withWalkieStatusLine } from '../lib/hook-settings.js';

const OURS = 'node "/x/walkie-code/hooks/statusline.js"';

test('la barra de estado se instala solo si no hay otra', () => {
  assert.equal(withWalkieStatusLine({}, OURS).settings.statusLine.command, OURS);
  const other = { statusLine: { type: 'command', command: 'mi-barra.sh' } };
  const kept = withWalkieStatusLine(other, OURS);
  assert.equal(kept.installed, false);
  assert.equal(kept.settings.statusLine.command, 'mi-barra.sh');
});

test('--remove saca solo la nuestra', () => {
  assert.equal(withWalkieStatusLine({ statusLine: { command: OURS } }, OURS, { remove: true }).settings.statusLine, undefined);
  const other = { statusLine: { command: 'mi-barra.sh' } };
  assert.equal(withWalkieStatusLine(other, OURS, { remove: true }).settings.statusLine.command, 'mi-barra.sh');
});
