// Hot reload: watches a registered service's source tree and refreshes its
// Lambda runtime when files change. Handler-only changes just restart the
// service worker (flushing the module cache — cheap); serverless.yml changes
// need a re-package + re-registration, which the caller wires in.

import fs from 'fs';
import path from 'path';

export interface WatchStatus {
  watching: boolean;
  lastReloadAt?: number;
  lastReloadKind?: 'runtime' | 'full';
  lastError?: string;
}

interface WatchedService {
  root: string;
  watcher: fs.FSWatcher;
  debounce?: NodeJS.Timeout;
  pendingFullReload: boolean;
  status: WatchStatus;
}

export interface ReloadHandlers {
  // Restart the runtime worker (source change).
  onRuntimeReload: (serviceName: string) => Promise<void>;
  // serverless.yml / package.json changed — full re-register needed.
  onFullReload: (serviceName: string) => Promise<void>;
}

const DEBOUNCE_MS = 500;
const IGNORED_SEGMENTS = new Set(['node_modules', '.serverless', '.esbuild', '.build', '.git', 'dist', '.lss']);
const FULL_RELOAD_FILES = new Set(['serverless.yml', 'serverless.yaml', 'serverless.json', 'package.json']);

export class SourceWatcher {
  private static instance: SourceWatcher;
  private watched = new Map<string, WatchedService>();
  private handlers?: ReloadHandlers;

  static getInstance(): SourceWatcher {
    if (!SourceWatcher.instance) {
      SourceWatcher.instance = new SourceWatcher();
    }
    return SourceWatcher.instance;
  }

  setHandlers(handlers: ReloadHandlers): void {
    this.handlers = handlers;
  }

  watch(serviceName: string, root: string): void {
    this.unwatch(serviceName);
    try {
      const watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
        this.onChange(serviceName, filename ? String(filename) : '');
      });
      watcher.on('error', err => {
        console.warn(`⚠️  Watcher for "${serviceName}" failed: ${err.message}`);
        this.unwatch(serviceName);
      });
      this.watched.set(serviceName, {
        root,
        watcher,
        pendingFullReload: false,
        status: { watching: true },
      });
      console.log(`👀 Watching ${root} for changes (service "${serviceName}")`);
    } catch (err) {
      console.warn(`⚠️  Could not watch ${root}: ${err instanceof Error ? err.message : err}`);
    }
  }

  unwatch(serviceName: string): void {
    const watched = this.watched.get(serviceName);
    if (!watched) return;
    if (watched.debounce) clearTimeout(watched.debounce);
    watched.watcher.close();
    this.watched.delete(serviceName);
  }

  unwatchAll(): void {
    for (const name of [...this.watched.keys()]) {
      this.unwatch(name);
    }
  }

  getStatus(serviceName: string): WatchStatus {
    return this.watched.get(serviceName)?.status ?? { watching: false };
  }

  private onChange(serviceName: string, filename: string): void {
    const watched = this.watched.get(serviceName);
    if (!watched || !filename) return;

    const segments = filename.split(path.sep);
    if (segments.some(s => IGNORED_SEGMENTS.has(s))) return;

    if (FULL_RELOAD_FILES.has(path.basename(filename)) && segments.length === 1) {
      watched.pendingFullReload = true;
    }

    if (watched.debounce) clearTimeout(watched.debounce);
    watched.debounce = setTimeout(() => {
      const kind = watched.pendingFullReload ? 'full' : 'runtime';
      watched.pendingFullReload = false;
      void this.reload(serviceName, watched, kind);
    }, DEBOUNCE_MS);
  }

  private async reload(serviceName: string, watched: WatchedService, kind: 'runtime' | 'full'): Promise<void> {
    if (!this.handlers) return;
    try {
      console.log(`♻️  Change detected in "${serviceName}" — ${kind === 'full' ? 're-registering service' : 'reloading runtime'}`);
      if (kind === 'full') {
        await this.handlers.onFullReload(serviceName);
      } else {
        await this.handlers.onRuntimeReload(serviceName);
      }
      watched.status.lastReloadAt = Date.now();
      watched.status.lastReloadKind = kind;
      watched.status.lastError = undefined;
    } catch (err) {
      watched.status.lastError = err instanceof Error ? err.message : String(err);
      console.error(`❌ Reload failed for "${serviceName}": ${watched.status.lastError}`);
    }
  }
}
