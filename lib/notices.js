// Avisos de los canales a los que no se les habló desde el teléfono.
// Típico: el usuario lanza una tarea larga desde la Mac y se va; cuando termina (o Claude
// pide permiso) el teléfono suena con un aviso corto. Las respuestas rápidas no avisan,
// para no molestar mientras trabaja en la Mac.

import path from 'node:path';

export const NOTICE_DEFAULTS = { notices: true, notifyAfterSeconds: 60 };
export const NOTICE_LIMITS = [10, 3600];

// Umbral en segundos, acotado a valores razonables.
export function clampSeconds(value, fallback = NOTICE_DEFAULTS.notifyAfterSeconds) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(NOTICE_LIMITS[1], Math.max(NOTICE_LIMITS[0], n));
}

// Decide si un hook de un canal merece aviso. Devuelve null o { kind, seconds }.
//   event:     'Stop' | 'PermissionRequest' | 'Notification'
//   kind:      'permission' si Claude pide permiso
//   pending:   si al canal se le habló desde el teléfono (eso ya se lee entero, no es aviso)
//   startedAt: cuándo empezó el turno (UserPromptSubmit), en ms; null si no se sabe
export function decideNotice({ event, kind, pending, startedAt, now = Date.now(), enabled, afterSeconds }) {
  if (!enabled || pending) return null;
  // Los permisos van bloqueando a Claude: se avisan siempre.
  if (kind === 'permission') return { kind: 'permission', seconds: elapsed(startedAt, now) };
  if (event !== 'Stop' || !startedAt) return null;
  const seconds = elapsed(startedAt, now);
  return seconds >= clampSeconds(afterSeconds) ? { kind: 'done', seconds } : null;
}

const elapsed = (startedAt, now) => (startedAt ? Math.max(0, Math.round((now - startedAt) / 1000)) : null);

// Lo que se dice en voz alta: corto, el detalle queda en la pantalla.
export function noticeSpeech(project, notice, tool = '') {
  if (notice.kind === 'permission') return `${project} necesita permiso para ${tool ? `usar ${tool}` : 'seguir'}.`;
  return `Terminó ${project}.`;
}

// "45 S", "4 MIN", "1 H 20 MIN": para el renglón de la pantalla.
export function durationLabel(seconds) {
  if (seconds == null) return '';
  if (seconds < 60) return `${seconds} S`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} MIN`;
  const rest = minutes % 60;
  return `${Math.floor(minutes / 60)} H${rest ? ` ${rest} MIN` : ''}`;
}

// Nombre del proyecto cuando no se encuentra el canal en iTerm2: el propio o el de la carpeta.
export function projectFromCwd(cwd, names = {}) {
  if (!cwd) return 'Claude';
  return names[cwd] || path.basename(cwd) || 'Claude';
}
