import { isDevMode } from '@angular/core';

/**
 * URL base de la API (único lugar donde se define).
 *  - Desarrollo (`ng serve`):      '/api'  → proxy.conf.json la redirige a http://localhost:3000
 *  - Producción (GitHub Pages + Render): 'https://d-a-i.onrender.com/api'
 * isDevMode() es true en `ng serve` y false en el build de producción, así no hay que editar este
 * archivo antes de desplegar ni se corre el riesgo de que el front local hable con la API de producción.
 */
export const API_URL = isDevMode() ? '/api' : 'https://d-a-i.onrender.com/api';
