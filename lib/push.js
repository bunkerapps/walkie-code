// Avisos push para cuando el teléfono está bloqueado o la app quedó en segundo plano.
// Guarda las claves VAPID y las suscripciones en ~/.walkie-code/push.json, y decide a quién avisar.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { generateVapidKeys } from './webpush.js';
import { toSpeech } from './speech.js';

const MAX_SUBSCRIPTIONS = 20;

// Carga el archivo de push y genera las claves VAPID la primera vez.
// Van aparte de config.json porque las suscripciones cambian solas y no son configuración.
export function openPushStore(file) {
  let data = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  data = { vapid: data.vapid || generateVapidKeys(), subscriptions: data.subscriptions || [] };

  const persist = () => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  };
  if (!existsSync(file)) persist();

  return {
    vapid: data.vapid,
    list: () => data.subscriptions,

    // Una suscripción por endpoint. Si el mismo cliente se volvió a suscribir (iOS a veces rota
    // el endpoint), la anterior se descarta para no mandar dos avisos al mismo teléfono.
    save(subscription, clientId, device) {
      const { endpoint, keys } = subscription || {};
      if (!isValidSubscription(subscription)) throw Object.assign(new Error('Suscripción inválida.'), { status: 400 });
      data.subscriptions = data.subscriptions.filter((s) => s.endpoint !== endpoint && (!clientId || s.clientId !== clientId));
      data.subscriptions.push({ endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth }, clientId, device, at: Date.now() });
      data.subscriptions = data.subscriptions.slice(-MAX_SUBSCRIPTIONS);
      persist();
    },

    remove(endpoint) {
      const before = data.subscriptions.length;
      data.subscriptions = data.subscriptions.filter((s) => s.endpoint !== endpoint);
      if (data.subscriptions.length !== before) persist();
    },
  };
}

// Solo se aceptan endpoints HTTPS con las dos claves del teléfono: el servidor les va a hacer POST.
export function isValidSubscription(sub) {
  try {
    return new URL(sub.endpoint).protocol === 'https:' && typeof sub.keys?.p256dh === 'string' && typeof sub.keys?.auth === 'string';
  } catch {
    return false;
  }
}

// ---------- Presencia ----------

// Si la app está a la vista ya suena el audio: no hace falta el aviso.
// Cada pedido del teléfono con la app visible (el refresco de canales va cada 10 s) la marca como vista;
// al pasar a segundo plano el teléfono avisa "oculta". Si ese último aviso se pierde
// (iOS congela la página de golpe), la marca vence sola.
export const PRESENCE_TTL_MS = 25000;

export function createPresence(now = () => Date.now()) {
  const seen = new Map(); // clientId -> { visible, at }
  return {
    touch(clientId, visible = true) {
      if (clientId) seen.set(clientId, { visible, at: now() });
    },
    isVisible(clientId) {
      const p = clientId && seen.get(clientId);
      return Boolean(p?.visible && now() - p.at < PRESENCE_TTL_MS);
    },
  };
}

// A quién mandarle el aviso: al dispositivo que habló (`to`), o a todos si no se sabe quién fue,
// salvo a los que tienen la app abierta y a la vista.
export function pushTargets(subscriptions, to, isVisible) {
  return subscriptions.filter((s) => (!to || s.clientId === to) && !isVisible(s.clientId));
}

// ---------- Texto del aviso ----------

const BODY_CHARS = 140;

// Recorta en un límite de palabra para que no quede una palabra partida.
export function shorten(text, max = BODY_CHARS) {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s.,;:]+$/, '')}…`;
}

// Título y cuerpo del aviso. Se reutiliza el limpiador de voz: saca el markdown, el código y las rutas.
export function pushMessage({ kind, text, project, tool }) {
  const title = project ? `CLAUDE · ${project}` : 'CLAUDE';
  const body = kind === 'permission'
    ? `Claude necesita permiso para ${tool ? `usar ${tool}` : 'seguir'}`
    : shorten(toSpeech(text) || 'Listo.');
  // El tag agrupa por proyecto: una respuesta nueva reemplaza a la anterior del mismo canal.
  return { title, body, tag: `walkie-code-${project || 'claude'}`, url: '/' };
}
