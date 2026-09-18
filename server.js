#!/usr/bin/env node
// supervoz: walkie-talkie entre el iPhone y Claude Code corriendo en iTerm2.
//
//   iPhone (miniweb) --audio--> este servidor --> whisper-server (voz a texto)
//                                             --> iTerm2 (escribe y envía en el canal elegido)
//   Claude Code --hook Stop/PermissionRequest--> este servidor --say--> audio --SSE--> iPhone

import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './lib/config.js';
import { toSpeech, cleanTranscript, permissionAnswer } from './lib/speech.js';
import { writeAndSubmit, pressKey, listChannels, highlight, unhighlight, openClaude, sessionContents } from './lib/iterm.js';
import { listFolders, safeDir } from './lib/folders.js';
import { synthesize, getClip } from './lib/tts.js';

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
const pending = new Map(); // tty -> { project, clientId, permission }

async function resolveChannels() {
  const list = await listChannels();
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
  const want = active && clients.size > 0 ? { tty: active.tty, label: `📻 ${chLabel(index)}` } : null;
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

const publicChannel = (c, i) => c && { id: c.id, project: c.project, title: cleanTitle(c.title), number: i + 1 };

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

async function readBody(req, limit = 20 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('audio demasiado largo'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const readJson = async (req) => JSON.parse((await readBody(req, 2 * 1024 * 1024)).toString('utf8') || '{}');

function authorized(req, url) {
  return (req.headers['x-supervoz-token'] || url.searchParams.get('t')) === cfg.token;
}

// El teléfono mandó audio: se transcribe y se escribe en el canal activo.
async function handleTalk(req, res) {
  const clientId = req.headers['x-supervoz-client'] || null;
  const audio = await readBody(req);
  if (audio.length < 1000) return json(res, 422, { error: 'No llegó audio.' });

  const [text, found] = await Promise.all([transcribe(audio, req.headers['content-type'] || 'audio/mp4'), resolveChannels()]);
  if (!text) return json(res, 422, { error: 'No se entendió nada.' });

  const { active } = found;
  if (!active) return json(res, 409, { error: channelsPayload(found).error, text });

  // Si Claude está esperando un permiso, "sí" o "no" contestan el menú en vez de escribirse.
  const waiting = pending.get(active.tty);
  const answer = waiting?.permission ? permissionAnswer(text) : null;
  if (answer) await pressKey(active.id, answer === 'yes' ? 'enter' : 'escape');
  else await writeAndSubmit(active.id, text);

  pending.set(active.tty, { project: active.project, clientId, permission: false });
  log(`> ${active.project}: ${answer ? `[permiso: ${answer}]` : text}`);
  return json(res, 200, { text, project: active.project, permission: answer });
}

// Lo llama hooks/claude-hook.js cuando Claude Code termina de responder o pide permiso.
async function handleHook(req, res) {
  const body = await readJson(req);
  const waiting = pending.get(body.tty);
  if (!waiting) return json(res, 200, { ignored: true });

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
  const { channels } = await listChannels();
  const activeDirs = new Set(channels.map((c) => c.cwd));
  return json(res, 200, await listFolders(cfg.projectsRoot, url.searchParams.get('path') || '', activeDirs));
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
    found = await listChannels();
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
    if (route === 'GET /api/folders') return await handleFolders(res, url);
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
await waitForWhisper();
// Solo escucha en localhost: al teléfono le llega por `tailscale serve`, con HTTPS.
server.listen(cfg.port, '127.0.0.1', () => {
  log(`supervoz escuchando en http://127.0.0.1:${cfg.port}`);
});
