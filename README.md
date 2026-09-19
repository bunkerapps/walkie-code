# Supervoz

Walkie-talkie para hablarle a Claude Code desde el iPhone. Mantenés el botón, hablás, soltás: el texto se escribe en la sesión de iTerm2 elegida y la respuesta de Claude se escucha en el teléfono.

```
iPhone (miniweb) ──audio──▶ server.js ──▶ whisper-server (voz a texto, local)
                                      └──▶ iTerm2: escribe y envía con Enter
Claude Code ──hook Stop / PermissionRequest──▶ server.js ──say──▶ audio ──SSE──▶ iPhone
```

Nada sale de tu red salvo lo que Claude Code ya manda. La transcripción corre en la Mac con Whisper.

## Requisitos

- macOS con iTerm2 y Node 20+
- `brew install whisper-cpp ffmpeg`
- Modelo en `~/.supervoz/models/ggml-large-v3-turbo-q5_0.bin`
  (`curl -L -o ~/.supervoz/models/ggml-large-v3-turbo-q5_0.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin`)
- Tailscale en la Mac y en el iPhone (Safari solo da el micrófono sobre HTTPS)

## Puesta en marcha

1. `node scripts/install-hooks.js` registra los hooks en `~/.claude/settings.json`, sin tocar los que ya tenés. Se sacan con `--remove`.
2. `scripts/service.sh install` lo deja corriendo como servicio de launchd: arranca solo al iniciar sesión y se reinicia si se cae. También sirven `restart`, `status`, `logs` y `uninstall`. Para desarrollo alcanza con `npm start`.
3. Una sola vez: `tailscale up` y después `tailscale serve --bg 8787`. En la consola de Tailscale tienen que estar activados MagicDNS y los certificados HTTPS.
4. En el iPhone abrí `https://<tu-mac>.<tu-tailnet>.ts.net/?t=<token>` (el token está en `~/.supervoz/config.json`) y usá "Agregar a pantalla de inicio".

La primera vez macOS pide permiso de Automatización para que `node` controle iTerm2.

## Uso

- **PTT**: mantener, esperar el bip, hablar y soltar. Se envía solo.
- **Canales**: cada sesión de iTerm2 con Claude Code es un canal. Deslizá la pantalla a la izquierda o a la derecha para cambiar; se anuncia por voz y se muestra de qué trata la sesión. Si no elegiste ninguno, sigue a la terminal activa en la Mac. Las terminales con una shell común no aparecen, para no ejecutar comandos dictados.
- En la Mac, la pestaña del canal sintonizado se pinta de naranja y lleva la marca "📻 CH03" mientras haya un teléfono conectado.
- **＋** abre un explorador de carpetas dentro de `projectsRoot` (por defecto `~/Development`). "ABRIR CLAUDE ACÁ" abre una ventana nueva de iTerm2 con Claude Code en esa carpeta y sintoniza el canal. Si Claude pregunta si confiás en la carpeta, se contesta con "sí".
- **Nombre propio**: manteniendo apretado el nombre del canal en la pantalla se le pone un nombre a esa carpeta (vacío = el de la carpeta). Se guarda en `names` de la configuración y se usa en el walkie, en la voz, en la marca de la Mac y en el explorador.
- Tocando un mensaje de la pantalla se abre completo, con scroll. Mientras Claude piensa, la pantalla muestra el mismo spinner que Claude Code.
- La respuesta suena **solo en el dispositivo que habló**; si la web está abierta en otro lado, ahí solo se ve el texto. Si le hablaste a un canal y cambiaste a otro, la respuesta se anuncia con "Desde <proyecto>".
- Si Claude pide un permiso, se escucha el aviso. Respondiendo "sí" o "dale" se aprueba, y con "no" se cancela.
- Tocando el **parlante** (VOZ) se elige la voz de las respuestas entre las voces en español instaladas en la Mac, y su velocidad. Se guarda en la configuración. La lista va de mejor a peor calidad (▮▮▮ premium, ▮▮▯ mejorada, ▮▯▯ estándar) y al final está **VOZ DEL SISTEMA**, que usa la voz que esté elegida en Ajustes de la Mac.
- **INSTALAR MÁS VOCES** abre en la Mac *Ajustes del Sistema → Accesibilidad → Lectura y voz* y te dice por voz qué tocar: menú *Voz del sistema* → *Administrar voces…* → Español → descargar una voz mejorada o premium. Mientras el panel está abierto la lista se refresca sola, así que la voz nueva aparece cuando termina de bajar.
- La **perilla** de arriba recarga la app.
- **REPETIR** vuelve a leer la última respuesta, **SILENCIO** corta la lectura y **ESC** interrumpe a Claude.
- La pantalla queda encendida mientras la app está abierta. Si el teléfono se bloquea, al volver se recupera lo que llegó mientras tanto.

Configuración en `~/.supervoz/config.json`: puerto, idioma, modelo y vocabulario de ayuda para Whisper, voz de las respuestas (`voice`, ver `say -v '?'`; `"(sistema)"` = la de Ajustes) y velocidad (`rate`).

### Voces mejoradas y premium

- Se descargan solo desde Ajustes: macOS no tiene una forma soportada de bajarlas por línea de comandos (`say` no descarga, `softwareupdate` no las maneja, y el catálogo de `/System/Library/AssetsV2/com_apple_MobileAsset_VoiceServices_*` se usa solamente a través de frameworks privados).
- Una vez instaladas, `say -v '?'` las lista como `Paulina (Mejorada)` o `Mónica (Premium)` (`Enhanced` si la Mac está en inglés), y supervoz las detecta por ese sufijo.
- Las voces de **Siri** no están ni en `say -v` ni en `AVSpeechSynthesizer`. La única vía es elegir una como voz del sistema en Ajustes y usar **VOZ DEL SISTEMA** en el walkie (experimental: `say` sin `-v`).
- Si la voz guardada se desinstala, `say` no falla: lee con la voz del sistema.
- No se agregó AVSpeechSynthesizer como motor: en esta Mac ve las mismas voces que `say`, y la Voz personal le queda denegada a un proceso de línea de comandos.

## Desarrollo

`npm test` corre los tests del limpiador de texto (markdown a voz, filtros de Whisper, respuestas de permiso), del explorador de carpetas (que no se pueda salir de la raíz) y de las voces (parseo de `say -v '?'`, calidades y orden).

Sonidos del equipo en `public/sounds`: `ptt.m4a` al apretar, `release.m4a` al soltar, `rx.m4a` cuando llega una respuesta.
