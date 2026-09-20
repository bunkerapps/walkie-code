// Cliente walkie-talkie: mantener PTT graba, soltar envía; las respuestas de Claude se escuchan solas.
// Deslizar la pantalla a los costados cambia de canal (cada sesión de Claude Code en iTerm2).

const $ = (id) => document.getElementById(id);
const radio = document.querySelector('.radio');
const lcd = $('lcd');
const ptt = $('ptt');
const meterBars = [...document.querySelectorAll('.lcd-meter i')];

const STATE_LABELS = {
  idle: 'LISTO',
  arming: 'ABRIENDO',
  tx: 'TX ▶',
  processing: 'PROCESANDO',
  waiting: 'CLAUDE PIENSA',
  rx: 'RX ◀',
  error: 'ERROR',
};

const MIN_TX_MS = 400;
const SWIPE_PX = 40;

// Identifica a este dispositivo: las respuestas suenan solo en el que habló.
// Se guarda para que sobreviva a una recarga: si iOS mató la app mientras Claude pensaba,
// la respuesta (y su aviso push) sigue siendo de este teléfono.
function readClientId() {
  const fresh = () => crypto.randomUUID?.() || String(Math.random()).slice(2);
  try {
    const saved = (localStorage.getItem('walkie-code-client') || localStorage.getItem('supervoz-client'));
    if (saved) return saved;
    const id = fresh();
    localStorage.setItem('walkie-code-client', id);
    return id;
  } catch {
    return fresh();
  }
}
const clientId = readClientId();

// ---------- Token ----------

function readToken() {
  const fromUrl = new URLSearchParams(location.search).get('t');
  try {
    if (fromUrl) localStorage.setItem('walkie-code-token', fromUrl);
    // supervoz-token: el nombre de antes; así el teléfono no hay que volver a configurarlo.
    return fromUrl || localStorage.getItem('walkie-code-token') || localStorage.getItem('supervoz-token');
  } catch {
    return fromUrl;
  }
}
const token = readToken();

function api(path, options = {}) {
  return fetch(path, {
    ...options,
    headers: { 'X-Walkie-Token': token, 'X-Walkie-Client': clientId, ...options.headers },
  });
}

// ---------- Pantalla ----------

let state = 'idle';

// Los mismos signos que usa Claude Code en la terminal mientras piensa.
const SPINNER = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
let spinnerTimer = 0;

function setSpinner(on) {
  clearInterval(spinnerTimer);
  if (!on) return;
  let frame = 0;
  const tick = () => ($('spinner').textContent = SPINNER[frame++ % SPINNER.length]);
  tick();
  spinnerTimer = setInterval(tick, 120);
}

function setState(next) {
  if (next !== state) setSpinner(next === 'waiting');
  if (next !== state && (next === 'idle' || next === 'waiting')) setTimeout(flushNotices, 600);
  state = next;
  radio.dataset.state = next;
  $('state-label').textContent = STATE_LABELS[next] || next.toUpperCase();
  renderHint();
}

function renderHint() {
  const hint = state === 'tx' ? 'SOLTÁ PARA ENVIAR' : 'MANTENÉ PARA HABLAR';
  $('ptt-hint').textContent = photo ? `${hint} + FOTO` : hint;
}

// Cada canal tiene su propio historial en pantalla: al cambiar de canal se ve solo lo de ese canal
// (antes era uno solo y lo del canal nuevo quedaba mezclado debajo de lo del anterior).
const MAX_LOG = 40;
const logs = new Map(); // id de canal -> [{ who, text, muted }]
const logKey = (channel) => channel || activeId || '-';

function logLine({ who, text, muted }) {
  const p = document.createElement('p');
  if (muted) p.className = 'muted';
  if (who) {
    const b = document.createElement('b');
    b.textContent = who;
    p.append(b);
  }
  p.append(text);
  p.addEventListener('click', () => openReader(who, text));
  return p;
}

// `channel`: a qué canal pertenece el mensaje (por defecto, el que está en pantalla).
function log(who, text, { muted = false, channel } = {}) {
  const key = logKey(channel);
  const list = logs.get(key) || [];
  const entry = { who, text, muted };
  list.push(entry);
  while (list.length > MAX_LOG) list.shift();
  logs.set(key, list);
  if (key !== logKey()) return;
  const logEl = $('log');
  logEl.append(logLine(entry));
  while (logEl.children.length > MAX_LOG) logEl.firstChild.remove();
  logEl.scrollTop = logEl.scrollHeight;
}

// Muestra el historial del canal que quedó en pantalla.
function renderLog() {
  const logEl = $('log');
  logEl.replaceChildren(...(logs.get(logKey()) || []).map(logLine));
  logEl.scrollTop = logEl.scrollHeight;
}

// El canal de un mensaje que llega con el nombre del proyecto.
const channelOf = (project) => channels.find((c) => c.project === project)?.id;

function fail(message) {
  sfx.error();
  setState('error');
  log('!', message);
  setTimeout(() => state === 'error' && setState('idle'), 1500);
}

// ---------- Canales ----------

let channels = [];
let activeId = null;

function renderChannel(direction) {
  const index = channels.findIndex((c) => c.id === activeId);
  const active = channels[index];
  $('ch').textContent = active ? `CH${String(index + 1).padStart(2, '0')}` : 'CH--';
  $('project').textContent = active ? active.project : 'SIN CLAUDE';
  $('ch-nav').textContent = channels.length > 1 ? `◂${index + 1}/${channels.length}▸` : '';
  setNowPlaying();
  if (direction) {
    lcd.classList.remove('swipe-next', 'swipe-prev');
    void lcd.offsetWidth;
    lcd.classList.add(direction > 0 ? 'swipe-next' : 'swipe-prev');
  }
}

let announcedId = null;

function applyChannels(payload) {
  channels = payload.channels || [];
  activeId = payload.active?.id || null;
  renderChannel();
  // Cada vez que cambia el canal (deslizando o porque cambió la terminal activa en la Mac)
  // se muestra de qué se trata esa sesión.
  if (payload.active && payload.active.id !== announcedId) {
    announcedId = payload.active.id;
    renderLog();
    takeFromInbox(payload.active.id);
    // El título y el resumen, solo la primera vez que se ve el canal: al volver ya está su historial.
    if (!logs.get(payload.active.id)?.length) {
      if (payload.active.title) log(`CH${String(payload.active.number).padStart(2, '0')}`, payload.active.title, { muted: true });
      showRecap(payload.active.id);
    }
  }
}

// Lo último que pasó en el canal, aunque se haya escrito desde la Mac: el último pedido y la última
// respuesta. Se muestra al abrir la app y al cambiar de canal; REPETIR lo lee en voz alta.
async function fetchRecap(id, speak = false) {
  const res = await api(`/api/recap?id=${encodeURIComponent(id || '')}${speak ? '&speak=1' : ''}`);
  return res.ok ? res.json() : null;
}

async function showRecap(id) {
  const recap = await fetchRecap(id).catch(() => null);
  if (!recap || recap.empty) return;
  // Va al historial de ese canal aunque, mientras llegaba, se haya cambiado a otro.
  if (recap.prompt) log('ÚLTIMO · VOS', recap.prompt, { muted: true, channel: id });
  if (recap.working) log('CLAUDE', 'TODAVÍA ESTÁ TRABAJANDO…', { muted: true, channel: id });
  else if (recap.reply) log('CLAUDE', recap.reply, { muted: true, channel: id });
  if (id !== activeId) return;
  setNowPlaying(recap.working ? 'Todavía está trabajando…' : recap.reply || '');
}

async function refreshChannels() {
  if (document.hidden || !token) return;
  try {
    const res = await api('/api/channels');
    if (res.status === 401) return fail('TOKEN INVÁLIDO');
    applyChannels(await res.json());
  } catch {}
}

async function switchChannel(direction) {
  if (channels.length < 2 || state === 'tx' || state === 'arming') {
    if (channels.length < 2) log('', 'HAY UN SOLO PROYECTO ABIERTO', { muted: true });
    return;
  }
  const index = channels.findIndex((c) => c.id === activeId);
  const next = channels[(index + direction + channels.length) % channels.length];
  return selectChannel(next.id, direction);
}

// Sintoniza un canal por su id (deslizando, desde la isla o tocando un aviso de respuesta en espera).
async function selectChannel(id, direction) {
  if (state === 'tx' || state === 'arming') return;
  unlockAudio();
  const from = channels.findIndex((c) => c.id === activeId);
  const to = channels.findIndex((c) => c.id === id);
  activeId = id;
  renderChannel(direction ?? (to < from ? -1 : 1));
  renderLog();
  renderInbox();
  sfx.click();
  try {
    const res = await api('/api/channel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    const body = await res.json();
    applyChannels(body);
    if (!res.ok) return fail((body.error || 'NO SE PUDO CAMBIAR').toUpperCase());
    if (body.audio) play(body.audio, { squelch: false, rx: false });
  } catch {
    fail('SIN CONEXIÓN CON LA MAC');
  }
}

// Deslizar a la izquierda = siguiente canal, a la derecha = anterior.
// Mantener apretado el nombre del canal = ponerle un nombre propio.
const LONG_PRESS_MS = 600;
let swipeStart = null;
let longPress = 0;

lcd.addEventListener('pointerdown', (e) => {
  swipeStart = { x: e.clientX, y: e.clientY };
  if (e.target.closest('.lcd-top')) {
    longPress = setTimeout(() => {
      swipeStart = null;
      openRename();
    }, LONG_PRESS_MS);
  }
});
lcd.addEventListener('pointermove', (e) => {
  if (swipeStart && Math.hypot(e.clientX - swipeStart.x, e.clientY - swipeStart.y) > 10) clearTimeout(longPress);
});
lcd.addEventListener('pointercancel', () => {
  clearTimeout(longPress);
  swipeStart = null;
});
lcd.addEventListener('pointerup', (e) => {
  clearTimeout(longPress);
  if (!swipeStart) return;
  const dx = e.clientX - swipeStart.x;
  const dy = e.clientY - swipeStart.y;
  swipeStart = null;
  if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(dy) * 1.5) switchChannel(dx < 0 ? 1 : -1);
});

// ---------- Sonidos del equipo ----------

let ctx;

// iOS deja el motor de sonido "interrupted" (no solo "suspended") después de un rato en segundo plano,
// una llamada o el micrófono: antes solo se reanudaba "suspended" y los efectos quedaban mudos.
// Se reanuda en cualquier estado que no sea "running", y si iOS lo cerró se crea otro
// (los sonidos ya decodificados sirven igual en el nuevo).
function audioCtx() {
  if (!ctx || ctx.state === 'closed') ctx = new AudioContext();
  if (ctx.state !== 'running') {
    ctx.resume().catch(() => {
      ctx = new AudioContext();
    });
  }
  return ctx;
}

function beep(notes, volume = 0.12) {
  const ac = audioCtx();
  let t = ac.currentTime;
  for (const [freq, dur] of notes) {
    if (!freq) {
      t += dur;
      continue;
    }
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = 'square';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(volume, t + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain).connect(ac.destination);
    osc.start(t);
    osc.stop(t + dur + 0.01);
    t += dur;
  }
}

function squelch(dur = 0.22, level = 1) {
  const ac = audioCtx();
  const buffer = ac.createBuffer(1, ac.sampleRate * dur, ac.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const src = ac.createBufferSource();
  const band = ac.createBiquadFilter();
  const gain = ac.createGain();
  src.buffer = buffer;
  band.type = 'bandpass';
  band.frequency.value = 1800;
  band.Q.value = 0.7;
  gain.gain.setValueAtTime(Math.max(0.0001, 0.25 * level), ac.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + dur);
  src.connect(band).connect(gain).connect(ac.destination);
  src.start();
}

// Volumen de cada efecto, de 0 a 150 %, guardado en este teléfono (cada dispositivo suena distinto).
const FX = [['ptt', 'APRETAR'], ['release', 'SOLTAR'], ['rx', 'RESPUESTA'], ['notice', 'AVISOS']];
const FX_KEY = 'walkie-code-fx';
const fxVolume = (() => {
  try {
    return { ptt: 1, release: 1, rx: 1, notice: 1, ...JSON.parse(localStorage.getItem(FX_KEY) || '{}') };
  } catch {
    return { ptt: 1, release: 1, rx: 1, notice: 1 };
  }
})();
const vol = (name) => fxVolume[name] ?? 1;

// Volumen de la voz, de 20 a 300 %, también por teléfono. Safari en iOS ignora el volumen de <audio>,
// así que la ganancia la aplica la Mac al servir el audio (?g=).
const VOICE_VOL_KEY = 'walkie-code-voice-volume';
const VOICE_VOL_MIN = 0.2;
const VOICE_VOL_MAX = 3;
let voiceVolume = (() => {
  try {
    const v = Number(localStorage.getItem(VOICE_VOL_KEY));
    return v >= VOICE_VOL_MIN && v <= VOICE_VOL_MAX ? v : 1;
  } catch {
    return 1;
  }
})();

// Sonidos grabados del equipo (public/sounds). Si todavía no cargaron, se sintetizan.
const samples = {};

async function loadSamples() {
  const ac = audioCtx();
  await Promise.all(['ptt', 'release', 'rx'].map(async (name) => {
    try {
      const res = await fetch(`sounds/${name}.m4a`);
      samples[name] = await ac.decodeAudioData(await res.arrayBuffer());
    } catch {}
  }));
}

function playSample(name) {
  const buffer = samples[name];
  if (!buffer) return false;
  const ac = audioCtx();
  const src = ac.createBufferSource();
  const gain = ac.createGain();
  gain.gain.value = vol(name);
  src.buffer = buffer;
  src.connect(gain).connect(ac.destination);
  src.start();
  return true;
}

const sfx = {
  txStart: () => playSample('ptt') || beep([[1250, 0.07]], 0.12 * vol('ptt')),
  release: () => playSample('release') || beep([[1500, 0.07], [1050, 0.1]], 0.12 * vol('release')),
  click: () => beep([[2200, 0.02]], 0.06),
  incoming: () => playSample('rx') || squelch(0.22, vol('rx')),
  error: () => beep([[320, 0.14], [220, 0.2]]),
  waiting: () => vol('notice') > 0 && beep([[1760, 0.06], [0, 0.07], [1760, 0.06]], 0.09 * vol('notice')),
  notice: () => vol('notice') > 0 && beep([[988, 0.09], [1319, 0.18]], 0.08 * vol('notice')),
};

// En iOS, con el micrófono abierto el audio sale por el auricular y no por el parlante.
function setAudioSession(type) {
  try {
    if (navigator.audioSession) navigator.audioSession.type = type;
  } catch {}
}

// ---------- Voz de Claude (audio generado en la Mac) ----------

const player = new Audio();
player.preload = 'auto';
let lastClip = null;

player.addEventListener('playing', () => {
  // Safari pisa los datos de la pantalla bloqueada al cargar un audio nuevo: se vuelven a poner.
  setNowPlaying();
  if (player.dataset.rx) setState('rx');
});
for (const type of ['ended', 'pause', 'error']) {
  player.addEventListener(type, () => state === 'rx' && setState('idle'));
}
player.addEventListener('ended', () => setTimeout(flushNotices, 400));

// Hasta cuándo hay un audio a punto de arrancar (el squelch va antes de la voz).
let playStartsAt = 0;

// `quiet`: si Safari no deja reproducir, no se pide tocar REPETIR (los avisos ya quedan en pantalla).
// iOS muestra el audio de la web en la Isla Dinámica y en la pantalla bloqueada como si fuera música:
// así se ve quién habla y en qué canal, con el ícono del walkie.
// Lo último que dijo Claude en el canal sintonizado, para mostrarlo debajo del canal.
let nowText = '';
let nowChannel = null;
const snippet = (text) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, 90);

function setNowPlaying(text) {
  if (!('mediaSession' in navigator)) return;
  if (activeId !== nowChannel) {
    nowChannel = activeId;
    nowText = '';
  }
  if (text !== undefined) nowText = snippet(text);
  const index = channels.findIndex((c) => c.id === activeId);
  const active = channels[index];
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: active ? `CH${String(index + 1).padStart(2, '0')} · ${active.project}` : 'Claude',
      artist: nowText || 'Walkie-Code',
      album: 'Walkie-Code · BunkerApps',
      artwork: [{ src: 'icon-180.png', sizes: '180x180', type: 'image/png' }],
    });
    navigator.mediaSession.setActionHandler('pause', stopPlayback);
    navigator.mediaSession.setActionHandler('stop', stopPlayback);
    navigator.mediaSession.setActionHandler('play', () => player.play().catch(() => {}));
    navigator.mediaSession.setActionHandler('seekbackward', null);
    navigator.mediaSession.setActionHandler('seekforward', null);
    navigator.mediaSession.setActionHandler('previoustrack', () => switchChannel(-1));
    navigator.mediaSession.setActionHandler('nexttrack', () => switchChannel(1));
  } catch {}
}

function play(src, { squelch: withSquelch = true, rx = true, delay = withSquelch ? 280 : 0, quiet = false } = {}) {
  player.pause();
  setAudioSession('playback');
  setNowPlaying();
  if (withSquelch) sfx.incoming();
  player.dataset.rx = rx ? '1' : '';
  playStartsAt = Date.now() + delay;
  setTimeout(() => {
    const gain = voiceVolume === 1 ? '' : `&g=${voiceVolume}`;
    player.src = `${src}?t=${encodeURIComponent(token)}${gain}`;
    player.play().catch(() => quiet || log('', 'TOCÁ REPETIR PARA ESCUCHAR', { muted: true }));
  }, delay);
}

function stopPlayback() {
  player.pause();
  if (state === 'rx') setState('idle');
}

// Safari solo deja reproducir audio si la primera vez ocurre dentro de un toque.
// Se "desbloquea" el reproductor con un silencio y después puede sonar solo.
function silentWav() {
  const samples = 800;
  const view = new DataView(new ArrayBuffer(44 + samples * 2));
  const text = (offset, s) => [...s].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples * 2, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 16000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples * 2, true);
  return URL.createObjectURL(new Blob([view.buffer], { type: 'audio/wav' }));
}

let unlocked = false;
function unlockAudio() {
  audioCtx();
  requestWakeLock();
  if (unlocked) return;
  unlocked = true;
  player.dataset.rx = '';
  player.src = silentWav();
  player.play().catch(() => (unlocked = false));
}

// ---------- Transmisión ----------

let stream = null;
let recorder = null;
let chunks = [];
let txStartedAt = 0;
let pressing = false;
let meterFrame = 0;

async function startTx() {
  if (pressing || state === 'processing') return;
  pressing = true;
  unlockAudio();
  stopPlayback();
  setState('arming');

  try {
    setAudioSession('play-and-record');
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch {
    pressing = false;
    return fail('SIN PERMISO DE MICRÓFONO');
  }
  // Soltó antes de que el micrófono estuviera listo.
  if (!pressing) return releaseMic(), setState('idle');

  const mimeType = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find((m) => MediaRecorder.isTypeSupported(m));
  recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  chunks = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.start();
  txStartedAt = performance.now();
  sfx.txStart();
  setState('tx');
  startMeter();
}

function endTx() {
  if (!pressing) return;
  pressing = false;
  if (state !== 'tx') return;

  const duration = performance.now() - txStartedAt;
  recorder.onstop = () => {
    const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/mp4' });
    releaseMic();
    if (duration < MIN_TX_MS) {
      setState('idle');
      log('', 'MUY CORTO, MANTENÉ APRETADO', { muted: true });
      return;
    }
    send(blob);
  };
  recorder.stop();
  sfx.release();
}

function releaseMic() {
  cancelAnimationFrame(meterFrame);
  meterBars.forEach((b) => b.classList.remove('on'));
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  setAudioSession('playback');
}

function startMeter() {
  const ac = audioCtx();
  const analyser = ac.createAnalyser();
  analyser.fftSize = 512;
  ac.createMediaStreamSource(stream).connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  const tick = () => {
    analyser.getFloatTimeDomainData(samples);
    const rms = Math.sqrt(samples.reduce((s, v) => s + v * v, 0) / samples.length);
    const lit = Math.min(meterBars.length, Math.round(rms * 60));
    meterBars.forEach((b, i) => b.classList.toggle('on', i < lit));
    meterFrame = requestAnimationFrame(tick);
  };
  tick();
}

async function send(blob) {
  setState('processing');
  // Si hay una foto cargada, viaja con esta transmisión (se espera a que termine de subir).
  const sent = photo;
  const imageId = sent ? await sent.ready.catch(() => null) : null;
  if (sent && !imageId) return fail('LA FOTO NO SE SUBIÓ. NO SE ENVIÓ NADA');
  try {
    const headers = { 'Content-Type': blob.type, ...(imageId && { 'X-Walkie-Image': imageId }) };
    await afterSend(await api('/api/talk', { method: 'POST', headers, body: blob }), sent);
  } catch {
    fail('SIN CONEXIÓN CON LA MAC');
  }
}

async function afterSend(res, sent) {
  const body = await res.json().catch(() => ({}));
  // 410: la foto ya no está en la Mac; no tiene sentido dejarla cargada.
  if (res.status === 410 && photo === sent) clearPhoto();
  if (!res.ok) {
    if (body.text) log('VOS', body.text, { muted: true });
    return fail((body.error || `ERROR ${res.status}`).toUpperCase());
  }
  if ('switched' in body) return tunedByVoice(body);
  if (body.image && photo === sent) clearPhoto();
  const text = body.image ? `📎 ${body.text}` : body.text;
  log('VOS', body.permission ? `${text} (permiso)` : text);
  setState('waiting');
}

// ---------- Foto para Claude ----------

// Se achica en el teléfono: una foto del iPhone pesa varios MB y Claude no necesita más de 1600 px.
const PHOTO_MAX_SIDE = 1600;
const PHOTO_QUALITY = 0.82;
const attachEl = $('attach');
let photo = null; // { ready: Promise<id>, thumb: objectURL }

async function shrinkPhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    const g = canvas.getContext('2d');
    // Fondo blanco: un PNG con transparencia en JPEG quedaría negro.
    g.fillStyle = '#fff';
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', PHOTO_QUALITY));
    if (!blob) throw new Error('no se pudo comprimir');
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function uploadPhoto(blob) {
  const res = await api('/api/image', {
    method: 'POST',
    headers: { 'Content-Type': blob.type || 'application/octet-stream' },
    body: blob,
  }).catch(() => {
    throw new Error('SIN CONEXIÓN CON LA MAC');
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `ERROR ${res.status}`);
  return body.id;
}

function renderPhoto(label = 'FOTO LISTA', busy = false) {
  radio.dataset.photo = photo ? 'on' : 'off';
  attachEl.hidden = !photo;
  attachEl.classList.toggle('busy', busy);
  $('attach-label').textContent = label;
  $('attach-send').disabled = busy;
  if (photo?.thumb) $('attach-thumb').src = photo.thumb;
  else $('attach-thumb').removeAttribute('src');
  renderHint();
}

function clearPhoto() {
  if (photo?.thumb) URL.revokeObjectURL(photo.thumb);
  photo = null;
  renderPhoto();
}

// Se sube apenas se elige; el PTT (o ENVIAR SOLA) después solo manda el id.
function attachPhoto(file) {
  clearPhoto();
  const current = { thumb: null };
  photo = current;
  renderPhoto('PREPARANDO…', true);
  current.ready = (async () => {
    const blob = await shrinkPhoto(file).catch(() => file);
    if (photo !== current) throw new Error('descartada');
    current.thumb = URL.createObjectURL(blob);
    renderPhoto('SUBIENDO…', true);
    const id = await uploadPhoto(blob);
    if (photo === current) renderPhoto();
    return id;
  })();
  current.ready.catch((err) => {
    if (photo !== current) return;
    clearPhoto();
    fail(`FOTO: ${err.message.toUpperCase()}`);
  });
}

// La foto sola, sin dictar nada: el servidor le pone el texto por defecto.
async function sendPhotoAlone() {
  if (!photo || ['arming', 'tx', 'processing'].includes(state)) return;
  unlockAudio();
  stopPlayback();
  sfx.click();
  const sent = photo;
  setState('processing');
  const image = await sent.ready.catch(() => null);
  if (!image) return state === 'processing' && setState('idle');
  try {
    await afterSend(await api('/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image }),
    }), sent);
  } catch {
    fail('SIN CONEXIÓN CON LA MAC');
  }
}

$('photo-key').addEventListener('click', () => {
  unlockAudio();
  $('photo-input').click();
});
$('photo-input').addEventListener('change', (e) => {
  const [file] = e.target.files;
  e.target.value = '';
  if (file) attachPhoto(file);
});
$('attach-send').addEventListener('click', sendPhotoAlone);
$('attach-remove').addEventListener('click', () => {
  sfx.click();
  clearPhoto();
});

// Dijo "canal superprecio": el servidor ya sintonizó (o explica por qué no) y no le escribió a Claude.
function tunedByVoice(body) {
  log('VOS', body.text, { muted: true });
  setState('idle');
  if (!body.switched) {
    sfx.error();
    log('CANAL', (body.message || 'NO ENCONTRÉ ESE CANAL').toUpperCase());
  } else {
    const before = channels.findIndex((c) => c.id === activeId);
    applyChannels(body);
    const after = channels.findIndex((c) => c.id === activeId);
    renderChannel(after < before ? -1 : 1);
    sfx.click();
    log('CANAL →', `CH${String(body.active.number).padStart(2, '0')} ${body.active.project.toUpperCase()}`);
  }
  if (body.audio) play(body.audio, { squelch: false, rx: false });
}

// ---------- Entrada: dedo o barra espaciadora ----------

ptt.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  ptt.setPointerCapture(e.pointerId);
  ptt.classList.add('pressed');
  startTx();
});
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  ptt.addEventListener(type, () => {
    ptt.classList.remove('pressed');
    endTx();
  });
}
ptt.addEventListener('contextmenu', (e) => e.preventDefault());

addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.code === 'Space' && !e.repeat) {
    e.preventDefault();
    startTx();
  }
  if (e.code === 'ArrowRight') switchChannel(1);
  if (e.code === 'ArrowLeft') switchChannel(-1);
});
addEventListener('keyup', (e) => e.code === 'Space' && endTx());

$('replay').addEventListener('click', async () => {
  unlockAudio();
  sfx.click();
  const recap = await fetchRecap(activeId, true).catch(() => null);
  if (recap?.audio) return play(recap.audio, { squelch: false });
  lastClip ? play(lastClip) : log('', 'TODAVÍA NO HAY NADA EN ESTE CANAL', { muted: true });
});
$('mute').addEventListener('click', stopPlayback);
$('reload').addEventListener('click', () => location.reload());
$('escape').addEventListener('click', async () => {
  unlockAudio();
  stopPlayback();
  const res = await api('/api/escape', { method: 'POST' }).catch(() => null);
  if (res?.ok) {
    log('', 'ESC ENVIADO A CLAUDE', { muted: true });
    if (state === 'waiting') setState('idle');
  } else fail('NO SE PUDO ENVIAR ESC');
});

// ---------- Abrir Claude en una carpeta ----------

const picker = $('picker');
const pickerOpen = $('picker-open');
let folderView = null;

function pickerMessage(text) {
  const li = document.createElement('li');
  li.className = 'empty';
  li.textContent = text;
  $('picker-list').replaceChildren(li);
}

async function loadFolder(rel = '') {
  pickerMessage('CARGANDO…');
  try {
    const res = await api(`/api/folders?path=${encodeURIComponent(rel)}`);
    const body = await res.json();
    if (!res.ok) throw new Error(body.error);
    folderView = body;
    $('picker-filter').value = '';
    renderFolders();
  } catch (err) {
    pickerMessage((err.message || 'SIN CONEXIÓN CON LA MAC').toUpperCase());
  }
}

function renderFolders() {
  const view = folderView;
  if (!view) return;
  $('picker-path').textContent = view.rel || `~/${view.name}`;
  $('picker-back').disabled = view.parent === null;
  pickerOpen.textContent = view.active ? '▶ OTRO CLAUDE ACÁ' : '▶ ABRIR CLAUDE ACÁ';

  const query = $('picker-filter').value.trim().toLowerCase();
  const rows = view.folders.filter((f) => f.name.toLowerCase().includes(query));
  if (!rows.length) return pickerMessage(query ? 'NADA COINCIDE' : 'SIN SUBCARPETAS');

  $('picker-list').replaceChildren(
    ...rows.map((folder) => {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = folder.name;
      button.append(name);
      if (folder.alias) name.textContent = `${folder.name} · ${folder.alias}`;
      for (const [on, label] of [[folder.active, 'EN USO'], [folder.git, 'GIT']]) {
        if (!on) continue;
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = label;
        button.append(tag);
      }
      button.append('›');
      button.addEventListener('click', () => {
        sfx.click();
        loadFolder(folder.rel);
      });
      li.append(button);
      return li;
    }),
  );
}

function openPicker() {
  unlockAudio();
  picker.hidden = false;
  renderCloseChannel();
  loadFolder(folderView?.rel || '');
}

// ---------- Cerrar el canal sintonizado ----------
// Dos toques: el primero pide confirmación (3 s), el segundo sale de Claude Code y cierra la pestaña.

const closeButton = $('close-channel');
let closeArmed = null;

function renderCloseChannel() {
  clearTimeout(closeArmed);
  closeArmed = null;
  closeButton.classList.remove('confirm');
  closeButton.disabled = false;
  const index = channels.findIndex((c) => c.id === activeId);
  closeButton.hidden = index === -1;
  if (index !== -1) closeButton.textContent = `✕ CERRAR CH${String(index + 1).padStart(2, '0')} · ${channels[index].project.toUpperCase()}`;
}

closeButton.addEventListener('click', async () => {
  unlockAudio();
  sfx.click();
  if (!closeArmed) {
    closeButton.classList.add('confirm');
    closeButton.textContent = '¿SEGURO? TOCÁ DE NUEVO PARA CERRAR';
    closeArmed = setTimeout(renderCloseChannel, 3000);
    return;
  }
  clearTimeout(closeArmed);
  closeButton.disabled = true;
  closeButton.textContent = '… CERRANDO';
  try {
    const res = await api('/api/close', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: activeId }),
    });
    const body = await res.json();
    applyChannels(body);
    if (!res.ok) fail((body.error || 'NO SE PUDO CERRAR').toUpperCase());
    else {
      closePicker();
      if (body.audio) play(body.audio, { squelch: false, rx: false });
    }
  } catch {
    fail('SIN CONEXIÓN CON LA MAC');
  }
  renderCloseChannel();
});

function closePicker() {
  picker.hidden = true;
  $('picker-filter').blur();
}

$('new').addEventListener('click', openPicker);
$('picker-close').addEventListener('click', closePicker);
$('picker-new').addEventListener('click', openNewProject);
$('picker-back').addEventListener('click', () => folderView?.parent !== null && loadFolder(folderView.parent));
$('picker-filter').addEventListener('input', renderFolders);

pickerOpen.addEventListener('click', async () => {
  unlockAudio();
  sfx.click();
  pickerOpen.disabled = true;
  pickerOpen.textContent = '… ARRANCANDO CLAUDE';
  try {
    const res = await api('/api/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: folderView?.rel || '' }),
    });
    const body = await res.json();
    closePicker();
    if (!res.ok) return fail((body.error || 'NO SE PUDO ABRIR').toUpperCase());
    applyChannels(body);
    renderChannel(1);
    if (body.trust) log('PERMISO', 'CLAUDE PREGUNTA SI CONFIÁS EN LA CARPETA. DECÍ "SÍ".');
    if (body.audio) play(body.audio, { squelch: false, rx: false });
  } catch {
    closePicker();
    fail('SIN CONEXIÓN CON LA MAC');
  } finally {
    pickerOpen.disabled = false;
    renderFolders();
  }
});

// ---------- Nombre del canal ----------

const renamePanel = $('rename');

// El mismo panel sirve para nombrar un proyecto nuevo: se crea la carpeta con una página inicial
// y se abre su propio canal de Claude Code.
let creandoProyecto = false;

function openNewProject() {
  unlockAudio();
  sfx.click();
  creandoProyecto = true;
  $('rename-title').textContent = 'PROYECTO NUEVO';
  $('rename-folder').textContent = 'SE CREA DENTRO DE TUS PROYECTOS';
  $('rename-input').value = '';
  $('rename-input').placeholder = 'PASEOS DE PERROS';
  renamePanel.hidden = false;
  $('rename-input').focus();
}

async function createProject(name) {
  closePicker();
  setState('processing');
  try {
    const res = await api('/api/project', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const body = await res.json();
    if (!res.ok) {
      setState('idle');
      return fail((body.error || 'NO SE PUDO CREAR').toUpperCase());
    }
    applyChannels(body);
    renderChannel(1);
    if (body.trust) log('PERMISO', 'CLAUDE PREGUNTA SI CONFIÁS EN LA CARPETA. DECÍ "SÍ".');
    setState('idle');
    if (body.audio) play(body.audio, { squelch: false, rx: false });
  } catch {
    setState('idle');
    fail('SIN CONEXIÓN CON LA MAC');
  }
}

function openRename() {
  creandoProyecto = false;
  $('rename-title').textContent = 'NOMBRE DEL CANAL';
  $('rename-input').placeholder = 'VACÍO = NOMBRE DE LA CARPETA';
  const active = channels.find((c) => c.id === activeId);
  if (!active) return log('', 'NO HAY CANAL PARA NOMBRAR', { muted: true });
  sfx.click();
  $('rename-folder').textContent = `CARPETA: ${active.folder}`;
  $('rename-input').value = active.named ? active.project.replace(/·\d+$/, '') : '';
  renamePanel.hidden = false;
  $('rename-input').focus();
}

async function saveName() {
  const name = $('rename-input').value;
  $('rename-input').blur();
  renamePanel.hidden = true;
  unlockAudio();
  if (creandoProyecto) {
    creandoProyecto = false;
    return name.trim() ? createProject(name) : log('', 'HACE FALTA UN NOMBRE', { muted: true });
  }
  try {
    const res = await api('/api/name', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: activeId, name }),
    });
    const body = await res.json();
    if (!res.ok) return fail((body.error || 'NO SE PUDO GUARDAR').toUpperCase());
    applyChannels(body);
    renderChannel(1);
    if (body.audio) play(body.audio, { squelch: false, rx: false });
  } catch {
    fail('SIN CONEXIÓN CON LA MAC');
  }
}

$('rename-save').addEventListener('click', saveName);
$('rename-input').addEventListener('keydown', (e) => e.key === 'Enter' && saveName());
$('rename-close').addEventListener('click', () => {
  $('rename-input').blur();
  renamePanel.hidden = true;
});

// ---------- Permisos ----------
//
// Claude pide permiso en el canal al que le hablaste: se ve qué quiere hacer (el comando, el archivo) y se
// contesta acá o por voz. La respuesta vuelve por el hook como decisión oficial, sin tocar teclas en la Mac.

let permId = null;

function showPermission({ permission, project }) {
  permId = permission.id;
  $('perm-title').textContent = `PERMISO · ${(project || '').toUpperCase()}`;
  $('perm-summary').textContent = permission.summary;
  $('perm-detail').textContent = permission.detail || '';
  $('perm-always').hidden = !permission.always;
  $('perm').hidden = false;
}

function hidePermission(id) {
  if (id && id !== permId) return;
  permId = null;
  $('perm').hidden = true;
}

const PERM_LABELS = { allow: 'APROBADO', always: 'APROBADO SIEMPRE', deny: 'RECHAZADO' };

async function answerPermission(decision) {
  if (!permId) return;
  unlockAudio();
  sfx.click();
  const id = permId;
  hidePermission();
  try {
    const res = await api('/api/permission', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, decision }),
    });
    if (!res.ok) return fail(((await res.json()).error || 'NO SE PUDO RESPONDER').toUpperCase());
    setState('waiting');
  } catch {
    fail('SIN CONEXIÓN CON LA MAC');
  }
}

$('perm-allow').addEventListener('click', () => answerPermission('allow'));
$('perm-always').addEventListener('click', () => answerPermission('always'));
$('perm-deny').addEventListener('click', () => answerPermission('deny'));

function onPermissionDone(e) {
  rememberEvent(e);
  const { id, decision, to } = JSON.parse(e.data);
  if (to && to !== clientId) return;
  hidePermission(id);
  log('PERMISO', decision ? PERM_LABELS[decision] : 'SIN RESPUESTA: QUEDÓ PARA CONTESTAR EN LA MAC', { muted: true });
}

// ---------- Respuestas en espera ----------
//
// Con varios canales trabajando a la vez, las voces se encimaban. Una respuesta de otro canal no suena:
// hace "pi-pi", queda esperando y la pantalla muestra "MSJ CH03"; se escucha al ir a ese canal.
// Una del canal actual que llega mientras suena otra cosa espera su turno en vez de cortarla.

const inbox = new Map(); // id de canal -> { audio, text, project, at }
const playQueue = [];
let queueTimer = 0;

function renderInbox() {
  const waiting = [...inbox.entries()].filter(([id]) => id !== activeId).sort((a, b) => a[1].at - b[1].at);
  const el = $('inbox');
  el.hidden = !waiting.length;
  if (!waiting.length) return;
  const number = channels.findIndex((c) => c.id === waiting[0][0]) + 1;
  el.textContent = `MSJ CH${String(number).padStart(2, '0')}${waiting.length > 1 ? ` +${waiting.length - 1}` : ''}`;
}

function enqueueAudio(audio) {
  playQueue.push(audio);
  clearInterval(queueTimer);
  queueTimer = setInterval(() => {
    if (!playQueue.length) return clearInterval(queueTimer);
    if (!audioBusy()) play(playQueue.shift());
  }, 400);
}

function deliverAudio(channel, reply) {
  if (channel && channel !== activeId) {
    inbox.set(channel, { ...reply, at: Date.now() });
    sfx.waiting();
    renderInbox();
    return;
  }
  lastClip = reply.audio;
  audioBusy() ? enqueueAudio(reply.audio) : play(reply.audio);
}

// Al llegar a un canal (deslizando, por voz o tocando el aviso), su respuesta en espera se escucha.
function takeFromInbox(channel) {
  const waiting = inbox.get(channel);
  inbox.delete(channel);
  renderInbox();
  if (!waiting) return;
  lastClip = waiting.audio;
  setNowPlaying(waiting.text);
  enqueueAudio(waiting.audio);
}

// Tocar el aviso: ir al canal que espera hace más tiempo.
$('inbox').addEventListener('click', (e) => {
  e.stopPropagation();
  const [first] = [...inbox.entries()].filter(([id]) => id !== activeId).sort((a, b) => a[1].at - b[1].at);
  if (first) selectChannel(first[0]);
});

// ---------- Lector de mensajes completos ----------

function openReader(who, text) {
  $('reader-title').textContent = who || 'MENSAJE';
  $('reader-text').textContent = text;
  $('reader').hidden = false;
  $('reader-text').scrollTop = 0;
}
$('reader-close').addEventListener('click', () => ($('reader').hidden = true));

// ---------- Tele ----------
//
// Un botón: proyecta la página más nueva del proyecto sintonizado y la deja recargándose sola en la tele.
// Volver a tocarlo la saca. Al lado, el dispositivo elegido, que se puede cambiar entre los de la red.

let castState = { casting: null, device: null };
let castDevices = [];

function renderCast() {
  const on = Boolean(castState.casting);
  $('cast-toggle').textContent = on ? 'SACAR' : 'PROYECTAR';
  $('cast-toggle').setAttribute('aria-pressed', String(on));
  $('cast-device').textContent = (castState.casting?.device || castState.device || '').toUpperCase() || 'SIN DISPOSITIVO';
}

async function refreshCast() {
  try {
    castState = await (await api('/api/cast')).json();
    renderCast();
  } catch {}
}

async function toggleCast() {
  unlockAudio();
  sfx.click();
  const era = Boolean(castState.casting);
  $('cast-toggle').textContent = era ? 'SACANDO…' : 'BUSCANDO…';
  try {
    const res = await api(era ? '/api/cast/stop' : '/api/cast/auto', { method: 'POST' });
    const body = await res.json();
    if (!res.ok) {
      await refreshCast();
      return fail((body.error || 'NO SE PUDO').toUpperCase());
    }
    if (body.audio) play(body.audio, { squelch: false, rx: false });
    if (body.file) log('TELE', `${body.project || ''} ${body.file.split('/').pop()}`.trim(), { muted: true });
    await refreshCast();
  } catch {
    fail('SIN CONEXIÓN CON LA MAC');
  }
}

// Recorre los dispositivos de la red (Chromecast, parlantes, grupos) y guarda el elegido.
async function nextCastDevice() {
  unlockAudio();
  sfx.click();
  if (!castDevices.length) {
    $('cast-device').textContent = 'BUSCANDO…';
    castDevices = (await (await api('/api/cast/devices')).json().catch(() => ({}))).devices || [];
  }
  if (!castDevices.length) return fail('NO ENCONTRÉ DISPOSITIVOS');
  const actual = castDevices.findIndex((d) => d.name === (castState.device || ''));
  const elegido = castDevices[(actual + 1) % castDevices.length];
  const res = await api('/api/cast/device', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device: elegido.name }),
  });
  if (!res.ok) return fail('NO SE PUDO GUARDAR');
  castState.device = elegido.name;
  renderCast();
}

$('cast-toggle').addEventListener('click', toggleCast);
$('cast-device-next').addEventListener('click', nextCastDevice);

// ---------- Voz de las respuestas ----------

const voicesPanel = $('voices');
const RATE_STEP = 20;
// Mientras el panel está abierto se vuelve a pedir la lista: una voz recién descargada aparece sola.
const VOICES_POLL_MS = 5000;
let voiceState = null; // { voices, current, rate }
let voicesTimer = 0;

// Calidad de cada voz, de mejor a peor, como el medidor de señal de la radio.
const QUALITY = {
  premium: { section: 'PREMIUM', bars: '▮▮▮' },
  mejorada: { section: 'MEJORADAS', bars: '▮▮▯' },
  estandar: { section: 'ESTÁNDAR', bars: '▮▯▯' },
  sistema: { section: 'AJUSTES DE LA MAC', bars: '' },
};

function voicesNote(text) {
  $('voices-note').hidden = !text;
  $('voices-note').textContent = text || '';
}

function listItem(className, text) {
  const li = document.createElement('li');
  li.className = className;
  li.textContent = text;
  return li;
}

function voiceButton(voice) {
  const li = document.createElement('li');
  const button = document.createElement('button');
  button.type = 'button';
  const tag = (className, text) => {
    const span = document.createElement('span');
    span.className = className;
    span.textContent = text;
    return span;
  };
  button.append(tag('name', voice.label.toUpperCase()));
  const bars = QUALITY[voice.quality]?.bars;
  if (bars) button.append(tag('quality', bars));
  button.append(tag('tag', voice.region));
  if (voice.name === voiceState.current) button.append(tag('current', '●'));
  button.addEventListener('click', () => chooseVoice({ voice: voice.name }));
  li.append(button);
  return li;
}

// La lista llega ordenada de mejor a peor: se corta en secciones por calidad.
function renderVoices() {
  if (!voiceState) return;
  $('rate-label').textContent = `VELOCIDAD ${voiceState.rate}`;
  const items = [];
  let section = null;
  for (const voice of voiceState.voices) {
    if (voice.quality !== section) {
      section = voice.quality;
      items.push(listItem('section', `— ${QUALITY[section]?.section || section.toUpperCase()} —`));
    }
    items.push(voiceButton(voice));
  }
  const good = voiceState.voices.some((v) => v.quality === 'premium' || v.quality === 'mejorada');
  if (!good) items.unshift(listItem('empty', 'NO HAY VOCES MEJORADAS NI PREMIUM. INSTALALAS ABAJO.'));
  $('voices-list').replaceChildren(...items);
}

// Trae la lista; si apareció una voz nueva, la avisa. Solo redibuja si algo cambió.
async function refreshVoices() {
  const res = await api('/api/voices');
  const next = await res.json();
  const before = voiceState ? new Set(voiceState.voices.map((v) => v.name)) : null;
  const fresh = before ? next.voices.filter((v) => !before.has(v.name)) : [];
  const changed = !voiceState || next.voices.length !== voiceState.voices.length || fresh.length || next.current !== voiceState.current;
  voiceState = next;
  if (changed) renderVoices();
  renderNotices();
  if (fresh.length) {
    sfx.incoming();
    voicesNote(`VOZ NUEVA: ${fresh.map((v) => v.label.toUpperCase()).join(', ')}`);
  }
}

function stopVoicesPoll() {
  clearInterval(voicesTimer);
  voicesTimer = 0;
}

async function openVoices() {
  unlockAudio();
  voicesPanel.hidden = false;
  voiceState = null;
  voicesNote('');
  $('voices-list').replaceChildren(listItem('empty', 'CARGANDO…'));
  try {
    await refreshVoices();
    renderNotices();
    refreshCast();
  } catch {
    $('voices-list').replaceChildren(listItem('empty', 'SIN CONEXIÓN CON LA MAC'));
  }
  stopVoicesPoll();
  voicesTimer = setInterval(() => !document.hidden && refreshVoices().catch(() => {}), VOICES_POLL_MS);
}

async function chooseVoice(change) {
  unlockAudio();
  sfx.click();
  try {
    const res = await api('/api/voice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(change),
    });
    const body = await res.json();
    if (!res.ok) return fail((body.error || 'NO SE PUDO CAMBIAR LA VOZ').toUpperCase());
    Object.assign(voiceState, { current: body.current, rate: body.rate });
    renderVoices();
    play(body.audio, { squelch: false, rx: false });
  } catch {
    fail('SIN CONEXIÓN CON LA MAC');
  }
}

// Avisos de los otros canales: se prenden o apagan y se elige desde cuánto dura un turno para avisar.
const NOTICE_STEPS = [30, 60, 120, 300, 600, 1200, 1800];

const shortDuration = (s) => (s < 60 ? `${s} S` : `${Math.round(s / 60)} MIN`);

function renderNotices() {
  const settings = voiceState?.notices;
  $('notices').hidden = !settings;
  if (!settings) return;
  $('notices-toggle').textContent = settings.enabled ? 'SÍ' : 'NO';
  $('notices-toggle').setAttribute('aria-pressed', String(settings.enabled));
  $('notices-label').textContent = `SI TARDA +${shortDuration(settings.afterSeconds)}`;
  $('notices-delay').classList.toggle('off', !settings.enabled);
}

async function saveNotices(change) {
  unlockAudio();
  sfx.click();
  try {
    const res = await api('/api/notices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(change),
    });
    const body = await res.json();
    if (!res.ok) return fail((body.error || 'NO SE PUDO GUARDAR').toUpperCase());
    voiceState.notices = body;
    renderNotices();
  } catch {
    fail('SIN CONEXIÓN CON LA MAC');
  }
}

// Abre en la Mac el panel de voces de Ajustes y explica por voz qué tocar.
async function installVoices() {
  unlockAudio();
  sfx.click();
  try {
    const res = await api('/api/voices/install', { method: 'POST' });
    const body = await res.json();
    if (!res.ok) return fail((body.error || 'NO SE PUDO ABRIR AJUSTES').toUpperCase());
    voicesNote('EN LA MAC: VOZ DEL SISTEMA → ADMINISTRAR VOCES… → ESPAÑOL → DESCARGÁ UNA MEJORADA O PREMIUM. APARECE SOLA ACÁ.');
    play(body.audio, { squelch: false, rx: false });
  } catch {
    fail('SIN CONEXIÓN CON LA MAC');
  }
}

function stepNotices(direction) {
  const current = voiceState?.notices?.afterSeconds;
  if (!current) return;
  const next = direction > 0
    ? NOTICE_STEPS.find((s) => s > current) ?? NOTICE_STEPS.at(-1)
    : NOTICE_STEPS.findLast((s) => s < current) ?? NOTICE_STEPS[0];
  if (next !== current) saveNotices({ afterSeconds: next });
}

$('notices-toggle').addEventListener('click', () => voiceState?.notices && saveNotices({ enabled: !voiceState.notices.enabled }));
$('notices-down').addEventListener('click', () => stepNotices(-1));
$('notices-up').addEventListener('click', () => stepNotices(1));

const FX_STEP = 0.1;
const FX_MAX = 1.5;
const fxBar = (v) => '▮'.repeat(Math.round(v * 5)).padEnd(Math.round(FX_MAX * 5), '▯');

function renderFx() {
  $('fx').replaceChildren(...FX.map(([name, label]) => {
    const row = document.createElement('div');
    row.className = 'rate';
    const down = document.createElement('button');
    const up = document.createElement('button');
    const text = document.createElement('span');
    const level = document.createElement('span');
    down.type = up.type = 'button';
    down.className = up.className = 'picker-btn';
    down.textContent = '−';
    up.textContent = '＋';
    down.setAttribute('aria-label', `Bajar ${label.toLowerCase()}`);
    up.setAttribute('aria-label', `Subir ${label.toLowerCase()}`);
    text.className = 'rate-label';
    text.textContent = label;
    level.className = 'fx-level';
    level.textContent = vol(name) === 0 ? 'MUDO' : fxBar(vol(name));
    down.addEventListener('click', () => setFx(name, vol(name) - FX_STEP));
    up.addEventListener('click', () => setFx(name, vol(name) + FX_STEP));
    row.append(down, text, level, up);
    return row;
  }));
}

// Cambia el volumen de un efecto, lo guarda y lo hace sonar para escucharlo.
function setFx(name, value) {
  unlockAudio();
  fxVolume[name] = Math.round(Math.min(FX_MAX, Math.max(0, value)) * 10) / 10;
  try {
    localStorage.setItem(FX_KEY, JSON.stringify(fxVolume));
  } catch {}
  renderFx();
  ({ ptt: sfx.txStart, release: sfx.release, rx: sfx.incoming, notice: sfx.notice })[name]();
}

const VOICE_VOL_STEP = 0.2;

function renderVoiceVolume() {
  $('voice-vol-level').textContent = `${Math.round(voiceVolume * 100)} %`;
}

// Cambia el volumen de la voz, lo guarda y hace sonar una muestra para escucharlo.
// La muestra es nueva cada vez: la última respuesta puede no estar (se recargó la app) o haber
// vencido en la Mac, y entonces no sonaba nada y parecía que el control no andaba.
let voicePreview = 0;

function setVoiceVolume(value) {
  unlockAudio();
  voiceVolume = Math.round(Math.min(VOICE_VOL_MAX, Math.max(VOICE_VOL_MIN, value)) * 10) / 10;
  try {
    localStorage.setItem(VOICE_VOL_KEY, String(voiceVolume));
  } catch {}
  renderVoiceVolume();
  sfx.click();
  // Se espera a que termine de tocar para no generar una muestra por cada toque.
  clearTimeout(voicePreview);
  voicePreview = setTimeout(async () => {
    try {
      const res = await api('/api/voice', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const body = await res.json();
      if (body.audio) play(body.audio, { squelch: false, rx: false });
    } catch {}
  }, 400);
}

$('voice-vol-down').addEventListener('click', () => setVoiceVolume(voiceVolume - VOICE_VOL_STEP));
$('voice-vol-up').addEventListener('click', () => setVoiceVolume(voiceVolume + VOICE_VOL_STEP));
renderVoiceVolume();

$('fx-toggle').addEventListener('click', () => {
  const open = $('fx').hidden;
  $('fx').hidden = !open;
  $('fx-toggle').textContent = open ? '▾' : '▸';
  $('fx-toggle').setAttribute('aria-expanded', String(open));
  if (open) renderFx();
});

$('voice-open').addEventListener('click', openVoices);
$('settings-key').addEventListener('click', openVoices);
$('voices-close').addEventListener('click', () => {
  voicesPanel.hidden = true;
  stopVoicesPoll();
  stopPlayback();
});
$('voices-install').addEventListener('click', installVoices);
$('rate-down').addEventListener('click', () => voiceState && chooseVoice({ rate: voiceState.rate - RATE_STEP }));
$('rate-up').addEventListener('click', () => voiceState && chooseVoice({ rate: voiceState.rate + RATE_STEP }));

// ---------- Barra de vida: límite de uso de Claude ----------
//
// La barra de estado de Claude Code (hooks/statusline.js) guarda en la Mac cuánto se usó de la ventana
// de 5 horas y de la semanal. Acá se muestra lo que QUEDA de la de 5 horas; tocándola se lee el detalle.

let usage = null;
const hhmm = (iso) => new Date(iso).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
const dayTime = (iso) => new Date(iso).toLocaleString('es-AR', { weekday: 'short', hour: '2-digit', minute: '2-digit' });

// Si ya pasó la hora de renovación, la ventana volvió a cero aunque el dato sea viejo.
function remaining(win) {
  if (!win) return null;
  if (win.resetsAt && Date.now() > new Date(win.resetsAt).getTime()) return 100;
  return Math.max(0, 100 - win.used);
}

function renderLife() {
  const life = $('life');
  const left = remaining(usage?.fiveHour) ?? remaining(usage?.sevenDay);
  life.hidden = left === null;
  radio.dataset.life = left === null ? 'off' : 'on';
  if (left === null) return;
  const cells = Math.ceil(left / 10);
  life.querySelectorAll('i').forEach((cell, i) => cell.classList.toggle('on', i < cells));
  life.dataset.level = left > 50 ? 'high' : left > 20 ? 'mid' : 'low';
  // Sin datos nuevos en 6 horas (Claude Code cerrado): se atenúa.
  life.toggleAttribute('data-stale', Date.now() - new Date(usage.at).getTime() > 6 * 3600e3);
  life.setAttribute('aria-label', `Queda ${Math.round(left)} % del límite de uso de Claude`);
}

async function refreshUsage() {
  if (!token || document.hidden) return;
  try {
    usage = (await (await api('/api/usage')).json()).usage;
  } catch {}
  renderLife();
}

$('life').addEventListener('click', () => {
  if (!usage) return;
  const parts = [];
  const five = remaining(usage.fiveHour);
  const week = remaining(usage.sevenDay);
  if (five !== null) parts.push(`5 H: QUEDA ${Math.round(five)} %${usage.fiveHour.resetsAt && five < 100 ? `, SE RENUEVA ${hhmm(usage.fiveHour.resetsAt)}` : ''}`);
  if (week !== null) parts.push(`SEMANA: QUEDA ${Math.round(week)} %${usage.sevenDay.resetsAt && week < 100 ? `, ${dayTime(usage.sevenDay.resetsAt).toUpperCase()}` : ''}`);
  log('USO', parts.join(' · '));
});

refreshUsage();
setInterval(refreshUsage, 60_000);
document.addEventListener('visibilitychange', refreshUsage);

// ---------- Canal con la Mac ----------

// Lo recuperado al volver a la app (replay) no suena todo junto: solo lo último, y si es reciente.
const REPLAY_FRESH_MS = 15 * 60 * 1000;
let replayTimer = 0;

function onIncoming(label) {
  return (e) => {
    rememberEvent(e);
    const data = JSON.parse(e.data);
    const { text, audio, project, to, replay, at } = data;
    const mine = !to || to === clientId;
    // También al volver desde la notificación (replay), mientras el hook lo siga esperando (~2 minutos).
    if (mine && data.permission && (!replay || Date.now() - (at || 0) < 125 * 1000)) showPermission(data);
    const channel = data.channel || channelOf(project);
    log(project ? `${label} ${project.toUpperCase()}` : label, text, { muted: !mine, channel });
    // Si habló otro dispositivo, acá solo se muestra el texto.
    if (!mine) return;
    lastClip = audio;
    setNowPlaying(text);
    setTimeout(refreshUsage, 5000); // la barra de estado de Claude Code se actualiza al terminar el turno
    if (state === 'waiting' || label === 'PERMISO') setState('idle');
    if (!replay) return deliverAudio(channel, { audio, text, project });
    clearTimeout(replayTimer);
    if (Date.now() - (at || 0) < REPLAY_FRESH_MS) replayTimer = setTimeout(() => play(audio), 300);
  };
}

// ---------- Avisos de otros canales ----------
//
// Un canal al que no se le habló desde acá terminó una tarea larga o pide permiso.
// Llega a todos los teléfonos: queda en la pantalla y suena un aviso corto,
// sin pisar lo que se está transmitiendo ni lo que se está escuchando.

const NOTICE_FRESH_MS = 2 * 60 * 1000;
const noticeQueue = [];

const audioBusy = () =>
  ['arming', 'tx', 'processing', 'rx'].includes(state) || Date.now() < playStartsAt + 300 || (!player.paused && !player.ended);

const NOTICE_LABELS = { permission: 'PERMISO', limit: 'LÍMITE', error: 'ERROR' };

function onNotice(e) {
  rememberEvent(e);
  const notice = JSON.parse(e.data);
  // Límite de uso o error de la API: Claude ya no va a responder, el walkie deja de esperar.
  if ((notice.kind === 'limit' || notice.kind === 'error') && state === 'waiting') setState('idle');
  if (notice.to && notice.to !== clientId && notice.kind === 'error') return;
  const who = `${NOTICE_LABELS[notice.kind] || 'AVISO'} ${notice.project.toUpperCase()}`;
  log(notice.duration ? `${who} · ${notice.duration}` : who, notice.text, { channel: notice.channel || channelOf(notice.project) });
  // Los que se recuperan al reconectar ya pasaron: solo se muestran.
  if (!notice.audio || Date.now() - notice.at > NOTICE_FRESH_MS) return;
  noticeQueue.push(notice);
  if (noticeQueue.length > 3) noticeQueue.shift();
  flushNotices();
}

function flushNotices() {
  if (!noticeQueue.length || audioBusy()) return;
  const notice = noticeQueue.shift();
  if (Date.now() - notice.at > NOTICE_FRESH_MS) return flushNotices();
  sfx.notice();
  play(notice.audio, { squelch: false, rx: false, delay: 350, quiet: true });
}

// Último evento recibido, guardado en el teléfono: si iOS recarga la app (al tocar una notificación),
// al reconectar se piden los que llegaron mientras tanto.
const LAST_EVENT_KEY = 'walkie-code-last-event';
function rememberEvent(e) {
  try {
    if (e.lastEventId) localStorage.setItem(LAST_EVENT_KEY, e.lastEventId);
  } catch {}
}
function lastSeenEvent() {
  try {
    return localStorage.getItem(LAST_EVENT_KEY) || '';
  } catch {
    return '';
  }
}

let events = null;

function connect() {
  events?.close();
  const since = lastSeenEvent();
  events = new EventSource(`/api/events?t=${encodeURIComponent(token)}&c=${clientId}${since ? `&since=${since}` : ''}`);
  events.onopen = () => (radio.dataset.link = 'on');
  events.onerror = () => (radio.dataset.link = 'off');
  events.addEventListener('reply', onIncoming('CLAUDE'));
  events.addEventListener('notify', onIncoming('PERMISO'));
  events.addEventListener('notice', onNotice);
  events.addEventListener('permission-done', onPermissionDone);
}

// ---------- Avisos push (teléfono bloqueado) ----------

// iOS solo da Web Push a la app agregada a la pantalla de inicio (iOS 16.4 o más nuevo).
const pushButton = $('push');
const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
let swRegistration = null;
let pushKey = null;

const setPush = (mode) => {
  pushButton.dataset.push = mode;
  pushButton.textContent = mode === 'on' ? 'SÍ' : mode === 'na' ? 'N/D' : mode === 'busy' ? '…' : 'NO';
  pushButton.setAttribute('aria-pressed', String(mode === 'on'));
};

function base64UrlToBytes(s) {
  const raw = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function saveSubscription(subscription, test) {
  const res = await api('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription: subscription.toJSON(), test }),
  });
  return res.json().catch(() => ({ ok: res.ok, status: res.status }));
}

// Al abrir: registra el service worker, trae la clave del servidor y, si ya había avisos,
// le vuelve a pasar la suscripción al servidor (por si iOS la rotó o se borró push.json).
// Se hace de antemano para que el toque en AVISOS vaya directo al pedido de permiso.
async function initPush() {
  if (!pushSupported) return setPush('na');
  try {
    swRegistration = await navigator.serviceWorker.register('sw.js');
    pushKey = (await (await api('/api/push')).json()).publicKey;
    const current = await swRegistration.pushManager.getSubscription();
    if (current && Notification.permission === 'granted') {
      setPush('on');
      await saveSubscription(current, false);
    }
  } catch {}
}

async function enablePush() {
  setPush('busy');
  // El pedido de permiso tiene que salir dentro del toque: nada de esperas antes.
  const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
  if (permission !== 'granted') {
    setPush('off');
    return log('!', 'AVISOS BLOQUEADOS. ACTIVALOS EN AJUSTES › NOTIFICACIONES › WALKIE-CODE.');
  }
  try {
    swRegistration ??= await navigator.serviceWorker.register('sw.js');
    pushKey ??= (await (await api('/api/push')).json()).publicKey;
    const subscription = await swRegistration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(pushKey) });
    const result = await saveSubscription(subscription, true);
    if (!result.ok) throw new Error(`EL SERVICIO DE PUSH RESPONDIÓ ${result.status || '?'}`);
    setPush('on');
    log('', 'AVISOS ACTIVADOS: CON EL TELÉFONO BLOQUEADO TE LLEGA UNA NOTIFICACIÓN', { muted: true });
  } catch (err) {
    setPush('off');
    // Si iOS no dejó suscribir fuera del toque, el segundo intento ya tiene permiso y va directo.
    fail(err.name === 'NotAllowedError' ? 'TOCÁ AVISOS OTRA VEZ' : (err.message || 'NO SE PUDIERON ACTIVAR LOS AVISOS').toUpperCase());
  }
}

async function disablePush() {
  setPush('busy');
  try {
    const subscription = await swRegistration?.pushManager.getSubscription();
    if (subscription) {
      await api('/api/push/unsubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      });
      await subscription.unsubscribe();
    }
    log('', 'AVISOS APAGADOS', { muted: true });
  } catch {}
  setPush('off');
}

pushButton.addEventListener('click', () => {
  sfx.click();
  if (!pushSupported) return log('!', 'PARA RECIBIR AVISOS: COMPARTIR › AGREGAR A INICIO, Y ABRÍ WALKIE-CODE DESDE AHÍ.');
  if (pushButton.dataset.push === 'busy') return;
  pushButton.dataset.push === 'on' ? disablePush() : enablePush();
});

// Con la app a la vista, las respuestas ya suenan: los avisos que quedaron en el centro
// de notificaciones sobran (lo que llegó se recupera por la conexión con la Mac).
async function clearNotifications() {
  try {
    for (const n of (await swRegistration?.getNotifications()) || []) n.close();
  } catch {}
}

// Le avisa a la Mac que la app dejó de estar a la vista, para que mande push en vez de audio.
// `keepalive` deja salir el pedido aunque iOS congele la página enseguida.
function reportHidden() {
  api('/api/presence', {
    method: 'POST',
    keepalive: true,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ visible: false }),
  }).catch(() => {});
}
addEventListener('pagehide', reportHidden);

// Mantiene la pantalla encendida: si el teléfono se bloquea, Safari corta la conexión.
let wakeLock = null;
async function requestWakeLock() {
  try {
    if (!wakeLock && navigator.wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    }
  } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return reportHidden();
  audioCtx();
  requestWakeLock();
  refreshChannels();
  clearNotifications();
  // En segundo plano iOS corta la conexión sin avisar: se reconecta pidiendo lo que llegó mientras tanto.
  if (token) connect();
});

if (!token) {
  setState('error');
  log('!', 'FALTA EL TOKEN. ABRÍ EL LINK QUE IMPRIME EL SERVIDOR.');
} else {
  setState('idle');
  loadSamples();
  connect();
  refreshChannels();
  initPush().then(clearNotifications);
  setInterval(refreshChannels, 10000);
}
