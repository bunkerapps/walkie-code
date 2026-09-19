# Walkie-Code

**Un walkie-talkie para hablarle a Claude Code.** Mantenés apretado un botón naranja en el iPhone, hablás y soltás: lo que dijiste se escribe en la sesión de Claude Code que corre en iTerm2 en tu Mac, y la respuesta de Claude se escucha en el teléfono.

[Read in English](README.md)

<p align="center"><img src="docs/screenshot.png" alt="Walkie-Code en un iPhone: pantalla LCD con el canal, parlante, botón PTT naranja y teclas" width="300"></p>

Todo corre en tus propios equipos. La voz se pasa a texto en la Mac con Whisper, las respuestas se leen con `say` de macOS, y el teléfono llega a la Mac por tu red privada de Tailscale. Nada sale de tu red salvo lo que Claude Code ya manda.

> Walkie-Code es un proyecto independiente de la comunidad. No está afiliado ni avalado por Anthropic.

## Cómo funciona

```
iPhone (web app) ──audio──▶ server.js ──▶ whisper-server (voz a texto, local)
                                      └──▶ iTerm2 (AppleScript): escribe en el canal y envía con Enter
Claude Code ──hooks──▶ server.js ──say──▶ audio ──SSE──▶ iPhone
                                 └──Web Push──▶ iPhone bloqueado
```

- Un servidor chico en Node.js, sin dependencias npm, corre en la Mac como agente de `launchd` y escucha solo en `127.0.0.1`.
- `tailscale serve` lo publica con HTTPS dentro de tu tailnet. Safari solo da acceso al micrófono sobre HTTPS.
- Los [hooks de Claude Code](https://code.claude.com/docs/en/hooks) le avisan al servidor cuándo empieza, termina, pide permiso o falla cada turno. Son `UserPromptSubmit`, `Stop`, `PermissionRequest` y `StopFailure`.
- En el iPhone es una web que se agrega a la pantalla de inicio: no hace falta Xcode ni App Store.

## Requisitos

- macOS con [iTerm2](https://iterm2.com) y Node.js 20 o más nuevo
- [Claude Code](https://code.claude.com)
- `brew install whisper-cpp ffmpeg`
- Un modelo de Whisper. Usamos `ggml-large-v3-turbo-q5_0.bin` (unos 550 MB), que anda muy bien en Apple Silicon.
- [Tailscale](https://tailscale.com) en la Mac y en el iPhone, con MagicDNS y los certificados HTTPS activados en la consola
- iOS 16.4 o más nuevo para las notificaciones push

## Puesta en marcha

```sh
git clone https://github.com/bunkerapps/walkie-code.git
cd walkie-code

# 1. Modelo de Whisper
mkdir -p ~/.walkie-code/models
curl -L -o ~/.walkie-code/models/ggml-large-v3-turbo-q5_0.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin

# 2. Hooks de Claude Code (se suman a ~/.claude/settings.json sin tocar los tuyos, con backup)
node scripts/install-hooks.js

# 3. El servidor como servicio de launchd (arranca solo al iniciar sesión y se reinicia si se cae)
scripts/service.sh install

# 4. Publicarlo dentro de tu tailnet con HTTPS
tailscale serve --bg 8787
```

Después, en Safari del iPhone, abrí `https://<tu-mac>.<tu-tailnet>.ts.net/?t=<token>` y usá **Compartir › Agregar a pantalla de inicio**. El token está en `~/.walkie-code/config.json`.

La primera vez, macOS pide permiso de **Automatización** para que `node` controle iTerm2.

Otros comandos: `scripts/service.sh restart | status | logs | uninstall` y `node scripts/install-hooks.js --remove`.

## Uso

### Hablar

- **PTT:** mantener apretado, esperar el bip, hablar y soltar. Se envía solo.
- Lo que dictás le llega a Claude con una instrucción extra para que **responda para escuchar**: corto, conversado, sin listas largas, tablas ni bloques de código (si hacen falta, los deja en la terminal y los menciona). Lo que tipeás en la Mac no cambia. Se apaga con `"voiceStyle": false`, y el texto de la instrucción está en `lib/voice-style.js`.
- La respuesta suena **solo en el dispositivo que habló**. Si la web está abierta en otro lado, ahí solo se ve el texto.
- **REPETIR** lee en voz alta el resumen del canal (lo último que se pidió y lo que respondió Claude), **SILENCIO** corta la lectura y **ESC** interrumpe a Claude.
- Si Claude pide un **permiso**, se escucha el aviso: "sí" o "dale" lo aprueban y "no" lo cancela.

### Canales

- Cada sesión de iTerm2 donde corre Claude Code es un canal. Las terminales con una shell común no aparecen, para no ejecutar comandos dictados.
- Se cambia **deslizando** la pantalla, con los botones **anterior y siguiente de la Isla Dinámica**, o **por voz**: "canal superprecio", "canal tres", "cambiá al canal de la landing", "sintonizá bunkerapps".
  - Por voz, busca en el nombre del proyecto, la carpeta y la tarea en curso. No importan mayúsculas, acentos ni espacios, y tolera errores chicos de Whisper ("Kick Way" = "Quickway").
  - Solo cuenta si la frase **empieza** con el comando y es corta: "el canal 3 no anda" va a Claude. Si hay dos canales parecidos, lo dice y no manda nada.
- En la Mac, la pestaña del canal sintonizado se pinta de **naranja** y lleva la marca **"📻 CH03 · proyecto"** mientras haya un teléfono conectado.
- Al abrir la app y al cambiar de canal, la pantalla muestra un **resumen**: el último pedido y la última respuesta de esa sesión, aunque se hayan escrito desde la Mac. Tocando un mensaje se abre completo, con scroll.
- **Nombre propio:** manteniendo apretado el nombre del canal se le pone un nombre a esa carpeta. Se usa en el walkie, en la voz, en la marca de la Mac y en el explorador.
- **＋** abre un explorador de carpetas dentro de `projectsRoot`. **ABRIR CLAUDE ACÁ** abre una ventana nueva de iTerm2 con Claude Code en esa carpeta y sintoniza el canal. Si Claude pregunta si confiás en la carpeta, se contesta "sí".

### Avisos

- **AVISOS** (arriba) activa las notificaciones push. Con el teléfono bloqueado llegan las respuestas ("CLAUDE · proyecto"), los pedidos de permiso y los avisos de otros canales. Requiere abrir la app desde el ícono de la pantalla de inicio. Si alguna vez lo rechazaste, se habilita en Ajustes › Notificaciones › Walkie-Code.
- **Otros canales:** si una sesión a la que no le hablaste termina un turno de más de `notifyAfterSeconds` (60 por defecto), suena "Terminó superprecio". Los permisos de cualquier canal se avisan siempre. Se configuran en el panel de VOZ.
- **Límite de uso:** si Claude llega al límite, avisa "Claude llegó al límite de uso y se renueva a las 23:10" a todos los teléfonos, y el walkie deja de decir CLAUDE PIENSA. Otros errores de la API se avisan en el canal donde hablaste.
- La pantalla queda encendida mientras la app está abierta. Si el teléfono se bloquea, al volver se recupera lo que llegó mientras tanto.
- En la **Isla Dinámica** y en la pantalla bloqueada aparece quién habla y en qué canal.

### Fotos

- **FOTO** saca una foto o elige una de la galería. El teléfono la achica a 1600 px y la sube, y se manda junto con la próxima transmisión. **ENVIAR SOLA** la manda sin hablar y **✕** la quita.
- En la terminal se escribe lo dictado más la ruta de la foto (`~/.walkie-code/uploads/…`), y Claude Code la abre desde ahí. La primera vez puede pedir permiso para leer esa carpeta; para que no pregunte, permití `Read(~/.walkie-code/uploads/**)` en tu configuración de Claude Code. Las fotos se borran a los 7 días.

### Voces

- Tocando **AJUSTES** (o el parlante) se elige la voz y la velocidad, entre las voces instaladas en la Mac y ordenadas por calidad (premium, mejorada, estándar). Al final está **VOZ DEL SISTEMA**, la que esté elegida en Ajustes.
- **INSTALAR MÁS VOCES** abre en la Mac *Ajustes del Sistema › Accesibilidad › Lectura y voz* y te dice qué tocar. macOS no permite descargar voces por programa: se bajan a mano desde *Voz del sistema › Administrar voces…*, y aparecen solas en la lista.
- **VOLUMEN DE VOZ**, debajo de la velocidad, va de 20 a 300 % y se guarda en cada teléfono. Safari en iOS ignora el volumen del audio, así que la ganancia la aplica la Mac con `ffmpeg`.
- **VOLUMEN DE EFECTOS**, en el mismo panel, ajusta por separado el sonido de apretar, soltar, la respuesta y los avisos (de mudo a 150 %). Se guarda en cada teléfono.
- Las voces de Siri no están disponibles para `say`. La única vía es elegir una como voz del sistema y usar VOZ DEL SISTEMA (experimental).

### Barra de vida

La barrita vertical del costado derecho muestra cuánto queda del límite de uso de Claude en la ventana de 5 horas: verde, ámbar y roja. Tocándola, la pantalla dice cuándo se renueva y cuánto queda de la semana. El dato sale de la barra de estado de Claude Code (`hooks/statusline.js`), que `install-hooks` instala solo si no tenés otra.

### Despertar la Mac

Si la Mac duerme, Walkie-Code no carga. [Walkie Wake](scripts/wake/README.md) es un relay chiquito en Python que corre en cualquier equipo siempre prendido de tu red (una Raspberry Pi, un servidor casero, un teléfono viejo…) y despierta la Mac con Wake-on-LAN. Es una web aparte, con la misma estética y un botón de encendido, y nunca guarda el token de Walkie-Code.

## Configuración

`~/.walkie-code/config.json` (se crea la primera vez):

| Clave | Por defecto | Para qué sirve |
| --- | --- | --- |
| `port` / `whisperPort` | `8787` / `8788` | Puertos locales del servidor y de whisper-server |
| `language` | `es` | Idioma de Whisper y de la lista de voces |
| `model` | `~/.walkie-code/models/ggml-large-v3-turbo-q5_0.bin` | Modelo de Whisper |
| `whisperPrompt` | vocabulario de programación | Palabras que Whisper suele entender mal |
| `voice` / `rate` | `Paulina` / `190` | Voz de `say` y palabras por minuto |
| `voiceStyle` | `true` | Pedir respuestas para escuchar en lo dictado |
| `notices` / `notifyAfterSeconds` | `true` / `60` | Avisos de otros canales y duración mínima del turno |
| `projectsRoot` | `~/Development` | Única carpeta donde el teléfono puede abrir Claude |
| `names` | `{}` | Nombres propios de cada carpeta (se ponen desde el teléfono) |
| `allowedHosts` | `[]` | Otros nombres de host aceptados, además de localhost y `*.ts.net` |
| `pushSubject` | `https://bunkerapps.net` | Contacto de la firma VAPID (`mailto:` o `https:`) |

**Sonidos.** Los públicos se generan con `scripts/make-sounds.js`. Para usar los tuyos sin publicarlos, poné `ptt.m4a`, `release.m4a` y `rx.m4a` en `~/.walkie-code/sounds/`.

Con `WALKIE_CODE_HOME` se levanta una segunda instancia aislada, por ejemplo para desarrollo.

## Seguridad

Walkie-Code escribe en tu terminal: leé [SECURITY.md](SECURITY.md) antes de usarlo. En resumen:

- El servidor escucha solo en `127.0.0.1` y se llega a él solo por tu tailnet. **Nunca lo expongas con Tailscale Funnel ni con otro túnel público.**
- Cada pedido a la API necesita un token aleatorio de 128 bits, comparado en tiempo constante. Se rechazan los pedidos con un `Host` ajeno, lo que frena el ataque de DNS rebinding.
- Solo se escribe en sesiones donde corre Claude Code, nunca en una shell, y sin caracteres de control.
- Lo dictado, las respuestas y las fotos quedan en tu Mac. El log del servicio, en `~/.walkie-code/`, incluye lo que dictás.

## Desarrollo

```sh
npm test         # node:test, sin dependencias
npm start        # el servidor en primer plano
```

Ver [CONTRIBUTING.md](CONTRIBUTING.md). No pruebes contra tus sesiones reales de Claude Code: usá `WALKIE_CODE_HOME` y una ventana de iTerm2 aparte.

## Licencia

[MIT](LICENSE)
