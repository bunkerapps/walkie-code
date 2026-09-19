# Supervoz

Walkie-talkie para hablarle a Claude Code desde el iPhone. Mantenés el botón, hablás, soltás: el texto se escribe en la sesión de iTerm2 elegida y la respuesta de Claude se escucha en el teléfono.

```
iPhone (miniweb) ──audio──▶ server.js ──▶ whisper-server (voz a texto, local)
                                      └──▶ iTerm2: escribe y envía con Enter
Claude Code ──hook Stop / PermissionRequest──▶ server.js ──say──▶ audio ──SSE──▶ iPhone
                                                        └──Web Push──▶ iPhone bloqueado
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
- Tocando el **parlante** (VOZ) se elige la voz de las respuestas entre las voces en español instaladas en la Mac, y su velocidad. Se guarda en la configuración.
- La **perilla** de arriba recarga la app.
- **REPETIR** vuelve a leer la última respuesta, **SILENCIO** corta la lectura y **ESC** interrumpe a Claude.
- La pantalla queda encendida mientras la app está abierta. Si el teléfono se bloquea, al volver se recupera lo que llegó mientras tanto.
- **AVISOS** (arriba, junto a la perilla) activa las notificaciones push: con el teléfono bloqueado o la app en segundo plano, cada respuesta llega como "CLAUDE · proyecto" con el comienzo del texto, y los pedidos de permiso como "Claude necesita permiso para usar Bash". Al tocarla se abre la app. El piloto verde indica que están activas; tocando otra vez se apagan. Al activarlas llega un aviso de prueba.

### Avisos push en el iPhone

Requieren iOS 16.4 o más nuevo y la app **agregada a la pantalla de inicio** (en Safari común no aparecen). Abrí Supervoz desde el ícono, tocá AVISOS y aceptá el permiso. Si alguna vez lo rechazaste, se vuelve a habilitar en Ajustes › Notificaciones › Supervoz.

- El aviso va solo al dispositivo que habló y solo si no tiene la app a la vista: con la app abierta ya suena el audio. La app avisa cuando pasa a segundo plano, y si ese aviso se pierde, a los 25 segundos sin noticias del teléfono se la da por oculta.
- Al volver a la app se borran los avisos pendientes: lo que llegó se recupera en la pantalla.
- Las claves VAPID y las suscripciones se guardan en `~/.supervoz/push.json` (se generan solas la primera vez). Si se borra ese archivo hay que volver a tocar AVISOS. `pushSubject` en la configuración es el contacto que va en la firma VAPID (Apple exige `mailto:` o `https:`).
- El cifrado (RFC 8291) y la firma VAPID (RFC 8292) están hechos con `node:crypto`, sin dependencias.

Configuración en `~/.supervoz/config.json`: puerto, idioma, modelo y vocabulario de ayuda para Whisper, voz de las respuestas (`voice`, ver `say -v '?'`) y velocidad (`rate`).

## Desarrollo

`npm test` corre los tests del limpiador de texto (markdown a voz, filtros de Whisper, respuestas de permiso), del explorador de carpetas (que no se pueda salir de la raíz) y de Web Push (cifrado contra los vectores de la RFC 8291, JWT VAPID, suscripciones y a quién avisar).

Para levantar una segunda instancia sin tocar la real, `SUPERVOZ_HOME=/otra/carpeta npm start` usa esa carpeta en lugar de `~/.supervoz` (con su propio `config.json`, otro `port` y otro `whisperPort`). Ojo: si le conectás un navegador, igual pinta la pestaña de iTerm2 del canal activo.

Sonidos del equipo en `public/sounds`: `ptt.m4a` al apretar, `release.m4a` al soltar, `rx.m4a` cuando llega una respuesta.
