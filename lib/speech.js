// Convierte una respuesta en markdown de Claude Code en texto que se pueda escuchar.
// En voz no aportan los bloques de código, las tablas, las URLs ni las rutas completas.

const MAX_CHARS = 1400;

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

const basename = (p) => p.replace(/\/+$/, '').split('/').pop();

export function toSpeech(markdown) {
  if (!markdown) return '';
  let t = markdown.replace(/\r\n/g, '\n');

  t = t.replace(/```[^\n]*\n([\s\S]*?)(```|$)/g, (_, code) => {
    const lines = code.trimEnd().split('\n').length;
    return `\nHay un bloque de código de ${plural(lines, 'línea', 'líneas')}.\n`;
  });

  t = t.replace(/(?:^\|.*\|[ \t]*\n?)+/gm, (table) => {
    const rows = table.trim().split('\n').filter((r) => !/^\|[\s:|-]+\|$/.test(r.trim()));
    return `\nHay una tabla de ${plural(Math.max(rows.length - 1, 0), 'fila', 'filas')}.\n`;
  });

  t = t.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
  t = t.replace(/https?:\/\/\S+/g, 'un enlace');

  t = t.replace(/`([^`\n]+)`/g, (_, code) => (code.includes('/') ? basename(code) : code));
  t = t.replace(/(?:~|\.{1,2})?(?:\/[\w.@-]+){2,}\/?(?::\d+)?/g, (p) => basename(p.replace(/:\d+$/, '')));

  t = t
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+\[[ xX]\]\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|\W)[*_](\S[^*_]*?)[*_](?=\W|$)/g, '$1$2')
    .replace(/^[-*_]{3,}$/gm, '');

  // Cada línea suelta pasa a ser una frase, para que la voz haga pausa.
  t = t
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (/[.!?:;,]$/.test(l) ? l : `${l}.`))
    .join(' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (t.length > MAX_CHARS) {
    const cut = t.slice(0, MAX_CHARS);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
    t = `${end > 200 ? cut.slice(0, end + 1) : cut} La respuesta sigue en la terminal.`;
  }
  return t;
}

const cut = (text, max) => (text.length <= max ? text : `${text.slice(0, text.lastIndexOf(' ', max) > 0 ? text.lastIndexOf(' ', max) : max)}…`);

// Resumen hablado de un canal: lo último que se pidió y lo que respondió Claude.
export function recapSpeech(project, { prompt, reply, working }) {
  const parts = [`Lo último en ${project}.`];
  if (prompt) parts.push(`Pediste: ${cut(toSpeech(prompt.text), 220)}`);
  if (working) parts.push('Claude todavía está trabajando en eso.');
  else if (reply) parts.push(`Claude respondió: ${toSpeech(reply.text)}`);
  return parts.join(' ');
}

// Frases que Whisper inventa cuando el audio es solo silencio o ruido.
const HALLUCINATIONS = [
  /subt[ií]tulos? (realizados|por)/i,
  /amara\.org/i,
  /^gracias( por ver)?[.!]*$/i,
  /^¡?suscr[ií]bete/i,
  /^\[.*\]$/,
  /^\(.*\)$/,
];

export function cleanTranscript(text) {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  if (!t || HALLUCINATIONS.some((re) => re.test(t))) return '';
  return t;
}

const YES = /^(s[ií]|dale|ok(ey)?|okay|aprobar|aprobado|acepto|aceptar|adelante|hacelo|de una)[.!]*$/i;
const NO = /^(no|cancel(ar|á)|rechaz(ar|o|á)|par(ar|á))[.!]*$/i;

// Respuesta corta a un pedido de permiso de Claude Code: 'yes', 'no' o null.
export function permissionAnswer(text) {
  const t = text.trim().replace(/^[¡¿]/, '');
  if (YES.test(t)) return 'yes';
  if (NO.test(t)) return 'no';
  return null;
}
