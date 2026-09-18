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
const clientId = crypto.randomUUID?.() || String(Math.random()).slice(2);

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
  state = next;
  radio.dataset.state = next;
  $('state-label').textContent = STATE_LABELS[next] || next.toUpperCase();
  $('ptt-hint').textContent = next === 'tx' ? 'SOLTÁ PARA ENVIAR' : 'MANTENÉ PARA HABLAR';
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

function play(src, { squelch: withSquelch = true, rx = true } = {}) {
  player.pause();
  setAudioSession('playback');
  if (withSquelch) sfx.incoming();
  player.dataset.rx = rx ? '1' : '';
  setTimeout(() => {
    player.src = `${src}?t=${encodeURIComponent(token)}`;
    player.play().catch(() => log('', 'TOCÁ REPETIR PARA ESCUCHAR', { muted: true }));
  }, withSquelch ? 280 : 0);
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
  try {
    const res = await api('/api/talk', { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (body.text) log('VOS', body.text, { muted: true });
      return fail((body.error || `ERROR ${res.status}`).toUpperCase());
    }
    log('VOS', body.permission ? `${body.text} (permiso)` : body.text);
    setState('waiting');
  } catch {
    fail('SIN CONEXIÓN CON LA MAC');
  }
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
let voiceState = null; // { voices, current, rate }

function renderVoices() {
  if (!voiceState) return;
  $('rate-label').textContent = `VELOCIDAD ${voiceState.rate}`;
  $('voices-list').replaceChildren(
    ...voiceState.voices.map((voice) => {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = voice.label;
      const region = document.createElement('span');
      region.className = 'tag';
      region.textContent = voice.region;
      button.append(name, region);
      if (voice.name === voiceState.current) {
        const mark = document.createElement('span');
        mark.className = 'current';
        mark.textContent = '●';
        button.append(mark);
      }
      button.addEventListener('click', () => chooseVoice({ voice: voice.name }));
      li.append(button);
      return li;
    }),
  );
}

async function openVoices() {
  unlockAudio();
  voicesPanel.hidden = false;
  const li = document.createElement('li');
  li.className = 'empty';
  li.textContent = 'CARGANDO…';
  $('voices-list').replaceChildren(li);
  try {
    const res = await api('/api/voices');
    voiceState = await res.json();
    renderVoices();
  } catch {
    li.textContent = 'SIN CONEXIÓN CON LA MAC';
  }
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

$('voice-open').addEventListener('click', openVoices);
$('voices-close').addEventListener('click', () => {
  voicesPanel.hidden = true;
  stopPlayback();
});
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

function connect() {
  const events = new EventSource(`/api/events?t=${encodeURIComponent(token)}&c=${clientId}`);
  events.onopen = () => (radio.dataset.link = 'on');
  events.onerror = () => (radio.dataset.link = 'off');
  events.addEventListener('reply', onIncoming('CLAUDE'));
  events.addEventListener('notify', onIncoming('PERMISO'));
}

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
  if (!document.hidden) {
    requestWakeLock();
    refreshChannels();
  }
});

if (!token) {
  setState('error');
  log('!', 'FALTA EL TOKEN. ABRÍ EL LINK QUE IMPRIME EL SERVIDOR.');
} else {
  setState('idle');
  loadSamples();
  connect();
  refreshChannels();
  setInterval(refreshChannels, 10000);
}
