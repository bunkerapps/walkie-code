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
  var version = null;
  var desde = 0;

  // Puntero virtual: en la tele no hay mouse, así que se dibuja uno y se simulan los eventos.
  var cursor = document.createElement('div');
  cursor.style.cssText = 'position:fixed;left:50%;top:50%;width:26px;height:26px;margin:-13px 0 0 -13px;' +
    'border-radius:50%;border:3px solid #fff;background:rgba(124,77,255,0.55);box-shadow:0 2px 10px rgba(0,0,0,0.5);' +
    'z-index:2147483647;pointer-events:none;transition:transform 90ms linear;display:none';
  document.documentElement.appendChild(cursor);
  var x = window.innerWidth / 2;
  var y = window.innerHeight / 2;

  function pintar() {
    cursor.style.display = 'block';
    cursor.style.left = x + 'px';
    cursor.style.top = y + 'px';
  }

  function evento(tipo, extra) {
    var destino = document.elementFromPoint(x, y) || document.body;
    var init = { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, pointerType: 'touch', buttons: extra ? 1 : 0, isPrimary: true };
    try { destino.dispatchEvent(new PointerEvent(tipo, init)); } catch (e) {}
    if (tipo === 'pointerdown') destino.dispatchEvent(new MouseEvent('mousedown', init));
    if (tipo === 'pointerup') {
      destino.dispatchEvent(new MouseEvent('mouseup', init));
      destino.dispatchEvent(new MouseEvent('click', init));
    }
    if (tipo === 'pointermove') destino.dispatchEvent(new MouseEvent('mousemove', init));
    return destino;
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
    } else if (c.tipo === 'scroll') {
      var alto = window.innerHeight * 0.8;
      if (c.accion === 'top') window.scrollTo({ top: 0, behavior: 'smooth' });
      else if (c.accion === 'bottom') window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
      else window.scrollBy({ top: c.accion === 'up' ? -alto : alto, behavior: 'smooth' });
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

export const withLiveReload = (html) =>
  html.includes('</body>') ? html.replace('</body>', `${LIVE_SCRIPT}\n</body>`) : html + LIVE_SCRIPT;

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
  }

  get url() {
    const ip = localAddress();
    return ip && (this.root || this.origin) ? `http://${ip}:${this.port}/${this.entry}` : null;
  }

  // Publica la carpeta del archivo (o hace de espejo de un servidor de desarrollo) y vigila los
  // cambios para recargar la tele. `file` puede ser una ruta o una URL http.
  async start(file, { watch: vigilar = null } = {}) {
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
    if (this.server) return this.url;

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
        const body = type.startsWith('text/html') ? Buffer.from(withLiveReload(data.toString('utf8'))) : data;
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Content-Length': body.length });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end('no encontrado');
      }
    });
    await new Promise((resolve) => this.server.listen(this.port, '0.0.0.0', resolve));
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
      const html = Buffer.from(withLiveReload(await respuesta.text()));
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

  // Control remoto desde el walkie: mover el puntero, apretar, soltar o scrollear.
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

export async function newestPage(root, { maxDepth = 3 } = {}) {
  const { readdir, stat } = await import('node:fs/promises');
  let best = null;
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
        if (!best || mtimeMs > best.mtimeMs) best = { file: full, mtimeMs };
      }
    }
  };
  await mirar(path.resolve(root), 0);
  return best?.file || null;
}
