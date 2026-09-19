import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

// Usar la voz que esté elegida en Ajustes del Sistema (`say` sin `-v`).
// Es la única forma de llegar a una voz de Siri: ni `say -v` ni AVSpeechSynthesizer las exponen.
export const SYSTEM_VOICE = '(sistema)';

// Calidades de las voces de macOS, de peor a mejor. `say -v '?'` las marca en el nombre
// según el idioma de la Mac: "Paulina (Mejorada)", "Mónica (Premium)", "Samantha (Enhanced)".
export const QUALITIES = ['estandar', 'mejorada', 'premium'];

export function voiceQuality(name) {
  if (/\(premium\)/i.test(name)) return 'premium';
  if (/\((?:mejorada|enhanced)\)/i.test(name)) return 'mejorada';
  return 'estandar';
}

// "Eddy (Español (España))": voces Eloquence (Eddy, Flo, Grandma…), las más robóticas.
const isEloquence = (name) => /\([^()]*\([^()]*\)\)\s*$/.test(name);

// Voces de `say` instaladas en la Mac para un idioma. Cada línea de `say -v '?'` es:
//   Eddy (Español (España)) es_ES    # ¡Hola! Me llamo Eddy.
export function parseVoices(output, language) {
  const voices = [];
  for (const line of output.split('\n')) {
    const match = line.match(/^(.+?)\s+([a-z]{2,3}_[A-Z0-9]{2,3})\s+#/);
    if (!match) continue;
    const [, rawName, locale] = match;
    if (language && !locale.startsWith(`${language}_`)) continue;
    const name = rawName.trim();
    voices.push({
      name,
      locale,
      region: locale.split('_')[1],
      // "Eddy (Español (España))" → "Eddy"; "Paulina (Mejorada)" → "Paulina".
      label: name.replace(/\s*\([^()]*\([^()]*\)\)\s*$/, '').replace(/\s*\([^()]*\)\s*$/, '').trim(),
      quality: voiceQuality(name),
    });
  }
  return voices;
}

// Primero las mejores: premium, mejorada y estándar; dentro de cada una, las Eloquence al final.
// El orden estable respeta el de `say` para los empates.
export function sortVoices(voices) {
  const rank = (v) => -QUALITIES.indexOf(v.quality) * 2 + (isEloquence(v.name) ? 1 : 0);
  return voices
    .map((v, i) => [v, i])
    .sort(([a, i], [b, j]) => rank(a) - rank(b) || i - j)
    .map(([v]) => v);
}

export async function listVoices(language) {
  const { stdout } = await run('say', ['-v', '?']);
  return sortVoices(parseVoices(stdout, language));
}

// Ajustes del Sistema → Accesibilidad → Lectura y voz (en macOS 26; antes "Contenido leído").
// Ahí está "Voz del sistema", cuyo menú termina en "Administrar voces…". No hay URL más profunda:
// esa ventana es una hoja del menú y ninguna API pública descarga voces.
export const VOICE_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.universalaccess?TextToSpeech';

// URL fija: nada que venga del teléfono llega a `open`.
export async function openVoiceSettings() {
  await run('open', [VOICE_SETTINGS_URL], { timeout: 10000 });
}
