import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
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

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
