import { DurableObject } from 'cloudflare:workers';
import config from '../../config.json';

const BOAT_API = 'https://boat.dev/api/v1';
const GATE_HEADER = 'x-godmaps-gate';
const GATE_UP = 'x-godmaps-gate-up';
const APP_DOWN = 'x-godmaps-app-down';
// EventSource reconnects by itself, so a forgotten tab would wake the sandbox
// forever. This route never resumes the sandbox and never extends its lifetime.
const PASSIVE_PATHS = new Set(['/api/ghostmaps/events']);
// A stopped sandbox does not refuse a connection, it never answers. After this
// long without headers the Worker asks boat whether the sandbox is running.
const SLOW_MS = 1_500;
const PROBE_TIMEOUT_MS = 3_000;
const WAKE_BUDGET_MS = 20_000;
const POLL_MS = 750;
const EXTEND_EVERY_MS = 60_000;
const ttlSeconds = config.idleMinutes * 60;

const STOPPED_STATES = new Set(['archiving', 'archived', 'error']);
const ROBOTS = 'User-agent: *\nDisallow: /\n';
const WAKING_PAGE = `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="5"><title>Starting</title><body style="font:16px system-ui;background:#0b0f14;color:#d6dde6;display:grid;place-items:center;height:100vh;margin:0"><p>The demo server is starting. This page reloads by itself.</p>`;

let lastTouchMs = 0;

const SLOW = Symbol('slow');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The gate answered and the app behind it is serving. */
function isUp(response) {
  return response.headers.has(GATE_UP) && !response.headers.has(APP_DOWN);
}

/** Resolves to null when the sandbox does not answer at all. */
function toSandbox(env, { method, path, headers, body }, signal) {
  const upstream = new Headers(headers);
  upstream.set(GATE_HEADER, env.GATE_SECRET);
  return fetch(new URL(path, env.SANDBOX_URL), {
    method,
    headers: upstream,
    body,
    redirect: 'manual',
    signal,
  }).catch(() => null);
}

/**
 * Send the request to the sandbox, waking it first when it is stopped. A
 * request that is only slow is never sent twice. Resolves to null when the
 * sandbox is not serving and this request may not wake it, or the wake ran out
 * of time.
 */
async function fetchAwake(env, keeper, forward, mayWake) {
  const controller = new AbortController();
  const pending = toSandbox(env, forward, controller.signal);
  let response = await Promise.race([pending, sleep(SLOW_MS).then(() => SLOW)]);
  if (response === SLOW && (await keeper.isRunning())) response = await pending;
  if (response && response !== SLOW && isUp(response)) return response;
  controller.abort();
  if (!mayWake || !(await keeper.wake())) return null;
  response = await toSandbox(env, forward);
  return response && isUp(response) ? response : null;
}

function wakingResponse(request) {
  const wantsHtml = (request.headers.get('accept') || '').includes('text/html');
  return new Response(
    wantsHtml ? WAKING_PAGE : '{"error":"The demo server is starting"}',
    {
      status: 503,
      headers: {
        'content-type': wantsHtml
          ? 'text/html; charset=utf-8'
          : 'application/json',
        'retry-after': '5',
        'cache-control': 'no-store',
        'x-robots-tag': 'noindex, nofollow',
      },
    },
  );
}

function outward(response) {
  const clean = new Response(response.body, response);
  clean.headers.delete(GATE_UP);
  clean.headers.delete(APP_DOWN);
  return clean;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (url.protocol === 'http:' && url.hostname === config.publicHost) {
      url.protocol = 'https:';
      return Response.redirect(url.href, 301);
    }
    if (path === '/robots.txt') {
      return new Response(ROBOTS, {
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
    if (config.blockedPrefixes.some((prefix) => path.startsWith(prefix))) {
      return new Response('Not found', { status: 404 });
    }
    if (path.startsWith('/api/')) {
      const key = request.headers.get('cf-connecting-ip') || 'unknown';
      const { success } = await env.API_LIMITER.limit({ key });
      if (!success) {
        return new Response('{"error":"Too many requests"}', {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '60' },
        });
      }
    }

    const fingerprinted =
      request.method === 'GET' && path.startsWith('/assets/');
    if (fingerprinted) {
      const hit = await caches.default.match(request);
      if (hit) return hit;
    }

    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    const forward = {
      method: request.method,
      path: path + url.search,
      headers: request.headers,
      body: hasBody ? await request.arrayBuffer() : undefined,
    };
    const passive = PASSIVE_PATHS.has(path);
    const keeper = env.KEEPER.get(env.KEEPER.idFromName('sandbox'));

    const response = await fetchAwake(env, keeper, forward, !passive);
    if (!response) {
      // 204 tells EventSource to stop reconnecting.
      return passive
        ? new Response(null, { status: 204 })
        : wakingResponse(request);
    }

    if (!passive && Date.now() - lastTouchMs >= EXTEND_EVERY_MS) {
      lastTouchMs = Date.now();
      ctx.waitUntil(keeper.touch());
    }

    const result = outward(response);
    if (fingerprinted && result.status === 200) {
      // The runtime has already decoded the body. A cached copy that keeps
      // the header is gzipped a second time when the cache serves it.
      result.headers.delete('content-encoding');
      result.headers.delete('content-length');
      result.headers.set(
        'cache-control',
        'public, max-age=31536000, immutable',
      );
      ctx.waitUntil(caches.default.put(request, result.clone()));
    }
    return result;
  },
};

/**
 * The one place that calls the boat API. Every isolate sends its wake and
 * touch calls here, so many visitors cause one resume and one extend a minute.
 */
export class SandboxKeeper extends DurableObject {
  waking = null;
  lastExtendMs = 0;

  wake() {
    this.waking ??= this.resumeAndWait().finally(() => {
      this.waking = null;
    });
    return this.waking;
  }

  async touch() {
    if (Date.now() - this.lastExtendMs < EXTEND_EVERY_MS) return;
    this.lastExtendMs = Date.now();
    const response = await this.boat('PATCH', '', { ttlSeconds });
    if (!response.ok) console.log(`extend failed: HTTP ${response.status}`);
  }

  async isRunning() {
    return !STOPPED_STATES.has(await this.sandboxState());
  }

  async resumeAndWait() {
    const deadline = Date.now() + WAKE_BUDGET_MS;
    let resumed = false;
    while (Date.now() < deadline) {
      if (!resumed) {
        const state = await this.sandboxState();
        if (state === 'archived') {
          const response = await this.boat('POST', '/resume', { ttlSeconds });
          console.log(`resume sent: HTTP ${response.status}`);
          resumed = response.ok;
          this.lastExtendMs = Date.now();
        } else if (state !== 'archiving') {
          resumed = true;
        }
      }
      if (resumed) {
        const probe = await toSandbox(
          this.env,
          { method: 'GET', path: '/' },
          AbortSignal.timeout(PROBE_TIMEOUT_MS),
        );
        if (probe && isUp(probe)) return true;
      }
      await sleep(POLL_MS);
    }
    return false;
  }

  async sandboxState() {
    const response = await this.boat('GET', '');
    if (!response.ok) return 'unknown';
    const body = await response.json();
    return (body.sandbox ?? body).state;
  }

  boat(method, suffix, body) {
    return fetch(`${BOAT_API}/sandboxes/${this.env.SANDBOX_ID}${suffix}`, {
      method,
      headers: {
        authorization: `Bearer ${this.env.BOAT_API_KEY}`,
        'content-type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  }
}
