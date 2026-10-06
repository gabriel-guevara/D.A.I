const MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
const pad = (n) => String(n).padStart(2, '0');

/** 4404019 -> "4.2 MB" */
export function formatBytes(b) {
  b = Number(b) || 0;
  for (const [u, s] of [['TB', 2 ** 40], ['GB', 2 ** 30], ['MB', 2 ** 20], ['KB', 2 ** 10]]) {
    if (b >= s) {
      const v = b / s;
      return `${Number.isInteger(v) || v >= 100 ? Math.round(v) : v.toFixed(1)} ${u}`;
    }
  }
  return `${b} B`;
}

/** "14 Oct 2024" */
export function fechaCorta(d) {
  if (!d) return '';
  const x = new Date(d);
  return `${pad(x.getUTCDate())} ${MESES[x.getUTCMonth()]} ${x.getUTCFullYear()}`;
}

/** "15 Ene 2025, 09:42 UTC" */
export function fechaHoraUTC(d) {
  if (!d) return '';
  const x = new Date(d);
  return `${fechaCorta(x)}, ${pad(x.getUTCHours())}:${pad(x.getUTCMinutes())} UTC`;
}

/** "Hace 12 min" (corto) o "Hace 12 minutos" (largo). Más de 2 días: fecha corta. */
export function haceCuanto(d, largo = false) {
  if (!d) return '';
  const min = Math.floor((Date.now() - new Date(d).getTime()) / 60_000);
  if (min < 1) return 'Hace instantes';
  if (min < 60) return largo ? `Hace ${min} ${min === 1 ? 'minuto' : 'minutos'}` : `Hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return largo ? `Hace ${h} ${h === 1 ? 'hora' : 'horas'}` : `Hace ${h} h`;
  const dias = Math.floor(h / 24);
  if (dias < 2) return 'Ayer';
  if (dias < 7) return `Hace ${dias} días`;
  return fechaCorta(d);
}

/** "9f8d...d41e" a partir de un SHA-256 completo */
export function hashCorto(h) {
  return h ? `${h.slice(0, 4)}...${h.slice(-4)}` : null;
}

export function iniciales(nombre) {
  const limpio = nombre.replace(/^(Dra?\.|Lic\.|Ing\.|Mtro\.|MSc\.)\s+/i, '');
  return limpio.split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('');
}

/** Escapa % _ \ para usar la entrada del usuario en un ILIKE. */
export const escapeLike = (s) => s.replace(/[\\%_]/g, '\\$&');

/** Valida que un parámetro de ruta sea un id numérico. */
export const idValido = (v) => /^\d{1,18}$/.test(String(v));
