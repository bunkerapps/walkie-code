// Cuando un turno termina por un error de la API (hook StopFailure): qué decirle al usuario.
// Lo más importante es el límite de uso: sin esto, el walkie se queda en "CLAUDE PIENSA" para siempre.

const ERROR_TEXT = {
  overloaded: 'los servidores de Claude están sobrecargados',
  server_error: 'hubo un error en los servidores de Claude',
  authentication_failed: 'se venció el inicio de sesión de Claude Code',
  billing_error: 'hay un problema con la facturación de la cuenta',
  max_output_tokens: 'la respuesta superó el largo máximo',
  invalid_request: 'el pedido no fue válido',
};

// "You've hit your session limit · resets 11:10pm (America/Cordoba)" → "23:10".
export function resetTime(text) {
  const match = String(text || '').match(/resets\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minutes = match[2] || '00';
  const half = match[3]?.toLowerCase();
  if (half === 'pm' && hour < 12) hour += 12;
  if (half === 'am' && hour === 12) hour = 0;
  return `${String(hour).padStart(2, '0')}:${minutes}`;
}

// El mensaje de error que Claude Code dejó al final de la transcripción (el más reciente que hable de límites).
export function limitMessage(jsonl) {
  const lines = String(jsonl || '').trim().split('\n');
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 40); i--) {
    if (/resets|limit/i.test(lines[i])) {
      const found = lines[i].match(/[^"]*(?:limit|resets)[^"]*/i);
      if (found) return found[0];
    }
  }
  return null;
}

export function failureSpeech(errorType, project, reset) {
  if (errorType === 'rate_limit') {
    return `Claude llegó al límite de uso${reset ? ` y se renueva a las ${reset}` : ''}. Lo de ${project} quedó sin terminar.`;
  }
  return `Claude se cortó en ${project}: ${ERROR_TEXT[errorType] || 'hubo un error de la API'}.`;
}
