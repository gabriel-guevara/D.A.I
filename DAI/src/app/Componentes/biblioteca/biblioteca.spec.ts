import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Biblioteca } from './biblioteca';

describe('Biblioteca', () => {
  let component: Biblioteca;
  let fixture: ComponentFixture<Biblioteca>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Biblioteca],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    }).compileComponents();

    fixture = TestBed.createComponent(Biblioteca);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
