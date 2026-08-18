import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const ignoredDirectories = new Set(['.git', 'node_modules']);
const requiredFiles = [
  '.github/dependabot.yml',
  '.github/workflows/ci.yml',
  'LICENSE',
  'README.md',
  'SECURITY.md',
  'compose.yaml',
  'docs/adr/0001-postgres-hybrid-fanout-and-feed-sessions.md',
  'docs/api.md',
  'docs/architecture.md',
  'docs/closed-book-contract.md',
  'docs/operations.md',
  'docs/requirements.md',
  'docs/research-log.md',
  'docs/threat-model.md',
  'docs/verification.md',
  'package-lock.json',
];

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (ignoredDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

const files = walk(root);
const names = new Set(files.map((file) => relative(root, file)));
for (const name of requiredFiles) assert.ok(names.has(name), `missing required file: ${name}`);

for (const file of files.filter((path) => ['.js', '.mjs'].includes(extname(path)))) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
}

const textExtensions = new Set(['.js', '.json', '.md', '.mjs', '.yml', '.yaml']);
const localMacPrefix = ['/', 'Users', '/'].join('');
for (const file of files.filter((path) => textExtensions.has(extname(path)))) {
  const fileText = readFileSync(file, 'utf8');
  const name = relative(root, file);
  assert.ok(!/[\t ]+$/m.test(fileText), `${name} contains trailing whitespace`);
  assert.ok(!fileText.includes('\r\n'), `${name} contains CRLF line endings`);
  assert.ok(!fileText.includes(localMacPrefix), `${name} contains a local macOS path`);
  assert.ok(!/[A-Za-z]:\\Users\\/.test(fileText), `${name} contains a local Windows path`);
  assert.ok(!/(?:ghp|github_pat)_[A-Za-z0-9_]{20,}/.test(fileText), `${name} resembles a GitHub token`);
  assert.ok(!/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(fileText), `${name} contains a private key`);
  if (name.startsWith('test/')) {
    assert.ok(!/(?:test|describe)\.skip\s*\(/.test(fileText), `${name} contains a skipped test`);
  }
}

const markdownLinks = /!?\[[^\]]*\]\(([^)]+)\)/g;
for (const file of files.filter((path) => extname(path) === '.md')) {
  const fileText = readFileSync(file, 'utf8');
  for (const match of fileText.matchAll(markdownLinks)) {
    const rawTarget = match[1].trim().replace(/^<|>$/g, '').split(/\s+['"]/)[0];
    if (/^(?:https?:|mailto:|#)/.test(rawTarget)) continue;
    const target = decodeURIComponent(rawTarget.split('#')[0]);
    if (target.length === 0) continue;
    assert.ok(existsSync(resolve(dirname(file), target)), `${relative(root, file)} has broken link: ${rawTarget}`);
  }
}

const workflow = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
for (const match of workflow.matchAll(/^\s*uses:\s*([^\s]+)(?:\s+#.*)?$/gm)) {
  assert.match(match[1], /@[a-f0-9]{40}$/, `GitHub Action is not pinned by commit: ${match[1]}`);
}
assert.match(workflow, /postgres:17\.6-alpine/);
assert.match(workflow, /node:\s*\[22, 24, 26\]/);

const verification = readFileSync(join(root, 'docs/verification.md'), 'utf8');
assert.match(verification, /screen display/i);
assert.match(verification, /does not prove/i);

process.stdout.write(`${JSON.stringify({
  kind: 'repository_static_receipt',
  files: files.length,
  javascriptFiles: files.filter((path) => ['.js', '.mjs'].includes(extname(path))).length,
  markdownFiles: files.filter((path) => extname(path) === '.md').length,
  actionPins: [...workflow.matchAll(/^\s*uses:/gm)].length,
})}\n`);
