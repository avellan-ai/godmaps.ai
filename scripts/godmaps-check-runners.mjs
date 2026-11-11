#!/usr/bin/env node
/**
 * Fails when a workflow can run on anything but a GitHub-hosted runner.
 * Every `runs-on` must be one literal hosted label on its own line, so a
 * list, a runner group or an expression fails too: any of them can name a
 * self-hosted runner.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const HOSTED_LABEL = /^(ubuntu|windows|macos)-[a-z0-9.-]+$/;
const RUNS_ON_LINE = /^\s*(?:-\s*)?runs-on\s*:\s*(.*?)\s*(?:#.*)?$/;

/** @returns {string[]} One message per violation in the workflow text. */
function runnerViolations(name, text) {
  const violations = [];
  let read = 0;
  text.split('\n').forEach((line, index) => {
    const where = `${name}:${index + 1}`;
    const match = RUNS_ON_LINE.exec(line);
    if (match) read += 1;
    if (/self-hosted/i.test(line)) {
      violations.push(`${where} names a self-hosted runner`);
      return;
    }
    if (!match) return;
    const label = match[1].replace(/^(['"])(.*)\1$/, '$2');
    if (!HOSTED_LABEL.test(label)) {
      violations.push(
        `${where} runs-on is not one hosted label: ${line.trim()}`,
      );
    }
  });
  const mentions = text.match(/runs-on/g)?.length ?? 0;
  if (mentions !== read) {
    violations.push(
      `${name} mentions runs-on in a form this check cannot read`,
    );
  }
  return violations;
}

const dir = process.argv[2] ?? '.github/workflows';
const violations = readdirSync(dir)
  .filter((file) => /\.ya?ml$/.test(file))
  .flatMap((file) =>
    runnerViolations(join(dir, file), readFileSync(join(dir, file), 'utf8')),
  );
for (const violation of violations) console.error(violation);
if (violations.length > 0) {
  console.error('Workflows in this repo run on GitHub-hosted runners only.');
  process.exit(1);
}
console.log(`runners ok: every runs-on in ${dir} is a GitHub-hosted label`);
