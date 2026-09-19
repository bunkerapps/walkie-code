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
    const saved = localStorage.getItem('supervoz-client');
    if (saved) return saved;
    const id = fresh();
    localStorage.setItem('supervoz-client', id);
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
    if (fromUrl) localStorage.setItem('supervoz-token', fromUrl);
    return fromUrl || localStorage.getItem('supervoz-token');
  } catch {
    return fromUrl;
  }
}
const token = readToken();

function api(path, options = {}) {
  return fetch(path, {
    ...options,
    headers: { 'X-Supervoz-Token': token, 'X-Supervoz-Client': clientId, ...options.headers },
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

function log(who, text, { muted = false } = {}) {
  const logEl = $('log');
  const p = document.createElement('p');
  if (muted) p.className = 'muted';
  if (who) {
    const b = document.createElement('b');
    b.textContent = who;
    p.append(b);
  }
  p.append(text);
  p.addEventListener('click', () => openReader(who, text));
  logEl.append(p);
  while (logEl.children.length > 12) logEl.firstChild.remove();
  logEl.scrollTop = logEl.scrollHeight;
}

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
    if (payload.active.title) log(`CH${String(payload.active.number).padStart(2, '0')}`, payload.active.title, { muted: true });
  }
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
  unlockAudio();
  const index = channels.findIndex((c) => c.id === activeId);
  const next = channels[(index + direction + channels.length) % channels.length];
  activeId = next.id;
  renderChannel(direction);
  sfx.click();
  try {
    const res = await api('/api/channel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: next.id }),
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

function audioCtx() {
  ctx ??= new AudioContext();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function beep(notes, volume = 0.12) {
  const ac = audioCtx();
  let t = ac.currentTime;
  for (const [freq, dur] of notes) {
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

function squelch(dur = 0.22) {
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
  gain.gain.setValueAtTime(0.25, ac.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + dur);
  src.connect(band).connect(gain).connect(ac.destination);
  src.start();
}

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
  src.buffer = buffer;
  src.connect(ac.destination);
  src.start();
  return true;
}

const sfx = {
  txStart: () => playSample('ptt') || beep([[1250, 0.07]]),
  release: () => playSample('release') || beep([[1500, 0.07], [1050, 0.1]]),
  click: () => beep([[2200, 0.02]], 0.06),
  incoming: () => playSample('rx') || squelch(),
  error: () => beep([[320, 0.14], [220, 0.2]]),
  notice: () => beep([[988, 0.09], [1319, 0.18]], 0.08),
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

player.addEventListener('playing', () => player.dataset.rx && setState('rx'));
for (const type of ['ended', 'pause', 'error']) {
  player.addEventListener(type, () => state === 'rx' && setState('idle'));
}
player.addEventListener('ended', () => setTimeout(flushNotices, 400));

// Hasta cuándo hay un audio a punto de arrancar (el squelch va antes de la voz).
let playStartsAt = 0;

// `quiet`: si Safari no deja reproducir, no se pide tocar REPETIR (los avisos ya quedan en pantalla).
function play(src, { squelch: withSquelch = true, rx = true, delay = withSquelch ? 280 : 0, quiet = false } = {}) {
  player.pause();
  setAudioSession('playback');
  if (withSquelch) sfx.incoming();
  player.dataset.rx = rx ? '1' : '';
  playStartsAt = Date.now() + delay;
  setTimeout(() => {
    player.src = `${src}?t=${encodeURIComponent(token)}`;
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
    const headers = { 'Content-Type': blob.type, ...(imageId && { 'X-Supervoz-Image': imageId }) };
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

$('replay').addEventListener('click', () => {
  unlockAudio();
  lastClip ? play(lastClip) : log('', 'TODAVÍA NO HAY RESPUESTAS', { muted: true });
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
  loadFolder(folderView?.rel || '');
}

function closePicker() {
  picker.hidden = true;
  $('picker-filter').blur();
}

$('new').addEventListener('click', openPicker);
$('picker-close').addEventListener('click', closePicker);
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

function openRename() {
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

// ---------- Lector de mensajes completos ----------

function openReader(who, text) {
  $('reader-title').textContent = who || 'MENSAJE';
  $('reader-text').textContent = text;
  $('reader').hidden = false;
  $('reader-text').scrollTop = 0;
}
$('reader-close').addEventListener('click', () => ($('reader').hidden = true));

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

$('voice-open').addEventListener('click', openVoices);
$('voices-close').addEventListener('click', () => {
  voicesPanel.hidden = true;
  stopVoicesPoll();
  stopPlayback();
});
$('voices-install').addEventListener('click', installVoices);
$('rate-down').addEventListener('click', () => voiceState && chooseVoice({ rate: voiceState.rate - RATE_STEP }));
$('rate-up').addEventListener('click', () => voiceState && chooseVoice({ rate: voiceState.rate + RATE_STEP }));

// ---------- Canal con la Mac ----------

function onIncoming(label) {
  return (e) => {
    const { text, audio, project, to } = JSON.parse(e.data);
    const mine = !to || to === clientId;
    log(project ? `${label} ${project.toUpperCase()}` : label, text, { muted: !mine });
    // Si habló otro dispositivo, acá solo se muestra el texto.
    if (!mine) return;
    lastClip = audio;
    if (state === 'waiting' || label === 'PERMISO') setState('idle');
    play(audio);
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

function onNotice(e) {
  const notice = JSON.parse(e.data);
  const who = `${notice.kind === 'permission' ? 'PERMISO' : 'AVISO'} ${notice.project.toUpperCase()}`;
  log(notice.duration ? `${who} · ${notice.duration}` : who, notice.text);
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

function connect() {
  const events = new EventSource(`/api/events?t=${encodeURIComponent(token)}&c=${clientId}`);
  events.onopen = () => (radio.dataset.link = 'on');
  events.onerror = () => (radio.dataset.link = 'off');
  events.addEventListener('reply', onIncoming('CLAUDE'));
  events.addEventListener('notify', onIncoming('PERMISO'));
  events.addEventListener('notice', onNotice);
}

// ---------- Avisos push (teléfono bloqueado) ----------

// iOS solo da Web Push a la app agregada a la pantalla de inicio (iOS 16.4 o más nuevo).
const pushButton = $('push');
const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
let swRegistration = null;
let pushKey = null;

const setPush = (mode) => {
  pushButton.dataset.push = mode;
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
    return log('!', 'AVISOS BLOQUEADOS. ACTIVALOS EN AJUSTES › NOTIFICACIONES › SUPERVOZ.');
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
  if (!pushSupported) return log('!', 'PARA RECIBIR AVISOS: COMPARTIR › AGREGAR A INICIO, Y ABRÍ SUPERVOZ DESDE AHÍ.');
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
  requestWakeLock();
  refreshChannels();
  clearNotifications();
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
