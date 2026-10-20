import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router, provideRouter } from '@angular/router';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Busqueda } from './busqueda';

const resultado = {
  docId: '9', title: 'Póliza.pdf', badge: 'USO INTERNO', badgeColor: '', formatLabel: 'PDF', hashLabel: 'SHA-256 del archivo',
  expediente: 'EXP-9', ruta: '', actualizado: '16 Oct 2026', pagina: 'Página 4', numeroPagina: 4, paginasCoincidentes: 2,
  origenTexto: 'pdf', origenEtiqueta: 'Texto extraído del PDF', score: 'Score Semántico 100.0%', responsable: 'Ana', extra: '',
  tipo: 'Contratos y Convenios', clasificacion: 'Uso Interno General',
  segmentos: [
    { texto: 'deberá notificar el ', resaltado: false },
    { texto: 'siniestro', resaltado: true },
    { texto: ' <img src=x onerror=alert(1)>', resaltado: false },
  ],
};

describe('Busqueda', () => {
  let component: Busqueda;
  let fixture: ComponentFixture<Busqueda>;
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Busqueda],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    }).compileComponents();

    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(Busqueda);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  const responder = async () => {
    http.expectOne('/api/busqueda/facetas').flush({
      tiposDocumentales: [], clasificaciones: [], terminosFrecuentes: [], documentosConTexto: 13, documentosConTextoReal: 1,
    });
    http.expectOne((r) => r.url === '/api/busqueda').flush([resultado]);
    fixture.detectChanges();
    await fixture.whenStable();
  };

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('pinta el fragmento real con la coincidencia resaltada, la página y el origen, sin interpretar HTML', async () => {
    await responder();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('mark')?.textContent?.trim()).toBe('siniestro');
    expect(el.querySelector('img[src="x"]')).toBeNull(); // el texto del PDF nunca se convierte en etiquetas
    expect(el.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(el.textContent).toContain('Página 4');
    expect(el.textContent).toContain('Texto extraído del PDF');
    expect(el.textContent).toContain('coincide en 2 páginas');
    expect(component.documentosConTexto()).toBe(13);
  });

  it('abrir un resultado lleva al visor en la página de la coincidencia', async () => {
    await responder();
    const navegar = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    component.abrirDocumento(resultado as never);
    expect(navegar).toHaveBeenCalledWith(['/documento', '9'], { queryParams: { pagina: 4 } });
    component.abrirDocumento({ docId: '5', numeroPagina: null });
    expect(navegar).toHaveBeenLastCalledWith(['/documento', '5'], {});
  });

  it('sin maquetas: sin toggle "Texto dentro de OCR" ni paginación falsa; "Previsualizar coincidencia" abre la página', async () => {
    await responder();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.textContent).not.toContain('Texto dentro de OCR');
    expect([...el.querySelectorAll('button')].some((b) => b.textContent?.trim() === '‹')).toBe(false);
    expect(el.textContent).toContain('Mostrando los 1 mejores resultados');
    const navegar = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const previsualizar = [...el.querySelectorAll('button')].find((b) => b.textContent?.includes('Previsualizar coincidencia'));
    expect(previsualizar?.textContent).toContain('pág. 4');
    previsualizar!.click();
    expect(navegar).toHaveBeenCalledWith(['/documento', '9'], { queryParams: { pagina: 4 } });
  });
});
