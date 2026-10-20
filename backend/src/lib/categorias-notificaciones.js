/**
 * Qué categorías de notificaciones recibe (y ve) cada rol. Criterio: "recibes avisos de lo que haces o de lo que
 * supervisas". Es la ÚNICA fuente de verdad: todo INSERT de lib/notify.js filtra por ella, y GET /notificaciones
 * también, así que un aviso nunca llega a un rol que no debe verlo aunque quien lo emite se equivoque de destinatarios.
 *
 *  - seguridad: eventos de la propia cuenta (ingresos, bloqueos, contraseña, 2FA). Todos.
 *  - solicitud: solicitudes de movimiento (las crea Cumplimiento; las resuelven Admin y Operador).
 *  - consulta:  quién abrió qué documento (supervisión: Admin y Cumplimiento).
 *  - edicion:   carpetas y movimientos (solo quienes pueden mover: Admin y Operador).
 *  - version:   versiones nuevas o restauradas (las sube el Operador; las supervisa Cumplimiento).
 *  - eliminado: papelera (la operan Admin y Cumplimiento).
 */
export const CATEGORIAS = ['seguridad', 'solicitud', 'consulta', 'edicion', 'version', 'eliminado'];
export const CATEGORIAS_POR_ROL = {
  'super-admin': ['seguridad', 'solicitud', 'consulta', 'edicion', 'version', 'eliminado'],
  compliance: ['seguridad', 'solicitud', 'consulta', 'version', 'eliminado'],
  'ocr-operator': ['seguridad', 'solicitud', 'edicion', 'version'],
  'read-only': ['seguridad'],
};

/** Categorías de un rol (un rol desconocido solo ve las de su propia seguridad). */
export const categoriasDe = (rol) => CATEGORIAS_POR_ROL[rol] ?? ['seguridad'];
/** Roles que admiten una categoría. */
export const rolesCon = (categoria) => Object.keys(CATEGORIAS_POR_ROL).filter((r) => CATEGORIAS_POR_ROL[r].includes(categoria));
