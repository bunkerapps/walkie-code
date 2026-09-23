// Tele en modo video: la página corre en un Chrome moderno e invisible en la Mac y al Chromecast le
// llega solo el video (H.264, que decodifica por hardware).
//
// Por qué no mandar la página directo: el Chromecast trae un Chrome viejo, sin teclado, y los clics
// que se le simulan no abren desplegables, no enfocan campos y no scrollean cajas internas. Acá los
// clics, el scroll y el teclado son eventos reales de Chrome (CDP), así que la página se usa como en
// la Mac. Lo único que Chrome dibuja por fuera de la página (el menú de un <select>) se reemplaza por
// uno dibujado adentro, para que salga en el video.
//
// Camino de cada cuadro: Chrome headless → screencast JPEG (CDP) → ffmpeg (H.264 baseline, fMP4 de
// un cuadro por fragmento) → visor liviano en el Chromecast (Media Source Extensions).

import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

export const ANCHO = 1280;
export const ALTO = 720;
export const FPS = 30;

const CHROMES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];
const FFMPEGS = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'];

// El servicio no siempre tiene Homebrew en el PATH: se buscan las rutas conocidas primero.
export const chromeBin = () => CHROMES.find((ruta) => existsSync(ruta)) || null;
export const ffmpegBin = () => FFMPEGS.find((ruta) => existsSync(ruta)) || 'ffmpeg';
export const videoDisponible = () => Boolean(chromeBin());

// ---------- Visor (lo que corre en el Chromecast) ----------
//
// Nada de saltar seguido al final del buffer: cada salto obliga al decodificador del Chromecast a
// esperar un cuadro clave y la imagen se congela. Si se atrasa, se acelera un poco hasta alcanzar.
export const VISOR = `<!doctype html><meta charset=utf-8><title>walkie-code</title>
<body style="margin:0;background:#000;overflow:hidden">
<video id=v muted autoplay playsinline style="width:100vw;height:100vh;object-fit:contain"></video>
<script>
var ms = new MediaSource(), sb = null, cola = [];
v.src = URL.createObjectURL(ms);
ms.addEventListener('sourceopen', function () {
  sb = ms.addSourceBuffer('video/mp4; codecs="avc1.42E01F"');
  sb.mode = 'sequence';
  sb.addEventListener('updateend', meter);
  fetch('/video').then(function (r) {
    var rd = r.body.getReader();
    (function leer() {
      rd.read().then(function (x) {
        if (x.done) return reintentar();
        cola.push(x.value); meter(); leer();
      }, reintentar);
    })();
  }, reintentar);
});
function reintentar() { setTimeout(function () { location.reload(); }, 1000); }
function meter() {
  if (!sb || sb.updating || !cola.length) return;
  var n = 0; cola.forEach(function (c) { n += c.length; });
  var b = new Uint8Array(n), o = 0;
  cola.forEach(function (c) { b.set(c, o); o += c.length; });
  cola = [];
  try { sb.appendBuffer(b); } catch (e) {}
}
setInterval(function () {
  if (!v.buffered.length) return;
  var fin = v.buffered.end(v.buffered.length - 1), atraso = fin - v.currentTime;
  if (atraso > 2) v.currentTime = fin - 0.1;
  v.playbackRate = atraso > 0.4 ? 1.15 : 1;
  if (v.paused) v.play().catch(function () {});
  if (!sb.updating && v.currentTime > 30) try { sb.remove(0, v.currentTime - 10); } catch (e) {}
}, 200);
</script>`;

// ---------- Lo que se le agrega a la página en el Chrome invisible ----------
//
// Puntero visible (en headless no hay cursor del sistema), menú propio para los <select>, y links que
// abren pestaña nueva se quedan en la misma (en la tele hay una sola).
export const EN_LA_PAGINA = `(function () {
  if (window.__walkieTele) return;
  window.__walkieTele = true;
  var cursor = null;
  window.__walkiePuntero = function (x, y, apretado) {
    if (!cursor) {
      cursor = document.createElement('div');
      cursor.style.cssText = 'position:fixed;width:26px;height:26px;margin:-13px 0 0 -13px;border-radius:50%;' +
        'border:3px solid #fff;background:rgba(124,77,255,0.55);box-shadow:0 2px 10px rgba(0,0,0,0.5);' +
        'z-index:2147483647;pointer-events:none';
      (document.body || document.documentElement).appendChild(cursor);
    }
    cursor.style.left = x + 'px';
    cursor.style.top = y + 'px';
    cursor.style.transform = apretado ? 'scale(0.8)' : 'none';
  };

  var lista = null;
  function cerrar() { if (lista) { lista.remove(); lista = null; } }
  function abrir(sel) {
    cerrar();
    var r = sel.getBoundingClientRect();
    lista = document.createElement('div');
    lista.setAttribute('data-walkie-lista', '');
    var abajo = window.innerHeight - r.bottom;
    lista.style.cssText = 'position:fixed;z-index:2147483646;overflow:auto;background:#fff;color:#111;' +
      'font:16px system-ui,sans-serif;border:1px solid #888;border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,.35);' +
      'left:' + r.left + 'px;min-width:' + r.width + 'px;' +
      (abajo > 220 ? 'top:' + r.bottom + 'px;max-height:' + (abajo - 12) + 'px' : 'bottom:' + (window.innerHeight - r.top) + 'px;max-height:' + (r.top - 12) + 'px');
    Array.prototype.forEach.call(sel.options, function (op, i) {
      if (op.hidden) return;
      var item = document.createElement('div');
      item.textContent = op.label || op.text;
      var elegido = i === sel.selectedIndex;
      item.style.cssText = 'padding:8px 14px;white-space:nowrap;cursor:default;' +
        (op.disabled ? 'opacity:.4;' : '') + (elegido ? 'background:#1a73e8;color:#fff;' : '');
      item.addEventListener('mouseenter', function () { if (!elegido && !op.disabled) item.style.background = '#e8f0fe'; });
      item.addEventListener('mouseleave', function () { if (!elegido) item.style.background = ''; });
      item.addEventListener('mousedown', function (e) { e.preventDefault(); e.stopPropagation(); });
      item.addEventListener('click', function (e) {
        e.stopPropagation();
        if (op.disabled) return;
        cerrar();
        if (sel.selectedIndex === i) return;
        sel.selectedIndex = i;
        sel.dispatchEvent(new Event('input', { bubbles: true }));
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      });
      lista.appendChild(item);
    });
    document.body.appendChild(lista);
    var marcado = lista.children[sel.selectedIndex];
    if (marcado) marcado.scrollIntoView({ block: 'nearest' });
  }
  document.addEventListener('mousedown', function (e) {
    if (lista && lista.contains(e.target)) return;
    var sel = e.target.closest && e.target.closest('select');
    if (!sel || sel.multiple || sel.disabled || sel.size > 1) return cerrar();
    e.preventDefault(); // sin esto Chrome abre su menú, que no sale en el video
    sel.focus();
    if (lista) return cerrar();
    abrir(sel);
  }, true);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') cerrar(); }, true);
  window.addEventListener('scroll', function (e) { if (!lista || !lista.contains(e.target)) cerrar(); }, true);

  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[target]');
    if (a && a.target !== '_self') a.target = '_self';
  }, true);
  window.open = function (url) { if (url) location.href = url; return window; };
})();`;

// ---------- Teclado: de lo que manda el walkie a eventos de Chrome ----------

const TECLAS = {
  Backspace: { code: 'Backspace', keyCode: 8 },
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  ShiftTab: { key: 'Tab', code: 'Tab', keyCode: 9, modifiers: 8 },
  Escape: { code: 'Escape', keyCode: 27 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
};

export function eventosDeTecla(tecla) {
  const t = TECLAS[tecla];
  if (!t) return [];
  const base = { key: t.key || tecla, code: t.code, windowsVirtualKeyCode: t.keyCode, nativeVirtualKeyCode: t.keyCode, modifiers: t.modifiers || 0 };
  return [
    { ...base, type: t.text ? 'keyDown' : 'rawKeyDown', ...(t.text && { text: t.text, unmodifiedText: t.text }) },
    { ...base, type: 'keyUp' },
  ];
}

// El puntero no se sale de la pantalla.
export const moverPuntero = ({ x, y }, dx, dy) => ({
  x: Math.max(2, Math.min(ANCHO - 2, x + dx)),
  y: Math.max(2, Math.min(ALTO - 2, y + dy)),
});

// Historial: a qué entrada ir con atrás o adelante; -1 si no hay adónde.
export function entradaDeHistorial(actual, total, accion) {
  const destino = actual + (accion === 'atras' ? -1 : 1);
  return destino >= 0 && destino < total ? destino : -1;
}

// Scroll: la rueda se manda donde está el puntero, así también se mueven las cajas con scroll propio.
export function ruedaDeScroll(accion) {
  if (accion === 'top') return -1e6;
  if (accion === 'bottom') return 1e6;
  return (accion === 'up' ? -1 : 1) * Math.round(ALTO * 0.8);
}

// Las teclas de scroll mandan una acción; los dos dedos en el pad, la distancia en píxeles.
export function rueda({ accion, dx = 0, dy = 0 }) {
  if (accion) return { deltaX: 0, deltaY: ruedaDeScroll(accion) };
  return { deltaX: Number(dx) || 0, deltaY: Number(dy) || 0 };
}

// ffmpeg a veces queda trabado escribiendo en una tubería que ya se cerró y sobrevive al TERM:
// si en dos segundos sigue vivo, se lo mata. Sin esto quedan procesos colgados de cada proyección.
function matarFfmpeg(ff) {
  if (!ff || ff.killed) return;
  ff.kill();
  const golpe = setTimeout(() => { try { ff.kill('SIGKILL'); } catch {} }, 2000);
  golpe.unref?.();
  ff.once('exit', () => clearTimeout(golpe));
}

// ---------- CDP mínimo ----------

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pendientes = new Map();
    this.oyentes = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pendientes.has(msg.id)) {
        const { ok, mal } = this.pendientes.get(msg.id);
        this.pendientes.delete(msg.id);
        return msg.error ? mal(new Error(msg.error.message)) : ok(msg.result);
      }
      if (msg.method) this.oyentes.get(msg.method)?.(msg.params);
    });
  }

  static async conectar(url) {
    const ws = new WebSocket(url);
    await new Promise((ok, mal) => {
      ws.addEventListener('open', ok, { once: true });
      ws.addEventListener('error', () => mal(new Error('No pude hablar con el Chrome de la tele.')), { once: true });
    });
    return new Cdp(ws);
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((ok, mal) => this.pendientes.set(id, { ok, mal }));
  }

  on(method, fn) {
    this.oyentes.set(method, fn);
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}

// ---------- La transmisión ----------

export class TeleVideo {
  constructor({ port, perfil, log = () => {} }) {
    this.port = port;
    this.perfil = perfil; // carpeta del Chrome invisible: guarda sesiones iniciadas entre proyecciones
    this.log = log;
    this.chrome = null;
    this.cdp = null;
    this.server = null;
    this.ffmpeg = null;
    this.visor = null;
    this.ultimo = null; // último cuadro JPEG del screencast
    this.puntero = { x: ANCHO / 2, y: ALTO / 2 };
    this.apretado = false;
  }

  async start(url, { host }) {
    if (!this.chrome) await this.abrirChrome();
    await this.cdp.send('Page.navigate', { url });
    if (!this.server) {
      this.server = http.createServer((req, res) => this.atender(req, res));
      await new Promise((ok) => this.server.listen(this.port, host, ok));
    }
    this.log(`+ tele (video): ${url}`);
    return `http://${host}:${this.port}/`;
  }

  async abrirChrome() {
    const bin = chromeBin();
    if (!bin) throw new Error('No encontré Google Chrome para el modo video.');
    mkdirSync(this.perfil, { recursive: true });
    const puertoArchivo = path.join(this.perfil, 'DevToolsActivePort');
    rmSync(puertoArchivo, { force: true });
    this.chrome = spawn(bin, [
      '--headless=new', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${this.perfil}`, `--window-size=${ANCHO},${ALTO}`, '--no-first-run',
      '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required', 'about:blank',
    ], { stdio: 'ignore' });
    this.chrome.on('exit', () => { this.chrome = null; });

    // Chrome elige un puerto libre y lo anota en el perfil.
    let puerto = null;
    for (let i = 0; i < 100 && !puerto; i++) {
      await new Promise((ok) => setTimeout(ok, 100));
      if (existsSync(puertoArchivo)) puerto = readFileSync(puertoArchivo, 'utf8').split('\n')[0].trim();
    }
    if (!puerto) throw new Error('El Chrome de la tele no arrancó.');
    let pagina = null;
    for (let i = 0; i < 50 && !pagina; i++) {
      try {
        pagina = (await (await fetch(`http://127.0.0.1:${puerto}/json/list`)).json()).find((t) => t.type === 'page');
      } catch {}
      if (!pagina) await new Promise((ok) => setTimeout(ok, 100));
    }
    if (!pagina) throw new Error('El Chrome de la tele no abrió ninguna pestaña.');

    this.cdp = await Cdp.conectar(pagina.webSocketDebuggerUrl);
    this.cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
      this.cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
      this.ultimo = Buffer.from(data, 'base64');
    });
    // alert, confirm y prompt frenan la página hasta que alguien conteste: en la tele no hay quien.
    // Se cancelan (confirm devuelve false: nunca se confirma algo sin querer) y se avisa en pantalla.
    this.cdp.on('Page.javascriptDialogOpening', ({ type, message }) => {
      this.cdp.send('Page.handleJavaScriptDialog', { accept: type === 'alert' || type === 'beforeunload' }).catch(() => {});
      this.log(`= tele (video): diálogo ${type} cancelado: ${message}`);
      this.aviso(type === 'alert' ? message : `Cancelado: ${message}`);
    });
    this.cdp.on('Page.frameNavigated', ({ frame }) => {
      if (!frame.parentId) this.dibujarPuntero();
    });
    await this.cdp.send('Page.enable');
    await this.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: EN_LA_PAGINA });
    await this.cdp.send('Emulation.setDeviceMetricsOverride', { width: ANCHO, height: ALTO, deviceScaleFactor: 1, mobile: false });
    await this.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 80, maxWidth: ANCHO, maxHeight: ALTO });
  }

  atender(req, res) {
    const ruta = req.url.split('?')[0];
    if (ruta === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(VISOR);
    }
    if (ruta === '/video') return this.mandarVideo(req, res);
    res.writeHead(404);
    res.end();
  }

  // Un visor por vez: si el Chromecast se reconecta, se corta el anterior y arranca un video nuevo
  // (el visor necesita el encabezado del MP4 desde el principio).
  mandarVideo(req, res) {
    this.cortarVideo();
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store' });
    const ff = spawn(ffmpegBin(), [
      '-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-profile:v', 'baseline', '-level', '3.1',
      '-b:v', '3M', '-maxrate', '3M', '-bufsize', '1M', '-pix_fmt', 'yuv420p', '-g', String(FPS / 2), '-bf', '0',
      '-f', 'mp4', '-movflags', 'empty_moov+default_base_moof+frag_every_frame', '-',
    ], { stdio: ['pipe', 'pipe', 'ignore'] });
    ff.stdout.on('data', (d) => res.write(d));
    ff.stdin.on('error', () => {});
    ff.on('exit', () => res.end());
    // El screencast solo manda cuadros cuando algo cambia: se repite el último para mantener el ritmo.
    const ritmo = setInterval(() => { if (this.ultimo) ff.stdin.write(this.ultimo); }, 1000 / FPS);
    this.ffmpeg = ff;
    this.visor = { res, ritmo };
    res.on('close', () => {
      clearInterval(ritmo);
      matarFfmpeg(ff);
      if (this.ffmpeg === ff) this.ffmpeg = this.visor = null;
    });
  }

  cortarVideo() {
    if (!this.visor) return;
    clearInterval(this.visor.ritmo);
    matarFfmpeg(this.ffmpeg);
    this.visor.res.end();
    this.ffmpeg = this.visor = null;
  }

  dibujarPuntero() {
    const { x, y } = this.puntero;
    this.cdp?.send('Runtime.evaluate', { expression: `window.__walkiePuntero && window.__walkiePuntero(${x}, ${y}, ${this.apretado})` }).catch(() => {});
  }

  aviso(texto) {
    const t = JSON.stringify(String(texto).slice(0, 200));
    this.cdp?.send('Runtime.evaluate', {
      expression: `(function(){var d=document.createElement('div');d.textContent=${t};d.style.cssText='position:fixed;left:50%;bottom:32px;transform:translateX(-50%);z-index:2147483647;background:#222;color:#fff;font:18px system-ui;padding:12px 18px;border-radius:8px;max-width:80vw';document.body.appendChild(d);setTimeout(function(){d.remove()},5000)})()`,
    }).catch(() => {});
  }

  mouse(type, extra = {}) {
    const { x, y } = this.puntero;
    return this.cdp.send('Input.dispatchMouseEvent', {
      type, x, y, button: 'left', buttons: this.apretado ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1, ...extra,
    });
  }

  // Las mismas órdenes que el modo espejo (ver /api/cast/control), pero como eventos reales.
  async comando(orden) {
    if (!this.cdp) return;
    if (orden.tipo === 'mover') {
      this.puntero = moverPuntero(this.puntero, orden.dx, orden.dy);
      this.dibujarPuntero();
      await this.mouse('mouseMoved', { button: this.apretado ? 'left' : 'none' });
    } else if (orden.tipo === 'apretar') {
      this.apretado = true;
      this.dibujarPuntero();
      await this.mouse('mousePressed');
    } else if (orden.tipo === 'soltar') {
      this.apretado = false;
      this.dibujarPuntero();
      await this.mouse('mouseReleased');
    } else if (orden.tipo === 'scroll') {
      const { deltaX, deltaY } = rueda(orden);
      await this.mouse('mouseWheel', { button: 'none', deltaX, deltaY });
    } else if (orden.tipo === 'texto') {
      await this.cdp.send('Input.insertText', { text: orden.texto });
    } else if (orden.tipo === 'tecla') {
      for (const ev of eventosDeTecla(orden.tecla)) await this.cdp.send('Input.dispatchKeyEvent', ev);
    } else if (orden.tipo === 'navegar') {
      await this.navegar(orden.accion);
    }
  }

  // Atrás y adelante en el historial del Chrome invisible. Si no hay adónde ir, no pasa nada.
  async navegar(accion) {
    const { currentIndex, entries } = await this.cdp.send('Page.getNavigationHistory');
    const entrada = entries[entradaDeHistorial(currentIndex, entries.length, accion)];
    if (entrada) await this.cdp.send('Page.navigateToHistoryEntry', { entryId: entrada.id });
  }

  stop() {
    this.cortarVideo();
    this.server?.close();
    this.server = null;
    this.cdp?.close();
    this.cdp = null;
    this.chrome?.kill();
    this.chrome = null;
    this.ultimo = null;
    this.apretado = false;
    this.puntero = { x: ANCHO / 2, y: ALTO / 2 };
  }
}
