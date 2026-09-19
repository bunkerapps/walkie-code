# Supervoz

Walkie-talkie para hablarle a Claude Code desde el iPhone. Mantenés el botón, hablás, soltás: el texto se escribe en la sesión de iTerm2 elegida y la respuesta de Claude se escucha en el teléfono.

```
iPhone (miniweb) ──audio──▶ server.js ──▶ whisper-server (voz a texto, local)
                                      └──▶ iTerm2: escribe y envía con Enter
Claude Code ──hook Stop / PermissionRequest──▶ server.js ──say──▶ audio ──SSE──▶ iPhone
Claude Code ──hook UserPromptSubmit──▶ server.js: anota el inicio del turno y, si lo dictó el teléfono, pide "respondé para escuchar"
```

Nada sale de tu red salvo lo que Claude Code ya manda. La transcripción corre en la Mac con Whisper.

## Requisitos

- macOS con iTerm2 y Node 20+
- `brew install whisper-cpp ffmpeg`
- Modelo en `~/.supervoz/models/ggml-large-v3-turbo-q5_0.bin`
  (`curl -L -o ~/.supervoz/models/ggml-large-v3-turbo-q5_0.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin`)
- Tailscale en la Mac y en el iPhone (Safari solo da el micrófono sobre HTTPS)

## Puesta en marcha

1. `node scripts/install-hooks.js` registra los hooks (Stop, PermissionRequest y UserPromptSubmit) en `~/.claude/settings.json`, sin tocar los que ya tenés. Se puede volver a correr cuando se agregan eventos nuevos, y se sacan con `--remove`.
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
- **Respuestas para escuchar**: lo que dictás desde el teléfono le llega a Claude con una instrucción extra para que conteste corto y conversacional, en tu idioma, sin listas largas, tablas ni bloques de código (si hacen falta, los deja en la terminal y los menciona). Lo que tipeás en la Mac no cambia: el hook `UserPromptSubmit` compara el prompt con lo último que se dictó en esa terminal. Si supervoz no responde en 1,5 s, el prompt sigue sin la instrucción. Se apaga con `"voiceStyle": false` y el texto de la instrucción está en `lib/voice-style.js`.
- Si Claude pide un permiso, se escucha el aviso. Respondiendo "sí" o "dale" se aprueba, y con "no" se cancela.
- **Avisos de otros canales**: si una sesión a la que no le hablaste desde el teléfono (por ejemplo, algo que lanzaste desde la Mac antes de irte) termina un turno que duró más de `notifyAfterSeconds` (60 por defecto), todos los teléfonos conectados suenan con un aviso corto ("Terminó superprecio") y el texto completo queda en la pantalla, para tocarlo y leerlo. Si Claude pide permiso en cualquier canal se avisa siempre ("superprecio necesita permiso para usar Bash"); sintonizando ese canal, "sí" o "no" lo contestan. Las respuestas cortas no avisan. El aviso no interrumpe: si estás transmitiendo o escuchando otra cosa, espera; los que llegan al reconectar después de 2 minutos solo se muestran. Se prenden, apagan y ajustan (de 30 s a 30 min) en el panel de VOZ.
- Tocando el **parlante** (VOZ) se elige la voz de las respuestas entre las voces en español instaladas en la Mac, y su velocidad. Se guarda en la configuración.
- La **perilla** de arriba recarga la app.
- **REPETIR** vuelve a leer la última respuesta, **SILENCIO** corta la lectura y **ESC** interrumpe a Claude.
- La pantalla queda encendida mientras la app está abierta. Si el teléfono se bloquea, al volver se recupera lo que llegó mientras tanto.

Configuración en `~/.supervoz/config.json`: puerto, idioma, modelo y vocabulario de ayuda para Whisper, voz de las respuestas (`voice`, ver `say -v '?'`), velocidad (`rate`), si lo dictado pide respuestas para escuchar (`voiceStyle`, por defecto `true`) y avisos de otros canales (`notices`, `notifyAfterSeconds`).

## Desarrollo

`npm test` corre los tests del limpiador de texto (markdown a voz, filtros de Whisper, respuestas de permiso), del explorador de carpetas (que no se pueda salir de la raíz), del reconocimiento de prompts dictados, del instalador de hooks (idempotente, sin tocar hooks ajenos) y de cuándo avisar desde otros canales (`lib/notices.js`).

Sonidos del equipo en `public/sounds`: `ptt.m4a` al apretar, `release.m4a` al soltar, `rx.m4a` cuando llega una respuesta.
