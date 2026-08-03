// First-visit redirect state for the guided onboarding. localStorage rather
// than server config on purpose: "seen it" is a per-browser fact, and the
// flow stays re-runnable from Settings regardless.
export const ONBOARDING_DONE_KEY = 'lss-onboarding-done';

export function isOnboardingDone(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_DONE_KEY) === '1';
  } catch {
    return true; // storage unavailable — never trap the user in a redirect
  }
}

export function markOnboardingDone(): void {
  try {
    localStorage.setItem(ONBOARDING_DONE_KEY, '1');
  } catch {
    /* private mode */
  }
}
