import { ref } from 'vue';
import { api, resolveApiUrl } from './api';
import type { BrandingInfo } from './api';

const THEME_STORAGE_KEY = 'lss-theme';
const STYLE_ELEMENT_ID = 'lss-branding-overrides';

export const branding = ref<BrandingInfo>({
  title: 'Local Serverless Stack',
  subtitle: 'Local development control plane',
  logoUrl: null,
  faviconUrl: null,
  defaultTheme: 'dark',
  colors: {},
  themeColors: { dark: {}, light: {} },
});

export function getStoredTheme(): 'dark' | 'light' | null {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  return stored === 'dark' || stored === 'light' ? stored : null;
}

export function applyTheme(theme: 'dark' | 'light', persist = false): void {
  document.documentElement.setAttribute('data-tree-theme', theme);
  if (persist) localStorage.setItem(THEME_STORAGE_KEY, theme);
}

// "brand-primary" → "--tree-color-brand-primary"; full custom property names
// ("--tree-radius-md") pass through so any TreeUI token can be overridden.
function toCustomProperty(key: string): string {
  return key.startsWith('--') ? key : `--tree-color-${key}`;
}

function toDeclarations(colors: Record<string, string>): string {
  return Object.entries(colors)
    .map(([key, value]) => `${toCustomProperty(key)}:${value};`)
    .join('');
}

// Inject the token overrides after the library CSS. :root[data-tree-theme=...]
// outweighs TreeUI's own :root:not([data-tree-theme=light]) blocks because the
// style element comes later in the document with equal specificity.
function applyColorOverrides(info: BrandingInfo): void {
  const dark = toDeclarations({ ...info.colors, ...info.themeColors.dark });
  const light = toDeclarations({ ...info.colors, ...info.themeColors.light });

  let el = document.getElementById(STYLE_ELEMENT_ID) as HTMLStyleElement | null;
  // "No tokens at all" is a reachable state now that Settings can empty the
  // three maps and re-pull branding in the same page load: bailing out early
  // (as this did while the maps were file-only) would leave the previous
  // stylesheet applied, so clearing every token would visibly do nothing.
  if (!dark && !light) {
    el?.remove();
    return;
  }

  if (!el) {
    el = document.createElement('style');
    el.id = STYLE_ELEMENT_ID;
    document.head.appendChild(el);
  }
  el.textContent = [
    dark ? `:root[data-tree-theme="dark"]{${dark}}` : '',
    light ? `:root[data-tree-theme="light"]{${light}}` : '',
  ].join('\n');
}

function applyFavicon(url: string): void {
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.href = url;
}

/**
 * Fetch branding from the orchestrator and apply everything that lives
 * outside Vue templates (tab title, favicon, theme default, color tokens).
 * Navbar title/logo render reactively from the exported `branding` ref.
 */
export async function loadBranding(): Promise<void> {
  try {
    const info = await api.getBranding();
    info.logoUrl = info.logoUrl ? resolveApiUrl(info.logoUrl) : null;
    info.faviconUrl = info.faviconUrl ? resolveApiUrl(info.faviconUrl) : null;
    branding.value = info;

    document.title = info.title;
    if (info.faviconUrl) applyFavicon(info.faviconUrl);
    applyColorOverrides(info);
    // The user's explicit choice (stored on toggle) wins over the config default.
    if (!getStoredTheme()) applyTheme(info.defaultTheme);
  } catch (error) {
    console.error('Failed to load branding, using defaults:', error);
  }
}
