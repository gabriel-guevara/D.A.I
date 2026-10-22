import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withViewTransitions } from '@angular/router';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { routes } from './app.routes';
import { authInterceptor } from './shared/auth-interceptor';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // View Transitions: al navegar, el indicador activo de la barra lateral se desliza al nuevo ítem.
    provideRouter(routes, withViewTransitions()),
    provideHttpClient(withInterceptors([authInterceptor])),
  ]
};
