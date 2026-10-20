import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Dashboard } from './dashboard';
import type { DashboardDatos } from '../../shared/api';

const datos = (almacenamiento: DashboardDatos['almacenamiento']): DashboardDatos => ({
  documentos: { visibles: 1234, altasMes: 7, conArchivo: 30, sinArchivo: 1204, fueraDePlazo: 2 },
  porDepartamento: [{ nombre: 'Legal', color: '', total: 800 }, { nombre: 'Sin departamento', color: '', total: 434 }],
  porFormato: [{ formato: 'pdf', total: 1000 }, { formato: 'xlsx', total: 234 }],
  recientes: [{ id: '9', name: 'Acta.pdf', formato: 'pdf', category: 'Legal', categoryColor: '', user: 'Ana', time: 'Hace 3 min', size: '1 MB' }],
  almacenamiento,
});
const almacen: DashboardDatos['almacenamiento'] = {
  bytes: 1048576, usado: '1 MB', objetos: 3, cuotaBytes: 5497558138880, cuota: '5 TB', porcentaje: 0,
  papelera: { documentos: 1, bytes: 1024, usado: '1 KB' }, driver: 'r2',
  cifrado: 'Cloudflare R2 cifra en reposo todos los objetos (AES-256, claves gestionadas por Cloudflare).', cifradoEnReposo: true,
};

describe('Dashboard', () => {
  let fixture: ComponentFixture<Dashboard>;
  let http: HttpTestingController;
  const texto = () => (fixture.nativeElement as HTMLElement).textContent ?? '';

  async function crear(rolClave: string, respuesta: DashboardDatos, nombre = 'Gabriel Guevara') {
    sessionStorage.setItem('dai_token', 't');
    sessionStorage.setItem('dai_user', JSON.stringify({ name: nombre, role: 'Oficial Cumplimiento', email: 'g@dai.corp', rolClave, nivel: 'Nivel 3 Alto' }));
    await TestBed.configureTestingModule({
      imports: [Dashboard],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(Dashboard);
    http.expectOne('/api/dashboard').flush(respuesta);
    fixture.detectChanges();
    await fixture.whenStable();
  }

  afterEach(() => {
    http.match('/api/notificaciones/resumen');
    http.verify();
    sessionStorage.clear();
  });

  it('banner con nombre, rol y nivel REALES (sin "Dra. Elena Ramos") y cifras del servidor', async () => {
    await crear('compliance', datos(almacen));
    const t = texto();
    expect(t).toContain('Hola, Gabriel Guevara');
    expect(t).toContain('Oficial Cumplimiento · Nivel 3 Alto');
    for (const falso of ['Elena Ramos', 'Auditoría y Jurisdicción', 'Alertas & Biblioteca', '120 expedientes', 'Encriptado'])
      expect(t).not.toContain(falso);
    expect(t).toContain('1.234'); // separador de miles de Colombia
    expect(t).toContain('1.204 solo con metadatos');
    expect(t).toContain('Acta.pdf');
  });

  it('Admin/Cumplimiento: panel de almacenamiento real con el texto honesto del cifrado', async () => {
    await crear('super-admin', datos(almacen));
    const panel = (fixture.nativeElement as HTMLElement).querySelector('[aria-label="Almacenamiento"]')?.textContent ?? '';
    expect(panel).toContain('1 MB');
    expect(panel).toContain('de 5 TB');
    expect(panel).toContain('Cloudflare R2 cifra en reposo');
    expect(panel).toContain('1 documento');
  });

  it('Lector u Operador: el servidor no envía almacenamiento y no se pinta el panel; sin "Subir Documento" para el lector', async () => {
    await crear('read-only', datos(null));
    expect((fixture.nativeElement as HTMLElement).querySelector('[aria-label="Almacenamiento"]')).toBeNull();
    expect(texto()).not.toContain('Subir Documento');
  });
});
