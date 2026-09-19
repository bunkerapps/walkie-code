// Límites de uso de Claude (ventana de 5 horas y semanal). Claude Code los pasa a la barra de estado:
// hooks/statusline.js los guarda en ~/.walkie-code/usage.json y el teléfono los muestra como barra de vida.

const pct = (value) => (Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : null);

function windowOf(raw) {
  const used = pct(raw?.used_percentage);
  if (used === null) return null;
  const resets = raw.resets_at ? new Date(typeof raw.resets_at === 'number' && raw.resets_at < 1e12 ? raw.resets_at * 1000 : raw.resets_at) : null;
  return { used, resetsAt: resets && !Number.isNaN(resets.getTime()) ? resets.toISOString() : null };
}

// Del JSON que Claude Code le pasa a la barra de estado, se queda solo con los límites.
export function usageFrom(status, now = Date.now()) {
  const limits = status?.rate_limits;
  const fiveHour = windowOf(limits?.five_hour);
  const sevenDay = windowOf(limits?.seven_day);
  if (!fiveHour && !sevenDay) return null;
  return { fiveHour, sevenDay, at: new Date(now).toISOString() };
}

// Texto corto para la barra de estado de la terminal.
export function usageLine(usage) {
  if (!usage) return '';
  const parts = [];
  if (usage.fiveHour) parts.push(`5h ${Math.round(usage.fiveHour.used)}%`);
  if (usage.sevenDay) parts.push(`7d ${Math.round(usage.sevenDay.used)}%`);
  return `📻 ${parts.join(' · ')}`;
}
