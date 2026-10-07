import { Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute, Router } from '@angular/router';
import { Barraizq } from '../barraizq/barraizq';
import { Navbar } from '../navbar/navbar';
import { ApiService } from '../../shared/api';
import { AuthService } from '../../shared/auth';

type Tab = 'crear' | 'modificar';
type Modo = 'crear' | 'editar';

interface UsuarioFila {
  id: string;
  name: string;
  email: string;
  initials: string;
  avatarColor: string;
  departamento: string;
  rol: string;
  rolLabel: string;
  mfaMethod: string;
  nivel: string;
  activo: boolean;
  ultimoAcceso: string;
}

interface Catalogos {
  departamentos: { id: number; nombre: string }[];
  niveles: { id: number; nombre: string; rango: number }[];
  roles: { id: number; clave: string; nombre: string }[];
}

interface FormUsuario {
  nombre: string;
  email: string;
  password: string;
  rol: string;
  departamento: string; // '' = sin departamento
  nivel: string;
  mfaMetodo: string;
  activo: boolean;
}

const FORM_VACIO: FormUsuario = {
  nombre: '', email: '', password: '', rol: '', departamento: '', nivel: '', mfaMetodo: 'TOTP', activo: true,
};

const METODOS_2FA = ['TOTP', 'TOTP 2 Dispositivos', 'FIDO2 Yubikey', 'Push OTP Dispositivo', 'SMS Backup', 'eOTP CorpID'];
// Mismas reglas que el servidor: el Oficial de Cumplimiento solo puede crear estos roles
const ROLES_CUMPLIMIENTO = ['ocr-operator', 'read-only'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

@Component({
  selector: 'app-usuarios-gestion',
  standalone: true,
  imports: [CommonModule, FormsModule, Barraizq, Navbar],
  templateUrl: './usuarios.html',
})
export class UsuariosGestion {
  private api = inject(ApiService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private auth = inject(AuthService);

  metodos2fa = METODOS_2FA;

  tab = signal<Tab>('crear');
  catalogos = signal<Catalogos | null>(null);
  usuarios = signal<UsuarioFila[]>([]);
  cargandoUsuarios = signal(false);
  errorCarga = signal('');
  busqueda = signal('');
  seleccionado = signal<UsuarioFila | null>(null);

  formCrear = signal<FormUsuario>({ ...FORM_VACIO });
  formEditar = signal<FormUsuario>({ ...FORM_VACIO });
  verPassword = signal(false);
  guardando = signal(false);
  mensajeOk = signal('');
  mensajeError = signal('');

  /** Solo el Super Administrador modifica usuarios (el servidor lo exige igualmente). */
  esSuperAdmin = computed(() => this.auth.currentUser()?.rolClave === 'super-admin');

  private miRango = computed(() => {
    const nivel = this.auth.currentUser()?.nivel;
    return this.catalogos()?.niveles.find((n) => n.nombre === nivel)?.rango ?? 0;
  });

  /** Roles y niveles que el usuario actual puede asignar. */
  rolesDisponibles = computed(() => {
    const roles = this.catalogos()?.roles ?? [];
    return this.esSuperAdmin() ? roles : roles.filter((r) => ROLES_CUMPLIMIENTO.includes(r.clave));
  });
  nivelesDisponibles = computed(() => {
    const niveles = this.catalogos()?.niveles ?? [];
    return this.esSuperAdmin() ? niveles : niveles.filter((n) => n.rango <= this.miRango());
  });

  usuariosFiltrados = computed(() => {
    const t = this.busqueda().trim().toLowerCase();
    return this.usuarios().filter((u) => !t || u.name.toLowerCase().includes(t) || u.email.toLowerCase().includes(t));
  });

  /** Editando la propia cuenta: no se permite cambiarse el rol ni desactivarse. */
  esMiCuenta = computed(() => {
    const sel = this.seleccionado();
    const yo = this.auth.currentUser()?.email;
    return !!sel && !!yo && sel.email.toLowerCase() === yo.toLowerCase();
  });

  constructor() {
    const q = this.route.snapshot.queryParamMap;
    if (q.get('tab') === 'modificar' && this.esSuperAdmin()) this.tab.set('modificar');

    this.api.catalogos<Catalogos>().subscribe({
      next: (c) => this.catalogos.set(c),
      error: () => this.mensajeError.set('No se pudieron cargar los roles, niveles y departamentos.'),
    });

    // La lista de usuarios solo hace falta para modificar
    if (this.esSuperAdmin()) this.cargarUsuarios(q.get('id'));
  }

  // ------------------------------------------------------------------ navegación
  volver(): void {
    this.router.navigate(['/roles']);
  }

  setTab(t: Tab): void {
    if (t === 'modificar' && !this.esSuperAdmin()) return;
    this.tab.set(t);
    this.limpiarMensajes();
  }

  private limpiarMensajes(): void {
    this.mensajeOk.set('');
    this.mensajeError.set('');
  }

  // ------------------------------------------------------------------ datos
  private cargarUsuarios(seleccionarId?: string | null): void {
    this.cargandoUsuarios.set(true);
    this.api.usuarios<UsuarioFila[]>().subscribe({
      next: (lista) => {
        this.usuarios.set(lista);
        this.cargandoUsuarios.set(false);
        const id = seleccionarId ?? this.seleccionado()?.id;
        const fila = id ? lista.find((u) => u.id === id) : undefined;
        if (fila) this.seleccionar(fila, false);
      },
      error: (err: HttpErrorResponse) => {
        this.cargandoUsuarios.set(false);
        this.errorCarga.set(err.status === 403 ? 'No tienes permisos para ver los usuarios.' : 'No se pudo cargar la lista de usuarios.');
      },
    });
  }

  seleccionar(u: UsuarioFila, limpiar = true): void {
    if (limpiar) this.limpiarMensajes();
    this.seleccionado.set(u);
    this.formEditar.set({
      nombre: u.name,
      email: u.email,
      password: '',
      rol: u.rol,
      departamento: u.departamento === '—' ? '' : u.departamento,
      nivel: u.nivel,
      mfaMetodo: u.mfaMethod,
      activo: u.activo,
    });
    this.verPassword.set(false);
  }

  /** Los métodos 2FA del catálogo, más el actual del usuario si no estuviera en la lista. */
  opciones2fa(actual: string): string[] {
    return actual && !METODOS_2FA.includes(actual) ? [...METODOS_2FA, actual] : METODOS_2FA;
  }

  // ------------------------------------------------------------------ formularios
  parche(modo: Modo, cambios: Partial<FormUsuario>): void {
    (modo === 'crear' ? this.formCrear : this.formEditar).update((f) => ({ ...f, ...cambios }));
  }

  generarPassword(modo: Modo): void {
    const letras = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    const numeros = '23456789';
    const todos = letras + numeros + '!@#$%&*';
    const azar = (n: number) => {
      const a = new Uint32Array(1);
      crypto.getRandomValues(a);
      return a[0] % n;
    };
    const chars = [letras[azar(letras.length)], numeros[azar(numeros.length)]];
    while (chars.length < 12) chars.push(todos[azar(todos.length)]);
    for (let i = chars.length - 1; i > 0; i--) {
      const j = azar(i + 1);
      [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    this.parche(modo, { password: chars.join('') });
    this.verPassword.set(true); // se muestra para que el administrador pueda comunicársela al usuario
  }

  private validar(f: FormUsuario, crear: boolean): string | null {
    const nombre = f.nombre.trim();
    if (nombre.length < 2 || nombre.length > 120) return 'El nombre debe tener entre 2 y 120 caracteres.';
    if (!EMAIL_RE.test(f.email.trim())) return 'Ingrese un correo institucional válido.';
    if (crear || f.password) {
      if (f.password.length < 8 || f.password.length > 72) return 'La contraseña debe tener entre 8 y 72 caracteres.';
      if (!/[A-Za-z]/.test(f.password) || !/\d/.test(f.password)) return 'La contraseña debe incluir al menos una letra y un número.';
    }
    if (!f.rol) return 'Seleccione un rol.';
    if (!f.nivel) return 'Seleccione un nivel de confidencialidad.';
    return null;
  }

  private textoError(err: HttpErrorResponse): string {
    if (err.status === 0) return 'No se pudo conectar con el servidor. Inténtelo de nuevo en unos segundos.';
    return err.error?.error ?? 'No se pudo completar la operación.';
  }

  // ------------------------------------------------------------------ acciones
  crearUsuario(): void {
    const f = this.formCrear();
    const error = this.validar(f, true);
    this.limpiarMensajes();
    if (error) return this.mensajeError.set(error);

    this.guardando.set(true);
    this.api
      .crearUsuario({
        nombre: f.nombre.trim(),
        email: f.email.trim(),
        password: f.password,
        rol: f.rol,
        nivel: f.nivel,
        departamento: f.departamento || null,
        mfaMetodo: f.mfaMetodo,
      })
      .subscribe({
        next: () => {
          this.guardando.set(false);
          this.mensajeOk.set(`Usuario «${f.nombre.trim()}» creado. Ya puede iniciar sesión con la contraseña inicial.`);
          this.formCrear.set({ ...FORM_VACIO });
          this.verPassword.set(false);
          if (this.esSuperAdmin()) this.cargarUsuarios();
        },
        error: (err: HttpErrorResponse) => {
          this.guardando.set(false);
          this.mensajeError.set(this.textoError(err));
        },
      });
  }

  guardarCambios(): void {
    const sel = this.seleccionado();
    if (!sel) return;
    const f = this.formEditar();
    const error = this.validar(f, false);
    this.limpiarMensajes();
    if (error) return this.mensajeError.set(error);

    // Solo se envía lo que realmente cambió
    const cambios: Record<string, unknown> = {};
    if (f.nombre.trim() !== sel.name) cambios['nombre'] = f.nombre.trim();
    if (f.email.trim() !== sel.email) cambios['email'] = f.email.trim();
    if (f.rol !== sel.rol) cambios['rol'] = f.rol;
    if (f.nivel !== sel.nivel) cambios['nivel'] = f.nivel;
    if (f.mfaMetodo !== sel.mfaMethod) cambios['mfaMetodo'] = f.mfaMetodo;
    if (f.activo !== sel.activo) cambios['activo'] = f.activo;
    if (f.departamento !== (sel.departamento === '—' ? '' : sel.departamento)) cambios['departamento'] = f.departamento || null;
    if (f.password) cambios['password'] = f.password;

    if (Object.keys(cambios).length === 0) return this.mensajeError.set('No hay cambios que guardar.');

    this.guardando.set(true);
    this.api.modificarUsuario(sel.id, cambios).subscribe({
      next: () => {
        this.guardando.set(false);
        this.mensajeOk.set(`Cambios guardados en «${f.nombre.trim()}».`);
        this.cargarUsuarios(sel.id); // recarga la lista y vuelve a seleccionar al mismo usuario
      },
      error: (err: HttpErrorResponse) => {
        this.guardando.set(false);
        this.mensajeError.set(this.textoError(err));
      },
    });
  }

  descartarCambios(): void {
    const sel = this.seleccionado();
    if (sel) this.seleccionar(sel);
  }
}
