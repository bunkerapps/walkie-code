#!/usr/bin/env node
// Hook de Claude Code para los eventos Stop, PermissionRequest, Notification y UserPromptSubmit.
// Le pasa a walkie-code la última respuesta de Claude y la terminal donde corre.
// En UserPromptSubmit pregunta si el prompt lo dictó el teléfono y, si es así,
// le pide a Claude una respuesta pensada para escuchar.
// Si walkie-code no está corriendo no hace nada: nunca debe frenar a Claude Code.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../lib/config.js';
import { VOICE_STYLE, promptContextOutput } from '../lib/voice-style.js';

const TIMEOUT_MS = 1500;
// UserPromptSubmit frena el prompt hasta que el hook termina: pasado este plazo se sale igual.
const PROMPT_DEADLINE_MS = 1500;

// El hook hereda la terminal de Claude Code: se sube por los procesos padre hasta encontrarla.
function findTty() {
  let pid = process.pid;
  for (let i = 0; i < 8 && pid > 1; i++) {
    const [ppid, tty] = execFileSync('ps', ['-o', 'ppid=,tty=', '-p', String(pid)], { encoding: 'utf8' })
      .trim()
      .split(/\s+/);
    if (tty && tty !== '??') return `/dev/${tty}`;
    pid = Number(ppid);
  }
  return null;
}

// Último mensaje de texto del asistente en la transcripción (JSONL).
function lastAssistantText(transcriptPath) {
  const lines = readFileSync(transcriptPath, 'utf8').trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (entry.type === 'user' && !isToolResult(entry)) return '';
    if (entry.type !== 'assistant') continue;
    const content = entry.message?.content;
    const text = Array.isArray(content)
      ? content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
      : typeof content === 'string' ? content : '';
    if (text.trim()) return text;
  }
  return '';
}

function isToolResult(entry) {
  const c = entry.message?.content;
  return Array.isArray(c) && c.some((part) => part.type === 'tool_result');
}

function post(cfg, body, timeout = TIMEOUT_MS) {
  return fetch(`http://127.0.0.1:${cfg.port}/api/hook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Walkie-Token': cfg.token },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
}

async function main() {
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  const isPrompt = input.hook_event_name === 'UserPromptSubmit';
  if (isPrompt) setTimeout(() => process.exit(0), PROMPT_DEADLINE_MS).unref();

  const cfg = loadConfig({ create: false });
  if (!cfg.token) return;

  // La transcripción le sirve al servidor para el resumen de cada canal (lo último que pasó).
  const body = { event: input.hook_event_name, tty: findTty(), cwd: input.cwd, transcript: input.transcript_path };

  if (isPrompt) {
    body.prompt = input.prompt || '';
  } else if (body.event === 'Stop') {
    body.text = input.last_assistant_message || '';
    // La transcripción a veces se termina de escribir unos milisegundos después del hook.
    for (let i = 0; i < 4 && !body.text && input.transcript_path; i++) {
      body.text = lastAssistantText(input.transcript_path);
      if (!body.text) await new Promise((r) => setTimeout(r, 150));
    }
  } else if (body.event === 'StopFailure') {
    // El turno terminó por un error de la API (límite de uso, sobrecarga…): Claude ya no va a responder.
    body.error = input.error_type || 'unknown';
  } else if (body.event === 'PermissionRequest') {
    body.kind = 'permission';
    body.tool = input.tool_name || '';
    body.text = `Permiso para usar ${body.tool || 'una herramienta'}`;
  } else if (body.event === 'Notification') {
    body.text = input.message || '';
    const type = input.notification_type || '';
    body.kind = type === 'permission_prompt' || /permission/i.test(body.text) ? 'permission' : type || 'other';
  } else {
    return;
  }

  // En UserPromptSubmit el servidor anota que empezó un turno (para los avisos de tareas largas)
  // y contesta si el prompt lo dictó el teléfono (para pedir una respuesta apta para voz).
  const res = await post(cfg, body, isPrompt ? PROMPT_DEADLINE_MS - 300 : TIMEOUT_MS);

  if (isPrompt && cfg.voiceStyle !== false && res.ok && (await res.json()).dictated) {
    // En macOS la escritura a un pipe es asíncrona: hay que esperarla antes del process.exit.
    await new Promise((r) => process.stdout.write(promptContextOutput(VOICE_STYLE), r));
  }
}

main().catch(() => {}).finally(() => process.exit(0));
