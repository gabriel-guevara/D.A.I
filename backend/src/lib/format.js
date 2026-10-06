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

// Todas las fechas se muestran en hora de Colombia (America/Bogota, UTC-5, sin horario de verano).
const ZONA = 'America/Bogota';
const fmtPartes = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONA, year: 'numeric', month: 'numeric', day: 'numeric',
  hour: 'numeric', minute: '2-digit', hourCycle: 'h23',
});

function partes(d) {
  const o = {};
  for (const p of fmtPartes.formatToParts(new Date(d))) o[p.type] = p.value;
  return { anio: +o.year, mes: +o.month, dia: +o.day, hora: +o.hour % 24, minuto: o.minute };
}

/** "14 Oct 2024" (día en hora de Colombia) */
export function fechaCorta(d) {
  if (!d) return '';
  const p = partes(d);
  return `${pad(p.dia)} ${MESES[p.mes - 1]} ${p.anio}`;
}

/** "15 Ene 2025, 4:42 a. m." (hora de Colombia, formato de 12 horas) */
export function fechaHoraCO(d) {
  if (!d) return '';
  const p = partes(d);
  const h12 = p.hora % 12 || 12;
  return `${fechaCorta(d)}, ${h12}:${p.minuto} ${p.hora < 12 ? 'a. m.' : 'p. m.'}`;
}

/** Alias por compatibilidad: ahora devuelve hora de Colombia, no UTC. */
export const fechaHoraUTC = fechaHoraCO;

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
