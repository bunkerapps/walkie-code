# Registro de cambios

Acá queda anotado todo lo que va cambiando en Walkie-Code. El proyecto usa [versionado semántico](https://semver.org).

[Read in English](CHANGELOG.md)

## [1.4.0] — 2026-09-20

### Agregado

- **Control remoto de la página proyectada.** En la tele no se puede tocar ni scrollear, así que el teléfono hace de trackpad: arrastrando se mueve un puntero dibujado en la página, un toque hace clic, y manteniendo apretado se pueden arrastrar cosas (por ejemplo, un comparador de antes y después). Abajo hay cuatro teclas para moverse por la página. La página espera las órdenes con una conexión abierta, así que responde sin demora perceptible.
- **Varias fotos de una vez.** Hasta seis de la galería: se suben en paralelo, la pantalla muestra cuántas van y todas las rutas viajan al final del mensaje. Si alguna no sube, no se manda nada.
- **Laboratorio.** Los proyectos creados desde el teléfono nacen en la carpeta `laboratorio` y se ven marcados como PRUEBA. Dentro de uno hay dos acciones más: ascenderlo, que lo saca del laboratorio, y borrarlo, con confirmación, mandándolo a la Papelera. Fuera del laboratorio no se borra ni se mueve nada, y nunca se borra un proyecto con un canal abierto.

### Cambiado

- La tele pasa a tener su propia tecla abajo, con el ícono clásico de transmisión, y abre un panel con el dispositivo, proyectar o sacar, el trackpad y las teclas de scroll. Repetir y silencio también pasan a ícono.

## [1.3.0] — 2026-09-20

### Agregado

- **Proyectar en la tele.** Una página del proyecto sintonizado se puede mostrar en un Chromecast: la Mac publica esa carpeta en la red local, solo mientras dura la proyección, y cada cambio recarga la página en la tele, así se puede desarrollar en vivo en la pantalla grande. La fila TELE proyecta la página más nueva del proyecto y la vuelve a bajar; el dispositivo se elige entre los que hay en la red y queda guardado. También se maneja desde la terminal con `scripts/cast.js`. Necesita `catt`.
- **Proyecto nuevo desde el teléfono.** PROYECTO NUEVO, en el explorador de carpetas, crea una carpeta con una página inicial y abre su propio canal de Claude Code, listo para proyectar.

## [1.2.0] — 2026-09-19

### Agregado

- Las respuestas de otros canales ya no se encimen. Suena un aviso corto, la pantalla muestra "MSJ CH03" y la respuesta queda esperando: se escucha al sintonizar ese canal (tocando el aviso, deslizando o por voz). Una respuesta del canal actual que llega mientras suena otra cosa espera su turno.

### Arreglado

- Las respuestas y los avisos viajan con el id exacto del canal. Antes se ubicaban por el nombre del proyecto, y eso fallaba al renombrar un canal o cuando dos nombres se parecían.

## [1.1.0] — 2026-09-19

### Cambiado

- Botones reorganizados para usar el walkie con una mano:
  - abajo, en la zona del pulgar: repetir, silencio y la cámara a la derecha, donde la ponen las apps de mensajes;
  - arriba, lejos del pulgar: ESC (en rojo, para no interrumpir a Claude sin querer), abrir proyecto y ajustes.
- Los íconos pasan a ser vectoriales y las teclas de arriba tienen un área táctil de 44 px.

### Arreglado

- Cada canal tiene su propio historial en pantalla. Antes, al cambiar de canal, lo del canal nuevo quedaba mezclado debajo de lo del anterior. Al volver a un canal se recupera su historial, sin repetir el título ni el resumen.

## [1.0.0] — 2026-09-19

Primera versión oficial: un walkie-talkie para hablarle a Claude Code desde el iPhone a iTerm2 en la Mac.

### Hablarle a Claude

- Mantener para hablar de verdad, desde una app agregada a la pantalla de inicio. La voz se pasa a texto en la Mac con Whisper (`whisper-server`, large-v3-turbo).
- El texto se escribe en la sesión de iTerm2 sintonizada, solo donde corre Claude Code y nunca en una shell común.
- Lo dictado le pide a Claude respuestas pensadas para escuchar, mediante el hook `UserPromptSubmit`. Lo tipeado en la Mac no cambia.
- Si el dictado queda dudoso, Claude pregunta antes de actuar.
- Fotos: mandar una imagen (cámara, galería o captura) con el próximo mensaje, o sola.

### Escuchar a Claude

- Las respuestas se generan en la Mac con `say` y suenan solo en el teléfono que habló.
- El markdown se limpia para la voz: los bloques de código y las tablas se anuncian y las rutas se acortan.
- Selector de voces con su calidad (premium, mejorada, estándar), velocidad y volumen de voz hasta el 300 %, más un acceso para instalar mejores voces desde Ajustes del Sistema.
- Volumen por separado de cada efecto: apretar, soltar, respuesta y avisos. Los sonidos originales se generan con `scripts/make-sounds.js` y se pueden reemplazar por los propios en `~/.walkie-code/sounds/`.
- Resumen del canal: lo último que se pidió y lo último que respondió Claude, aunque se haya escrito en la Mac. REPETIR lo lee en voz alta.

### Canales

- Cada sesión de iTerm2 con Claude Code es un canal. Se cambia deslizando, por voz ("canal superprecio", "canal tres") o desde la Isla Dinámica.
- La pestaña sintonizada se pinta de naranja en la Mac, con la marca "📻 CH03".
- Nombre propio por canal.
- Abrir Claude Code en cualquier carpeta dentro de `projectsRoot` desde el teléfono, y cerrar un canal desde el teléfono.
- El canal elegido y las respuestas pendientes sobreviven a un reinicio del servidor.

### Permisos y avisos

- Los pedidos de permiso muestran exactamente qué quiere hacer Claude, con los botones APROBAR, SIEMPRE y RECHAZAR (o "sí" y "no" por voz). La respuesta vuelve por el hook `PermissionRequest` como decisión oficial.
- Avisos push con el teléfono bloqueado. Las respuestas que se perdieron se recuperan y suenan al volver desde una notificación.
- Avisos cuando termina una tarea larga en cualquier canal, y aviso de límite de uso con la hora en que se renueva (hook `StopFailure`).
- Barra de vida con el límite de uso de Claude.
- La pantalla bloqueada y la Isla Dinámica muestran el canal y el comienzo de la última respuesta.

### Del lado de la Mac

- Servidor en Node.js sin dependencias npm, corriendo como agente de `launchd` y accesible solo por `tailscale serve`. Web Push implementado con `node:crypto`.
- Walkie Wake: un relay Wake-on-LAN para despertar la Mac desde otro equipo.
- Endurecimiento de seguridad:
  - token de 128 bits comparado en tiempo constante;
  - lista de hosts permitidos contra DNS rebinding;
  - Content-Security-Policy en la página;
  - control de rutas para archivos estáticos, carpetas y transcripciones;
  - caracteres de control quitados antes de escribir en la terminal.

  Ver [SECURITY.md](SECURITY.md).

[1.4.0]: https://github.com/bunkerapps/walkie-code/releases/tag/v1.4.0
[1.3.0]: https://github.com/bunkerapps/walkie-code/releases/tag/v1.3.0
[1.2.0]: https://github.com/bunkerapps/walkie-code/releases/tag/v1.2.0
[1.1.0]: https://github.com/bunkerapps/walkie-code/releases/tag/v1.1.0
[1.0.0]: https://github.com/bunkerapps/walkie-code/releases/tag/v1.0.0
