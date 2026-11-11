#!/usr/bin/env node
/**
 * Prints what this branch changes relative to upstream: the upstream commit it
 * is built on, every file it adds and every upstream file it modifies.
 *
 *   node scripts/godmaps-upstream-diff.mjs           print the record
 *   node scripts/godmaps-upstream-diff.mjs --write   update deploy/UPSTREAM.md
 *   node scripts/godmaps-upstream-diff.mjs --check   fail when the doc is stale
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const UPSTREAM_URL = 'https://github.com/bilawalsidhu/gods-eye-view.git';
const DOC = 'deploy/UPSTREAM.md';
const BEGIN = '<!-- upstream-diff:begin -->';
const END = '<!-- upstream-diff:end -->';

const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 26 }).trim();

function upstreamRef() {
  try {
    return git('rev-parse', '--verify', '--quiet', 'upstream/main');
  } catch {
    git('fetch', '--quiet', UPSTREAM_URL, 'main');
    return git('rev-parse', 'FETCH_HEAD');
  }
}

function record() {
  const base = git('merge-base', upstreamRef(), 'HEAD');
  const changes = git('diff', '--name-status', '--no-renames', base, 'HEAD')
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t'));
  const list = (status) => {
    const files = changes.filter(([s]) => s === status).map(([, file]) => file);
    return files.length ? files.map((file) => `- \`${file}\``) : ['- none'];
  };
  return [
    `Built on upstream commit \`${base}\`.`,
    '',
    'Upstream files modified:',
    '',
    ...list('M'),
    '',
    'Upstream files deleted:',
    '',
    ...list('D'),
    '',
    'Files added:',
    '',
    ...list('A'),
  ].join('\n');
}

function withRecord(doc, text) {
  const start = doc.indexOf(BEGIN);
  const end = doc.indexOf(END);
  if (start === -1 || end === -1)
    throw new Error(`${DOC} has no record markers`);
  return `${doc.slice(0, start + BEGIN.length)}\n\n${text}\n\n${doc.slice(end)}`;
}

const mode = process.argv[2];
const text = record();
if (mode === '--write') {
  writeFileSync(DOC, withRecord(readFileSync(DOC, 'utf8'), text));
} else if (mode === '--check') {
  const doc = readFileSync(DOC, 'utf8');
  if (withRecord(doc, text) !== doc) {
    console.error(
      `${DOC} does not match git. Run: node scripts/godmaps-upstream-diff.mjs --write`,
    );
    process.exit(1);
  }
  console.log(`upstream record ok: ${DOC} matches git`);
} else {
  console.log(text);
}
