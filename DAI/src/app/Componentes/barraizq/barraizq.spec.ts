import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Barraizq } from './barraizq';

describe('Barraizq', () => {
  let component: Barraizq;
  let fixture: ComponentFixture<Barraizq>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Barraizq],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    }).compileComponents();

    fixture = TestBed.createComponent(Barraizq);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  afterEach(() => sessionStorage.clear()); // se comparte entre archivos de specs

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('el logo de DAI lleva al Dashboard (enlace accesible con teclado)', () => {
    fixture.detectChanges();
    const logo = (fixture.nativeElement as HTMLElement).querySelector('a[aria-label="DAI, ir al Dashboard"]') as HTMLAnchorElement;
    expect(logo.getAttribute('href')).toBe('/dashboard');
    expect(logo.querySelector('img')?.getAttribute('src')).toBe('Dai.svg');
  });

  it('sin sesión (o rol sin permiso) no muestra la Papelera', () => {
    expect(component.itemsVisibles().some((i) => i.id === 'papelera')).toBe(false);
  });
});

describe('Barraizq: Papelera según el rol', () => {
  afterEach(() => {
    TestBed.inject(HttpTestingController).match(() => true); // resumen de notificaciones: no interesa aquí
    sessionStorage.clear();
  });

  const itemsPara = async (rolClave: string) => {
    sessionStorage.setItem('dai_token', 'token-de-prueba');
    sessionStorage.setItem('dai_user', JSON.stringify({ name: 'Ana', role: 'x', email: 'a@b.c', rolClave }));
    await TestBed.configureTestingModule({
      imports: [Barraizq],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    }).compileComponents();
    const f = TestBed.createComponent(Barraizq);
    return f.componentInstance.itemsVisibles().map((i) => i.id);
  };

  it('super-admin la ve', async () => {
    expect(await itemsPara('super-admin')).toContain('papelera');
  });
  it('cumplimiento la ve', async () => {
    expect(await itemsPara('compliance')).toContain('papelera');
  });
  it('operador OCR no la ve', async () => {
    expect(await itemsPara('ocr-operator')).not.toContain('papelera');
  });
});
