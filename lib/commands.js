// Comandos de voz del walkie: "canal superprecio", "canal tres", "pasame a bunkerapps".
// Todo es puro (sin iTerm2 ni red) para poder probarlo con frases reales de Whisper.
//
// La detección es conservadora: la frase tiene que EMPEZAR con el comando.
// - Fuerte: nombra el canal ("canal …", "cambiá al canal …", "sintonizá …"). Si no hay
//   coincidencia se avisa por voz y no se le manda nada a Claude.
// - Débil: un verbo de movimiento sin la palabra canal ("pasame a bunkerapps"). Solo cambia
//   si coincide con un proyecto o carpeta; si no, la frase va a Claude como siempre
//   ("cambiá a TypeScript el archivo" no es un cambio de canal).

const MAX_WORDS = 4;

// Minúsculas, sin acentos y sin puntuación: "¡Canal Súper-Precio!" -> "canal super precio".
export function normalize(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Para comparar nombres: "super precio", "super-precio" y "superprecio" son lo mismo.
export const compact = (text) => normalize(text).replace(/ /g, '');

// ---------- Números en letras ----------

const UNITS = ['', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve'];
const TEENS = ['diez', 'once', 'doce', 'trece', 'catorce', 'quince', 'dieciseis', 'diecisiete', 'dieciocho', 'diecinueve'];

function numberWords() {
  const words = new Map([['un', 1], ['una', 1], ['primero', 1], ['primer', 1], ['segundo', 2], ['tercero', 3], ['tercer', 3]]);
  UNITS.forEach((w, n) => n && words.set(w, n));
  TEENS.forEach((w, i) => words.set(w, 10 + i));
  UNITS.forEach((w, n) => n > 5 && words.set(`diezy${w}`, 10 + n)); // "diez y seis"
  words.set('veinte', 20);
  words.set('treinta', 30);
  UNITS.forEach((w, n) => {
    if (!n) return;
    words.set(`veinti${w}`, 20 + n); // "veintitres"
    words.set(`veintey${w}`, 20 + n); // "veinte y tres"
  });
  words.set('veintiun', 21);
  return words;
}

const NUMBER_WORDS = numberWords();

// "3", "03", "tres", "número tres", "veinti tres" -> 3. Cualquier otra cosa -> null.
export function parseNumber(text) {
  const c = compact(text);
  if (/^\d{1,3}$/.test(c)) return Number(c) || null;
  return NUMBER_WORDS.get(c) ?? null;
}

// ---------- Frases ----------

const VERB = '(?:cambia(?:me|te)?|pasa(?:me|te)?|ir|anda|andate|volve|volvete|vamos|move(?:me|te)?|pone(?:me)?|sintoniza(?:me)?)';
const TO = '(?:(?:a|al|a la|en|en el|el|para|para el)\\s+)';

// El canal con nombre explícito: "canal 3", "cambiá al canal de la landing", "poné el canal dos", "CH03".
// Sin verbo tiene que arrancar directo con "canal": "el canal 3 no anda" es para Claude.
const STRONG = new RegExp(`^(?:${VERB}\\s+${TO}?)?(?:canal\\s+|ch\\s*(?=\\d))(.+)$`);
// "Sintonizá" solo se usa para canales: "sintonizá superprecio".
const TUNE = new RegExp(`^sintoniza(?:me)?\\s+${TO}?(.+)$`);
// Verbo de movimiento y destino, sin la palabra canal: "pasame a bunkerapps", "andá al tres".
// Acá van menos verbos: "volvé a correr los tests" o "vamos a probar" son pedidos para Claude.
const WEAK_VERB = '(?:cambia(?:me|te)?|pasa(?:me|te)?|ir|anda(?:te)?|move(?:me|te)?)';
const WEAK = new RegExp(`^${WEAK_VERB}\\s+(?:a|al|a la)\\s+(.+)$`);

const LEADING = /^(?:de la|del|de|la|el|los|las|numero|nro|n|proyecto|carpeta|sesion|terminal)\s+/;
const TRAILING = /\s+(?:por favor|porfa|porfis|gracias|che)$/;

function cleanQuery(rest) {
  let q = rest.trim();
  for (let prev; prev !== q; ) {
    prev = q;
    q = q.replace(LEADING, '').replace(TRAILING, '');
  }
  return q;
}

// Devuelve { query, number, strong } si la frase es un cambio de canal, o null.
export function parseChannelCommand(text) {
  const t = normalize(text);
  const strong = t.match(STRONG) || t.match(TUNE);
  const match = strong || t.match(WEAK);
  if (!match) return null;
  const query = cleanQuery(match[1]);
  const words = query.split(' ');
  if (!query || words.length > MAX_WORDS) return null;
  // "canal 3 no anda": un número seguido de más palabras es una frase, no un canal.
  if (words.length > 1 && /^\d+$/.test(words[0])) return null;
  return { query, number: parseNumber(query), strong: Boolean(strong) };
}

// ---------- Búsqueda del canal ----------

// Distancia de Levenshtein, para errores chicos de transcripción ("super prezio").
export function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

// Cómo suena en castellano, para nombres en inglés que Whisper escribe de oído:
// "Kick Way" ~ "Quickway", "Super Bos" ~ "supervoz".
export function phonetic(text) {
  return compact(text)
    .replace(/qu/g, 'k')
    .replace(/c(?=[ei])/g, 's')
    .replace(/c/g, 'k')
    .replace(/z/g, 's')
    .replace(/v/g, 'b')
    .replace(/w/g, 'u')
    .replace(/ll/g, 'y')
    .replace(/h/g, '')
    .replace(/(.)\1+/g, '$1');
}

const tolerance = (q) => (q.length < 4 ? 0 : Math.max(1, Math.floor(q.length / 5)));

// Qué tan bien coincide el pedido con un nombre: 4 exacto, 3 empieza con, 2 contiene, 1 parecido, 0 nada.
export function matchLevel(query, name) {
  const q = compact(query);
  const n = compact(name);
  if (!q || !n) return 0;
  if (n === q) return 4;
  if (n.startsWith(q)) return 3;
  if (q.length >= 3 && n.includes(q)) return 2;
  const max = tolerance(q);
  if (!max) return 0;
  const words = normalize(name).split(' ');
  const near = (a, list) => list.some((w) => editDistance(a, w) <= max);
  if (near(q, [n, n.slice(0, q.length), ...words])) return 1;
  const pq = phonetic(q);
  const pn = phonetic(n);
  return near(pq, [pn, pn.slice(0, pq.length), ...words.map(phonetic)]) ? 1 : 0;
}

// El proyecto y la carpeta pesan más que el título de la tarea a igual nivel.
function score(query, channel, fields) {
  let best = 0;
  for (const field of fields) {
    const level = matchLevel(query, channel[field]);
    if (level) best = Math.max(best, level * 2 + (field === 'title' ? 0 : 1));
  }
  return best;
}

// Busca el canal pedido entre los de la pantalla ({ id, project, folder, title, number }).
// Devuelve { channel } si hay uno claro, { candidates } si hay empate o { candidates: [] } si nada.
export function findChannel(command, channels) {
  if (command.number) {
    const channel = channels.find((c) => c.number === command.number);
    return channel ? { channel } : { candidates: [] };
  }
  // Sin la palabra canal es demasiado fácil coincidir de casualidad: no se busca en el título
  // de la tarea y el nombre tiene que ser igual o empezar con lo dicho.
  const fields = command.strong ? ['project', 'folder', 'title'] : ['project', 'folder'];
  const min = command.strong ? 1 : 3 * 2 + 1;
  const scored = channels
    .map((channel) => ({ channel, score: score(command.query, channel, fields) }))
    .filter((s) => s.score >= min)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return { candidates: [] };
  const top = scored.filter((s) => s.score === scored[0].score).map((s) => s.channel);
  return top.length === 1 ? { channel: top[0] } : { candidates: top };
}

// ---------- Lo que se dice cuando no se pudo cambiar ----------

const spoken = (project) => project.replace(/·/g, ' ');

export function missSpeech(command, result, total) {
  const { candidates } = result;
  if (candidates.length > 1) {
    const list = candidates.slice(0, 3).map((c) => `canal ${c.number}, ${spoken(c.project)}`);
    const count = candidates.length === 2 ? 'dos' : candidates.length === 3 ? 'tres' : String(candidates.length);
    return `Hay ${count} canales parecidos: ${list.join('; ')}. Decí el número.`;
  }
  if (command.number) {
    return total === 1 ? `No hay canal ${command.number}. Hay un solo canal.` : `No hay canal ${command.number}. Hay ${total} canales.`;
  }
  return `No encontré el canal ${command.query}.`;
}
