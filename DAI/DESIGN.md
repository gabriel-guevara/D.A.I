---
name: DAI · Gestión Documental
description: Sistema de Digitalización y Almacenamiento de Información; herramienta institucional de trabajo diario, en modo claro y oscuro.
colors:
  brand: "#004583"
  on-brand: "#ffffff"
  accent: "#0077b6"
  accent-hover: "#00629a"
  on-accent: "#ffffff"
  accent-soft: "#e6f2fa"
  accent-ink: "#005a8c"
  canvas: "#f5f0e6"
  surface: "#fffcf5"
  surface-2: "#efe8da"
  sunken: "#f7f2e8"
  overlay: "rgb(11 18 32 / 0.45)"
  ink: "#14213d"
  ink-2: "#3d4558"
  ink-3: "#5f5d58"
  line: "#e4dccc"
  line-strong: "#cfc4b0"
  ok: "#15803d"
  ok-soft: "#e8f5ec"
  ok-ink: "#166534"
  warn: "#b45309"
  warn-soft: "#fdf3e4"
  warn-ink: "#92400e"
  danger: "#b91c1c"
  danger-hover: "#991b1b"
  danger-soft: "#fdecec"
  danger-ink: "#991b1b"
  info: "#0077b6"
  info-soft: "#e6f2fa"
  info-ink: "#005a8c"
  canvas-oscuro: "#0b1220"
  surface-oscuro: "#121b2c"
  surface-2-oscuro: "#0f1726"
  sunken-oscuro: "#0d1524"
  ink-oscuro: "#e6ecf3"
  ink-2-oscuro: "#b4c0d0"
  ink-3-oscuro: "#8a99ad"
  line-oscuro: "#233047"
  line-strong-oscuro: "#33425c"
  brand-oscuro: "#0e3a66"
  brand-ink-oscuro: "#7cc4f0"
  accent-oscuro: "#38b6f0"
  accent-hover-oscuro: "#6ccaf5"
  on-accent-oscuro: "#08111f"
  accent-soft-oscuro: "rgb(56 182 240 / 0.14)"
  accent-ink-oscuro: "#8fd6f7"
  ok-oscuro: "#4ade80"
  warn-oscuro: "#f59e0b"
  danger-oscuro: "#f87171"
typography:
  display:
    fontFamily: "IBM Plex Sans, ui-sans-serif, system-ui, Segoe UI, sans-serif"
    fontSize: "1.75rem"
    fontWeight: 600
    lineHeight: "2.2rem"
    letterSpacing: "-0.01em"
  headline:
    fontFamily: "IBM Plex Sans, ui-sans-serif, system-ui, Segoe UI, sans-serif"
    fontSize: "1.375rem"
    fontWeight: 600
    lineHeight: "1.8rem"
    letterSpacing: "-0.01em"
  title-lg:
    fontFamily: "IBM Plex Sans, ui-sans-serif, system-ui, Segoe UI, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: "1.6rem"
  title:
    fontFamily: "IBM Plex Sans, ui-sans-serif, system-ui, Segoe UI, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: "1.5rem"
  body:
    fontFamily: "IBM Plex Sans, ui-sans-serif, system-ui, Segoe UI, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: "1.375rem"
  body-sm:
    fontFamily: "IBM Plex Sans, ui-sans-serif, system-ui, Segoe UI, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: "1.25rem"
  label:
    fontFamily: "IBM Plex Sans, ui-sans-serif, system-ui, Segoe UI, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 500
    lineHeight: "1.25rem"
  caption:
    fontFamily: "IBM Plex Sans, ui-sans-serif, system-ui, Segoe UI, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: "1.1rem"
  mono:
    fontFamily: "IBM Plex Mono, ui-monospace, Cascadia Mono, Consolas, monospace"
    fontSize: "0.9em"
    fontWeight: 400
    letterSpacing: "0.01em"
rounded:
  md: "6px"
  lg: "10px"
  xl: "14px"
  full: "999px"
spacing:
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "5": "20px"
  "6": "24px"
  "8": "32px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0 14px"
    height: "36px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
  button-brand:
    backgroundColor: "{colors.brand}"
    textColor: "{colors.on-brand}"
    rounded: "{rounded.md}"
    padding: "0 14px"
    height: "44px"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "0 14px"
    height: "36px"
  button-secondary-hover:
    backgroundColor: "{colors.sunken}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.md}"
    padding: "0 14px"
    height: "36px"
  button-ghost-hover:
    backgroundColor: "{colors.sunken}"
    textColor: "{colors.ink}"
  button-danger:
    backgroundColor: "{colors.danger}"
    textColor: "#ffffff"
    rounded: "{rounded.md}"
    padding: "0 14px"
    height: "36px"
  button-danger-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.danger}"
    rounded: "{rounded.md}"
  button-sm:
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "30px"
  button-icon:
    rounded: "{rounded.md}"
    width: "36px"
    height: "36px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "7px 12px"
    height: "36px"
  input-disabled:
    backgroundColor: "{colors.sunken}"
    textColor: "{colors.ink-3}"
  panel:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
  panel-header:
    padding: "14px 20px"
  badge:
    backgroundColor: "{colors.sunken}"
    textColor: "{colors.ink-2}"
    typography: "{typography.caption}"
    rounded: "{rounded.full}"
    padding: "2px 8px"
  badge-accent:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.accent-ink}"
  badge-ok:
    backgroundColor: "{colors.ok-soft}"
    textColor: "{colors.ok-ink}"
  badge-warn:
    backgroundColor: "{colors.warn-soft}"
    textColor: "{colors.warn-ink}"
  badge-danger:
    backgroundColor: "{colors.danger-soft}"
    textColor: "{colors.danger-ink}"
  badge-count:
    backgroundColor: "{colors.danger}"
    textColor: "#ffffff"
    rounded: "{rounded.full}"
    padding: "0 6px"
  chip:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink-2}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    padding: "4px 10px"
  chip-active:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.accent-ink}"
  tabs:
    backgroundColor: "{colors.surface-2}"
    rounded: "{rounded.lg}"
    padding: "4px"
  tab:
    textColor: "{colors.ink-3}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "6px 12px"
  tab-active:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
  table-head:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.ink-3}"
    typography: "{typography.caption}"
    padding: "10px 16px"
  table-cell:
    textColor: "{colors.ink-2}"
    typography: "{typography.body}"
    padding: "10px 16px"
  alert-info:
    backgroundColor: "{colors.info-soft}"
    textColor: "{colors.info-ink}"
    rounded: "{rounded.md}"
    padding: "10px 14px"
  alert-danger:
    backgroundColor: "{colors.danger-soft}"
    textColor: "{colors.danger-ink}"
    rounded: "{rounded.md}"
    padding: "10px 14px"
  dialog:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.xl}"
    padding: "24px"
  menu:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
    padding: "4px"
  menu-item:
    textColor: "{colors.ink-2}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "8px 10px"
  meter:
    backgroundColor: "{colors.surface-2}"
    rounded: "{rounded.full}"
    height: "6px"
  sidebar:
    backgroundColor: "{colors.surface-2}"
    width: "256px"
  sidebar-item-active:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    height: "40px"
  navbar:
    backgroundColor: "{colors.surface}"
    height: "64px"
  avatar:
    backgroundColor: "{colors.brand}"
    textColor: "{colors.on-brand}"
    rounded: "{rounded.full}"
    size: "36px"
---

# Design System: DAI · Gestión Documental

## Overview

**Creative North Star: "El Archivo en Orden"**

DAI es una herramienta institucional que se usa todo el día, en escritorio, por personal administrativo que digitaliza, busca, versiona y audita expedientes. El sistema visual parte de ahí: un archivo bien llevado, donde cada cosa está en su sitio, con su folio y su estado a la vista. El azul marino del logo pone la firma institucional y el celeste marca la acción; todo lo demás es papel, tinta y renglón. La herramienta desaparece en la tarea: la consistencia pesa más que la sorpresa.

La densidad es de aplicación de trabajo, no de sitio de marketing. El cuerpo es de 14 px, las filas de tabla son compactas, los paneles son planos y bordeados, y la jerarquía viene del peso tipográfico y de la tinta (tres tonos de texto) antes que del color. Los datos llevan su contexto real: cifras tabulares, folios y hashes en monoespaciada, estados en insignias semánticas. Hay dos temas completos, claro y oscuro, que comparten las mismas variables semánticas; ninguna pantalla decide colores por su cuenta.

El único gesto expresivo de marca vive en la pantalla de acceso: un panel marino con renglones de archivo y dos láminas translúcidas giradas, como hojas apiladas. Dentro de la aplicación ese gesto no se repite; ahí manda la tarea.

**Key Characteristics:**
- Marino institucional para la firma (marca, avatar, acceso); celeste para la acción, el foco y el estado activo.
- Superficies planas con borde de 1 px; la sombra queda solo para lo que flota (menús, diálogos, paneles laterales).
- Escala tipográfica fija (ratio ~1,2) en IBM Plex Sans, nada por debajo de 12 px; IBM Plex Mono para folios, códigos y hashes.
- Una sola familia de iconos de trazo (rejilla de 24, trazo 1,75, puntas redondeadas).
- Modo claro y oscuro con las mismas variables semánticas, sin parpadeo al cargar.

## Colors

Paleta "Marino y celeste", derivada del logo: neutros fríos con sesgo azul, un marino de firma, un celeste de acción y cuatro estados semánticos, cada uno en trío (sólido / suave / tinta).

### Primary
- **Marino Institucional** (`brand`): el azul del logo. Va en el panel de acceso, en el botón de acción de entrada (Continuar, Verificar) y en el avatar de iniciales. En oscuro baja a un marino más profundo (`brand-oscuro`) y su versión para texto y barras pasa a un celeste claro (`brand-ink-oscuro`).
- **Celeste de Acción** (`accent`, hover `accent-hover`): el celeste del logo oscurecido hasta cumplir AA sobre blanco (el `#009ddd` original no llega a 4,5:1 con texto blanco). Botón primario, foco del teclado, cursor de texto, casillas, barras de progreso, icono del ítem activo de la barra lateral. En oscuro sube a `accent-oscuro` con texto casi negro (`on-accent-oscuro`).
- **Celeste Suave / Tinta Celeste** (`accent-soft`, `accent-ink`): fondo y texto de selección, resaltado de búsqueda (`mark`), chips activos, insignias de acento y enlaces.

### Neutral
- **Lienzo** (`canvas`): fondo de página detrás de todo.
- **Hoja** (`surface`): paneles, campos, diálogos, menús, barra superior.
- **Bandeja** (`surface-2`): barra lateral, cabeceras de tabla, rieles de pestañas y medidores, fondos de iconos de fila.
- **Hundido** (`sunken`): estado hover de filas, botones secundarios y fantasma; fondo de campos deshabilitados y del buscador de la barra superior.
- **Tinta** (`ink`, `ink-2`, `ink-3`): texto principal, texto secundario de celdas y etiquetas, y texto de ayuda / placeholder / iconos en reposo. `ink-3` es el piso de contraste AA; no hay un cuarto tono más claro.
- **Renglón** (`line`, `line-strong`): bordes de paneles y divisores (`line`); bordes de campos, chips y botón secundario (`line-strong`).
- **Velo** (`overlay`): fondo detrás de diálogos y paneles laterales.

### Estados
- **Correcto** (`ok`), **Advertencia** (`warn`), **Peligro** (`danger`), **Información** (`info`, igual al acento). Cada uno con `-soft` para fondos de insignias y avisos y `-ink` para su texto. En oscuro los fondos suaves pasan a translúcidos (12–14 % de opacidad del sólido) y la tinta a tonos claros.

### Named Rules
**The Semantic-Only Rule.** Las pantallas usan solo los colores semánticos (`bg-surface`, `text-ink-3`, `border-line`, `bg-accent`…). Nunca la paleta cruda de Tailwind ni hex sueltos. La única excepción son las clases que la base de datos entrega para etiquetas y avatares; esas se listan en `@source inline` y tienen su reasignación oscura en `styles.css`.

**The Two Blues Rule.** El marino firma, el celeste actúa. Un botón que ejecuta una tarea dentro de la aplicación es celeste; el marino queda para la identidad (acceso, avatar) y no compite con la acción.

**The Trio Rule.** Todo estado se expresa con su trío: sólido para la señal (icono, contador, barra), suave para el fondo, tinta para el texto. Nunca texto sólido sobre fondo suave del mismo color.

## Typography

**Display Font:** IBM Plex Sans (con ui-sans-serif, system-ui, Segoe UI)
**Body Font:** IBM Plex Sans
**Label/Mono Font:** IBM Plex Mono (con ui-monospace, Cascadia Mono, Consolas)

**Character:** Una grotesca institucional con oficio técnico: legible en tablas largas, sobria sin ser fría. La monoespaciada de la misma familia trata folios, hashes y códigos como dato, no como adorno. Pesos cargados: Sans 400/500/600/700, Mono 400/500.

### Hierarchy
- **Display** (600, 28 px, 35 px): saludo del panel de inicio, título "Acceso" y cifras grandes de indicadores (con `tabular-nums`).
- **Headline** (600, 22 px, 29 px): título de página (`page-title`) en todas las pantallas de trabajo.
- **Title Large** (600, 18 px): títulos de paneles laterales y diálogos.
- **Title** (600, 16 px, 24 px): título de panel (`panel-title`).
- **Body** (400, 14 px, 22 px): texto base, celdas de tabla, campos, botones (500), subtítulo de página en `ink-3`.
- **Body Small / Label** (400–500, 13 px, 20 px): etiquetas de formulario (500, `ink-2`), chips, pestañas, metadatos de filas.
- **Caption** (500–600, 12 px): insignias, cabeceras de tabla (600, `ink-3`, +0,02em), texto de ayuda. Es el mínimo absoluto.
- **Mono** (400, 0,9em, +0,01em): folios, formatos, hashes, claves 2FA y códigos de recuperación; en campos de código, con espaciado amplio.

### Named Rules
**The 12px Floor Rule.** Nada se compone por debajo de 12 px. La escala es fija (12 / 13 / 14 / 16 / 18 / 22 / 28); no hay tamaños fluidos ni intermedios.

**The Tabular Rule.** Toda cifra que se compara (tablas, indicadores, contadores, tamaños) usa números tabulares.

**The Mono Means Data Rule.** La monoespaciada solo aparece en identificadores y códigos que el usuario lee, copia o teclea. No es una voz decorativa.

## Layout

Armazón fijo para todas las pantallas autenticadas: `min-h-screen` sobre el lienzo, en fila: barra lateral fija a la altura de la ventana + columna flexible con la barra superior pegajosa y el `main`. El contenido se centra con un ancho máximo de 1440 px; el relleno del `main` crece con el viewport (16 → 24 → 32 px horizontal; 24 → 32 px vertical). Cada pantalla abre con un `header` que alinea a la izquierda el título de página y su subtítulo y a la derecha las acciones (con salto de línea si no caben).

- **Barra lateral:** 256 px con icono y texto desde `lg`; por debajo se reduce a 64 px de solo iconos (cada enlace conserva su nombre en `title` y `aria-label`).
- **Barra superior:** 64 px, buscador flexible (máx. ~576 px) y un grupo derecho que nunca se encoge: en pantallas estrechas se ocultan los textos, no los botones.
- **Ritmo:** base de 4 px. 24 px entre bloques de página, 20 px de relleno interno de paneles, 12 px y 8 px dentro de grupos. Las rejillas de paneles usan 24 px de separación (`xl:grid-cols-3`, el principal ocupa dos columnas).
- **Indicadores:** una sola franja dividida por líneas de 1 px (rejilla con `gap-px` sobre el color de renglón), no tarjetas sueltas.
- **Acceso:** rejilla de dos columnas desde `lg` (panel de marca flexible + formulario de 440–560 px); debajo de `lg`, solo el formulario con el logo encima.
- **Diálogos:** 448–512 px de ancho con 24 px de relleno; los paneles laterales (auditoría) entran desde la derecha a 448 px.

## Elevation & Depth

El sistema es plano y se lee por capas tonales: lienzo → hoja → bandeja/hundido, separadas por bordes de 1 px. La sombra no da jerarquía a lo que está en reposo; solo marca lo que flota sobre la página. La barra superior usa la hoja al 90 % con desenfoque suave para que el contenido pase por debajo sin perder legibilidad.

### Shadow Vocabulary
- **Flotante** (`shadow-float`, claro: `0 8px 24px -6px rgb(20 33 61 / 0.18), 0 2px 6px -2px rgb(20 33 61 / 0.1)`; oscuro: `0 12px 32px -8px rgb(0 0 0 / 0.6), 0 2px 8px -2px rgb(0 0 0 / 0.4)`): menús contextuales, diálogos, paneles laterales y capas `.floating`.
- **Pestaña elevada** (`0 1px 2px rgb(0 0 0 / 0.08)`): la pestaña seleccionada dentro de su riel y, con 0,06, el ítem activo de la barra lateral.

### Named Rules
**The Flat-At-Rest Rule.** Paneles, tablas, tarjetas de fila e indicadores no llevan sombra. Si algo necesita destacarse en reposo, se usa tinta, peso o un borde, nunca una sombra.

## Shapes

Esquinas suavemente redondeadas y uniformes: 6 px para controles (botones, campos, ítems de menú, avisos, esqueletos), 10 px para contenedores (paneles, menús, rieles de pestañas), 14 px para diálogos y círculo completo para insignias, chips, medidores, avatares y el contenedor del icono de estado vacío. Bordes siempre de 1 px. Los iconos siguen la misma geometría: trazos redondeados, rectángulos con radio 1–2 en una rejilla de 24.

## Components

### Buttons
Discretos y firmes: altura fija, peso 500, nada de sombras.
- **Shape:** esquinas suaves (6 px); 36 px de alto, 14 px laterales; `btn-sm` 30 px; `btn-icon` cuadrado de 36 px. Icono a la izquierda del texto con 8 px de separación (16–17 px de tamaño).
- **Primary:** celeste de acción con texto blanco (casi negro en oscuro). Una acción principal por zona.
- **Brand:** marino institucional, solo en el flujo de acceso (44 px de alto, ancho completo); hover aclara un 12 %.
- **Secondary:** hoja con borde fuerte y texto de tinta; los iconos de las acciones rápidas van en celeste.
- **Ghost:** transparente con `ink-2`; hover a hundido. Para acciones de barra (tema, cerrar, volver).
- **Danger / Danger Ghost:** rojo sólido para confirmar; fantasma rojo para iniciar una acción destructiva, que siempre pasa por una confirmación en línea ("¿Enviar a la papelera? Sí / No") o un diálogo.
- **States:** transición de 150 ms con `cubic-bezier(0.22, 1, 0.36, 1)`; al presionar baja 0,5 px; deshabilitado al 50 % con cursor prohibido; foco visible con contorno celeste de 2 px separado 2 px.

### Chips
- **Style:** píldora con borde fuerte, hoja de fondo, 13 px peso 500.
- **State:** activo (`aria-pressed`) pasa a celeste suave sin borde con tinta celeste. Se usan como filtros.

### Cards / Containers
- **Corner Style:** 10 px.
- **Background:** hoja sobre lienzo.
- **Shadow Strategy:** ninguna en reposo (ver Elevation & Depth).
- **Border:** 1 px `line`; la cabecera del panel se separa con otro renglón.
- **Internal Padding:** cabecera 14 × 20 px; cuerpo 20 px. Las listas dentro del panel van a sangre con divisores y filas de 12 × 20 px.

### Inputs / Fields
- **Style:** hoja, borde fuerte de 1 px, 6 px de radio, 36 px de alto (44 px en el acceso), icono interior a 12 px del borde cuando aplica.
- **Focus:** borde celeste + halo de 3 px en celeste suave (sustituye al contorno).
- **Error / Disabled:** `aria-invalid` pinta el borde de peligro; deshabilitado en hundido con texto `ink-3`. Etiqueta encima (13 px, 500, `ink-2`), ayuda debajo (12 px, `ink-3`). El select usa el mismo chevrón de la familia de iconos.
- **Código 2FA:** seis casillas de 48 px, centradas, en mono 22 px semibold.

### Navigation
- **Barra lateral:** fondo bandeja con renglón derecho; marca arriba (logo en recuadro blanco de 40 px, "DAI" + "Gestión documental"). Ítems de 40 px, 14 px: en reposo `ink-2` con icono `ink-3`; hover a hundido; activo en hoja con anillo de renglón, sombra mínima, semibold e icono celeste, con `aria-current="page"`. Contador de no leídos como insignia roja.
- **Barra superior:** pegajosa, 64 px, hoja translúcida; buscador hundido con lupa a la izquierda; acción "Nuevo Documento" primaria; alternador de tema (sol/luna); avatar marino de 36 px con iniciales, nombre y rol; cerrar sesión como botón de icono que se tiñe de peligro al pasar.

### Tablas
Cabecera pegajosa en bandeja, 12 px semibold `ink-3`; celdas de 10 × 16 px en `ink-2`, divididas por renglones; hover de fila a hundido (120 ms). Cifras tabulares.

### Insignias y avisos
Insignia: píldora de 12 px peso 500, neutra (hundido + borde) o en trío semántico sin borde, con icono opcional de 12–13 px. Aviso: bloque de 6 px de radio, icono arriba a la izquierda, fondo suave, tinta del estado y borde al 25 % del sólido.

### Diálogos, menús y paneles laterales
Diálogo sobre velo, 14 px de radio, sombra flotante, entrada de 180 ms (sube 6 px y escala desde 0,985). Menú contextual: hoja, 10 px, 4 px de relleno, ítems de 6 px con hover hundido y variante de peligro. Panel lateral de auditoría: pegado a la derecha, 448 px, cabecera con título 18 px y botón de cerrar fantasma.

### Carga y vacío
Esqueletos con barrido entre bandeja y hundido (1,4 s) que imitan la forma final; spinner de 16 px en `currentColor` dentro del botón que espera, con el texto en gerundio ("Verificando…"). Estado vacío centrado: círculo de 44 px en bandeja con el icono, y una frase en `ink-3`.

### Iconos
Una sola familia (`<app-icono nombre="…" [tamano] etiqueta>`): trazos estilo Lucide, rejilla 24, trazo 1,75, puntas y uniones redondeadas, color `currentColor`. Tamaño por defecto 18 px (navegación, títulos de panel); 16–17 px dentro de botones y campos; 12–13 px en insignias. Sin `etiqueta` queda oculto a lectores de pantalla; un icono solo (sin texto) siempre lleva `etiqueta` o `aria-label` en su botón.

Vocabulario: `inicio` (dashboard), `biblioteca`, `buscar`, `digitalizar`, `notificacion`, `papelera`, `roles` (escudo con check), `escudo` (integridad / 2FA), `usuarios`, `usuario`, `usuario-mas`, `candado` (cifrado / contraseña), `llave`, `movil` (app autenticadora), `documento`, `carpeta`, `carpeta-mas`, `mover`, `subir`, `descargar`, `versiones`, `restaurar`, `refrescar`, `ojo` / `ojo-off` (mostrar / ocultar), `salir` (cerrar sesión), `mas`, `cerrar`, `check`, `check-doble` (marcar leídas), `chevron-derecha` / `-izquierda` / `-abajo`, `flecha-derecha` / `-izquierda` (avanzar / volver), `filtro`, `ordenar`, `mas-opciones`, `editar`, `copiar`, `alerta`, `info`, `ayuda`, `sol` / `luna` (tema), `calendario`, `reloj` (tiempo / auditoría), `almacenamiento`, `etiqueta`, `casa` (raíz de carpetas), `cuadricula` / `lista` (vistas), `enlace-externo`, `menu`, `correo`, `firma`.

### Tema claro / oscuro
La clase `dark` en `<html>` cambia todas las variables. Un script en línea en `index.html` la aplica antes de pintar (clave `dai-tema` en `localStorage`, valores `claro` / `oscuro`; sin elección, sigue a `prefers-color-scheme`). El servicio `Tema` la alterna y la recuerda. Los colores que llegan de la base de datos tienen su reasignación oscura (fondos translúcidos, textos claros).

### Panel de marca del acceso (firma)
Solo en la pantalla de acceso, desde `lg`: fondo marino, renglones horizontales blancos cada 32 px al 7 % de opacidad (papel de archivo), y dos láminas de 420 × 520 px con radio de 28 px, bordes blancos al 10–15 % y giros de 6° y −3°, como hojas apiladas. Logo en recuadro blanco, nombre completo del sistema en 28 px. Es decorativo (`aria-hidden`) y no se replica dentro de la aplicación.

## Do's and Don'ts

### Do:
- **Do** usar solo los colores semánticos expuestos por `@theme inline`; así cada pantalla funciona en claro y oscuro sin código extra.
- **Do** abrir cada pantalla de trabajo con el armazón barra lateral + barra superior + `main` a 1440 px y un `header` con título de página (22 px) y subtítulo en `ink-3`.
- **Do** agrupar el contenido en paneles planos de 10 px con borde de 1 px y cabecera de 16 px semibold.
- **Do** expresar los estados con su trío sólido / suave / tinta, en insignias y avisos.
- **Do** escribir folios, formatos, hashes y códigos en IBM Plex Mono y las cifras con números tabulares.
- **Do** usar iconos de `<app-icono>` y nada más; etiquetar los que van solos.
- **Do** confirmar en línea o en diálogo toda acción destructiva, con el botón rojo sólido solo en la confirmación.
- **Do** mantener el foco visible (2 px celeste) y respetar `prefers-reduced-motion`.

### Don't:
- **Don't** usar la paleta cruda de Tailwind (`bg-blue-600`, `text-slate-500`) ni hex en plantillas; la única excepción son las clases que llegan de la base de datos.
- **Don't** poner sombra a paneles, tablas o filas en reposo; `shadow-float` es solo para capas flotantes.
- **Don't** componer texto por debajo de 12 px ni inventar tamaños fuera de la escala.
- **Don't** usar el marino para acciones de trabajo dentro de la aplicación; el botón primario es celeste.
- **Don't** usar el celeste del logo (`#009ddd`) como color de texto o de botón con texto blanco: no cumple AA. Se usa `accent`.
- **Don't** mezclar otras familias de iconos, emojis o glifos de texto como iconos.
- **Don't** llevar los renglones y láminas del panel de acceso a las pantallas de trabajo.
- **Don't** mostrar cifras, gráficos o indicadores sin dato real detrás.
