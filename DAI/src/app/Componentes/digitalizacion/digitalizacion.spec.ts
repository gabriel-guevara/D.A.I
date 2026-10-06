import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Digitalizacion } from './digitalizacion';

describe('Digitalizacion', () => {
  let component: Digitalizacion;
  let fixture: ComponentFixture<Digitalizacion>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Digitalizacion],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    }).compileComponents();

    fixture = TestBed.createComponent(Digitalizacion);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
