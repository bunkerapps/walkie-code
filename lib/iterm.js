import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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

// Escribe el texto en la sesión y lo envía con Enter.
// El Enter va separado y con una pausa: si llega pegado al texto,
// Claude Code lo toma como parte de un pegado y no lo envía.
export async function writeAndSubmit(sessionId, text) {
  return osascript(inSession(`tell s to write text (item 2 of argv) newline false
            delay 0.25
            tell s to write text (character id 13) newline false`), sessionId, text);
}

const KEYS = { enter: 13, escape: 27 };

export async function pressKey(sessionId, name) {
  return osascript(inSession(`tell s to write text (character id ${KEYS[name]}) newline false`), sessionId);
}

// Todas las sesiones de iTerm2 donde corre Claude Code, en el orden de las ventanas y pestañas.
// `current` marca la sesión activa de la ventana al frente.
export async function listChannels() {
  let out;
  try {
    out = await osascript(`tell application "iTerm2"
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
end tell`);
  } catch (err) {
    // -1743: macOS no le dio a este proceso permiso de Automatización sobre iTerm2.
    if (/-1743/.test(err.stderr || '')) {
      return { ok: false, error: 'Falta permiso de Automatización para controlar iTerm2.', channels: [] };
    }
    console.error('iTerm2:', (err.stderr || err.message).trim());
    return { ok: false, error: 'No encuentro iTerm2 abierto.', channels: [] };
  }

  const [currentId, ...lines] = out.split('\n');
  const sessions = lines.filter(Boolean).map((l) => {
    const [id, tty, title = ''] = l.split('\t');
    return { id, tty, title };
  });

  const claudeByTty = await claudeProcessesByTty();
  const cwds = await cwdsOf([...claudeByTty.values()]);

  const channels = sessions
    .filter((s) => claudeByTty.has(s.tty))
    .map((s) => {
      const pid = claudeByTty.get(s.tty);
      const cwd = cwds.get(pid) || '';
      return { ...s, pid, cwd, project: cwd ? path.basename(cwd) : 'claude', current: s.id === currentId };
    });

  // Dos sesiones en el mismo proyecto se distinguen con un número.
  const seen = new Map();
  for (const ch of channels) {
    const n = (seen.get(ch.project) || 0) + 1;
    seen.set(ch.project, n);
    if (n > 1) ch.project = `${ch.project}·${n}`;
  }

  return { ok: true, channels };
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
