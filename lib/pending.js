import { readFileSync, writeFileSync, renameSync } from 'node:fs';

// Canales que esperan respuesta para el teléfono, guardados en disco: si el servidor se reinicia a
// mitad de un turno (por ejemplo, porque Claude cambió Walkie-Code), la respuesta igual llega.
const MAX_AGE_MS = 6 * 60 * 60 * 1000;

export class PendingStore extends Map {
  constructor(file, now = Date.now()) {
    super();
    this.file = file;
    try {
      for (const [tty, entry] of Object.entries(JSON.parse(readFileSync(file, 'utf8')))) {
        if (now - (entry.since ?? 0) < MAX_AGE_MS) super.set(tty, entry);
      }
    } catch {}
  }

  set(tty, entry) {
    entry.since ??= Date.now();
    super.set(tty, entry);
    this.save();
    return this;
  }

  delete(tty) {
    const had = super.delete(tty);
    if (had) this.save();
    return had;
  }

  // También hay que llamarlo después de cambiar un campo de una entrada.
  save() {
    if (!this.file) return;
    try {
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this)), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch {}
  }
}
