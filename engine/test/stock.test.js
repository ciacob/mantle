'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { loadEnv, findMissingEnv, runShell, readAsset } = require('../stock');

// ── loadEnv ───────────────────────────────────────────────────────────────────

function makeFileIO(files = {}) {
  return {
    exists: (p) => p in files,
    read:   (p) => files[p] ?? '',
  };
}

test('loadEnv: returns empty object when no .env file exists', () => {
  const result = loadEnv('/descriptor', makeFileIO({}));
  assert.deepEqual(result, {});
});

test('loadEnv: parses key=value pairs', () => {
  const files = { '/desc/.env': 'FOO=bar\nBAZ=qux\n' };
  const result = loadEnv('/desc', makeFileIO(files));
  assert.equal(result.FOO, 'bar');
  assert.equal(result.BAZ, 'qux');
});

test('loadEnv: empty value in .env file is loaded as empty string', () => {
  const files = { '/desc/.env': 'EMPTY=\n' };
  // Temporarily ensure process.env does not have EMPTY set
  const prev = process.env.EMPTY;
  delete process.env.EMPTY;
  const result = loadEnv('/desc', makeFileIO(files));
  if (prev !== undefined) process.env.EMPTY = prev;
  assert.equal(result.EMPTY, '');
});

test('loadEnv: shell env takes precedence over .env file value', () => {
  const files = { '/desc/.env': 'OVERRIDE=from-file\n' };
  process.env.OVERRIDE = 'from-shell';
  const result = loadEnv('/desc', makeFileIO(files));
  delete process.env.OVERRIDE;
  assert.equal(result.OVERRIDE, 'from-shell');
});

test('loadEnv: .env value used when shell env is not set', () => {
  const files = { '/desc/.env': 'ONLY_IN_FILE=hello\n' };
  delete process.env.ONLY_IN_FILE;
  const result = loadEnv('/desc', makeFileIO(files));
  assert.equal(result.ONLY_IN_FILE, 'hello');
});

test('loadEnv: uses injected dotenvParse', () => {
  const files  = { '/desc/.env': 'X=1' };
  const fakeParse = () => ({ INJECTED: 'yes' });
  const result = loadEnv('/desc', makeFileIO(files), fakeParse);
  assert.equal(result.INJECTED, 'yes');
});

// ── findMissingEnv ────────────────────────────────────────────────────────────

test('findMissingEnv: returns empty array when all vars have values', () => {
  const env = { FOO: 'bar', BAZ: 'qux' };
  assert.deepEqual(findMissingEnv(env), []);
});

test('findMissingEnv: returns keys with empty string values', () => {
  const env = { FOO: 'bar', MISSING: '' };
  assert.deepEqual(findMissingEnv(env), ['MISSING']);
});

test('findMissingEnv: returns keys with null or undefined values', () => {
  const env = { A: null, B: undefined, C: 'ok' };
  const missing = findMissingEnv(env);
  assert.ok(missing.includes('A'));
  assert.ok(missing.includes('B'));
  assert.ok(!missing.includes('C'));
});

test('findMissingEnv: returns all missing keys', () => {
  const env = { X: '', Y: '', Z: 'set' };
  const missing = findMissingEnv(env);
  assert.equal(missing.length, 2);
  assert.ok(missing.includes('X') && missing.includes('Y'));
});

// ── runShell ──────────────────────────────────────────────────────────────────

test('runShell: returns trimmed stdout on success', () => {
  const fakeExec = (_cmd, _opts) => '  hello world  \n';
  const result   = runShell('echo hello', {}, fakeExec);
  assert.equal(result, 'hello world');
});

test('runShell: throws on non-zero exit with stderr message', () => {
  const fakeExec = () => {
    const err    = new Error('Command failed');
    err.stderr   = 'something went wrong';
    throw err;
  };
  assert.throws(
    () => runShell('bad-cmd', {}, fakeExec),
    /something went wrong/
  );
});

test('runShell: includes the command in the error message', () => {
  const fakeExec = () => { throw new Error('exit code 1'); };
  assert.throws(
    () => runShell('my-failing-cmd', {}, fakeExec),
    /my-failing-cmd/
  );
});

test('runShell: returns empty string when execSync returns non-string', () => {
  const fakeExec = () => null;
  const result   = runShell('cmd', {}, fakeExec);
  assert.equal(result, '');
});

// ── readAsset ─────────────────────────────────────────────────────────────────

function makeAssetIO(files = {}) {
  return {
    read:       (p) => { if (!(p in files)) throw new Error(`Not found: ${p}`); return files[p]; },
    readBinary: (p) => { if (!(p in files)) throw new Error(`Not found: ${p}`); return Buffer.from(files[p]); },
  };
}

test('readAsset: reads text file from assets dir', () => {
  const assetsDir = '/desc/assets';
  const fileIO    = makeAssetIO({ '/desc/assets/template.html': '<html/>' });
  const result    = readAsset(assetsDir, 'template.html', {}, fileIO);
  assert.equal(result, '<html/>');
});

test('readAsset: returns Buffer when binary:true', () => {
  const assetsDir = '/desc/assets';
  const fileIO    = makeAssetIO({ '/desc/assets/icon.icns': 'binary data' });
  const result    = readAsset(assetsDir, 'icon.icns', { binary: true }, fileIO);
  assert.ok(Buffer.isBuffer(result));
});

test('readAsset: returns Buffer when encoding:null', () => {
  const assetsDir = '/desc/assets';
  const fileIO    = makeAssetIO({ '/desc/assets/data.bin': 'data' });
  const result    = readAsset(assetsDir, 'data.bin', { encoding: null }, fileIO);
  assert.ok(Buffer.isBuffer(result));
});

test('readAsset: reads nested path', () => {
  const assetsDir = '/desc/assets';
  const fileIO    = makeAssetIO({ '/desc/assets/sub/config.json': '{"x":1}' });
  const result    = readAsset(assetsDir, 'sub/config.json', {}, fileIO);
  assert.equal(result, '{"x":1}');
});

test('readAsset: throws on path traversal', () => {
  const assetsDir = '/desc/assets';
  const fileIO    = makeAssetIO({ '/etc/passwd': 'sensitive' });
  assert.throws(
    () => readAsset(assetsDir, '../../etc/passwd', {}, fileIO),
    /path traversal/
  );
});
