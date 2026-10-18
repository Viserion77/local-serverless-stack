// The engine's "reset everything" endpoint: one constant set shared by the
// router (which serves it), is-aws-request (which must hand it to the engine
// on the shared listener) and the backend (which performs it).

export const RESET_PATH = '/_lss/reset';

// Required on every reset request. A custom header cannot be sent cross-site
// without a CORS preflight, and the reset route never answers one — so a page
// open in the developer's browser cannot wipe the stack behind their back.
export const RESET_CONFIRM_HEADER = 'x-lss-confirm-reset';

// Loopback in every shape Node reports a peer address: IPv4 127/8, IPv6 ::1,
// and IPv4-mapped IPv6 (a dual-stack listener reports `::ffff:127.0.0.1`).
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const v4 = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  return v4.startsWith('127.') || address === '::1';
}
