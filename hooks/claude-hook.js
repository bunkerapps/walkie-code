#!/usr/bin/env node
// Hook de Claude Code para los eventos Stop, PermissionRequest, Notification y UserPromptSubmit.
// Le pasa a supervoz la última respuesta de Claude y la terminal donde corre.
// Si supervoz no está corriendo no hace nada: nunca debe frenar a Claude Code.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../lib/config.js';

const TIMEOUT_MS = 1500;
// UserPromptSubmit frena el envío del prompt hasta que el hook termina: tiene que ser rápido.
const TURN_TIMEOUT_MS = 500;

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
    headers: { 'Content-Type': 'application/json', 'X-Supervoz-Token': cfg.token },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
}

// UserPromptSubmit: le avisa a supervoz que empezó un turno, para medir cuánto dura
// y avisar al teléfono si fue largo. No imprime nada (acá stdout se sumaría al prompt).
async function turnStarted(cfg, input) {
  await post(cfg, { event: 'UserPromptSubmit', tty: findTty(), cwd: input.cwd }, TURN_TIMEOUT_MS);
}

async function main() {
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  const cfg = loadConfig({ create: false });
  if (!cfg.token) return;
  if (input.hook_event_name === 'UserPromptSubmit') return turnStarted(cfg, input);

  const body = { event: input.hook_event_name, tty: findTty(), cwd: input.cwd };

  if (body.event === 'Stop') {
    body.text = input.last_assistant_message || '';
    // La transcripción a veces se termina de escribir unos milisegundos después del hook.
    for (let i = 0; i < 4 && !body.text && input.transcript_path; i++) {
      body.text = lastAssistantText(input.transcript_path);
      if (!body.text) await new Promise((r) => setTimeout(r, 150));
    }
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

  await post(cfg, body);
}

main().catch(() => {}).finally(() => process.exit(0));
