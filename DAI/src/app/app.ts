import { Component, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { Login } from './Componentes/login/login';
import { Biblioteca } from './Componentes/biblioteca/biblioteca';
import { Dashboard } from './Componentes/dashboard/dashboard';

@Component({
  imports: [RouterOutlet, Login, Biblioteca, Dashboard],
  selector: 'app-root',
  styleUrl: './app.css',
  templateUrl: './app.html',
})
export class App {
  protected readonly title = signal('DAI');
}
