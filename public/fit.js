// iPhone con la app instalada: con la barra de estado translúcida, iOS le da a la página el alto de la
// pantalla menos la franja de la hora, y abajo queda una banda negra. Se usa el alto real de la pantalla.
// Va en un archivo aparte (y se carga antes que nada) porque la CSP no deja scripts dentro del HTML.
if (navigator.standalone) document.documentElement.style.setProperty('--app-height', `${screen.height}px`);
