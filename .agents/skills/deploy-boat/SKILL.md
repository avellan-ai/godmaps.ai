---
name: deploy-boat
description: Deploy God's Eye View as a public demo on a boat.dev sandbox behind a Cloudflare Worker, or update an existing deployment. Use to deploy your own copy to boat.dev, redeploy after a change or an upstream sync, rotate the gate secret or the boat key, or check a deployment; not for local development.
---

# Deploy to boat.dev

Read [AGENTS.md](../../../AGENTS.md) first, then [deploy/README.md](../../../deploy/README.md) for how the parts work. Never commit a secret. Every secret below lives in `~/.config/godmaps/`, on the sandbox, or in the Worker.

You need a boat.dev account with the `boat` CLI signed in, a Cloudflare account with the domain as an active zone, `git`, `jq`, `curl`, `openssl`, and Node 22 or later.

## 1. Set the deployment values

Edit `deploy/config.json`. Set `publicHost` to your domain and `sandboxName` to a name that is unique in your boat account. Leave the other values unless you have a reason. Commit the change, because the deploy copies the `HEAD` commit, not the working tree.

## 2. Collect the keys

The app runs without any key. It starts on keyless imagery and the keyless data layers. Each key adds a layer. `.env.example` documents every key and where to get it. Write the keys you have into one dotenv file outside the repository, for example `~/.config/godmaps/app.env`, with mode 600.

- **Public keys.** The build writes `GOOGLE_MAPS_API_KEY`, `CESIUM_ION_TOKEN`, and `MAPILLARY_CLIENT_TOKEN` into the browser bundle, and every visitor can read them. Use a free key and restrict it to your domain at the provider. Cesium ion and Mapillary have free plans. A Google Maps key needs a billing account, so leave it out of a free demo.
- **Server keys.** Every other key stays in the app container. Free ones include `FIRMS_MAP_KEY`, `TOMTOM_API_KEY`, `AISSTREAM_API_KEY`, `WORLDNEWSAPI_KEY`, and the OpenSky credentials.
- **Keys to leave out of a free demo.** `OPENAI_API_KEY` and `GEMINI_API_KEY` let any visitor spend your money on voice and chat.

## 3. Deploy the sandbox

```sh
deploy/boat-deploy.sh all ~/.config/godmaps/app.env
```

Omit the file to keep the keys that are already on the sandbox. The command creates the sandbox with `--no-env` or reuses the one named in `config.json`, copies `HEAD`, starts the `app` and `gate` containers, exposes the gate's port, waits until the app answers through the gate, and creates a boat API key for the Worker. A first run takes a few minutes, because it builds the image and the browser bundle. A second run with nothing changed converges to the same state.

The command prints the names of four Worker secrets and the files that hold them. It never prints a value. A boat key cannot outlive the login that creates it. If boat refuses the key, set `GODMAPS_KEY_TTL` to a shorter lifetime such as `80d`, and note the expiry date the command prints.

## 4. Check the gate before you add Cloudflare

```sh
url=$(cat ~/.config/godmaps/sandbox-url)
curl -s -o /dev/null -w '%{http_code}\n' "$url/"
curl -s -o /dev/null -w '%{http_code}\n' -H "X-Godmaps-Gate: $(cat ~/.config/godmaps/gate-secret)" "$url/"
```

The first request must print `403` and the second `200`. If the first request prints anything else, the app is exposed. Stop and fix the gate.

## 5. Deploy the Worker

Sign in to Cloudflare with `npx wrangler login`, or set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The token needs the **Edit Cloudflare Workers** template, limited to your account and your zone.

```sh
deploy/boat-deploy.sh worker
```

The command deploys `deploy/worker` to the custom domain in `config.json` and uploads the four secrets. To try the Worker on your computer first, write the four secrets to `deploy/worker/.dev.vars`, which git ignores, and run `npx wrangler dev` in `deploy/worker`.

## 6. Prove the deployment

Run the requests in the "Check a deployment" section of `deploy/README.md` against your domain. Then run `boat stop` on the sandbox, wait until `boat info` shows it stopped, and load the site. The page must answer within about 5 seconds. After more than 10 minutes stopped, expect a "starting" page that reloads itself for about 45 seconds.

## Update, rotate, remove

- **Update.** Commit, then run `deploy/boat-deploy.sh sandbox`. Run `deploy/boat-deploy.sh worker` too when `deploy/worker` or `deploy/config.json` changed. With the GitHub secrets in place, a push to `godmaps` does both. The "GitHub Actions" section of `deploy/README.md` lists the secrets.
- **Rotate the gate secret.** Delete `~/.config/godmaps/gate-secret`, then run `sandbox` and `worker`. The site answers 503 between the two commands.
- **Rotate the boat key.** Revoke the old key with `boat api-key revoke`, delete `~/.config/godmaps/boat-worker-key`, then run `worker-key` and `worker`.
- **Remove.** Delete the Worker in Cloudflare, run `boat delete` on the sandbox, and revoke the boat key.

Report the sandbox id, the commit, the result of each check, and the expiry date of the boat key. Never report a secret value.
