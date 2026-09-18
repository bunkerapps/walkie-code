import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

// Voces de `say` instaladas en la Mac para un idioma. Cada línea de `say -v '?'` es:
//   Eddy (Español (España)) es_ES    # ¡Hola! Me llamo Eddy.
export function parseVoices(output, language) {
  const voices = [];
  for (const line of output.split('\n')) {
    const match = line.match(/^(.+?)\s+([a-z]{2,3}_[A-Z0-9]{2,3})\s+#/);
    if (!match) continue;
    const [, name, locale] = match;
    if (language && !locale.startsWith(`${language}_`)) continue;
    const region = locale.split('_')[1];
    voices.push({
      name: name.trim(),
      locale,
      region,
      // "Eddy (Español (España))" → "Eddy"; "Paulina (Mejorada)" se queda como está.
      label: name.replace(/\s*\([^()]*\([^()]*\)\)\s*$/, '').trim(),
    });
  }
  return voices;
}

export async function listVoices(language) {
  const { stdout } = await run('say', ['-v', '?']);
  return parseVoices(stdout, language);
}
