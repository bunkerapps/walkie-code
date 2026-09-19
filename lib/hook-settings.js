// Arma la sección `hooks` de ~/.claude/settings.json con el hook de walkie-code.
// Lógica pura (sin tocar archivos) para poder probarla: la usa scripts/install-hooks.js.

// Evento -> segundos que Claude Code le da al hook antes de cortarlo.
// UserPromptSubmit frena el prompt, por eso tiene menos margen (el hook igual sale a los 1,5 s).
export const EVENTS = { Stop: 5, PermissionRequest: 5, UserPromptSubmit: 3, StopFailure: 5 };

// También reconoce los hooks de cuando el proyecto se llamaba supervoz, para reemplazarlos.
export const isOurs = (h) => /(walkie-code|supervoz).*claude-hook\.js/.test(h.command || '');

// Saca nuestras entradas de cada evento y, si no es --remove, vuelve a agregar una sola.
// Los hooks ajenos quedan como estaban; los grupos que se vacían se borran.
export function withWalkieHooks(settings, command, { remove = false } = {}) {
  const hooks = { ...(settings.hooks ?? {}) };
  for (const [event, timeout] of Object.entries(EVENTS)) {
    const groups = (hooks[event] ?? [])
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h)) }))
      .filter((g) => g.hooks.length > 0);
    if (!remove) groups.push({ hooks: [{ type: 'command', command, timeout }] });
    if (groups.length) hooks[event] = groups;
    else delete hooks[event];
  }
  return { ...settings, hooks };
}
