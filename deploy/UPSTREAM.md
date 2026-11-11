# What differs from upstream

Upstream is [bilawalsidhu/gods-eye-view](https://github.com/bilawalsidhu/gods-eye-view). The `main` branch of this fork mirrors upstream `main` and is never edited. The `godmaps` branch is upstream plus the files listed below.

The rule for this fork is to add files and not edit upstream files. A sync with upstream then merges without conflicts. If an upstream edit is the only fix for a problem, make the smallest edit and say why in the table in this section.

| Upstream file | Why it is modified |
| ------------- | ------------------ |
| none          |                    |

## The record

`scripts/godmaps-upstream-diff.mjs` writes the block below from git. Do not edit the block by hand. `node scripts/godmaps-check.mjs` fails when the block does not match git. To update the block, run `node scripts/godmaps-upstream-diff.mjs --write`.

<!-- upstream-diff:begin -->

Built on upstream commit `962f7293c60f132acc7c80778c3e43890408bf5b`.

Upstream files modified:

- none

Upstream files deleted:

- none

Files added:

- `.agents/skills/deploy-boat/SKILL.md`
- `.github/workflows/godmaps-ci.yml`
- `.github/workflows/godmaps-deploy.yml`
- `AGENTS.md`
- `deploy/Caddyfile`
- `deploy/README.md`
- `deploy/UPSTREAM.md`
- `deploy/boat-deploy.sh`
- `deploy/compose.yaml`
- `deploy/config.json`
- `deploy/worker/.gitignore`
- `deploy/worker/src/index.js`
- `deploy/worker/wrangler.jsonc`
- `scripts/godmaps-check-runners.mjs`
- `scripts/godmaps-check.mjs`
- `scripts/godmaps-upstream-diff.mjs`

<!-- upstream-diff:end -->

## Sync with upstream

1. Fetch upstream and move the mirror branch forward.

   ```sh
   git fetch upstream
   git push origin upstream/main:main
   ```

2. Merge upstream into `godmaps` on a branch.

   ```sh
   git switch -c sync-upstream origin/godmaps
   git merge upstream/main
   ```

3. Update the record, because the upstream commit changed.

   ```sh
   node scripts/godmaps-upstream-diff.mjs --write
   git commit -am "Update the upstream record"
   ```

4. Run `node scripts/godmaps-check.mjs`. Read the diff of `Dockerfile`, `build/allowedHosts.js`, `src/localRequestGate.mjs`, and `.github/workflows/` in the merge. The gate in `deploy/Caddyfile` depends on the first three. A new workflow must use a GitHub-hosted runner.

5. Open a pull request with `gh pr create --repo avellan-ai/godmaps.ai --base godmaps`. A push to `godmaps` deploys the merged commit.
