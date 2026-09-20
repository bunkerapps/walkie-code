import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { open } from 'node:fs/promises';
import path from 'node:path';

const run = promisify(execFile);

// El texto viaja como argumento de osascript, así no hay que escapar comillas ni acentos.
async function osascript(script, ...args) {
  const { stdout } = await run('osascript', ['-e', script, ...args], { timeout: 8000 });
  return stdout.trim();
}

// Busca la sesión de iTerm2 por su id (item 1 de argv) y ejecuta `body` sobre ella, como `s`.
const inSession = (body) => `on run argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if (id of s) is (item 1 of argv) then
            ${body}
            return tty of s
          end if
        end repeat
      end repeat
    end repeat
  end tell
  error "La sesión de iTerm2 ya no existe."
end run`;

// Saca los caracteres de control (Enter, Escape, Ctrl+C…): lo que llega del teléfono es solo texto.
export const cleanForTerminal = (text) => String(text).replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/ {2,}/g, ' ').trim();

// Escribe el texto en la sesión y lo envía con Enter.
// El Enter va separado y con una pausa: si llega pegado al texto,
// Claude Code lo toma como parte de un pegado y no lo envía.
export async function writeAndSubmit(sessionId, text) {
  text = cleanForTerminal(text);
  return osascript(inSession(`tell s to write text (item 2 of argv) newline false
            delay 0.25
            tell s to write text (character id 13) newline false`), sessionId, text);
}

// Cierra un canal: sale de Claude Code con /exit (así guarda la sesión) y después cierra la pestaña.
// Con solo la shell corriendo, iTerm2 no pide confirmación para cerrarla.
export async function closeChannel(sessionId) {
  await writeAndSubmit(sessionId, '/exit');
  await new Promise((r) => setTimeout(r, 2500));
  return osascript(inSession('tell s to close'), sessionId);
}

// Abre una ventana nueva de iTerm2 y arranca Claude Code en la carpeta.
// `quoted form of` arma la ruta entre comillas para la shell.
export async function openClaude(dir, command) {
  const out = await osascript(`on run argv
  tell application "iTerm2"
    set w to (create window with default profile)
    set s to current session of w
    tell s to write text "cd " & quoted form of (item 1 of argv) & " && " & (item 2 of argv)
    return (id of s) & linefeed & (tty of s)
  end tell
end run`, dir, command);
  const [id, tty] = out.split('\n');
  return { id, tty };
}

export async function sessionContents(sessionId) {
  return osascript(inSession('return contents of s'), sessionId);
}

const KEYS = { enter: 13, escape: 27 };

export async function pressKey(sessionId, name) {
  return osascript(inSession(`tell s to write text (character id ${KEYS[name]}) newline false`), sessionId);
}

// Flechas para moverse por un menú de Claude Code: la secuencia ESC [ A (arriba) o ESC [ B (abajo).
// Van de a una y con una pausa, para que la terminal las procese como pulsaciones separadas.
export async function pressArrow(sessionId, dir, veces = 1) {
  const n = Math.min(Math.max(Math.trunc(veces), 0), 10);
  if (!n) return null;
  return osascript(inSession(`repeat ${n} times
              tell s to write text ((character id 27) & "[${dir === 'up' ? 'A' : 'B'}") newline false
              delay 0.15
            end repeat`), sessionId);
}

// AppleScript falla feo mientras iTerm2 abre o cierra una ventana, pero se recupera enseguida.
async function conReintento(fn, intentos = 2, pausa = 400) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const pasajero = /-1728/.test(err.stderr || '') || err.killed;
      if (i >= intentos || !pasajero) throw err;
      await new Promise((r) => setTimeout(r, pausa));
    }
  }
}

// Todas las sesiones de iTerm2 donde corre Claude Code, en el orden de las ventanas y pestañas.
// `current` marca la sesión activa de la ventana al frente.
// `names` son los nombres que se le pusieron a cada carpeta desde el teléfono.
// `channelNames`: nombre propio de cada canal (por id de sesión de iTerm2), puesto desde el teléfono.
// `names`: nombre de una carpeta; solo se usa si en esa carpeta hay un único canal.
export async function listChannels(names = {}, channelNames = {}) {
  let out;
  try {
    // Con dos intentos: si justo se está abriendo o cerrando una ventana, iTerm2 contesta con un error
    // pasajero (-1728, "no puede obtenerse every tab of…") y quedaríamos sin ningún canal a la vista.
    out = await conReintento(() => osascript(`tell application "iTerm2"
  set out to ""
  set cur to ""
  if (count of windows) > 0 then set cur to id of current session of current window
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        set out to out & (id of s) & (character id 9) & (tty of s) & (character id 9) & (name of s) & linefeed
      end repeat
    end repeat
  end repeat
  return cur & linefeed & out
end tell`));
  } catch (err) {
    // -1743: macOS no le dio a este proceso permiso de Automatización sobre iTerm2.
    if (/-1743/.test(err.stderr || '')) {
      return { ok: false, error: 'Falta permiso de Automatización para controlar iTerm2.', channels: [] };
    }
    console.error('iTerm2:', (err.stderr || err.message).trim());
    // -1728 o un osascript que tardó: iTerm2 está ocupado, no es que se haya cerrado.
    const ocupado = /-1728/.test(err.stderr || '') || err.killed;
    return {
      ok: false,
      error: ocupado ? 'iTerm2 está ocupado y no contestó: probá de nuevo.' : 'No encuentro iTerm2 abierto.',
      channels: [],
    };
  }

  const [currentId, ...lines] = out.split('\n');
  const sessions = lines.filter(Boolean).map((l) => {
    const [id, tty, title = ''] = l.split('\t');
    return { id, tty, title };
  });

  const claudeByTty = await claudeProcessesByTty();
  const cwds = await cwdsOf([...claudeByTty.values()]);

  const found = sessions
    .filter((s) => claudeByTty.has(s.tty))
    .map((s) => ({ ...s, pid: claudeByTty.get(s.tty), cwd: cwds.get(claudeByTty.get(s.tty)) || '' }));
  const perFolder = new Map();
  for (const s of found) perFolder.set(s.cwd, (perFolder.get(s.cwd) || 0) + 1);

  const channels = found.map((s) => {
    const folder = s.cwd ? path.basename(s.cwd) : 'claude';
    const folderName = perFolder.get(s.cwd) === 1 ? names[s.cwd] : null;
    return { ...s, folder, project: channelNames[s.id] || folderName || folder, current: s.id === currentId };
  });

  // Dos sesiones en el mismo proyecto se distinguen con un número.
  const seen = new Map();
  for (const ch of channels) {
    const n = (seen.get(ch.project) || 0) + 1;
    seen.set(ch.project, n);
    if (n > 1) ch.project = `${ch.project}·${n}`;
  }

  // `sessions` son todas las pestañas de iTerm2, corra Claude Code o no: sirven para saber si un canal
  // que dejó de verse sigue abierto (Claude Code se reinicia solo al aceptar la confianza de una carpeta).
  return { ok: true, channels, sessions };
}

async function claudeProcessesByTty() {
  const { stdout } = await run('ps', ['-A', '-o', 'pid=,tty=,comm=']);
  const byTty = new Map();
  for (const line of stdout.split('\n')) {
    const [pid, tty, ...cmd] = line.trim().split(/\s+/);
    if (tty && tty !== '??' && path.basename(cmd.join(' ')) === 'claude' && !byTty.has(`/dev/${tty}`)) {
      byTty.set(`/dev/${tty}`, Number(pid));
    }
  }
  return byTty;
}

async function cwdsOf(pids) {
  const cwds = new Map();
  if (!pids.length) return cwds;
  try {
    const { stdout } = await run('lsof', ['-a', '-p', pids.join(','), '-d', 'cwd', '-Fpn']);
    let pid;
    for (const line of stdout.split('\n')) {
      if (line.startsWith('p')) pid = Number(line.slice(1));
      else if (line.startsWith('n') && pid) cwds.set(pid, line.slice(1));
    }
  } catch {}
  return cwds;
}

// ---------- Marca en la Mac del canal sintonizado ----------
//
// Secuencias de escape propias de iTerm2, escritas en la salida de la terminal (el tty).
// Las interpreta iTerm2 y no llegan como entrada a Claude Code.

const ESC = '\x1b]';
const BEL = '\x07';
const TAB_COLOR = { red: 255, green: 91, blue: 26 }; // el naranja del PTT

const tabColor = () =>
  Object.entries(TAB_COLOR).map(([c, v]) => `${ESC}6;1;bg;${c};brightness;${v}${BEL}`).join('');
const badge = (text) => `${ESC}1337;SetBadgeFormat=${Buffer.from(text).toString('base64')}${BEL}`;

async function writeToTty(tty, data) {
  const fh = await open(tty, 'w');
  try {
    await fh.write(data);
  } finally {
    await fh.close();
  }
}

// Pinta la pestaña y pone una marca de agua con el canal.
export function highlight(tty, label) {
  return writeToTty(tty, tabColor() + badge(label));
}

// Devuelve la pestaña a como estaba. Si la terminal ya se cerró, no hay nada que limpiar.
export function unhighlight(tty) {
  return writeToTty(tty, `${ESC}6;1;bg;*;default${BEL}${badge('')}`).catch(() => {});
}
