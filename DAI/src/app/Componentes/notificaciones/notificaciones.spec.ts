import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Notificaciones } from './notificaciones';

describe('Notificaciones', () => {
  let component: Notificaciones;
  let fixture: ComponentFixture<Notificaciones>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Notificaciones],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    }).compileComponents();

    fixture = TestBed.createComponent(Notificaciones);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
