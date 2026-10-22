# Product

DAI — Sistema de Digitalización y Almacenamiento de Información.

## Platform

web

## Stack

Angular 22 (componentes standalone, signals, control flow `@if/@for`), Tailwind CSS 4 vía `@tailwindcss/postcss`, Vitest. El frontend vive en `src/app/Componentes`; los servicios de API, autenticación y guardas están en `src/app/shared` y no forman parte del trabajo visual.

## Users

Personal administrativo de la organización (Colombia): operadores de digitalización/OCR, lectores, oficiales de cumplimiento y super administradores. Usan DAI a diario, en escritorio, durante jornadas largas.

## Product Purpose

Gestión documental: digitalizar expedientes en PDF, organizarlos en carpetas, buscarlos por texto y metadatos, controlar versiones, verificar su integridad (SHA-256), gestionar la papelera con retención legal y administrar usuarios, roles y niveles de confidencialidad.

## Positioning

Herramienta de trabajo institucional y de cumplimiento: confianza, trazabilidad (auditoría) y control de acceso por nivel.

## Operating Context

Oficina, pantallas de escritorio, uso prolongado. Español de Colombia (fechas y separador de miles `es-CO`). Prioridad: lectura cómoda de tablas, listas y formularios.

## Capabilities and Constraints

- Los permisos los decide el servidor; la interfaz solo adapta lo que muestra.
- Algunas clases de color (etiquetas, avatares) llegan desde la base de datos como clases Tailwind.
- Presupuesto inicial de paquete: 500 kB (las pantallas pesadas se cargan en diferido).

## Brand Commitments

- Logo DAI: azul marino `#004583` y celeste `#009ddd`.
- Tono pedido por el usuario: empresarial y moderno, con toques creativos; comodidad visual; tipografía y tamaños fáciles de leer; iconos coherentes entre sí; modo claro y oscuro.

## Evidence on Hand

- Logos en `public/Dai.svg` y `public/logotipo.svg`.
- Decisiones confirmadas por el usuario (oct. 2026): paleta "Marino y celeste", tipografía IBM Plex Sans, modo oscuro incluido, usuarios administrativos de escritorio.

## Product Principles

- La herramienta desaparece en la tarea: consistencia por encima de sorpresa.
- Cada dato con su contexto real (nada de cifras o paneles inventados).
- Acciones irreversibles con confirmación explícita y segundo factor.

## Accessibility & Inclusion

Contraste AA en ambos temas, foco visible con teclado, textos de 12 px como mínimo, `aria-*` y roles existentes preservados, respeto de `prefers-reduced-motion`.
