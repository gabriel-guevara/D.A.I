import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Barraizq } from '../barraizq/barraizq';
import { Navbar } from '../navbar/navbar';
import { ApiService } from '../../shared/api';

type Channel = 'scanner' | 'file';
type ScanState = 'idle' | 'scanning' | 'done';
type ExtractionView = 'structured' | 'raw';

interface QueueItem {
  id?: string;
  name: string;
  meta: string;
  status: 'en_foco' | 'en_espera';
}

interface PreprocessingOption {
  key: 'deskew' | 'denoise' | 'binarization' | 'orientation';
  label: string;
  enabled: boolean;
}

interface ColaOcr {
  queue: QueueItem[];
  processedCount: number;
  totalInQueue: number;
}

@Component({
  selector: 'app-digitalizacion',
  standalone: true,
  imports: [CommonModule, Barraizq, Navbar],
  templateUrl: './digitalizacion.html',
})
export class Digitalizacion {
  channel = signal<Channel>('scanner');
  scanState = signal<ScanState>('idle');
  extractionView = signal<ExtractionView>('structured');
  confirmationMessage = signal<string | null>(null);

  preprocessing = signal<PreprocessingOption[]>([
    { key: 'deskew', label: 'Enderezado Automático (Deskew)', enabled: true },
    { key: 'denoise', label: 'Filtro de Ruido y Manchas Físicas', enabled: true },
    { key: 'binarization', label: 'Binarización Adaptativa Otsu', enabled: true },
    { key: 'orientation', label: 'Detección de Orientación (0°/180°)', enabled: false },
  ]);

  queue = signal<QueueItem[]>([]);

  processedCount = signal(0);
  totalInQueue = signal(0);

  private api = inject(ApiService);

  constructor() {
    this.cargarCola();
  }

  private cargarCola(): void {
    this.api.colaOcr<ColaOcr>().subscribe({
      next: (cola) => this.aplicarCola(cola),
      error: (err) => console.error('No se pudo cargar la cola de digitalización', err),
    });
  }

  private aplicarCola(cola: ColaOcr): void {
    this.queue.set(cola.queue);
    this.processedCount.set(cola.processedCount);
    this.totalInQueue.set(cola.totalInQueue);
  }

  setChannel(channel: Channel): void {
    this.channel.set(channel);
  }

  togglePreprocessing(key: PreprocessingOption['key']): void {
    this.preprocessing.update((list) =>
      list.map((item) => (item.key === key ? { ...item, enabled: !item.enabled } : item))
    );
  }

  setExtractionView(view: ExtractionView): void {
    this.extractionView.set(view);
  }

  /** Simula el proceso de escaneo/carga y extracción OCR de la página activa. */
  startScan(): void {
    if (this.scanState() === 'scanning') return;
    this.scanState.set('scanning');
    this.confirmationMessage.set(null);
    setTimeout(() => this.scanState.set('done'), 1400);
  }

  approveAndIndex(): void {
    const actual = this.queue().find((q) => q.status === 'en_foco');
    if (!actual?.id) return;

    // Crea el documento en la BD a partir del trabajo en foco.
    // Cuando el OCR sea real, aquí se envían también { folio, textoRaw, campos, confianza, departamento, clasificacion... }
    this.api.aprobarOcr<ColaOcr>(actual.id, {}).subscribe({
      next: (cola) => {
        this.aplicarCola(cola);
        this.confirmationMessage.set('Documento aprobado e indexado en DAI correctamente.');
        this.scanState.set('idle');
        setTimeout(() => this.confirmationMessage.set(null), 3500);
      },
      error: (err) => this.confirmationMessage.set(err.error?.error ?? 'No se pudo indexar el documento.'),
    });
  }

  reescanear(): void {
    this.scanState.set('idle');
    this.startScan();
  }
}
