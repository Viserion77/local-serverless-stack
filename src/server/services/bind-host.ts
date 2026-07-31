// The network posture of the whole process: which interface **every** listener
// binds to (`LSS_BIND_HOST`), and which browser origins the REST API answers
// (`LSS_CORS_ORIGINS`). Both are env-only, both default to "this machine only",
// and both are resolved here so no caller can hold a different opinion.
//
// `LSS_BIND_HOST` governs **every socket this process opens** — one variable,
// one posture, no listener left behind. LSS opens far more than one, and each of
// them is an unauthenticated surface that executes code or moves data on this
// host. The complete list (a listener that is not here is a listener that
// forgot to ask):
//
//   - the orchestrator itself — dashboard, REST API and (in the default
//     single-listener layout) the embedded AWS wire (`src/server/index.ts`);
//   - per registered service, an API Gateway listener on its apiPort and an
//     **AWS Lambda Invoke API** listener on its invokePort
//     (`services/gateway-manager.ts`) — the invoke port runs any registered
//     handler with the request body as the event, and `FunctionRegistry.resolve()`
//     falls back to the global registry, so one port reaches every service;
//   - the self engine's own front door when `serverPort` and `selfEngine.port`
//     differ (`engine/backends/self-backend.ts`) — read/write access to every
//     table, queue, topic, bucket and secret;
//   - the optional DynamoDB proxy (`dev/dynamo-proxy.ts`).
//
// So "which interface do we bind" is a security decision, and it has to be the
// SAME decision for all of them. It was not. Only `index.ts` honoured
// `LSS_BIND_HOST`; the others called `server.listen(port)` with no host (or
// asked for `'0.0.0.0'` outright), and a bare `listen(port)` binds `::` — a
// dual-stack wildcard. Verified empirically: `address()` reports `'::'` and the
// port answers on this host's LAN address, while a `listen(port, '127.0.0.1')`
// socket refuses that same connection with ECONNREFUSED. The result was a
// loopback-bound dashboard that still shipped every service's invoke port — and,
// in split-listener mode, the whole AWS data plane — to anything on the network.
// Centralising the answer here is what makes "LSS listens on loopback" a
// statement about the process rather than about one file.
//
// Related but deliberately NOT unified here: `lambdaRuntime.invokeHost`
// (`ConfigManager.getInvokeHost()`) only builds the callback URL the engine's
// Lambda proxy records as `INVOKE_URL`. Pointing it at a non-loopback address
// (the documented container case) now also requires `LSS_BIND_HOST`, because
// the listener that URL names is the one fenced above — naming an address is
// not the same act as offering the port on it, and only the second one is an
// exposure.

/** Loopback: reachable only from processes running on this machine. */
const DEFAULT_BIND_HOST = '127.0.0.1';

// Resolved ONCE, at module load, on purpose.
//
// Listeners are opened at very different moments — the orchestrator at boot,
// gateway/invoke listeners on every service registration and hot reload, the
// DynamoDB proxy at the end of boot — and they must not be able to disagree
// about how exposed this process is. A single frozen answer means a listener
// that comes up an hour into the session is bound exactly like the one that
// came up at boot.
//
// It is read straight from the environment rather than through `ConfigManager`
// for the same reason it has no `lss.config.json` key and no `PUT /api/config`
// spelling: widening the bind *through* the very API the bind protects would
// hand the exposure straight back to whoever already reached the API.
const BIND_HOST = process.env.LSS_BIND_HOST?.trim() || DEFAULT_BIND_HOST;

/**
 * The address to pass as the `host` argument of every `server.listen()` in this
 * process. Never omit that argument — omitting it is what binds every
 * interface.
 */
export function getBindHost(): string {
  return BIND_HOST;
}

/**
 * True when `host` can only accept connections that originate on this machine.
 * Everything else — `0.0.0.0`, `::`, a LAN address, a routable hostname — is
 * reachable from the network. The whole `127.0.0.0/8` block is loopback, and
 * `::ffff:127.x.x.x` is that same address seen through a dual-stack socket.
 */
export function isLoopbackBind(host: string): boolean {
  // `[::1]` is the bracketed spelling a URL or a `--host` value carries.
  const normalized = host.toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/^::ffff:/, '');
  return normalized === 'localhost' || normalized === '::1' || /^127\./.test(normalized);
}

// ---------------------------------------------------------------------------
// Which browser ORIGINS the REST API answers
// ---------------------------------------------------------------------------
//
// The bind decides which machines can open the socket; CORS decides which
// *pages* a browser will let read the answer once the socket is open. They are
// two halves of the same question, so they live in the same module and move
// together: a bind that is reachable from another machine is usually reached by
// a browser running on it.
//
// The default is the loopback allowlist below, which is what the previous
// hardening shipped: `cors()` with no options answered every preflight with
// `Access-Control-Allow-Origin: *`, which is what made an unauthenticated,
// command-running API drive-by reachable from any page the developer happened to
// have open.
//
// But loopback-only is wrong for a real, documented LSS layout: the stack runs
// in a container and is reached from a browser OUTSIDE it, and the developer's
// own frontends — served from `http://app.localhost:5173`, from the host's LAN
// address, from a preview URL — call LSS directly to inspect a queue, hit the
// emulated API Gateway or invoke a Lambda. Those are the intended callers, and a
// hardcoded regexp turns them into a support ticket. Hence `LSS_CORS_ORIGINS`:
// a comma-separated allowlist, with `*` for "any origin, I know what that
// means". Unset or empty keeps the loopback default, so nobody who did not ask
// gets a wider answer.
//
// Env-only, exactly like the bind: a CORS list editable through `PUT /api/config`
// would let whoever already reached the API widen the set of pages that may
// reach it next.

/**
 * Origins the API answers when `LSS_CORS_ORIGINS` says nothing: any port on a
 * loopback name, http only. That is every caller of a default install — the
 * built dashboard is served by this same process (same-origin, so CORS never
 * applies to it) and the Vite dev dashboard on :3101 calls :14566 cross-origin.
 */
const LOOPBACK_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/** Any origin at all — the deliberate wildcard spelling of `LSS_CORS_ORIGINS`. */
const ANY_ORIGIN = '*';

/**
 * Comparable spelling of an origin. Browsers send the scheme and host
 * lowercased and never send a trailing slash; an operator typing the env var by
 * hand does neither reliably, and `LSS_CORS_ORIGINS=https://App.Example.com/`
 * silently matching nothing is the worst possible failure mode for a knob whose
 * whole job is to unblock a frontend.
 */
function normalizeOrigin(value: string): string {
  return value.trim().toLowerCase().replace(/\/+$/, '');
}

const CORS_ORIGINS = (process.env.LSS_CORS_ORIGINS ?? '')
  .split(',')
  .map(normalizeOrigin)
  .filter(entry => entry.length > 0);

/** True when the operator asked for the wildcard, explicitly and in writing. */
const CORS_ALLOWS_ANY = CORS_ORIGINS.includes(ANY_ORIGIN);

/**
 * Whether a browser origin may call this API cross-origin — the predicate the
 * `cors` middleware in `src/server/index.ts` consults.
 */
export function isOriginAllowed(origin: string | undefined): boolean {
  // No Origin header: same-origin browser requests, curl, the CLI, LssClient,
  // the MCP server, an AWS SDK, the Vite proxy. None of them is a cross-origin
  // browser request, so none of them is what this list is defending against —
  // and rejecting them would break every non-browser caller LSS has.
  if (!origin) return true;
  if (CORS_ALLOWS_ANY) return true;
  const candidate = normalizeOrigin(origin);
  // An empty list is "unset", not "deny everything": the default posture.
  if (CORS_ORIGINS.length === 0) return LOOPBACK_ORIGIN.test(candidate);
  return CORS_ORIGINS.includes(candidate);
}

/**
 * The boot banner's exposure warning, or `null` when the process is in the safe
 * default posture (loopback bind + loopback-only CORS).
 *
 * Widening either half must never be something you did and did not notice: this
 * API has no authentication and runs commands on this host, so the operator sees
 * exactly what they opened on **every** boot, not once in a changelog. One
 * warning covers the whole process — the bind it names is the one every listener
 * uses, resolved above.
 */
export function getExposureWarning(): string | null {
  const networkBind = !isLoopbackBind(BIND_HOST);
  if (!networkBind && !CORS_ALLOWS_ANY) return null;

  const exposures: string[] = [];
  const knobs: string[] = [];
  if (networkBind) {
    exposures.push(
      `LSS_BIND_HOST=${BIND_HOST} — the dashboard, the REST API, the AWS wire and every ` +
        "service's API/invoke port are reachable from the network",
    );
    knobs.push('LSS_BIND_HOST');
  }
  if (CORS_ALLOWS_ANY) {
    exposures.push(
      'LSS_CORS_ORIGINS=* — any web page open in a browser that can reach this port may call ' +
        'the API cross-origin and read the answer',
    );
    knobs.push('LSS_CORS_ORIGINS');
  }

  return (
    `⚠️  ${exposures.join('; ')}. This API has no authentication and can run commands on this ` +
    'host (starting a service spawns a process, packaging one runs a build command) — use it ' +
    `only where you trust every caller, and unset ${knobs.join(' and ')} to go back to the ` +
    'default (127.0.0.1, loopback origins only).'
  );
}
