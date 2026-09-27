// Mostrar una página en la tele (Chromecast) y desarrollarla en vivo.
//
// El Chromecast no entra al tailnet: la página se publica en la red local, en un puerto aparte y solo
// mientras dura la proyección. A cada HTML se le agrega un script que pregunta si hubo cambios y recarga,
// así lo que se edita en la Mac se ve en la tele sin tocar nada.

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { watch } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { networkInterfaces, homedir } from 'node:os';
import { existsSync } from 'node:fs';
import path from 'node:path';

const run = promisify(execFile);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.ogg': 'audio/ogg',
};

// La IP de la Mac en la red de casa: es la que tiene que poder alcanzar el Chromecast.
export function localAddress() {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const a of addresses || []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('100.')) return a.address;
    }
  }
  return null;
}

// El script que se le agrega a la página en la tele: recarga cuando algo cambia y obedece al control
// remoto del walkie (subir, bajar, ir al principio o al final), porque en la tele no se puede scrollear.
export const LIVE_SCRIPT = `<script>
(function () {
  // Una app con router carga páginas nuevas sin recargar del todo, y el proxy le inyecta este script
  // a cada una: sin esta bandera terminan corriendo dos (y aparecen dos punteros, uno quieto).
  if (window.__walkieLive) return;
  window.__walkieLive = true;

  var version = null;
  var desde = 0;

  // Puntero virtual: en la tele no hay mouse, así que se dibuja uno y se simulan los eventos.
  // Si quedó uno de una carga anterior, se saca: si no, aparecen dos y solo uno se mueve.
  var viejos = document.querySelectorAll('[data-walkie-cursor]');
  for (var v = 0; v < viejos.length; v++) viejos[v].parentNode.removeChild(viejos[v]);

  var cursor = document.createElement('div');
  cursor.setAttribute('data-walkie-cursor', '1');
  cursor.style.cssText = 'position:fixed;left:50%;top:50%;width:26px;height:26px;margin:-13px 0 0 -13px;' +
    'border-radius:50%;border:3px solid #fff;background:rgba(124,77,255,0.7);' +
    'box-shadow:0 0 0 2px rgba(0,0,0,0.55), 0 3px 12px rgba(0,0,0,0.6);' +
    'z-index:2147483647;pointer-events:none;display:block';

  function plantar() {
    var padre = document.body || document.documentElement;
    if (cursor.parentNode !== padre) padre.appendChild(cursor);
  }
  plantar();
  setInterval(plantar, 2000);
  var x = window.innerWidth / 2;
  var y = window.innerHeight / 2;

  function pintar() {
    plantar();
    cursor.style.display = 'block';
    cursor.style.left = x + 'px';
    cursor.style.top = y + 'px';
  }
  pintar();

  function evento(tipo, extra) {
    var destino = document.elementFromPoint(x, y) || document.body;
    var init = { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, pointerType: 'touch', buttons: extra ? 1 : 0, isPrimary: true };
    try { destino.dispatchEvent(new PointerEvent(tipo, init)); } catch (e) {}
    if (tipo === 'pointerdown') {
      destino.dispatchEvent(new MouseEvent('mousedown', init));
      // Un clic simulado no enfoca nada: sin esto, lo que se escribe desde el walkie no tendría adónde ir.
      var campo = destino.closest && destino.closest('input,textarea,select,[contenteditable],[tabindex]');
      if (campo) campo.focus();
      else if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    }
    if (tipo === 'pointerup') {
      destino.dispatchEvent(new MouseEvent('mouseup', init));
      destino.dispatchEvent(new MouseEvent('click', init));
    }
    if (tipo === 'pointermove') destino.dispatchEvent(new MouseEvent('mousemove', init));
    return destino;
  }

  // Teclado: el texto llega del teclado del teléfono y se escribe en el campo enfocado en la tele.
  function editable(el) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    if (el.tagName === 'TEXTAREA') return true;
    return el.tagName === 'INPUT' && /^(text|search|email|url|tel|password|number|)$/.test(el.type || '');
  }

  function teclaEvento(el, key) {
    var init = { key: key, bubbles: true, cancelable: true };
    var seguir = el.dispatchEvent(new KeyboardEvent('keydown', init));
    el.dispatchEvent(new KeyboardEvent('keyup', init));
    return seguir;
  }

  function escribir(el, texto) {
    if (el.isContentEditable) return document.execCommand('insertText', false, texto);
    var ini = el.selectionStart == null ? el.value.length : el.selectionStart;
    var fin = el.selectionEnd == null ? ini : el.selectionEnd;
    el.setRangeText(texto, ini, fin, 'end');
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: texto, inputType: 'insertText' }));
  }

  function borrar(el) {
    if (el.isContentEditable) return document.execCommand('delete');
    var ini = el.selectionStart == null ? el.value.length : el.selectionStart;
    var fin = el.selectionEnd == null ? ini : el.selectionEnd;
    if (ini === fin && ini === 0) return;
    el.setRangeText('', ini === fin ? ini - 1 : ini, fin, 'end');
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
  }

  function siguiente(el, atras) {
    var todos = Array.prototype.filter.call(
      document.querySelectorAll('a[href],button,input,select,textarea,[contenteditable],[tabindex]'),
      function (e) { return !e.disabled && e.tabIndex >= 0 && e.offsetParent !== null; });
    var i = todos.indexOf(el);
    var otro = todos[(i + (atras ? -1 : 1) + todos.length) % todos.length];
    if (otro) { otro.focus(); otro.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  }

  function tecla(key) {
    var el = document.activeElement || document.body;
    if (!teclaEvento(el, key)) return; // la página se hizo cargo de la tecla
    if (key === 'Tab' || key === 'ShiftTab') return siguiente(el, key === 'ShiftTab');
    if (key === 'Escape') return el.blur && el.blur();
    if (!editable(el)) {
      if (key === 'Enter' && el.click) el.click();
      return;
    }
    if (key === 'Backspace') return borrar(el);
    if (key === 'Enter') {
      if (el.tagName === 'TEXTAREA' || el.isContentEditable) return escribir(el, '\\n');
      if (el.form) return el.form.requestSubmit ? el.form.requestSubmit() : el.form.submit();
      return;
    }
    if ((key === 'ArrowLeft' || key === 'ArrowRight') && el.setSelectionRange) {
      var p = Math.max(0, Math.min(el.value.length, el.selectionStart + (key === 'ArrowLeft' ? -1 : 1)));
      el.setSelectionRange(p, p);
    }
  }

  // La caja con scroll propio más cercana a un elemento, si es que hay una.
  function conScroll(el) {
    for (; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
      var estilo = getComputedStyle(el);
      var puede = /(auto|scroll)/.test(estilo.overflowY + estilo.overflowX);
      if (puede && (el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth)) return el;
    }
    return null;
  }

  function hacer(c) {
    if (c.tipo === 'mover') {
      x = Math.max(4, Math.min(window.innerWidth - 4, x + c.dx));
      y = Math.max(4, Math.min(window.innerHeight - 4, y + c.dy));
      pintar();
      evento('pointermove', c.apretado);
    } else if (c.tipo === 'apretar') {
      evento('pointerdown', true);
    } else if (c.tipo === 'soltar') {
      evento('pointerup', false);
    } else if (c.tipo === 'scroll' && c.accion) {
      var alto = window.innerHeight * 0.8;
      if (c.accion === 'top') window.scrollTo({ top: 0, behavior: 'smooth' });
      else if (c.accion === 'bottom') window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
      else window.scrollBy({ top: c.accion === 'up' ? -alto : alto, behavior: 'smooth' });
    } else if (c.tipo === 'scroll') {
      // Dos dedos en el pad: se mueve la caja con scroll propio que está bajo el puntero, o la página.
      var caja = conScroll(document.elementFromPoint(x, y));
      if (caja) caja.scrollBy(c.dx || 0, c.dy || 0);
      else window.scrollBy(c.dx || 0, c.dy || 0);
    } else if (c.tipo === 'texto') {
      if (editable(document.activeElement)) escribir(document.activeElement, c.texto);
    } else if (c.tipo === 'tecla') {
      tecla(c.tecla);
    } else if (c.tipo === 'navegar') {
      // Atrás y adelante en el historial, como las flechas de un navegador.
      if (c.accion === 'atras') history.back();
      else if (c.accion === 'adelante') history.forward();
    }
  }

  function check() {
    fetch('/__walkie-live?desde=' + desde, { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (estado) {
        if (version === null) version = estado.version;
        else if (estado.version !== version) return location.reload();
        desde = estado.seq;
        (estado.comandos || []).forEach(hacer);
      })
      .catch(function () {})
      .then(function () { setTimeout(check, 60); });
  }
  check();
})();
</script>`;

// Lo que se escribe desde el teclado del walkie: texto corto o una de estas teclas. Lo demás se descarta.
export const TECLAS_TELE = ['Backspace', 'Enter', 'Tab', 'ShiftTab', 'Escape', 'ArrowLeft', 'ArrowRight'];
export const TEXTO_TELE_MAX = 500;

// Las flechas del navegador: atrás y adelante en el historial de la página proyectada.
export const NAVEGACION_TELE = ['atras', 'adelante'];

export const ordenNavegar = ({ tipo, accion } = {}) => (tipo === 'navegar' && NAVEGACION_TELE.includes(accion) ? { tipo, accion } : null);

export function ordenTeclado({ tipo, texto, tecla } = {}) {
  if (tipo === 'texto' && typeof texto === 'string' && texto.length > 0 && texto.length <= TEXTO_TELE_MAX) {
    return { tipo, texto };
  }
  if (tipo === 'tecla' && TECLAS_TELE.includes(tecla)) return { tipo, tecla };
  return null;
}

export const SOLO_RECARGA = `<script>
(function () {
  if (window.__walkieLive) return;
  window.__walkieLive = true;
  var version = null;
  function check() {
    fetch('/__walkie-live?desde=0', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (estado) {
        if (version === null) version = estado.version;
        else if (estado.version !== version) location.reload();
      })
      .catch(function () {})
      .then(function () { setTimeout(check, 700); });
  }
  check();
})();
</script>`;

// `soloRecarga`: en modo video la página la maneja el Chrome invisible (puntero y clics reales por
// CDP), así que inyectar el puntero de acá dibujaba un segundo punto, quieto en el medio.
export const withLiveReload = (html, { soloRecarga = false } = {}) => {
  const script = soloRecarga ? SOLO_RECARGA : LIVE_SCRIPT;
  return html.includes('</body>') ? html.replace('</body>', `${script}\n</body>`) : html + script;
};

// Mientras dura la proyección, la carpeta queda publicada en la red de casa: lo que no es parte de la
// página no tiene por qué viajar. Se bloquean los archivos ocultos y los que suelen guardar secretos.
const PROHIBIDO = /(^|[\\/])(\.[^\\/]+|node_modules|package-lock\.json|.*\.(env|pem|key|crt|p12|sqlite|db))([\\/]|$)/i;

export const esServible = (relativo) => !PROHIBIDO.test(relativo);

// Qué archivo sirve cada pedido, sin salir de la carpeta publicada.
export function resolveRequest(root, urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  const file = path.normalize(path.join(root, clean === '/' ? 'index.html' : clean));
  if (file !== root && !file.startsWith(root + path.sep)) return null;
  return esServible(path.relative(root, file)) ? file : null;
}

// Carpetas que cambian solas y no cambian lo que se ve: no tienen que recargar la tele.
const IGNORAR = /(^|[\\/])(node_modules|\.git|tmp|storage|dist|build|coverage|\.adonisjs|\.next)([\\/]|$)/;

export class Preview {
  constructor({ port, log = () => {} }) {
    this.port = port;
    this.log = log;
    this.version = String(Date.now());
    this.seq = 0;
    this.comandos = [];
    this.esperando = [];
    this.server = null;
    this.watcher = null;
    this.root = null;
    this.entry = null;
    this.origin = null; // modo proxy: el servidor de desarrollo que se está proyectando
    this.soloRecarga = false; // en modo video, el puntero lo pone el espejo
  }

  get url() {
    const ip = localAddress();
    return ip && (this.root || this.origin) ? `http://${ip}:${this.port}/${this.entry}` : null;
  }

  // En modo video la página la abre un Chrome de la misma Mac: no hace falta publicarla en la red.
  get localUrl() {
    return this.root || this.origin ? `http://127.0.0.1:${this.port}/${this.entry}` : null;
  }

  // Publica la carpeta del archivo (o hace de espejo de un servidor de desarrollo) y vigila los
  // cambios para recargar la tele. `file` puede ser una ruta o una URL http.
  async start(file, { watch: vigilar = null, host = '0.0.0.0', soloRecarga = false } = {}) {
    this.soloRecarga = soloRecarga;
    const esUrl = typeof file === 'string' && /^https?:\/\//.test(file);
    if (esUrl) {
      // Modo espejo: la tele no llega al servidor de desarrollo con el script de control, así que
      // se le pasa por delante este servidor, que le agrega el control y el aviso de recarga.
      const destino = new URL(file);
      this.origin = destino.origin;
      this.entry = destino.pathname.replace(/^\//, '') + destino.search;
      this.root = null;
    } else {
      const info = await stat(file);
      this.origin = null;
      this.root = info.isDirectory() ? path.resolve(file) : path.dirname(path.resolve(file));
      this.entry = info.isDirectory() ? '' : path.basename(file);
    }
    this.version = String(Date.now());
    this.watcher?.close();
    this.watcher = null;
    // En modo espejo se vigila la carpeta del proyecto, si nos la pasaron.
    const mirar = esUrl ? vigilar : this.root;
    if (mirar) {
      this.watcher = watch(mirar, { recursive: true }, (_evento, nombre) => {
        // Sin filtro, cualquier archivo temporal o de dependencias recargaría la tele sin parar.
        if (nombre && IGNORAR.test(String(nombre))) return;
        this.version = String(Date.now());
      });
    }
    if (this.server && this.host === host) return this.url;
    this.server?.close();
    this.host = host;

    this.server = http.createServer(async (req, res) => {
      if (req.url.startsWith('/__walkie-live')) {
        const desde = Number(new URL(req.url, 'http://x').searchParams.get('desde') || 0);
        return this.responder(res, desde);
      }
      if (this.origin) return this.espejar(req, res);
      const file = resolveRequest(this.root, req.url);
      if (!file) {
        res.writeHead(403);
        return res.end('fuera de la carpeta');
      }
      try {
        const data = await readFile(file);
        const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
        const body = type.startsWith('text/html')
          ? Buffer.from(withLiveReload(data.toString('utf8'), { soloRecarga: this.soloRecarga }))
          : data;
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Content-Length': body.length });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end('no encontrado');
      }
    });
    await new Promise((resolve) => this.server.listen(this.port, host, resolve));
    this.log(`+ tele: publicando ${this.root} en el puerto ${this.port}`);
    return this.url;
  }

  // Modo espejo: repite el pedido contra el servidor de desarrollo y, si vuelve HTML, le agrega el
  // script de control. Así se puede proyectar una app viva (Adonis, Vite, lo que sea), no solo
  // archivos sueltos.
  async espejar(req, res) {
    const cabeceras = {};
    for (const [nombre, valor] of Object.entries(req.headers)) {
      if (['host', 'connection', 'accept-encoding', 'content-length'].includes(nombre)) continue;
      cabeceras[nombre] = valor;
    }
    let cuerpo;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const partes = [];
      for await (const parte of req) partes.push(parte);
      cuerpo = Buffer.concat(partes);
    }
    let respuesta;
    try {
      respuesta = await fetch(this.origin + req.url, { method: req.method, headers: cabeceras, body: cuerpo, redirect: 'manual' });
    } catch (error) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('el proyecto no responde: ' + error.message);
    }
    const salida = {};
    for (const [nombre, valor] of respuesta.headers) {
      if (['content-encoding', 'content-length', 'set-cookie'].includes(nombre)) continue;
      salida[nombre] = valor;
    }
    const galletas = respuesta.headers.getSetCookie?.() || [];
    if (galletas.length) salida['set-cookie'] = galletas;
    salida['Cache-Control'] = 'no-store';
    const tipo = respuesta.headers.get('content-type') || '';
    if (tipo.includes('text/html')) {
      const html = Buffer.from(withLiveReload(await respuesta.text(), { soloRecarga: this.soloRecarga }));
      res.writeHead(respuesta.status, { ...salida, 'Content-Length': html.length });
      return res.end(html);
    }
    const datos = Buffer.from(await respuesta.arrayBuffer());
    res.writeHead(respuesta.status, { ...salida, 'Content-Length': datos.length });
    res.end(datos);
  }

  // Espera larga: la página queda esperando hasta que haya algo para hacer (o pasen 20 segundos).
  responder(res, desde) {
    const pendientes = this.comandos.filter((c) => c.seq > desde);
    if (pendientes.length || desde === 0) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ version: this.version, seq: this.seq, comandos: pendientes }));
    }
    const espera = { res, desde, timer: null };
    espera.timer = setTimeout(() => {
      this.esperando = this.esperando.filter((e) => e !== espera);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ version: this.version, seq: this.seq, comandos: [] }));
    }, 20000);
    this.esperando.push(espera);
  }

  // Control remoto desde el walkie: mover el puntero, apretar, soltar, scrollear o ir atrás y adelante.
  comando(orden) {
    this.seq += 1;
    this.comandos.push({ ...orden, seq: this.seq });
    if (this.comandos.length > 50) this.comandos.shift();
    for (const espera of this.esperando.splice(0)) {
      clearTimeout(espera.timer);
      espera.res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      espera.res.end(JSON.stringify({ version: this.version, seq: this.seq, comandos: this.comandos.filter((c) => c.seq > espera.desde) }));
    }
  }

  stop() {
    this.watcher?.close();
    this.server?.close();
    this.watcher = this.server = this.root = this.origin = null;
  }
}

// ---------- Chromecast (catt) ----------

// pip lo instala en ~/.local/bin, que no siempre está en el PATH del servicio.
const cattBin = () => (existsSync(path.join(homedir(), '.local', 'bin', 'catt')) ? path.join(homedir(), '.local', 'bin', 'catt') : 'catt');

const catt = (args, timeout = 30000) => run(cattBin(), args, { timeout });

// Los dispositivos de la red: el preferido es el de la configuración, pero siempre se pueden ver los otros.
export async function scanDevices() {
  const { stdout } = await catt(['scan'], 20000);
  return stdout
    .split('\n')
    .map((line) => line.match(/^(\d+\.\d+\.\d+\.\d+)\s+-\s+(.+?)\s+-\s+(.+)$/))
    .filter(Boolean)
    .map(([, address, name, model]) => ({ address, name, model }));
}

export const castSite = (device, url) => catt(['-d', device, 'cast_site', url], 60000);
export const stopCast = (device) => catt(['-d', device, 'stop'], 20000);

// La página más nueva de un proyecto: lo que el botón TELE del walkie proyecta sin preguntar nada.
const SALTAR = new Set(['node_modules', '.git', 'dist', 'build', 'vendor', 'coverage', '.next']);

// Las páginas de un proyecto, de la más nueva a la más vieja: lo que se puede elegir para la tele.
export async function paginas(root, { maxDepth = 3, max = 12 } = {}) {
  const { readdir, stat } = await import('node:fs/promises');
  const encontradas = [];
  const mirar = async (dir, depth) => {
    let entries = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || SALTAR.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth) await mirar(full, depth + 1);
      } else if (/\.html?$/i.test(entry.name)) {
        const { mtimeMs } = await stat(full).catch(() => ({ mtimeMs: 0 }));
        encontradas.push({ file: full, mtimeMs });
      }
    }
  };
  await mirar(path.resolve(root), 0);
  return encontradas.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, max);
}

export const newestPage = async (root, opciones) => (await paginas(root, { ...opciones, max: 1 }))[0]?.file || null;

// ---------- Servidores de desarrollo vivos ----------
//
// Lo que está escuchando en un puerto de la Mac (Adonis, Vite, Next…) se puede proyectar por el espejo.
// La salida de `lsof -Fpcn` viene por renglones: p<pid>, c<comando>, n<dirección:puerto>.
export function parseEscuchando(stdout) {
  const vistos = new Map();
  let pid = null;
  let comando = '';
  for (const linea of String(stdout).split('\n')) {
    if (linea.startsWith('p')) {
      pid = Number(linea.slice(1));
      comando = '';
    } else if (linea.startsWith('c')) comando = linea.slice(1);
    else if (linea.startsWith('n') && pid) {
      const puerto = Number(linea.match(/:(\d+)$/)?.[1]);
      if (puerto && !vistos.has(puerto)) vistos.set(puerto, { pid, comando, puerto });
    }
  }
  return [...vistos.values()].sort((a, b) => a.puerto - b.puerto);
}

export async function servidoresVivos({ ignorarPuertos = [], ignorarPids = [] } = {}) {
  let escuchando = [];
  try {
    const { stdout } = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn'], { timeout: 5000 });
    escuchando = parseEscuchando(stdout).filter((s) => !ignorarPuertos.includes(s.puerto) && !ignorarPids.includes(s.pid));
  } catch {
    return [];
  }
  if (!escuchando.length) return [];
  // La carpeta de cada proceso dice de qué proyecto es.
  const cwds = new Map();
  try {
    const pids = [...new Set(escuchando.map((s) => s.pid))];
    const { stdout } = await run('lsof', ['-a', '-p', pids.join(','), '-d', 'cwd', '-Fpn'], { timeout: 5000 });
    let pid;
    for (const linea of stdout.split('\n')) {
      if (linea.startsWith('p')) pid = Number(linea.slice(1));
      else if (linea.startsWith('n') && pid) cwds.set(pid, linea.slice(1));
    }
  } catch {}
  return escuchando.map((s) => ({ ...s, cwd: cwds.get(s.pid) || null }));
}
