'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const {
  localRegistryPath, globalRegistryPath,
  parseAndValidate, load,
  addDescriptor, setEnabled, moveDescriptor, setConfig,
  readRaw, writeRaw,
} = require('../registry');

// ── Path helpers ──────────────────────────────────────────────────────────────

test('localRegistryPath: returns cwd/mantle.json', () => {
  const p = localRegistryPath('/my/project');
  assert.ok(p.endsWith('mantle.json'));
  assert.ok(p.includes('my') && p.includes('project'));
});

test('globalRegistryPath: returns home/.mantle.json', () => {
  const p = globalRegistryPath('/home/user');
  assert.ok(p.endsWith('.mantle.json'));
  assert.ok(p.includes('home') && p.includes('user'));
});

// ── parseAndValidate ──────────────────────────────────────────────────────────

test('parseAndValidate: returns ok:true for valid JSON', () => {
  const r = parseAndValidate('{"descriptors":[]}', '/fake.json');
  assert.ok(r.ok);
  assert.deepEqual(r.data, { descriptors: [] });
});

test('parseAndValidate: returns ok:false for invalid JSON', () => {
  const r = parseAndValidate('{bad json}', '/fake.json');
  assert.ok(!r.ok);
  assert.ok(r.error.includes('invalid JSON'));
});

test('parseAndValidate: returns ok:false for schema violations', () => {
  const r = parseAndValidate('{"config":{"onError":"explode"}}', '/fake.json');
  assert.ok(!r.ok);
  assert.ok(r.error.includes('onError'));
});

// ── load ──────────────────────────────────────────────────────────────────────

function makeFileIO(files = {}) {
  return {
    exists: (p) => p in files,
    read:   (p) => {
      if (!(p in files)) throw new Error(`File not found: ${p}`);
      return files[p];
    },
  };
}

const LOCAL_PATH  = '/project/mantle.json';
const GLOBAL_PATH = '/home/user/.mantle.json';

function makeLoadOpts(files) {
  return {
    cwd:     '/project',
    home:    '/home/user',
    fileIO:  makeFileIO(files),
    pathMod: require('node:path'),
  };
}

test('load: throws when neither registry exists', () => {
  assert.throws(
    () => load(makeLoadOpts({})),
    /No registry found/
  );
});

test('load: loads local registry only', () => {
  const files = {
    [LOCAL_PATH]: JSON.stringify({ descriptors: [{ name: 'a', path: '/abs/a', enabled: true }] })
  };
  const r = load(makeLoadOpts(files));
  assert.ok(r.localFound);
  assert.ok(!r.globalFound);
  assert.equal(r.registry.descriptors.length, 1);
});

test('load: loads global registry only', () => {
  const files = {
    [GLOBAL_PATH]: JSON.stringify({ descriptors: [{ name: 'g', path: '/abs/g', enabled: true }] })
  };
  const r = load(makeLoadOpts(files));
  assert.ok(!r.localFound);
  assert.ok(r.globalFound);
  assert.equal(r.registry.descriptors.length, 1);
});

test('load: merges global and local — global descriptors first', () => {
  const files = {
    [GLOBAL_PATH]: JSON.stringify({ descriptors: [{ name: 'global-desc', path: '/abs/g', enabled: true }] }),
    [LOCAL_PATH]:  JSON.stringify({ descriptors: [{ name: 'local-desc',  path: '/abs/l', enabled: true }] }),
  };
  const r = load(makeLoadOpts(files));
  assert.equal(r.registry.descriptors[0].name, 'global-desc');
  assert.equal(r.registry.descriptors[1].name, 'local-desc');
});

test('load: local config wins over global config', () => {
  const files = {
    [GLOBAL_PATH]: JSON.stringify({ config: { onError: 'abort' }, descriptors: [] }),
    [LOCAL_PATH]:  JSON.stringify({ config: { onError: 'skip'  }, descriptors: [] }),
  };
  const r = load(makeLoadOpts(files));
  assert.equal(r.registry.config.onError, 'skip');
});

test('load: throws on invalid local registry', () => {
  const files = { [LOCAL_PATH]: '{"config":{"onError":"explode"}}' };
  assert.throws(() => load(makeLoadOpts(files)), /onError/);
});

test('load: throws on invalid global registry', () => {
  const files = { [GLOBAL_PATH]: '{not json}' };
  assert.throws(() => load(makeLoadOpts(files)), /invalid JSON/);
});

// ── readRaw / writeRaw ────────────────────────────────────────────────────────

test('readRaw: returns empty registry when file does not exist', () => {
  const fileIO = makeFileIO({});
  const data   = readRaw('/nonexistent.json', fileIO);
  assert.deepEqual(data, { descriptors: [] });
});

test('readRaw: parses existing file', () => {
  const fileIO = makeFileIO({ '/reg.json': '{"descriptors":[{"name":"x","path":"/x","enabled":true}]}' });
  const data   = readRaw('/reg.json', fileIO);
  assert.equal(data.descriptors[0].name, 'x');
});

test('writeRaw: writes formatted JSON', () => {
  const written = {};
  const fileIO  = { exists: () => false, read: () => {}, write: (p, d) => { written[p] = d; } };
  writeRaw('/out.json', { descriptors: [] }, fileIO);
  const parsed = JSON.parse(written['/out.json']);
  assert.deepEqual(parsed, { descriptors: [] });
});

// ── addDescriptor ─────────────────────────────────────────────────────────────

test('addDescriptor: adds entry to empty registry', () => {
  const store  = {};
  const fileIO = {
    exists: (p) => p in store,
    read:   (p) => store[p],
    write:  (p, d) => { store[p] = d; },
  };
  addDescriptor('/reg.json', { name: 'new-desc', path: '/new', enabled: false }, fileIO);
  const data = JSON.parse(store['/reg.json']);
  assert.equal(data.descriptors.length, 1);
  assert.equal(data.descriptors[0].name, 'new-desc');
});

test('addDescriptor: throws on duplicate name', () => {
  const existing = JSON.stringify({ descriptors: [{ name: 'dup', path: '/d', enabled: true }] });
  const fileIO   = { exists: () => true, read: () => existing, write: () => {} };
  assert.throws(
    () => addDescriptor('/reg.json', { name: 'dup', path: '/x', enabled: false }, fileIO),
    /already exists/
  );
});

// ── setEnabled ────────────────────────────────────────────────────────────────

test('setEnabled: enables a disabled descriptor', () => {
  let stored;
  const src    = JSON.stringify({ descriptors: [{ name: 'x', path: '/x', enabled: false }] });
  const fileIO = { exists: () => true, read: () => src, write: (_, d) => { stored = d; } };
  setEnabled('/reg.json', 'x', true, fileIO);
  const data = JSON.parse(stored);
  assert.equal(data.descriptors[0].enabled, true);
});

test('setEnabled: throws when descriptor not found', () => {
  const src    = JSON.stringify({ descriptors: [] });
  const fileIO = { exists: () => true, read: () => src, write: () => {} };
  assert.throws(() => setEnabled('/reg.json', 'missing', true, fileIO), /not found/);
});

// ── moveDescriptor ────────────────────────────────────────────────────────────

test('moveDescriptor: moves descriptor up', () => {
  let stored;
  const src = JSON.stringify({ descriptors: [
    { name: 'a', path: '/a', enabled: true },
    { name: 'b', path: '/b', enabled: true },
  ]});
  const fileIO = { exists: () => true, read: () => src, write: (_, d) => { stored = d; } };
  moveDescriptor('/reg.json', 'b', 'up', fileIO);
  const data = JSON.parse(stored);
  assert.equal(data.descriptors[0].name, 'b');
  assert.equal(data.descriptors[1].name, 'a');
});

test('moveDescriptor: moves descriptor down', () => {
  let stored;
  const src = JSON.stringify({ descriptors: [
    { name: 'a', path: '/a', enabled: true },
    { name: 'b', path: '/b', enabled: true },
  ]});
  const fileIO = { exists: () => true, read: () => src, write: (_, d) => { stored = d; } };
  moveDescriptor('/reg.json', 'a', 'down', fileIO);
  const data = JSON.parse(stored);
  assert.equal(data.descriptors[0].name, 'b');
});

test('moveDescriptor: throws when already first and moving up', () => {
  const src    = JSON.stringify({ descriptors: [{ name: 'a', path: '/a', enabled: true }] });
  const fileIO = { exists: () => true, read: () => src, write: () => {} };
  assert.throws(() => moveDescriptor('/reg.json', 'a', 'up', fileIO), /already first/);
});

test('moveDescriptor: throws when already last and moving down', () => {
  const src    = JSON.stringify({ descriptors: [{ name: 'a', path: '/a', enabled: true }] });
  const fileIO = { exists: () => true, read: () => src, write: () => {} };
  assert.throws(() => moveDescriptor('/reg.json', 'a', 'down', fileIO), /already last/);
});

test('moveDescriptor: throws when descriptor not found', () => {
  const src    = JSON.stringify({ descriptors: [] });
  const fileIO = { exists: () => true, read: () => src, write: () => {} };
  assert.throws(() => moveDescriptor('/reg.json', 'x', 'up', fileIO), /not found/);
});

// ── setConfig ─────────────────────────────────────────────────────────────────

test('setConfig: merges into existing config', () => {
  let stored;
  const src    = JSON.stringify({ config: { onError: 'abort' }, descriptors: [] });
  const fileIO = { exists: () => true, read: () => src, write: (_, d) => { stored = d; } };
  setConfig('/reg.json', { logLevel: 'debug' }, fileIO);
  const data = JSON.parse(stored);
  assert.equal(data.config.onError,  'abort');
  assert.equal(data.config.logLevel, 'debug');
});
