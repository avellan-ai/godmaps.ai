#!/usr/bin/env node
/**
 * The one verify command for the godmaps branch: upstream CI's checks in
 * upstream's order (.github/workflows/ci.yml, job `verify`), then the two
 * checks this fork adds. Stops at the first failure.
 */
import { spawnSync } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const STEPS = [
  [npm, 'run', 'doctor', '--', '--json'],
  [npm, 'run', 'format:check'],
  [npm, 'run', 'check:boundaries'],
  [npm, 'test'],
  [npm, 'run', 'build'],
  ['node', 'scripts/godmaps-check-runners.mjs'],
  ['node', 'scripts/godmaps-upstream-diff.mjs', '--check'],
];

for (const [command, ...args] of STEPS) {
  console.log(`\n== ${[command, ...args].join(' ')}`);
  const { status } = spawnSync(command, args, { stdio: 'inherit' });
  if (status !== 0) {
    console.error(`\ngodmaps-check failed at: ${[command, ...args].join(' ')}`);
    process.exit(status ?? 1);
  }
}
console.log('\ngodmaps-check passed');
