// Typed in-process event bus connecting emulators (producers) to the
// dispatcher (consumer). A thin wrapper over EventEmitter so payloads stay
// typed per event name and listeners never see `any`.

import { EventEmitter } from 'events';
import type { EngineBusEvents } from './types.js';

export class EngineBus {
  private emitter = new EventEmitter();

  constructor() {
    // Delivery fan-out can register one listener per event source mapping.
    this.emitter.setMaxListeners(1000);
  }

  emit<K extends keyof EngineBusEvents>(event: K, payload: EngineBusEvents[K]): void {
    this.emitter.emit(event, payload);
  }

  on<K extends keyof EngineBusEvents>(event: K, listener: (payload: EngineBusEvents[K]) => void): void {
    this.emitter.on(event, listener as (payload: unknown) => void);
  }

  off<K extends keyof EngineBusEvents>(event: K, listener: (payload: EngineBusEvents[K]) => void): void {
    this.emitter.off(event, listener as (payload: unknown) => void);
  }

  removeAll(): void {
    this.emitter.removeAllListeners();
  }
}
