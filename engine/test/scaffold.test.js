'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { scaffold, buildJsTemplate, dotEnvTemplate } = require('../scaffold');

// ── buildJsTemplate ───────────────────────────────────────────────────────────

test('buildJsTemplate: includes descriptor name in comment', () => {
  const src = buildJsTemplate('my-build');
  assert.ok(src.includes('my-build'));
});

test('buildJsTemplate: exports a main function', () => {
  const src = buildJsTemplate('x');
  assert.ok(src.includes('async main(stock)'));
  assert.ok(src.includes('module.exports'));
});

test('buildJsTemplate: documents resolvePath and resolveAssetPath', () => {
  const src = buildJsTemplate('x');
  assert.ok(src.includes('stock.resolvePath'));
  assert.ok(src.includes('stock.resolveAssetPath'));
});

test('buildJsTemplate: mentions stock bundle properties', () => {
  const src = buildJsTemplate('x');
  assert.ok(src.includes('log'));
  assert.ok(src.includes('env'));
  assert.ok(src.includes('readAsset'));
  assert.ok(src.includes('shell'));
  assert.ok(src.includes('fs'));
  assert.ok(src.includes('path'));
});

// ── dotEnvTemplate ────────────────────────────────────────────────────────────

test('dotEnvTemplate: is a non-empty string', () => {
  assert.ok(typeof dotEnvTemplate === 'string' && dotEnvTemplate.length > 0);
});

test('dotEnvTemplate: mentions .gitignore', () => {
  assert.ok(dotEnvTemplate.includes('.gitignore'));
});

// ── scaffold ──────────────────────────────────────────────────────────────────

function makeMockFileIO() {
  const created = { dirs: [], files: {} };
  return {
    created,
    fileIO: {
      exists:  () => false,
      mkdir:   (p) => created.dirs.push(p),
      write:   (p, c) => { created.files[p] = c; },
    },
  };
}

test('scaffold: creates descriptor root and assets dir', () => {
  const { created, fileIO } = makeMockFileIO();
  scaffold({ name: 'my-build', destPath: '/builds/my-build', fileIO });
  assert.ok(created.dirs.includes('/builds/my-build'));
  assert.ok(created.dirs.includes('/builds/my-build/assets'));
});

test('scaffold: writes build.js, .env, and .gitkeep', () => {
  const { created, fileIO } = makeMockFileIO();
  scaffold({ name: 'my-build', destPath: '/builds/my-build', fileIO });
  assert.ok('/builds/my-build/build.js' in created.files);
  assert.ok('/builds/my-build/.env'     in created.files);
  assert.ok('/builds/my-build/assets/.gitkeep' in created.files);
});

test('scaffold: build.js contains the descriptor name', () => {
  const { created, fileIO } = makeMockFileIO();
  scaffold({ name: 'special-name', destPath: '/builds/special-name', fileIO });
  assert.ok(created.files['/builds/special-name/build.js'].includes('special-name'));
});

test('scaffold: throws when destination already exists', () => {
  const fileIO = {
    exists: () => true,
    mkdir:  () => {},
    write:  () => {},
  };
  assert.throws(
    () => scaffold({ name: 'x', destPath: '/existing', fileIO }),
    /already exists/
  );
});

test('scaffold: does not create anything when destination exists', () => {
  const { created, fileIO: base } = makeMockFileIO();
  const fileIO = { ...base, exists: () => true };
  try { scaffold({ name: 'x', destPath: '/existing', fileIO }); } catch (_) {}
  assert.equal(created.dirs.length,           0);
  assert.equal(Object.keys(created.files).length, 0);
});
