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

// El script de recarga en vivo: pregunta por la versión y recarga cuando cambia.
export const LIVE_SCRIPT = `<script>
(function () {
  var version = null;
  function check() {
    fetch('/__walkie-live', { cache: 'no-store' })
      .then(function (r) { return r.text(); })
      .then(function (v) {
        if (version === null) version = v;
        else if (v !== version) location.reload();
      })
      .catch(function () {})
      .then(function () { setTimeout(check, 1000); });
  }
  check();
})();
</script>`;

export const withLiveReload = (html) =>
  html.includes('</body>') ? html.replace('</body>', `${LIVE_SCRIPT}\n</body>`) : html + LIVE_SCRIPT;

// Qué archivo sirve cada pedido, sin salir de la carpeta publicada.
export function resolveRequest(root, urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  const file = path.normalize(path.join(root, clean === '/' ? 'index.html' : clean));
  return file === root || file.startsWith(root + path.sep) ? file : null;
}

export class Preview {
  constructor({ port, log = () => {} }) {
    this.port = port;
    this.log = log;
    this.version = String(Date.now());
    this.server = null;
    this.watcher = null;
    this.root = null;
    this.entry = null;
  }

  get url() {
    const ip = localAddress();
    return ip && this.root ? `http://${ip}:${this.port}/${this.entry}` : null;
  }

  // Publica la carpeta del archivo y vigila los cambios para recargar la tele.
  async start(file) {
    const info = await stat(file);
    this.root = info.isDirectory() ? path.resolve(file) : path.dirname(path.resolve(file));
    this.entry = info.isDirectory() ? '' : path.basename(file);
    this.version = String(Date.now());
    this.watcher?.close();
    this.watcher = watch(this.root, { recursive: true }, () => {
      this.version = String(Date.now());
    });
    if (this.server) return this.url;

    this.server = http.createServer(async (req, res) => {
      if (req.url.startsWith('/__walkie-live')) {
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
        return res.end(this.version);
      }
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

  stop() {
    this.watcher?.close();
    this.server?.close();
    this.watcher = this.server = this.root = null;
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
