# The godmaps.ai deployment

This directory runs God's Eye View as a public demo. A Cloudflare Worker answers on the public hostname and forwards each request to a boat.dev sandbox. The sandbox runs only while people use the site.

To deploy, follow [the deploy-boat skill](../.agents/skills/deploy-boat/SKILL.md). This page explains how the parts work.

## How a request travels

```text
browser -> Cloudflare Worker -> boat public URL -> gate (Caddy) -> app (vite preview)
           deploy/worker                           deploy/Caddyfile  repo Dockerfile
```

The app is a Vite single-page app. Its `/api/*` routes are middleware in the same Node process, so `vite preview` serves the built site and the API together. The app was written for one person on one computer. It refuses any `Host` it does not know, and it refuses a cost-bearing request that carries a forwarding header or an `Origin` that is not its own. The gate and the Worker make that app reachable without editing it.

`deploy/config.json` holds every value that is not a secret. The Worker imports the file. `boat-deploy.sh` generates the gate's environment from the file.

| Key               | Meaning                                                                  |
| ----------------- | ------------------------------------------------------------------------ |
| `publicHost`      | The hostname visitors use.                                               |
| `sandboxName`     | The name of the boat sandbox. The script finds the sandbox by this name. |
| `sandboxPort`     | The port the gate listens on, which boat exposes.                        |
| `idleMinutes`     | How long the sandbox stays up after the last request.                    |
| `blockedPrefixes` | Path prefixes that answer 404.                                           |

## The sandbox

`compose.yaml` runs two containers. Both restart when the sandbox resumes.

- **`app`** is the image from the repository's own `Dockerfile`. It runs `vite build` once per container, then `vite preview`. No port of this container is published. Its keys come from `/home/user/godmaps-env/app.env` on the sandbox, outside the checkout.
- **`gate`** is Caddy on the published port. `Caddyfile` is the whole policy.

The gate does the following to each request:

1. It answers 403 unless the request carries the shared secret in the `X-Godmaps-Gate` header. Only the Worker knows the secret, so a request sent straight to the boat URL fails.
2. It answers 404 for the blocked prefixes: `/mcp`, `/api/setup/`, `/api/realtime/oauth-`, `/api/realtime/debug-log`, and `/api/local-receivers/`. These routes serve a local operator. One of them writes to disk.
3. It deletes the nine forwarding headers that the app treats as proof of a proxy, and the secret header.
4. It sets `Host` to the public hostname, which `GEV_ALLOWED_HOSTS` allows.
5. It rewrites `Origin` only when the value is exactly `https://<publicHost>`. The new value is `http://<publicHost>`, which is what the app computes for its own plain-http hop. Every other `Origin` passes through unchanged, so the app still refuses a cross-site request. `Sec-Fetch-Site` passes through untouched.
6. It adds `X-Robots-Tag: noindex, nofollow` to every response.

## The Worker

`worker/src/index.js` does five jobs.

- **Proxy.** It forwards every request to the sandbox's boat URL with the secret header.
- **Wake.** A stopped sandbox does not refuse a connection. It never answers. When the sandbox sends no headers for 1.5 seconds, the Worker asks the boat API for the sandbox state. If the sandbox is stopped, the Worker resumes it, waits up to 20 seconds for the app to answer through the gate, and then sends the request. If the wait runs out, the visitor gets a 503 page that reloads itself. boat keeps a stopped machine for 10 minutes. A wake inside that window measured about 3 seconds. A wake after it starts a new machine and restarts the containers, and measured about 45 seconds. A request that is only slow is never sent twice.
- **Stay up while in use.** At most once a minute, the Worker sets the sandbox's remaining lifetime to `idleMinutes`. boat's auto-stop is a countdown, not an idle detector, so the sandbox stops `idleMinutes` after the last request.
- **Rate limit.** Each client IP gets 300 requests a minute to `/api/*`, through the Workers Rate Limiting binding. The free plan includes that binding and it needs no storage. The app's own rate limits key on the socket address, so behind the gate all visitors share each of the app's buckets.
- **Cache and robots.** The Worker serves `/robots.txt` as disallow-all. It caches `/assets/*` at the edge for a year, because Vite puts a content hash in those file names. A cached asset does not reach the sandbox.

All boat API calls go through one Durable Object, `SandboxKeeper`. Cloudflare runs many copies of a Worker, and each copy sees its own visitors. The Durable Object is the single place where concurrent wake requests join one resume and where the once-a-minute limit holds.

The route `/api/ghostmaps/events` is a server-sent-events stream that the browser reconnects by itself. A forgotten tab would wake the sandbox forever. So this route never resumes the sandbox and never extends its lifetime. While the sandbox is stopped, the route answers 204, which tells the browser to stop reconnecting.

The Worker has four secrets and no plain variables: `SANDBOX_ID`, `SANDBOX_URL`, `GATE_SECRET`, and `BOAT_API_KEY`. The boat key is scoped to the one sandbox with the actions `sandbox.read`, `sandbox.resume`, and `sandbox.update`. It cannot stop, delete, or run a command.

## Cost

- **boat.** A `small` sandbox costs $0.018 an hour while it runs and nothing while stopped. One visit keeps it up for about `idleMinutes`, so about $0.009. Running all month would cost about $13. The $20 plan allows 60 starts an hour and 200 a day.
- **Cloudflare.** The Workers free plan allows 100,000 requests a day. The Durable Object uses the SQLite backend, which the free plan includes.

## Security posture

The demo has no login. Anyone can use every route the gate leaves open, at the rate limit above.

- **Blocked.** A direct request to the boat URL, the five prefixes above, and any cross-site browser request to a cost-bearing route.
- **Open.** The page, its static files, and every other `/api/*` route. A visitor can spend the quota of each server key you configure, so configure free keys only.
- **Public by design.** `GOOGLE_MAPS_API_KEY`, `CESIUM_ION_TOKEN`, and `MAPILLARY_CLIENT_TOKEN` are in the browser bundle. Restrict them at the provider.
- **Sandbox.** The sandbox is created with `--no-env`, so it holds none of the boat account's stored secrets.
- **Search engines.** `robots.txt` and the `X-Robots-Tag` header ask crawlers to stay away.

Known limits:

- An open tab polls the API, so it keeps the sandbox up for as long as it stays open.
- The first visitor after more than 10 minutes without traffic sees the "starting" page for about 45 seconds.
- The Worker's boat key expires. `boat-deploy.sh worker-key` prints the date. After that date the Worker cannot resume the sandbox.

## Check a deployment

Replace `https://godmaps.ai` with `http://localhost:8787` to check `npx wrangler dev`.

| Request                                                                                        | Expected answer                                                                                           |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `GET` the boat URL without the secret header                                                   | 403                                                                                                       |
| `GET https://godmaps.ai/`                                                                      | 200                                                                                                       |
| `GET https://godmaps.ai/api/military`                                                          | 200                                                                                                       |
| `POST /api/realtime/token` with `Origin: https://godmaps.ai` and `Sec-Fetch-Site: same-origin` | 503 with "OPENAI_API_KEY is not set". The 503 proves that the app's same-site check admitted the request. |
| The same `POST` with `Origin: https://evil.example`                                            | 403                                                                                                       |
| `POST /api/realtime/debug-log`, `GET /mcp`, `GET /api/setup/status`                            | 404                                                                                                       |
| `GET /robots.txt`                                                                              | `Disallow: /`                                                                                             |

## GitHub Actions

Both workflows run on GitHub-hosted runners only. `scripts/godmaps-check-runners.mjs` fails the build when a workflow names any other runner.

`godmaps-ci.yml` runs `node scripts/godmaps-check.mjs` on every push to `godmaps`. On a pull request into `godmaps` it runs only the runner check and the upstream record check, because upstream's `ci.yml` already runs the rest.

`godmaps-deploy.yml` deploys the pushed commit to the sandbox and then deploys the Worker. It then requests an `/api` route on the sandbox URL without the gate secret and fails unless the answer is 403. The job reads its secrets from the `production` environment. When a required secret is missing, the job names the missing secrets in a notice and ends green.

| Secret                  | Value                                                                                                                            |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | A token from the **Edit Cloudflare Workers** template, limited to the one account and the one zone.                              |
| `CLOUDFLARE_ACCOUNT_ID` | The account that holds the zone.                                                                                                 |
| `BOAT_DEPLOY_API_KEY`   | A boat key scoped to the sandbox with the actions `sandbox.read`, `sandbox.resume`, `sandbox.update`, `exec`, `ssh`, and `host`. |
| `BOAT_WORKER_API_KEY`   | The content of `~/.config/godmaps/boat-worker-key`.                                                                              |
| `GODMAPS_SANDBOX_ID`    | The content of `~/.config/godmaps/sandbox-id`.                                                                                   |
| `GODMAPS_GATE_SECRET`   | The content of `~/.config/godmaps/gate-secret`.                                                                                  |
| `GODMAPS_APP_ENV`       | Optional. The content of the app's dotenv file. When it is not set, the sandbox keeps the keys it has.                           |

The workflow needs no repository variables, because `deploy/config.json` holds every value that is not a secret.

## Sync with upstream

[UPSTREAM.md](UPSTREAM.md) lists every file this fork adds and gives the sync steps.
