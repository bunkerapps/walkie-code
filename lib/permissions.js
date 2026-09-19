// Permisos contestados desde el teléfono. El hook PermissionRequest espera la respuesta y se la devuelve
// a Claude Code como decisión oficial (sin simular teclas en la terminal).
// Formato: https://code.claude.com/docs/en/hooks#permissionrequest-decision-control

const MAX_DETAIL = 600;

const short = (text, max = MAX_DETAIL) => {
  const t = String(text ?? '').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

// Qué quiere hacer Claude, para mostrarlo en la pantalla: el comando, el archivo o la URL.
export function describePermission(tool, input = {}) {
  if (!input || typeof input !== 'object') return { detail: '', summary: tool || 'una herramienta' };
  if (tool === 'Bash') return { detail: short(input.command), summary: input.description || 'correr un comando' };
  if (input.file_path) return { detail: input.file_path, summary: `${tool === 'Read' ? 'leer' : 'modificar'} ${input.file_path.split('/').pop()}` };
  if (input.url) return { detail: input.url, summary: 'abrir una página web' };
  return { detail: short(JSON.stringify(input)), summary: `usar ${tool}` };
}

// Lo que se dice por voz. Con la descripción que Claude le puso al comando se entiende mejor que con el comando.
export function permissionSpeech({ from = '', tool, summary }) {
  return `${from}Claude quiere ${tool === 'Bash' ? summary.charAt(0).toLowerCase() + summary.slice(1) : summary}. ¿Lo aprobás? Decí sí o no, o tocá un botón.`;
}

// "Siempre" = aprobar y aplicar las reglas que sugirió Claude Code, para que no vuelva a preguntar por lo mismo.
export const canAlways = (suggestions) => Array.isArray(suggestions) && suggestions.some((s) => s?.type === 'addRules');

// Salida del hook para Claude Code, o null si no hay decisión (entonces aparece el diálogo de siempre).
export function decisionOutput(decision, suggestions = []) {
  let body;
  if (decision === 'allow') body = { behavior: 'allow' };
  else if (decision === 'always') {
    body = { behavior: 'allow', updatedPermissions: (suggestions || []).filter((s) => s?.type === 'addRules') };
  } else if (decision === 'deny') {
    body = { behavior: 'deny', message: 'El usuario lo rechazó desde el walkie. Preguntale qué prefiere antes de seguir.' };
  } else return null;
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: body } });
}
