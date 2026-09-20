#!/usr/bin/env node
// walkie-code: walkie-talkie entre el iPhone y Claude Code corriendo en iTerm2.
//
//   iPhone (miniweb) --audio--> este servidor --> whisper-server (voz a texto)
//                                             --> iTerm2 (escribe y envía en el canal elegido)
//   Claude Code --hook Stop/PermissionRequest--> este servidor --say--> audio --SSE--> iPhone
//                                                             --Web Push--> iPhone bloqueado
//   Claude Code --hook UserPromptSubmit--> este servidor: anota cuándo empezó el turno (avisos)
//                                          y contesta si lo dictó el teléfono (estilo para voz)

import http from 'node:http';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadConfig, saveConfig, HOME_DIR } from './lib/config.js';
import { toSpeech, cleanTranscript, permissionAnswer, recapSpeech } from './lib/speech.js';
import { recapOf, newestTranscript, readTail, isTranscriptPath } from './lib/transcript.js';
import { resetTime, limitMessage, failureSpeech } from './lib/limits.js';
import { describePermission, permissionSpeech, canAlways } from './lib/permissions.js';
import { Preview, scanDevices, castSite, stopCast, newestPage } from './lib/cast.js';
import { writeAndSubmit, pressKey, closeChannel, listChannels, highlight, unhighlight, openClaude, sessionContents } from './lib/iterm.js';
import { listFolders, safeDir } from './lib/folders.js';
import { slugify, starterPage, inLab, isLabProject } from './lib/projects.js';
import { listVoices, openVoiceSettings, SYSTEM_VOICE } from './lib/voices.js';
import { parseChannelCommand, findChannel, missSpeech } from './lib/commands.js';
import { synthesize, getClipWithGain, parseGain } from './lib/tts.js';
import { isDictated } from './lib/voice-style.js';
import { decideNotice, noticeSpeech, durationLabel, projectFromCwd, clampSeconds } from './lib/notices.js';
import { saveImage, findImage, cleanupImages, promptWithImage, MAX_IMAGE_BYTES, DEFAULT_IMAGE_TEXT } from './lib/images.js';
import { PendingStore } from './lib/pending.js';
import { openPushStore, createPresence, pushTargets, pushMessage } from './lib/push.js';
import { sendPush } from './lib/webpush.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const cfg = loadConfig();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.m4a': 'audio/mp4',
  '.webmanifest': 'application/manifest+json',
};

const run = promisify(execFile);

const log = (...args) => console.log(new Date().toLocaleTimeString('es-AR'), ...args);

// ---------- Canales ----------

// selectedId: la sesión de iTerm2 elegida deslizando en el teléfono (null = la activa en la Mac).
// Se guarda en disco para que un reinicio del servidor no mande el próximo dictado a otro canal.
const SELECTED_FILE = path.join(HOME_DIR, 'selected.json');
let selectedId = (() => {
  try {
    return JSON.parse(readFileSync(SELECTED_FILE, 'utf8')).id ?? null;
  } catch {
    return null;
  }
})();

function select(id) {
  if (id === selectedId) return;
  selectedId = id;
  try {
    writeFileSync(SELECTED_FILE, JSON.stringify({ id }));
  } catch {}
}

// Terminales a las que les hablamos y todavía no respondieron.
// Solo se leen en voz alta las respuestas de estas, y solo en el teléfono que habló.
// `sent` es lo último que se dictó ahí, para reconocerlo cuando Claude Code lo reciba.
// Transcripción de Claude Code de cada terminal, según los hooks (para el resumen del canal).
const transcripts = new Map(); // tty -> ruta del .jsonl

const pending = new PendingStore(path.join(HOME_DIR, 'pending.json')); // tty -> { project, clientId, permission, sent: { text, at } | null, since }

// Cuándo empezó el turno en curso de cada terminal (hook UserPromptSubmit), para medir cuánto duró.
const turns = new Map(); // tty -> ms
// Terminales que no están en `pending` y avisaron que esperan un permiso:
// si se sintoniza ese canal, "sí" o "no" contestan el menú.
const asking = new Set();

const channelsNow = () => listChannels(cfg.names || {}, cfg.channelNames || {});

async function resolveChannels() {
  const list = await channelsNow();
  const { channels } = list;
  // Si la sesión elegida se cerró, se vuelve a seguir la terminal activa en la Mac.
  if (list.ok && selectedId && !channels.some((c) => c.id === selectedId)) select(null);
  const active = channels.find((c) => c.id === selectedId) || channels.find((c) => c.current) || channels[0] || null;
  await syncHighlight(active, channels.indexOf(active));
  return { ...list, active };
}

const chLabel = (index) => `CH${String(index + 1).padStart(2, '0')}`;

// En la Mac, la pestaña del canal sintonizado se pinta de naranja y lleva la marca "📻 CH03".
// Solo mientras haya algún teléfono conectado.
let highlighted = null; // { tty, label }

async function syncHighlight(active, index) {
  const want = active && clients.size > 0 ? { tty: active.tty, label: `📻 ${chLabel(index)} · ${active.project}` } : null;
  if (highlighted && highlighted.tty !== want?.tty) {
    await unhighlight(highlighted.tty);
    highlighted = null;
  }
  if (want && highlighted?.label !== want.label) {
    await highlight(want.tty, want.label).catch(() => {});
    highlighted = want;
  }
}

// iTerm2 muestra "✳ Tarea en curso (claude)": queda solo la tarea.
const cleanTitle = (title) => title.replace(/^\W+\s*/u, '').replace(/\s*\(claude\)$/, '').trim();

const publicChannel = (c, i) =>
  c && { id: c.id, project: c.project, folder: c.folder, named: c.project !== c.folder, title: cleanTitle(c.title), number: i + 1 };

function channelsPayload({ channels, active, error }) {
  const index = channels.indexOf(active);
  return {
    channels: channels.map(publicChannel),
    active: publicChannel(active, index),
    following: !selectedId,
    error: active ? undefined : error || 'No hay ninguna terminal de iTerm2 con Claude Code corriendo.',
  };
}

// ---------- Eventos al teléfono (SSE) ----------

const clients = new Map(); // res -> { clientId, device }
const history = [];
let seq = 0;
// Los ids llevan una marca de este arranque: si el servidor se reinicia, la numeración vuelve a 1 y el
// teléfono no debe confundir los eventos nuevos con los que ya vio.
const BOOT = Date.now().toString(36);

function broadcast(type, data) {
  const ev = { id: `${BOOT}.${++seq}`, type, data: { ...data, at: Date.now() } };
  history.push(ev);
  if (history.length > 30) history.shift();
  for (const res of clients.keys()) sendEvent(res, ev);
}

function sendEvent(res, ev) {
  res.write(`id: ${ev.id}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev.data)}\n\n`);
}

function deviceName(req) {
  const ua = req.headers['user-agent'] || '';
  const kind = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Macintosh/.test(ua) ? 'Mac' : 'otro';
  return `${kind} ${req.headers['x-forwarded-for'] || req.socket.remoteAddress}`;
}

function openEvents(req, res, url) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.write('retry: 2000\n\n');
  // Si el teléfono se bloqueó y reconecta, recupera lo que se perdió. Last-Event-ID lo manda el navegador
  // al reconectar solo; ?since= lo manda la app cuando iOS la recargó (por ejemplo al tocar una notificación).
  const since = String(req.headers['last-event-id'] || url.searchParams.get('since') || '');
  if (since) {
    // Mismo arranque: lo posterior a ese id. De otro arranque: todo lo que hay desde que volvió a arrancar.
    const [boot, n] = since.split('.');
    const after = boot === BOOT ? Number(n) : 0;
    for (const ev of history) if (Number(ev.id.split('.')[1]) > after) sendEvent(res, { ...ev, data: { ...ev.data, replay: true } });
  }

  const meta = { clientId: url.searchParams.get('c'), device: deviceName(req) };
  clients.set(res, meta);
  log(`+ conectado ${meta.device} (${clients.size} en total)`);
  resolveChannels().catch(() => {});
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
    log(`- desconectado ${meta.device} (${clients.size} en total)`);
    if (clients.size === 0) syncHighlight(null).catch(() => {});
  });
}

// ---------- Voz a texto ----------

let whisper;
let shuttingDown = false;

function startWhisper() {
  if (!existsSync(cfg.model)) {
    console.error(`Falta el modelo de Whisper en ${cfg.model}`);
    process.exit(1);
  }
  whisper = spawn('whisper-server', [
    '-m', cfg.model,
    '-l', cfg.language,
    '--host', '127.0.0.1',
    '--port', String(cfg.whisperPort),
    '--convert',
    '--prompt', cfg.whisperPrompt,
    '-nt',
  ], { stdio: 'ignore' });
  whisper.on('exit', (code) => {
    if (!shuttingDown) {
      console.error(`whisper-server terminó (código ${code})`);
      process.exit(1);
    }
  });
}

async function waitForWhisper() {
  for (let i = 0; i < 120; i++) {
    try {
      await fetch(`http://127.0.0.1:${cfg.whisperPort}/`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error('whisper-server no arrancó');
}

async function transcribe(audio, mime) {
  const ext = mime.includes('mp4') || mime.includes('m4a') ? 'm4a' : mime.includes('webm') ? 'webm' : 'wav';
  const form = new FormData();
  form.append('file', new Blob([audio], { type: mime }), `audio.${ext}`);
  form.append('response_format', 'json');
  form.append('temperature', '0.0');
  // Explícito en cada pedido: sin esto, audios con ruido a veces salían detectados como otro idioma.
  form.append('language', cfg.language);
  const res = await fetch(`http://127.0.0.1:${cfg.whisperPort}/inference`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`whisper respondió ${res.status}`);
  const { text } = await res.json();
  return cleanTranscript(text);
}

const speak = async (text) => `/api/audio/${await synthesize(text, cfg)}`;

// ---------- Avisos push (teléfono bloqueado) ----------

const pushStore = openPushStore(path.join(HOME_DIR, 'push.json'));
const presence = createPresence();

async function pushTo(subscription, message) {
  try {
    const result = await sendPush(subscription, message, { vapid: pushStore.vapid, subject: cfg.pushSubject });
    // El teléfono desinstaló la app o revocó el permiso: la suscripción no sirve más.
    if (result.gone) pushStore.remove(subscription.endpoint);
    if (!result.ok) log(`! push a ${subscription.device}: ${result.status} ${result.detail}`.trim());
    return result;
  } catch (err) {
    log(`! push a ${subscription.device}: ${err.message}`);
    return { ok: false, status: 0, detail: err.message };
  }
}

// Avisa a los teléfonos que no tienen la app a la vista. No frena al hook: corre por su cuenta.
function notifyPush(to, message) {
  const targets = pushTargets(pushStore.list(), to, presence.isVisible);
  for (const sub of targets) pushTo(sub, message);
  if (targets.length) log(`» push a ${targets.length} dispositivo(s): ${message.body.slice(0, 40)}`);
}

async function handlePushSubscribe(req, res) {
  const clientId = req.headers['x-walkie-client'] || null;
  const { subscription, test } = await readJson(req);
  pushStore.save(subscription, clientId, deviceName(req));
  // Al abrir la app se vuelve a mandar la suscripción, sin aviso: solo para mantenerla al día.
  if (!test) return json(res, 200, { ok: true });
  log(`+ avisos push activados en ${deviceName(req)}`);
  // Un primer aviso de prueba: si el servicio de push rechaza algo (clave, JWT), se ve en el acto.
  const result = await pushTo(pushStore.list().at(-1), { title: 'WALKIE-CODE', body: 'Avisos activados. Así te llegan las respuestas con el teléfono bloqueado.', tag: 'walkie-code-test', url: '/' });
  return json(res, 200, { ok: result.ok, status: result.status, detail: result.detail || undefined });
}

// ---------- Tele (Chromecast) ----------
//
// La página se publica en la red local solo mientras dura la proyección, y se recarga sola en la tele
// cada vez que cambia un archivo de esa carpeta: sirve para ir desarrollando en vivo.

const preview = new Preview({ port: cfg.castPort, log });
let casting = null; // { device, file, url, since }

async function handleCast(req, res) {
  const { path: wanted, device = cfg.castDevice } = await readJson(req);
  const { full } = await safeDir(cfg.projectsRoot, path.dirname(String(wanted || '')));
  const file = path.join(full, path.basename(String(wanted || '')));
  if (!existsSync(file)) return json(res, 404, { error: 'No encuentro ese archivo.' });

  return castFile(res, file, device);
}

// Publica la carpeta, la manda a la tele y avisa por voz.
async function castFile(res, file, device, project) {
  const url = await preview.start(file);
  if (!url) return json(res, 500, { error: 'La Mac no tiene IP en la red local.' });
  await castSite(device, url);
  casting = { device, file, url, project: project || null, since: Date.now() };
  log(`+ tele: ${path.basename(file)} en ${device}`);
  const que = project ? `${project} está en la tele` : `${path.basename(file)} está en la tele`;
  return json(res, 200, { ...casting, audio: await speak(`Listo, ${que}.`) });
}

// El botón TELE del walkie: proyecta la página más nueva del proyecto sintonizado, sin preguntar nada.
async function handleCastAuto(req, res) {
  const { active } = await resolveChannels();
  if (!active?.cwd) return json(res, 409, { error: 'No hay ningún canal sintonizado.' });
  // En la carpeta madre buscaría en todos los proyectos a la vez: mejor que elija el canal del proyecto.
  if (path.resolve(active.cwd) === path.resolve(cfg.projectsRoot)) {
    return json(res, 409, { error: 'Sintonizá el canal del proyecto que querés ver en la tele.' });
  }
  const file = await newestPage(active.cwd);
  if (!file) return json(res, 404, { error: `No encontré una página en ${active.project}.` });
  return castFile(res, file, cfg.castDevice, active.project);
}

// Guarda el dispositivo preferido (se puede elegir otro de los que hay en la red).
async function handleCastDevice(req, res) {
  const { device } = await readJson(req);
  if (!device || typeof device !== 'string') return json(res, 400, { error: 'Falta el dispositivo.' });
  cfg.castDevice = device;
  saveConfig({ castDevice: device });
  log(`= tele: dispositivo ${device}`);
  return json(res, 200, { device });
}

async function handleCastStop(res) {
  // Siempre deja de publicar, aunque no haya quedado registrada la proyección.
  preview.stop();
  if (!casting) return json(res, 200, { ok: true });
  await stopCast(casting.device).catch(() => {});
  preview.stop();
  log(`- tele: ${path.basename(casting.file)} fuera de ${casting.device}`);
  casting = null;
  return json(res, 200, { ok: true });
}

// ---------- Rutas ----------

function json(res, status, body) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req, limit = 20 * 1024 * 1024, tooBig = 'audio demasiado largo') {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error(tooBig), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const readJson = async (req) => JSON.parse((await readBody(req, 2 * 1024 * 1024)).toString('utf8') || '{}');

// El token se compara en tiempo constante. Va en un header, o en la URL cuando el navegador no deja
// poner headers (EventSource y <audio>).
function authorized(req, url) {
  const given = Buffer.from(String(req.headers['x-walkie-token'] || url.searchParams.get('t') || ''));
  const want = Buffer.from(cfg.token);
  return given.length === want.length && timingSafeEqual(given, want);
}

// Contra DNS rebinding: una página cualquiera no puede apuntar un dominio suyo a 127.0.0.1 y hablarle
// a este servidor. Solo se atiende a localhost, a la Mac en el tailnet (*.ts.net) y a `allowedHosts`.
function allowedHost(req) {
  const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  return ['localhost', '127.0.0.1', '[::1]'].includes(host) || host.endsWith('.ts.net') || (cfg.allowedHosts || []).includes(host);
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

// La página solo carga lo propio, más las tipografías de Google Fonts.
const CSP = [
  "default-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "img-src 'self' blob: data:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "worker-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

// ---------- Fotos ----------

// La foto cargada en el teléfono. Si ya se borró, el teléfono tiene que volver a elegirla.
function uploadedImage(id) {
  if (!id) return null;
  const file = findImage(cfg.uploadsDir, id);
  if (!file) throw Object.assign(new Error('La foto ya no está en la Mac. Elegila de nuevo.'), { status: 410 });
  return file;
}

// El teléfono sube la foto (ya achicada) apenas se elige; se manda después con el PTT.
async function handleImage(req, res) {
  const buffer = await readBody(req, MAX_IMAGE_BYTES, 'La foto es demasiado grande.');
  const { id, file } = await saveImage(cfg.uploadsDir, buffer);
  log(`+ foto ${path.basename(file)} (${Math.round(buffer.length / 1024)} KB)`);
  cleanupImages(cfg.uploadsDir).catch(() => {});
  return json(res, 201, { id });
}

// ---------- Hablarle a Claude ----------

// Escribe en el canal activo. Con foto, la ruta va al final y nunca se toma como respuesta a un permiso.
async function deliver(res, { found, text, image, clientId }) {
  const { active } = found;
  if (!active) return json(res, 409, { error: channelsPayload(found).error, text });

  // "Canal superprecio", "canal tres", "pasame a bunkerapps": se cambia de canal en vez de escribir.
  const tuned = image ? null : await tuneByVoice(found, text);
  if (tuned) return json(res, 200, { text, ...tuned });

  // Si Claude está esperando un permiso, "sí" o "no" contestan el menú en vez de escribirse.
  const waiting = pending.get(active.tty);
  // También vale para un permiso avisado desde otro canal (`asking`). Con foto nunca es un permiso.
  const answer = (waiting?.permission || asking.has(active.tty)) && !image ? permissionAnswer(text) : null;
  asking.delete(active.tty);
  const prompt = image ? promptWithImage(text, image) : text;

  // Se anota antes de escribir: el hook UserPromptSubmit salta apenas llega el Enter
  // y tiene que encontrar el texto dictado (con la ruta de la foto, tal cual lo recibe Claude).
  const sent = answer ? null : { text: prompt, at: Date.now() };
  pending.set(active.tty, { project: active.project, clientId, permission: false, sent });
  const ask = answer ? askForTty(active.tty) : null;
  try {
    if (ask) ask.resolve(answer === 'yes' ? 'allow' : 'deny');
    else if (answer) await pressKey(active.id, answer === 'yes' ? 'enter' : 'escape');
    else await writeAndSubmit(active.id, prompt);
  } catch (err) {
    if (waiting) pending.set(active.tty, waiting);
    else pending.delete(active.tty);
    throw err;
  }

  log(`> ${active.project}: ${answer ? `[permiso: ${answer}]` : prompt}`);
  return json(res, 200, { text: text || DEFAULT_IMAGE_TEXT, project: active.project, permission: answer, image: Boolean(image) });
}

// El teléfono mandó audio: se transcribe y se escribe en el canal activo.
// Con el header X-Walkie-Image va también la foto cargada; si no se entendió nada, igual se manda.
async function handleTalk(req, res) {
  const clientId = req.headers['x-walkie-client'] || null;
  const image = uploadedImage(req.headers['x-walkie-image']);
  const audio = await readBody(req);
  if (audio.length < 1000 && !image) return json(res, 422, { error: 'No llegó audio.' });

  const [text, found] = await Promise.all([
    audio.length < 1000 ? '' : transcribe(audio, req.headers['content-type'] || 'audio/mp4'),
    resolveChannels(),
  ]);
  if (!text && !image) return json(res, 422, { error: 'No se entendió nada.' });
  return deliver(res, { found, text, image, clientId });
}

// "ENVIAR SOLA": la foto sin dictar nada, con el texto por defecto.
async function handleSend(req, res) {
  const clientId = req.headers['x-walkie-client'] || null;
  const { image: id, text = '' } = await readJson(req);
  const image = uploadedImage(id);
  if (!image) return json(res, 422, { error: 'No hay foto para mandar.' });
  return deliver(res, { found: await resolveChannels(), text: String(text), image, clientId });
}

// Si el texto es un cambio de canal, lo hace (o avisa por qué no) y devuelve la respuesta para el
// teléfono. Devuelve null si el texto es para Claude.
async function tuneByVoice(found, text) {
  const command = parseChannelCommand(text);
  if (!command) return null;
  const screen = found.channels.map(publicChannel);
  const result = findChannel(command, screen);
  if (result.channel) {
    const target = found.channels.find((c) => c.id === result.channel.id);
    return { switched: true, ...(await tuneTo(found, target)) };
  }
  // "Pasame a TypeScript" sin la palabra canal y sin coincidencia es un pedido para Claude.
  if (!command.strong && !result.candidates.length) return null;
  const message = missSpeech(command, result, screen.length);
  log(`? canal por voz: "${text}" -> ${message}`);
  return { switched: false, message, ...channelsPayload(found), audio: await speak(message) };
}

// Lo llama hooks/claude-hook.js cuando empieza un turno, cuando Claude Code termina de responder
// o cuando pide permiso.
async function handleHook(req, res) {
  const body = await readJson(req);
  if (!body.tty) return json(res, 200, { ignored: true });
  body.transcript = isTranscriptPath(body.transcript) ? body.transcript : null;
  if (body.transcript) transcripts.set(body.tty, body.transcript);
  if (body.event === 'StopFailure') return json(res, 200, await handleFailure(body));
  // Claude Code recibió un prompt: se anota cuándo empezó el turno y se contesta rápido,
  // sin consultar a iTerm2, si lo dictó el teléfono (el hook lo está esperando).
  if (body.event === 'UserPromptSubmit') {
    turns.set(body.tty, Date.now());
    asking.delete(body.tty);
    const waiting = pending.get(body.tty);
    const dictated = isDictated(waiting?.sent, body.prompt);
    if (dictated) {
      waiting.sent = null; // se usa una sola vez
      pending.save();
      log(`~ ${waiting.project}: pide respuesta para escuchar`);
    }
    return json(res, 200, { dictated });
  }
  const startedAt = turns.get(body.tty) ?? null;
  if (body.event === 'Stop') {
    turns.delete(body.tty);
    asking.delete(body.tty);
  }

  const waiting = pending.get(body.tty);
  if (!waiting) return json(res, 200, await sendNotice(body, startedAt));

  // Si la respuesta viene de un canal distinto al que está en pantalla, se anuncia de dónde viene.
  const { active, channels: open = [] } = await resolveChannels().catch(() => ({}));
  const from = active?.tty === body.tty ? '' : `Desde ${waiting.project}. `;
  // El id exacto del canal: el teléfono lo usa para saber si la respuesta es del canal en pantalla
  // (por nombre fallaba si se renombraba o si dos canales se llamaban parecido).
  const channel = open.find((c) => c.tty === body.tty)?.id || null;

  if (body.event === 'Stop') {
    pending.delete(body.tty);
    const speech = from + (toSpeech(body.text) || 'Listo.');
    broadcast('reply', { text: body.text, audio: await speak(speech), project: waiting.project, channel, to: waiting.clientId });
    notifyPush(waiting.clientId, pushMessage({ kind: 'reply', text: body.text, project: waiting.project }));
    log(`< ${waiting.project}: respuesta de ${body.text?.length || 0} caracteres`);
  } else if (body.kind === 'permission') {
    waiting.permission = true;
    pending.save();
    const { detail, summary } = describePermission(body.tool, body.input);
    const speech = body.input
      ? permissionSpeech({ from, tool: body.tool, summary })
      : `${from}Claude necesita permiso para ${body.tool ? `usar ${body.tool}` : 'seguir'}. Decí sí para aprobar o no para cancelar.`;
    // Con un teléfono conectado, el hook espera la respuesta (botones o voz) y se la da a Claude Code
    // como decisión oficial. Sin teléfono, Claude Code muestra su diálogo de siempre en la Mac.
    const ask = body.event === 'PermissionRequest' && clients.size > 0
      ? { id: randomUUID(), tool: body.tool, summary, detail, always: canAlways(body.suggestions) }
      : null;
    broadcast('notify', {
      channel,
      text: detail ? `${summary}: ${detail}` : body.text,
      audio: await speak(speech),
      project: waiting.project,
      to: waiting.clientId,
      permission: ask,
    });
    notifyPush(waiting.clientId, pushMessage({ kind: 'permission', tool: body.tool, project: waiting.project }));
    log(`< ${waiting.project}: pide permiso (${body.tool || '?'}${detail ? `: ${detail.slice(0, 60)}` : ''})`);
    if (!ask) return json(res, 200, { ok: true });

    const decision = await waitForDecision(ask.id, body.tty, req);
    waiting.permission = false;
    pending.save();
    broadcast('permission-done', { id: ask.id, decision, project: waiting.project, to: waiting.clientId });
    log(`< ${waiting.project}: permiso ${decision || 'sin respuesta (queda en la Mac)'}`);
    return json(res, 200, { decision });
  }
  return json(res, 200, { ok: true });
}

// Canal al que no se le habló desde el teléfono: si vale la pena, aviso corto a todos los teléfonos.
async function sendNotice(body, startedAt) {
  const notice = decideNotice({
    event: body.event,
    kind: body.kind,
    pending: false,
    startedAt,
    enabled: cfg.notices,
    afterSeconds: cfg.notifyAfterSeconds,
  });
  if (!notice) return { ignored: true };

  const { channels } = await channelsNow().catch(() => ({ channels: [] }));
  const project = channels.find((c) => c.tty === body.tty)?.project || projectFromCwd(body.cwd, cfg.names);
  if (notice.kind === 'permission') asking.add(body.tty);

  const speech = noticeSpeech(project, notice, body.tool);
  // Sin teléfonos conectados no se genera el audio: al reconectar, el aviso viejo solo se muestra.
  const audio = clients.size ? await speak(speech) : null;
  const duration = durationLabel(notice.seconds);
  const channel = channels.find((c) => c.tty === body.tty)?.id || null;
  broadcast('notice', { kind: notice.kind, text: body.text || speech, speech, project, channel, duration, audio });
  // Con el teléfono bloqueado, el aviso llega igual como notificación (a todos los suscriptos).
  notifyPush(null, notice.kind === 'permission'
    ? pushMessage({ kind: 'permission', tool: body.tool, project })
    : pushMessage({ kind: 'reply', text: `Terminó, después de ${duration.toLowerCase()}. ${body.text || ''}`, project }));
  log(`! ${project}: ${notice.kind === 'permission' ? `pide permiso (${body.tool || '?'})` : `terminó (${duration})`}`);
  return { notice: notice.kind };
}

// El turno terminó por un error de la API. El límite de uso se avisa a todos los teléfonos (es de toda
// la cuenta, una vez cada 10 minutos); los otros errores, solo al que le habló a ese canal.
const LIMIT_NOTICE_EVERY_MS = 10 * 60 * 1000;
let lastLimitNotice = 0;

// Permisos esperando la respuesta del teléfono: id -> { tty, resolve }.
const PERMISSION_WAIT_MS = 120 * 1000;
const asks = new Map();

function waitForDecision(id, tty, req) {
  return new Promise((resolve) => {
    const done = (decision) => {
      clearTimeout(timer);
      if (asks.delete(id)) resolve(decision);
    };
    const timer = setTimeout(() => done(null), PERMISSION_WAIT_MS);
    asks.set(id, { tty, resolve: done });
    // Si Claude Code cortó el hook (por ejemplo, lo contestaron en la Mac), ya no hay nada que esperar.
    req.on('close', () => done(null));
  });
}

const askForTty = (tty) => [...asks.values()].find((a) => a.tty === tty);

// Respuesta desde los botones del teléfono: allow, always o deny.
async function handlePermission(req, res) {
  const { id, decision } = await readJson(req);
  if (!['allow', 'always', 'deny'].includes(decision)) return json(res, 400, { error: 'Respuesta inválida.' });
  const ask = asks.get(id);
  if (!ask) return json(res, 410, { error: 'Ese permiso ya no está esperando.' });
  ask.resolve(decision);
  return json(res, 200, { ok: true });
}

async function handleFailure(body) {
  const waiting = pending.get(body.tty);
  pending.delete(body.tty);
  turns.delete(body.tty);
  asking.delete(body.tty);

  const limit = body.error === 'rate_limit';
  if (!limit && !waiting) return { ignored: true };
  if (limit && !waiting && Date.now() - lastLimitNotice < LIMIT_NOTICE_EVERY_MS) return { ignored: true };
  if (limit) lastLimitNotice = Date.now();

  const { channels } = await channelsNow().catch(() => ({ channels: [] }));
  const project = waiting?.project || channels.find((c) => c.tty === body.tty)?.project || projectFromCwd(body.cwd, cfg.names);
  const tail = limit && body.transcript ? await readTail(body.transcript, 64 * 1024).catch(() => '') : '';
  const reset = resetTime(limitMessage(tail));
  const speech = failureSpeech(body.error, project, reset);

  const audio = clients.size ? await speak(speech) : null;
  broadcast('notice', { kind: limit ? 'limit' : 'error', text: speech, speech, project, audio, reset, to: waiting?.clientId });
  notifyPush(limit ? null : waiting?.clientId, {
    title: limit ? 'CLAUDE · LÍMITE DE USO' : `CLAUDE · ${project}`,
    body: speech,
    tag: limit ? 'walkie-code-limit' : `walkie-code-${project}`,
    url: '/',
  });
  log(`x ${project}: ${body.error}${reset ? ` (se renueva ${reset})` : ''}`);
  return { notice: limit ? 'limit' : 'error' };
}

// Sintoniza un canal (deslizando o por voz): lo marca en la Mac y devuelve la pantalla con el anuncio.
async function tuneTo(found, target) {
  select(target.id);
  await syncHighlight(target, found.channels.indexOf(target));
  const payload = channelsPayload({ ...found, active: target });
  log(`= canal ${payload.active.number}: ${target.project}`);
  return { ...payload, audio: await speak(`Canal ${payload.active.number}. ${target.project}.`) };
}

async function handleSelect(req, res) {
  const { id } = await readJson(req);
  const found = await resolveChannels();
  const target = found.channels.find((c) => c.id === id);
  if (!target) return json(res, 404, { error: 'Ese canal ya no existe.', ...channelsPayload(found) });
  return json(res, 200, await tuneTo(found, target));
}

// Cierra el canal (sale de Claude Code y cierra la pestaña de iTerm2) y sintoniza el que quede.
async function handleClose(req, res) {
  const { id } = await readJson(req);
  const found = await resolveChannels();
  const target = found.channels.find((c) => c.id === id);
  if (!target) return json(res, 404, { error: 'Ese canal ya no existe.', ...channelsPayload(found) });
  await unhighlight(target.tty).catch(() => {});
  if (highlighted?.tty === target.tty) highlighted = null;
  await closeChannel(target.id);
  pending.delete(target.tty);
  turns.delete(target.tty);
  asking.delete(target.tty);
  if (selectedId === target.id) select(null);
  log(`x canal cerrado: ${target.project}`);
  const after = await resolveChannels();
  const payload = channelsPayload(after);
  return json(res, 200, { ...payload, audio: await speak(`Cerré ${target.project}.`) });
}

async function handleFolders(res, url) {
  const { channels } = await channelsNow();
  const activeDirs = new Set(channels.map((c) => c.cwd));
  return json(res, 200, await listFolders(cfg.projectsRoot, url.searchParams.get('path') || '', activeDirs, cfg.names, cfg.labFolder));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Crea una carpeta nueva dentro de projectsRoot con una página inicial, y abre ahí su canal de Claude.
async function handleProject(req, res) {
  const { name, real = false } = await readJson(req);
  const slug = slugify(name || '');
  if (!slug) return json(res, 400, { error: 'Decime un nombre para el proyecto.' });

  const { rootReal } = await safeDir(cfg.projectsRoot, '');
  // Por defecto nace en el laboratorio; "real" lo crea directamente entre los proyectos de verdad.
  const dir = real ? path.join(rootReal, slug) : path.join(rootReal, cfg.labFolder, slug);
  if (existsSync(dir)) return json(res, 409, { error: `Ya existe un proyecto llamado ${slug}.` });

  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'index.html'), starterPage(String(name).trim()));
  log(`+ proyecto nuevo: ${slug}`);
  return openClaudeIn(req, res, dir, `Listo, creé ${slug} y abrí Claude ahí.`);
}

// Abre una ventana de iTerm2 con Claude Code en la carpeta elegida y sintoniza ese canal.
async function handleOpen(req, res) {
  const { path: rel = '' } = await readJson(req);
  const { full } = await safeDir(cfg.projectsRoot, rel);
  return openClaudeIn(req, res, full);
}

// Borrar y ascender solo valen dentro del laboratorio: afuera, el walkie no toca nada.
async function labProject(rel) {
  const { full } = await safeDir(cfg.projectsRoot, rel || '');
  if (!isLabProject(cfg.projectsRoot, cfg.labFolder, full)) {
    throw Object.assign(new Error(`Eso solo se puede con los proyectos del ${cfg.labFolder}.`), { status: 403 });
  }
  return full;
}

// No borra de verdad: manda la carpeta a la Papelera, así siempre se puede recuperar.
async function handleProjectDelete(req, res) {
  const { path: rel } = await readJson(req);
  const dir = await labProject(rel);
  const { channels: open = [] } = await channelsNow().catch(() => ({}));
  if (open.some((c) => c.cwd === dir)) {
    return json(res, 409, { error: 'Ese proyecto tiene un canal abierto: cerralo primero.' });
  }
  // Se mueve a ~/.Trash, no se borra: recuperable desde la Papelera. (Finder tarda o se cuelga; mejor mover.)
  const nombre = path.basename(dir);
  const papelera = path.join(os.homedir(), '.Trash', nombre);
  const destino = existsSync(papelera) ? `${papelera} ${new Date().toISOString().slice(0, 19)}` : papelera;
  await rename(dir, destino);
  log(`- proyecto a la papelera: ${nombre}`);
  return json(res, 200, { deleted: nombre, audio: await speak(`Mandé ${nombre} a la papelera.`) });
}

// Ascender: sale del laboratorio y pasa a ser un proyecto de verdad.
async function handleProjectPromote(req, res) {
  const { path: rel } = await readJson(req);
  const dir = await labProject(rel);
  const { rootReal } = await safeDir(cfg.projectsRoot, '');
  const destino = path.join(rootReal, path.basename(dir));
  if (existsSync(destino)) return json(res, 409, { error: `Ya hay un proyecto llamado ${path.basename(dir)}.` });
  await rename(dir, destino);
  const nombre = path.basename(destino);
  log(`= proyecto ascendido: ${nombre}`);
  return json(res, 200, { promoted: nombre, audio: await speak(`${nombre} ya es un proyecto de verdad.`) });
}

// Abre Claude Code en esa carpeta, espera a que arranque y sintoniza ese canal.
async function openClaudeIn(req, res, full, intro) {
  const clientId = req.headers['x-walkie-client'] || null;
  const session = await openClaude(full, cfg.claudeCommand);
  log(`+ nueva sesión de Claude en ${full}`);

  let found;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    found = await channelsNow();
    if (found.channels.some((c) => c.id === session.id)) break;
  }
  const target = found.channels.find((c) => c.id === session.id);
  if (!target) return json(res, 504, { error: 'Se abrió la terminal, pero Claude Code no arrancó.' });

  select(target.id);
  const index = found.channels.indexOf(target);
  await syncHighlight(target, index);

  // En una carpeta nueva, Claude Code primero pregunta si se confía en ella.
  await sleep(1500);
  const screen = await sessionContents(target.id).catch(() => '');
  const asksTrust = /trust/i.test(screen);
  if (asksTrust) pending.set(target.tty, { project: target.project, clientId, permission: true });

  const speech = `${intro || `Canal ${index + 1}. ${target.project}.`} ` +
    (asksTrust ? 'Claude pregunta si confiás en esta carpeta. Decí sí para aceptar.' : 'Claude está listo.');
  return json(res, 200, { ...channelsPayload({ ...found, active: target }), trust: asksTrust, audio: await speak(speech) });
}

// ---------- Voz de las respuestas ----------

const RATE_LIMITS = [120, 300];

// Además de las instaladas, la voz elegida en Ajustes del Sistema (la única vía a una voz de Siri).
const systemVoice = { name: SYSTEM_VOICE, label: 'Voz del sistema', region: 'MAC', quality: 'sistema' };

const voiceOptions = async () => [...(await listVoices(cfg.language)), systemVoice];

const noticeSettings = () => ({ enabled: cfg.notices !== false, afterSeconds: clampSeconds(cfg.notifyAfterSeconds) });

async function handleVoices(res) {
  return json(res, 200, { voices: await voiceOptions(), current: cfg.voice, rate: cfg.rate, notices: noticeSettings() });
}

// Prende o apaga los avisos de los otros canales y cambia el umbral. Se guarda en la configuración.
async function handleNotices(req, res) {
  const { enabled, afterSeconds } = await readJson(req);
  if (enabled !== undefined) cfg.notices = Boolean(enabled);
  if (afterSeconds !== undefined) cfg.notifyAfterSeconds = clampSeconds(afterSeconds, cfg.notifyAfterSeconds);
  saveConfig({ notices: cfg.notices, notifyAfterSeconds: cfg.notifyAfterSeconds });
  const settings = noticeSettings();
  log(`= avisos: ${settings.enabled ? `sí, después de ${settings.afterSeconds} s` : 'no'}`);
  return json(res, 200, settings);
}

// Cambia la voz o la velocidad, la guarda y devuelve una muestra para escucharla.
async function handleVoice(req, res) {
  const { voice, rate } = await readJson(req);
  const chosen = voice && (await voiceOptions()).find((v) => v.name === voice);
  if (voice && !chosen) return json(res, 404, { error: 'Esa voz no está instalada en la Mac.' });

  if (chosen) cfg.voice = chosen.name;
  if (rate !== undefined) cfg.rate = Math.min(RATE_LIMITS[1], Math.max(RATE_LIMITS[0], Math.round(Number(rate)) || cfg.rate));
  saveConfig({ voice: cfg.voice, rate: cfg.rate });
  log(`= voz: ${cfg.voice} a ${cfg.rate} palabras por minuto`);

  const sample = !chosen ? 'Así voy a hablar ahora.'
    : chosen === systemVoice ? 'Hola, soy la voz del sistema. Así te voy a leer las respuestas.'
    : `Hola, soy ${chosen.label}. Así te voy a leer las respuestas.`;
  return json(res, 200, { current: cfg.voice, rate: cfg.rate, audio: await speak(sample) });
}

// Abre en la Mac el panel donde se descargan voces mejoradas y premium, y explica qué tocar.
// No hay forma soportada de descargarlas por código: lo tiene que hacer el usuario en Ajustes.
async function handleInstallVoices(res) {
  await openVoiceSettings();
  log('= abriendo Ajustes para instalar voces');
  const speech = 'Te abrí Ajustes en la Mac, en Lectura y voz. Tocá el menú Voz del sistema y elegí Administrar voces. ' +
    'Buscá Español y descargá una voz mejorada o premium. Cuando termine, aparece sola en esta lista.';
  return json(res, 200, { ok: true, audio: await speak(speech) });
}

// Nombre propio de un canal (de esa sesión, no de la carpeta: en una carpeta puede haber varias).
// Vacío = vuelve al nombre de la carpeta.
async function handleName(req, res) {
  const { id, name = '' } = await readJson(req);
  const found = await channelsNow();
  const target = found.channels.find((c) => c.id === id);
  if (!target?.cwd) return json(res, 404, { error: 'Ese canal ya no existe.' });

  const clean = String(name).replace(/\s+/g, ' ').trim().slice(0, 40);
  // Se guardan solo los canales abiertos: los ids de sesiones cerradas no vuelven.
  const open = new Set(found.channels.map((c) => c.id));
  cfg.channelNames = Object.fromEntries(Object.entries(cfg.channelNames || {}).filter(([sid]) => open.has(sid)));
  if (clean) cfg.channelNames[id] = clean;
  else delete cfg.channelNames[id];
  // Si la carpeta tenía un nombre viejo (de cuando se nombraban carpetas), deja de pisar a este canal.
  if (cfg.names?.[target.cwd]) {
    cfg.names = { ...cfg.names };
    delete cfg.names[target.cwd];
  }
  saveConfig({ channelNames: cfg.channelNames, names: cfg.names || {} });
  log(`= nombre del canal ${target.folder}: ${clean || '(el de la carpeta)'}`);

  const updated = await resolveChannels();
  const renamed = updated.channels.find((c) => c.id === id) || updated.active;
  const payload = channelsPayload(updated);
  const number = updated.channels.indexOf(renamed) + 1;
  return json(res, 200, { ...payload, audio: await speak(`Canal ${number}. ${renamed.project}.`) });
}

// Lo último que pasó en un canal (aunque se haya escrito desde la Mac). Con ?speak=1, también en audio.
async function handleRecap(res, url) {
  const found = await resolveChannels();
  const channel = found.channels.find((c) => c.id === url.searchParams.get('id')) || found.active;
  if (!channel) return json(res, 404, { error: 'No hay ningún canal.' });

  const file = transcripts.get(channel.tty) || (channel.cwd && (await newestTranscript(channel.cwd)));
  const recap = file ? await recapOf(file).catch(() => null) : null;
  if (!recap?.prompt && !recap?.reply) return json(res, 200, { id: channel.id, project: channel.project, empty: true });

  const payload = {
    id: channel.id,
    project: channel.project,
    prompt: recap.prompt?.text || null,
    reply: recap.working ? null : recap.reply?.text || null,
    working: recap.working,
  };
  if (url.searchParams.get('speak')) payload.audio = await speak(recapSpeech(channel.project, recap));
  return json(res, 200, payload);
}

// Sonidos propios en ~/.walkie-code/sounds/ (mismo nombre) reemplazan a los públicos, sin publicarlos.
const SOUND_NAMES = new Set(['ptt.m4a', 'release.m4a', 'rx.m4a']);

function localSound(pathname) {
  const name = pathname.startsWith('/sounds/') ? pathname.slice('/sounds/'.length) : '';
  const file = SOUND_NAMES.has(name) ? path.join(HOME_DIR, 'sounds', name) : null;
  return file && existsSync(file) ? file : null;
}

async function serveStatic(res, pathname) {
  const file = localSound(pathname) || path.normalize(path.join(PUBLIC, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC + path.sep) && file !== localSound(pathname)) return json(res, 404, { error: 'no encontrado' });
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      ...(file.endsWith('.html') && { 'Content-Security-Policy': CSP }),
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    json(res, 404, { error: 'no encontrado' });
  }
}

// Si la Mac se despertó a medias (Wake-on-LAN por Wi-Fi solo da un DarkWake), el primer pedido
// del teléfono le avisa a macOS que hay alguien: caffeinate -u declara actividad y la despierta del todo.
let lastUserWake = 0;
function declareUserActivity() {
  const now = Date.now();
  if (now - lastUserWake < 30_000) return;
  lastUserWake = now;
  spawn('caffeinate', ['-u', '-t', '5'], { stdio: 'ignore' }).on('error', () => {});
}

// Para el relay de Wake-on-LAN: en un DarkWake la Mac contesta por red pero sin gráficos,
// así que "despierta de verdad" es tener Graphics entre las capacidades del sistema.
function fullyAwake() {
  return new Promise((resolve) => {
    execFile('pmset', ['-g', 'systemstate'], (err, out) => resolve(!err && /Capabilities are:.*\bGraphics\b/.test(out)));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const route = `${req.method} ${url.pathname}`;
  try {
    if (!allowedHost(req)) return json(res, 421, { error: 'Host no permitido.' });
    if (!url.pathname.startsWith('/api/')) return await serveStatic(res, url.pathname);
    // Sin token: el relay no lo tiene, y solo revela si la Mac está despierta.
    if (route === 'GET /api/awake') return json(res, 200, { awake: await fullyAwake() });
    if (!authorized(req, url)) return json(res, 401, { error: 'Token inválido.' });
    declareUserActivity();
    // Cualquier pedido del teléfono (salvo el aviso de que se ocultó) prueba que la app está a la vista.
    if (route !== 'POST /api/presence') presence.touch(req.headers['x-walkie-client']);

    if (route === 'GET /api/events') return openEvents(req, res, url);
    if (route === 'GET /api/usage') {
      const usage = await readFile(path.join(HOME_DIR, 'usage.json'), 'utf8').then(JSON.parse).catch(() => null);
      return json(res, 200, { usage });
    }
    if (route === 'GET /api/recap') return await handleRecap(res, url);
    if (route === 'GET /api/channels') return json(res, 200, channelsPayload(await resolveChannels()));
    if (route === 'POST /api/channel') return await handleSelect(req, res);
    if (route === 'POST /api/close') return await handleClose(req, res);
    if (route === 'POST /api/talk') return await handleTalk(req, res);
    if (route === 'POST /api/permission') return await handlePermission(req, res);
    if (route === 'GET /api/cast') return json(res, 200, { casting, device: cfg.castDevice });
    if (route === 'GET /api/cast/devices') return json(res, 200, { devices: await scanDevices(), preferido: cfg.castDevice });
    if (route === 'POST /api/cast') return await handleCast(req, res);
    if (route === 'POST /api/cast/auto') return await handleCastAuto(req, res);
    if (route === 'POST /api/cast/device') return await handleCastDevice(req, res);
    if (route === 'POST /api/cast/stop') return await handleCastStop(res);
    if (route === 'POST /api/image') return await handleImage(req, res);
    if (route === 'POST /api/send') return await handleSend(req, res);
    if (route === 'GET /api/folders') return await handleFolders(res, url);
    if (route === 'GET /api/voices') return await handleVoices(res);
    if (route === 'POST /api/voice') return await handleVoice(req, res);
    if (route === 'GET /api/notices') return json(res, 200, noticeSettings());
    if (route === 'POST /api/notices') return await handleNotices(req, res);
    if (route === 'POST /api/voices/install') return await handleInstallVoices(res);
    if (route === 'POST /api/name') return await handleName(req, res);
    if (route === 'POST /api/open') return await handleOpen(req, res);
    if (route === 'POST /api/project') return await handleProject(req, res);
    if (route === 'POST /api/project/delete') return await handleProjectDelete(req, res);
    if (route === 'POST /api/project/promote') return await handleProjectPromote(req, res);
    if (route === 'POST /api/hook') return await handleHook(req, res);
    if (route === 'GET /api/push') return json(res, 200, { publicKey: pushStore.vapid.publicKey });
    if (route === 'POST /api/push/subscribe') return await handlePushSubscribe(req, res);
    if (route === 'POST /api/push/unsubscribe') {
      pushStore.remove((await readJson(req)).endpoint);
      return json(res, 200, { ok: true });
    }
    if (route === 'POST /api/presence') {
      presence.touch(req.headers['x-walkie-client'], Boolean((await readJson(req)).visible));
      return json(res, 200, { ok: true });
    }
    if (route === 'POST /api/escape') {
      const { active } = await resolveChannels();
      if (!active) return json(res, 409, { error: 'No hay canal activo.' });
      await pressKey(active.id, 'escape');
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/audio/')) {
      const clip = await getClipWithGain(url.pathname.split('/').pop(), parseGain(url.searchParams.get('g')));
      if (!clip) return json(res, 404, { error: 'audio vencido' });
      res.writeHead(200, { 'Content-Type': 'audio/mp4', 'Content-Length': clip.length, 'Cache-Control': 'private, max-age=3600' });
      return res.end(clip);
    }
    json(res, 404, { error: 'no encontrado' });
  } catch (err) {
    console.error(err);
    json(res, err.status || 500, { error: err.message });
  }
});

async function shutdown() {
  shuttingDown = true;
  preview.stop();
  if (highlighted) await unhighlight(highlighted.tty);
  whisper?.kill();
  server.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

startWhisper();
cleanupImages(cfg.uploadsDir).catch(() => {});
await waitForWhisper();
// Solo escucha en localhost: al teléfono le llega por `tailscale serve`, con HTTPS.
server.listen(cfg.port, '127.0.0.1', () => {
  log(`walkie-code escuchando en http://127.0.0.1:${cfg.port}`);
});
