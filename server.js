#!/usr/bin/env node
// supervoz: walkie-talkie entre el iPhone y Claude Code corriendo en iTerm2.
//
//   iPhone (miniweb) --audio--> este servidor --> whisper-server (voz a texto)
//                                             --> iTerm2 (escribe y envía en el canal elegido)
//   Claude Code --hook Stop/PermissionRequest--> este servidor --say--> audio --SSE--> iPhone
//   Claude Code --hook UserPromptSubmit--> este servidor: anota cuándo empezó el turno (avisos)
//                                          y contesta si lo dictó el teléfono (estilo para voz)

import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, saveConfig } from './lib/config.js';
import { toSpeech, cleanTranscript, permissionAnswer } from './lib/speech.js';
import { writeAndSubmit, pressKey, listChannels, highlight, unhighlight, openClaude, sessionContents } from './lib/iterm.js';
import { listFolders, safeDir } from './lib/folders.js';
import { listVoices } from './lib/voices.js';
import { synthesize, getClip } from './lib/tts.js';
import { isDictated } from './lib/voice-style.js';
import { decideNotice, noticeSpeech, durationLabel, projectFromCwd, clampSeconds } from './lib/notices.js';
import { saveImage, findImage, cleanupImages, promptWithImage, MAX_IMAGE_BYTES, DEFAULT_IMAGE_TEXT } from './lib/images.js';

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

const log = (...args) => console.log(new Date().toLocaleTimeString('es-AR'), ...args);

// ---------- Canales ----------

// selectedId: la sesión de iTerm2 elegida deslizando en el teléfono (null = la activa en la Mac).
let selectedId = null;

// Terminales a las que les hablamos y todavía no respondieron.
// Solo se leen en voz alta las respuestas de estas, y solo en el teléfono que habló.
// `sent` es lo último que se dictó ahí, para reconocerlo cuando Claude Code lo reciba.
const pending = new Map(); // tty -> { project, clientId, permission, sent: { text, at } | null }

// Cuándo empezó el turno en curso de cada terminal (hook UserPromptSubmit), para medir cuánto duró.
const turns = new Map(); // tty -> ms
// Terminales que no están en `pending` y avisaron que esperan un permiso:
// si se sintoniza ese canal, "sí" o "no" contestan el menú.
const asking = new Set();

const channelsNow = () => listChannels(cfg.names || {});

async function resolveChannels() {
  const list = await channelsNow();
  const { channels } = list;
  // Si la sesión elegida se cerró, se vuelve a seguir la terminal activa en la Mac.
  if (list.ok && selectedId && !channels.some((c) => c.id === selectedId)) selectedId = null;
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

function broadcast(type, data) {
  const ev = { id: ++seq, type, data: { ...data, at: Date.now() } };
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
  // Si el teléfono se bloqueó y reconecta, recupera lo que se perdió.
  const lastId = Number(req.headers['last-event-id'] || 0);
  if (lastId) for (const ev of history) if (ev.id > lastId) sendEvent(res, ev);

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
  const res = await fetch(`http://127.0.0.1:${cfg.whisperPort}/inference`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`whisper respondió ${res.status}`);
  const { text } = await res.json();
  return cleanTranscript(text);
}

const speak = async (text) => `/api/audio/${await synthesize(text, cfg)}`;

// ---------- Rutas ----------

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
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

function authorized(req, url) {
  return (req.headers['x-supervoz-token'] || url.searchParams.get('t')) === cfg.token;
}

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
  try {
    if (answer) await pressKey(active.id, answer === 'yes' ? 'enter' : 'escape');
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
// Con el header X-Supervoz-Image va también la foto cargada; si no se entendió nada, igual se manda.
async function handleTalk(req, res) {
  const clientId = req.headers['x-supervoz-client'] || null;
  const image = uploadedImage(req.headers['x-supervoz-image']);
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
  const clientId = req.headers['x-supervoz-client'] || null;
  const { image: id, text = '' } = await readJson(req);
  const image = uploadedImage(id);
  if (!image) return json(res, 422, { error: 'No hay foto para mandar.' });
  return deliver(res, { found: await resolveChannels(), text: String(text), image, clientId });
}

// Lo llama hooks/claude-hook.js cuando empieza un turno, cuando Claude Code termina de responder
// o cuando pide permiso.
async function handleHook(req, res) {
  const body = await readJson(req);
  if (!body.tty) return json(res, 200, { ignored: true });
  // Claude Code recibió un prompt: se anota cuándo empezó el turno y se contesta rápido,
  // sin consultar a iTerm2, si lo dictó el teléfono (el hook lo está esperando).
  if (body.event === 'UserPromptSubmit') {
    turns.set(body.tty, Date.now());
    asking.delete(body.tty);
    const waiting = pending.get(body.tty);
    const dictated = isDictated(waiting?.sent, body.prompt);
    if (dictated) {
      waiting.sent = null; // se usa una sola vez
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
  const { active } = await resolveChannels().catch(() => ({}));
  const from = active?.tty === body.tty ? '' : `Desde ${waiting.project}. `;

  if (body.event === 'Stop') {
    pending.delete(body.tty);
    const speech = from + (toSpeech(body.text) || 'Listo.');
    broadcast('reply', { text: body.text, audio: await speak(speech), project: waiting.project, to: waiting.clientId });
    log(`< ${waiting.project}: respuesta de ${body.text?.length || 0} caracteres`);
  } else if (body.kind === 'permission') {
    waiting.permission = true;
    const what = body.tool ? `usar ${body.tool}` : 'seguir';
    const speech = `${from}Claude necesita permiso para ${what}. Decí sí para aprobar o no para cancelar.`;
    broadcast('notify', { text: body.text, audio: await speak(speech), project: waiting.project, to: waiting.clientId });
    log(`< ${waiting.project}: pide permiso (${body.tool || '?'})`);
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
  broadcast('notice', { kind: notice.kind, text: body.text || speech, speech, project, duration, audio });
  log(`! ${project}: ${notice.kind === 'permission' ? `pide permiso (${body.tool || '?'})` : `terminó (${duration})`}`);
  return { notice: notice.kind };
}

async function handleSelect(req, res) {
  const { id } = await readJson(req);
  const found = await resolveChannels();
  const target = found.channels.find((c) => c.id === id);
  if (!target) return json(res, 404, { error: 'Ese canal ya no existe.', ...channelsPayload(found) });
  selectedId = id;
  await syncHighlight(target, found.channels.indexOf(target));
  const payload = channelsPayload({ ...found, active: target });
  log(`= canal ${payload.active.number}: ${target.project}`);
  return json(res, 200, { ...payload, audio: await speak(`Canal ${payload.active.number}. ${target.project}.`) });
}

async function handleFolders(res, url) {
  const { channels } = await channelsNow();
  const activeDirs = new Set(channels.map((c) => c.cwd));
  return json(res, 200, await listFolders(cfg.projectsRoot, url.searchParams.get('path') || '', activeDirs, cfg.names));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Abre una ventana de iTerm2 con Claude Code en la carpeta elegida y sintoniza ese canal.
async function handleOpen(req, res) {
  const clientId = req.headers['x-supervoz-client'] || null;
  const { path: rel = '' } = await readJson(req);
  const { full } = await safeDir(cfg.projectsRoot, rel);
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

  selectedId = target.id;
  const index = found.channels.indexOf(target);
  await syncHighlight(target, index);

  // En una carpeta nueva, Claude Code primero pregunta si se confía en ella.
  await sleep(1500);
  const screen = await sessionContents(target.id).catch(() => '');
  const asksTrust = /trust/i.test(screen);
  if (asksTrust) pending.set(target.tty, { project: target.project, clientId, permission: true });

  const speech = `Canal ${index + 1}. ${target.project}. ` +
    (asksTrust ? 'Claude pregunta si confiás en esta carpeta. Decí sí para aceptar.' : 'Claude está listo.');
  return json(res, 200, { ...channelsPayload({ ...found, active: target }), trust: asksTrust, audio: await speak(speech) });
}

// ---------- Voz de las respuestas ----------

const RATE_LIMITS = [120, 300];

const noticeSettings = () => ({ enabled: cfg.notices !== false, afterSeconds: clampSeconds(cfg.notifyAfterSeconds) });

async function handleVoices(res) {
  return json(res, 200, { voices: await listVoices(cfg.language), current: cfg.voice, rate: cfg.rate, notices: noticeSettings() });
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
  const voices = await listVoices(cfg.language);
  const chosen = voice ? voices.find((v) => v.name === voice) : voices.find((v) => v.name === cfg.voice);
  if (!chosen) return json(res, 404, { error: 'Esa voz no está instalada en la Mac.' });

  cfg.voice = chosen.name;
  if (rate !== undefined) cfg.rate = Math.min(RATE_LIMITS[1], Math.max(RATE_LIMITS[0], Math.round(Number(rate)) || cfg.rate));
  saveConfig({ voice: cfg.voice, rate: cfg.rate });
  log(`= voz: ${cfg.voice} a ${cfg.rate} palabras por minuto`);

  const sample = voice ? `Hola, soy ${chosen.label.replace(/\s*\(.*\)$/, '')}. Así te voy a leer las respuestas.` : 'Así voy a hablar ahora.';
  return json(res, 200, { current: cfg.voice, rate: cfg.rate, audio: await speak(sample) });
}

// Nombre propio para la carpeta de un canal. Vacío = vuelve al nombre de la carpeta.
async function handleName(req, res) {
  const { id, name = '' } = await readJson(req);
  const found = await channelsNow();
  const target = found.channels.find((c) => c.id === id);
  if (!target?.cwd) return json(res, 404, { error: 'Ese canal ya no existe.' });

  const clean = String(name).replace(/\s+/g, ' ').trim().slice(0, 40);
  cfg.names = { ...(cfg.names || {}) };
  if (clean) cfg.names[target.cwd] = clean;
  else delete cfg.names[target.cwd];
  saveConfig({ names: cfg.names });
  log(`= nombre de ${target.cwd}: ${clean || '(el de la carpeta)'}`);

  const updated = await resolveChannels();
  const renamed = updated.channels.find((c) => c.id === id) || updated.active;
  const payload = channelsPayload(updated);
  const number = updated.channels.indexOf(renamed) + 1;
  return json(res, 200, { ...payload, audio: await speak(`Canal ${number}. ${renamed.project}.`) });
}

async function serveStatic(res, pathname) {
  const file = path.normalize(path.join(PUBLIC, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC)) return json(res, 404, { error: 'no encontrado' });
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    json(res, 404, { error: 'no encontrado' });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const route = `${req.method} ${url.pathname}`;
  try {
    if (!url.pathname.startsWith('/api/')) return await serveStatic(res, url.pathname);
    if (!authorized(req, url)) return json(res, 401, { error: 'Token inválido.' });

    if (route === 'GET /api/events') return openEvents(req, res, url);
    if (route === 'GET /api/channels') return json(res, 200, channelsPayload(await resolveChannels()));
    if (route === 'POST /api/channel') return await handleSelect(req, res);
    if (route === 'POST /api/talk') return await handleTalk(req, res);
    if (route === 'POST /api/image') return await handleImage(req, res);
    if (route === 'POST /api/send') return await handleSend(req, res);
    if (route === 'GET /api/folders') return await handleFolders(res, url);
    if (route === 'GET /api/voices') return await handleVoices(res);
    if (route === 'POST /api/voice') return await handleVoice(req, res);
    if (route === 'GET /api/notices') return json(res, 200, noticeSettings());
    if (route === 'POST /api/notices') return await handleNotices(req, res);
    if (route === 'POST /api/name') return await handleName(req, res);
    if (route === 'POST /api/open') return await handleOpen(req, res);
    if (route === 'POST /api/hook') return await handleHook(req, res);
    if (route === 'POST /api/escape') {
      const { active } = await resolveChannels();
      if (!active) return json(res, 409, { error: 'No hay canal activo.' });
      await pressKey(active.id, 'escape');
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/audio/')) {
      const clip = getClip(url.pathname.split('/').pop());
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
  log(`supervoz escuchando en http://127.0.0.1:${cfg.port}`);
});
