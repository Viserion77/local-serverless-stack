// Dashboard internationalisation — English, Brazilian Portuguese and Spanish.
//
// Hand-rolled rather than vue-i18n on purpose: the dashboard needs a reactive
// `t()`, a locale ref and interpolation, which is ~40 lines, and LSS ships as
// one npm package whose dependency list is a cost users pay on every install.
//
// Message catalogues live one file per feature area under `messages/`, each
// carrying all three languages side by side — so a translation review reads
// like a table, and two people editing different screens never touch the same
// file.
import { computed, ref } from 'vue';
import type { ComputedRef } from 'vue';
import { MESSAGES } from './messages';

export const LOCALES = ['en', 'pt-BR', 'es'] as const;
export type Locale = (typeof LOCALES)[number];

export const LOCALE_LABELS: Record<Locale, string> = {
  en: 'English',
  'pt-BR': 'Português (BR)',
  es: 'Español',
};

const STORAGE_KEY = 'lss-locale';
export const DEFAULT_LOCALE: Locale = 'en';

function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/**
 * Best match for a BCP-47 tag: exact first (`pt-BR`), then the language
 * subtag (`pt` → `pt-BR`, `es-AR` → `es`). Anything unknown falls back to
 * English rather than guessing.
 */
export function matchLocale(tag: string | undefined | null): Locale | null {
  if (!tag) return null;
  if (isLocale(tag)) return tag;
  const language = tag.split(/[-_]/)[0].toLowerCase();
  if (language === 'pt') return 'pt-BR';
  if (language === 'es') return 'es';
  if (language === 'en') return 'en';
  return null;
}

/**
 * Stored choice wins over the browser's languages — a user who picked a
 * language keeps it on a machine whose OS is set to another one.
 */
export function detectLocale(): Locale {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (isLocale(stored)) return stored;
  } catch {
    // Storage disabled (private mode, embedded webview): fall through to the
    // browser languages — never let a storage policy break the dashboard.
  }
  const candidates = typeof navigator === 'undefined'
    ? []
    : [...(navigator.languages ?? []), navigator.language];
  for (const candidate of candidates) {
    const matched = matchLocale(candidate);
    if (matched) return matched;
  }
  return DEFAULT_LOCALE;
}

const locale = ref<Locale>(detectLocale());

export function setLocale(next: Locale): void {
  locale.value = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Same as above: the choice still applies for this session.
  }
  if (typeof document !== 'undefined') {
    document.documentElement.lang = next;
  }
}

/**
 * Translate `key`, interpolating `{placeholder}` params.
 *
 * A missing key falls back to English and finally to the key itself: an
 * untranslated screen must still render something a human can act on, and a
 * visible `queues.title` is a better bug report than a blank label.
 */
export function translate(key: string, params?: Record<string, string | number>): string {
  const catalogue = MESSAGES[locale.value] ?? {};
  const template = catalogue[key] ?? MESSAGES[DEFAULT_LOCALE][key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    (name in params ? String(params[name]) : match));
}

export interface I18n {
  t: (key: string, params?: Record<string, string | number>) => string;
  locale: ComputedRef<Locale>;
  setLocale: (next: Locale) => void;
  locales: typeof LOCALES;
  localeLabels: Record<Locale, string>;
}

export function useI18n(): I18n {
  return {
    // Reading `locale.value` inside makes every t() call site reactive, so a
    // language switch re-renders without a reload.
    t: (key, params) => {
      void locale.value;
      return translate(key, params);
    },
    locale: computed(() => locale.value),
    setLocale,
    locales: LOCALES,
    localeLabels: LOCALE_LABELS,
  };
}
