# Agent instructions

This repository is avellan-ai/godmaps.ai, a public fork of bilawalsidhu/gods-eye-view.
The `godmaps` branch runs the app as a public demo at godmaps.ai. A Cloudflare Worker
sits in front of a boat.dev sandbox that runs only while people use the site. Everything
in `deploy/`, `scripts/godmaps-*.mjs`, `.github/workflows/godmaps-*.yml`, and
`.agents/skills/deploy-boat/` belongs to this fork. Everything else belongs to upstream.

## Ways to cause harm here

Read this section before you change anything.

- **A pull request can go to the wrong repository.** In a fork, `gh pr create` targets
  the upstream repository by default. Pass `--repo avellan-ai/godmaps.ai --base godmaps`
  on every `gh pr` command. Never open a pull request or an issue against
  bilawalsidhu/gods-eye-view.
- **Never open a pull request unless someone asked for one.**
- **Do not edit upstream files.** Add files instead, so that a sync with upstream merges
  without conflicts. If an upstream edit is the only fix, make the smallest edit and
  record it in `deploy/UPSTREAM.md`. Never commit to `main`. The `main` branch mirrors
  upstream.
- **Do not expose the app without the gate.** The app was written to run on one person's
  computer. Its Node server holds API keys, writes log files, and has a key setup panel.
  `deploy/Caddyfile` is the only thing that makes it safe on the internet. Never publish
  the `app` container's port, never run `npm run dev` on a public machine, and never
  create a sandbox without `--no-env`.
- **Never commit a secret.** This repository is public. Keys, tokens, the gate secret,
  the sandbox id, the sandbox URL, and the Cloudflare account id live in
  `~/.config/godmaps/`, in the sandbox's env files, in Worker secrets, or in GitHub
  environment secrets. A pre-push hook scans for secrets. Do not bypass it.
- **Three keys are public by design.** The build writes `GOOGLE_MAPS_API_KEY`,
  `CESIUM_ION_TOKEN`, and `MAPILLARY_CLIENT_TOKEN` into the browser bundle, so every
  visitor can read them. Use only free keys with a referrer or URL restriction for
  godmaps.ai.
- **No self-hosted runner, for any reason.** Every workflow runs on a GitHub-hosted
  runner. Do not write `runs-on: self-hosted`, a self-hosted label, a runner group, or
  an expression in `runs-on`. Do not register a runner for this repository.
  `scripts/godmaps-check-runners.mjs` fails the build if a workflow breaks this rule.
- **Do not add a `CLAUDE.md`.** This file is the one instruction file for every agent.
- **Commit no plans and no scratch files.** Keep notes outside the repository.
- **Stay in scope.** The demo has no login, no paid-key features, and no LiveKit voice.
  Ask before you add any of them.

## Verify a change

Run one command. It needs Node 24.22.2 and `npm ci`.

```sh
node scripts/godmaps-check.mjs
```

The command runs upstream CI's checks in upstream's order: `npm run doctor`,
`npm run format:check`, `npm run check:boundaries`, `npm test`, and `npm run build`. It
then runs the check for self-hosted runners and the check that `deploy/UPSTREAM.md`
matches git. The workflow `godmaps-ci.yml` runs the same command on every push to
`godmaps`.

Do not write new unit tests for the files this fork adds. Prove a change to `deploy/`
against the real sandbox and the real Worker. `deploy/README.md` lists the requests to
send and the answers to expect.

## Deploy

Follow `.agents/skills/deploy-boat/SKILL.md`. It covers a first deploy of your own copy
and an update of an existing one. `deploy/README.md` explains how the parts work, what
they cost, and what the gate blocks.

A push to `godmaps` deploys through `godmaps-deploy.yml` when the `production`
environment holds the deploy secrets. Without the secrets, the workflow reports which
secrets are missing and ends.

All deployment values that are not secret live in `deploy/config.json`: the public
hostname, the sandbox name and port, the idle minutes, and the blocked route prefixes.
The Worker imports that file, and `deploy/boat-deploy.sh` generates the gate's
environment from it. Do not repeat those values in another file.

## Sync with upstream

Follow the steps in `deploy/UPSTREAM.md`. They fetch `upstream`, push `upstream/main` to
`origin main`, merge `upstream/main` into a branch cut from `godmaps`, run
`node scripts/godmaps-upstream-diff.mjs --write`, run the verify command, and open a
pull request into `godmaps`.

To see what this fork changes, run `node scripts/godmaps-upstream-diff.mjs`.
