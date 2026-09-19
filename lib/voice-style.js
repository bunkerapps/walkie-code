// Estilo de respuesta para los mensajes que llegan desde el walkie.
// El hook UserPromptSubmit le suma esta instrucción al contexto de Claude,
// solo cuando el mensaje lo dictó el teléfono: lo tipeado en la Mac no cambia.

// Único lugar donde vive el texto de la instrucción.
export const VOICE_STYLE =
  'Este mensaje lo dictó el usuario por voz desde el teléfono (walkie-code) y tu respuesta se le va a leer en voz alta. ' +
  'Contestá en su idioma, corto y conversacional, como si se lo dijeras en persona: pocas frases, sin títulos, ' +
  'sin listas largas, sin tablas y sin bloques de código. Si hace falta código o una tabla, ponela igual pero ' +
  'mencionala en una frase ("te dejé el comando en la terminal") en vez de describirla. ' +
  'Evitá rutas completas, URLs y símbolos que no se pueden leer; nombrá los archivos por su nombre. ' +
  'Esto cambia solo la forma de la respuesta, no lo que tenés que hacer.';

// Cuánto puede tardar el prompt dictado en llegar al hook. Si Claude estaba ocupado,
// Claude Code lo encola y lo manda recién cuando termina el turno.
export const PROMPT_TTL_MS = 30 * 60 * 1000;

const normalize = (text) => String(text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

// ¿El prompt que recibió Claude Code es el que dictamos desde el teléfono?
// No alcanza con que la terminal esté esperando respuesta: el usuario puede tipear en la Mac
// mientras tanto. Se compara el texto; `includes` porque si había algo escrito a medias
// en la línea de Claude Code, lo dictado se agrega al final.
export function isDictated(sent, prompt, now = Date.now()) {
  if (!sent?.text || now - sent.at > PROMPT_TTL_MS) return false;
  const want = normalize(sent.text);
  return want.length > 0 && normalize(prompt).includes(want);
}

// Salida del hook en el formato de Claude Code para UserPromptSubmit.
export function promptContextOutput(context) {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } });
}
