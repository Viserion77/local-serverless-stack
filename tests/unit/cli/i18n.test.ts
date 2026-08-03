// Unit tests for bin/i18n.js — the CLI's hand-rolled translation layer.
//
// Two things need proving here. First, locale RESOLUTION: the module reads the
// environment once at require time, so a wrong answer means the whole CLI comes
// out in the wrong language and nothing downstream can recover. Second, the
// FALLBACK chain in t(): a key missing from a translation must still print
// something actionable, never `undefined` and never a blank line.
//
// The module caches the resolved locale in a module-level `let`, so tests that
// care about the boot-time detection re-require it through jest.resetModules()
// after setting process.env — the same trick cli.test.ts uses for EXPLICIT_CONFIG.

const I18N_PATH = require.resolve('../../../bin/i18n.js');

type I18n = typeof import('../../../bin/i18n.js');

function loadI18n(env: Record<string, string | undefined> = {}): I18n {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  jest.resetModules();
  return require(I18N_PATH);
}

describe('bin/i18n.js', () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...origEnv };
    jest.resetModules();
  });

  // ---------------------------------------------------------------------------
  // matchLocale
  // ---------------------------------------------------------------------------
  describe('matchLocale', () => {
    it('matches an exact catalogue tag', () => {
      const { matchLocale } = loadI18n();
      expect(matchLocale('pt-BR')).toBe('pt-BR');
      expect(matchLocale('en')).toBe('en');
      expect(matchLocale('es')).toBe('es');
    });

    it('matches on the language subtag, ignoring region, charset and modifier', () => {
      const { matchLocale } = loadI18n();
      // The POSIX shapes a shell actually exports.
      expect(matchLocale('pt_BR.UTF-8')).toBe('pt-BR');
      expect(matchLocale('pt_PT')).toBe('pt-BR'); // only one Portuguese catalogue
      expect(matchLocale('es-AR')).toBe('es');
      expect(matchLocale('es_MX.UTF-8@euro')).toBe('es');
      expect(matchLocale('en-GB')).toBe('en');
      expect(matchLocale('EN_US.UTF-8')).toBe('en'); // subtag comparison is case-insensitive
    });

    it('returns null for an unknown tag or an empty value', () => {
      const { matchLocale } = loadI18n();
      expect(matchLocale('de-DE')).toBeNull();
      expect(matchLocale('C.UTF-8')).toBeNull();
      expect(matchLocale('')).toBeNull();
      expect(matchLocale(undefined)).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // detectLocale — the LSS_LANG > LC_ALL > LC_MESSAGES > LANG chain
  // ---------------------------------------------------------------------------
  describe('detectLocale', () => {
    it('prefers LSS_LANG over every POSIX variable', () => {
      const { detectLocale } = loadI18n();
      expect(detectLocale({
        LSS_LANG: 'es',
        LC_ALL: 'pt_BR.UTF-8',
        LC_MESSAGES: 'pt_BR.UTF-8',
        LANG: 'pt_BR.UTF-8',
      })).toBe('es');
    });

    it('walks the chain in order when the more specific variable is absent or unknown', () => {
      const { detectLocale } = loadI18n();
      expect(detectLocale({ LC_ALL: 'pt_BR.UTF-8', LANG: 'es' })).toBe('pt-BR');
      expect(detectLocale({ LC_MESSAGES: 'es_CL.UTF-8', LANG: 'pt_BR' })).toBe('es');
      expect(detectLocale({ LANG: 'pt_BR.UTF-8' })).toBe('pt-BR');
      // An unrecognised LSS_LANG doesn't stop the walk — the next one answers.
      expect(detectLocale({ LSS_LANG: 'de', LANG: 'es_UY.UTF-8' })).toBe('es');
    });

    it('falls back to English when nothing is set or nothing matches', () => {
      const { detectLocale, DEFAULT_LOCALE } = loadI18n();
      expect(detectLocale({})).toBe('en');
      expect(detectLocale({ LANG: 'C' })).toBe(DEFAULT_LOCALE);
    });

    it('reads process.env when called with no argument', () => {
      const { detectLocale } = loadI18n({ LSS_LANG: 'pt-BR' });
      expect(detectLocale()).toBe('pt-BR');
    });

    it('is what the module resolves at require time', () => {
      expect(loadI18n({ LSS_LANG: 'es' }).getLocale()).toBe('es');
      expect(loadI18n({ LSS_LANG: undefined, LC_ALL: undefined, LC_MESSAGES: undefined, LANG: undefined }).getLocale())
        .toBe('en');
    });
  });

  // ---------------------------------------------------------------------------
  // setLocale / getLocale
  // ---------------------------------------------------------------------------
  describe('setLocale', () => {
    it('switches to a supported locale and reports it back', () => {
      const { setLocale, getLocale, t } = loadI18n({ LSS_LANG: 'en' });
      expect(setLocale('pt-BR')).toBe('pt-BR');
      expect(getLocale()).toBe('pt-BR');
      expect(t('seed.aborted')).toBe('Cancelado.');
    });

    it('falls back to English for an unsupported value', () => {
      const { setLocale, getLocale } = loadI18n({ LSS_LANG: 'pt-BR' });
      expect(setLocale('de')).toBe('en');
      expect(getLocale()).toBe('en');
    });
  });

  // ---------------------------------------------------------------------------
  // t
  // ---------------------------------------------------------------------------
  describe('t', () => {
    it('returns the raw template when no params are given', () => {
      const { t } = loadI18n({ LSS_LANG: 'en' });
      expect(t('scan.registered')).toBe('registered');
      // A template with placeholders and no params keeps them verbatim rather
      // than printing "undefined".
      expect(t('scan.header')).toBe('{count} service(s) under {root}:');
    });

    it('interpolates every {placeholder} it is given', () => {
      const { t } = loadI18n({ LSS_LANG: 'en' });
      expect(t('scan.header', { count: 3, root: '/abs' })).toBe('3 service(s) under /abs:');
      expect(t('register.notFound', { target: 'svc-a' })).toBe('✗ svc-a: directory not found');
    });

    it('leaves a placeholder intact when the param is missing', () => {
      const { t } = loadI18n({ LSS_LANG: 'en' });
      // Half-supplied params must not produce "undefined" in the operator's face.
      expect(t('scan.header', { count: 2 })).toBe('2 service(s) under {root}:');
    });

    it('translates through the active locale', () => {
      const { t } = loadI18n({ LSS_LANG: 'pt-BR' });
      expect(t('scan.registered')).toBe('registrado');
      const es = loadI18n({ LSS_LANG: 'es' });
      expect(es.t('scan.registered')).toBe('registrado');
      expect(es.t('scan.notRegistered')).toBe('sin registrar');
    });

    it('falls back to English for a key missing from a translation', () => {
      const { t, MESSAGES } = loadI18n({ LSS_LANG: 'pt-BR' });
      MESSAGES.en['test.onlyEnglish'] = 'English only';
      expect(t('test.onlyEnglish')).toBe('English only');
      delete MESSAGES.en['test.onlyEnglish'];
    });

    it('returns the key itself when it is missing everywhere', () => {
      const { t } = loadI18n({ LSS_LANG: 'es' });
      // A visible key is a better bug report than a blank line.
      expect(t('nope.notAKey')).toBe('nope.notAKey');
      expect(t('nope.notAKey', { any: 'thing' })).toBe('nope.notAKey');
    });
  });

  // ---------------------------------------------------------------------------
  // Catalogue integrity — a key present in one language and missing in another
  // silently degrades that language to English, which is exactly the kind of
  // regression nobody notices until a user reports it.
  // ---------------------------------------------------------------------------
  describe('catalogues', () => {
    it('declares the same keys in all three languages', () => {
      const { MESSAGES, LOCALES } = loadI18n();
      const english = Object.keys(MESSAGES.en).sort();
      expect(LOCALES).toEqual(['en', 'pt-BR', 'es']);
      for (const locale of LOCALES) {
        expect({ locale, keys: Object.keys(MESSAGES[locale]).sort() }).toEqual({ locale, keys: english });
      }
    });

    it('uses the same placeholders in every translation of a key', () => {
      const { MESSAGES, LOCALES } = loadI18n();
      const placeholders = (template: string) =>
        (template.match(/\{(\w+)\}/g) || []).sort();
      for (const key of Object.keys(MESSAGES.en)) {
        for (const locale of LOCALES) {
          expect({ key, locale, params: placeholders(MESSAGES[locale][key]) })
            .toEqual({ key, locale, params: placeholders(MESSAGES.en[key]) });
        }
      }
    });
  });
});
