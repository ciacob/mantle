'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { validate, merge, resolveDescriptorPaths, CONFIG_DEFAULTS } = require('../schema');

// ── validate ──────────────────────────────────────────────────────────────────

test('validate: accepts minimal valid registry (empty descriptors)', () => {
  const r = validate({ descriptors: [] });
  assert.ok(r.valid);
  assert.deepEqual(r.errors, []);
});

test('validate: accepts registry with no keys at all', () => {
  assert.ok(validate({}).valid);
});

test('validate: rejects non-object root', () => {
  for (const bad of [null, [], 'string', 42]) {
    const r = validate(bad);
    assert.ok(!r.valid, `Expected invalid for ${JSON.stringify(bad)}`);
    assert.ok(r.errors[0].includes('root must be a JSON object'));
  }
});

test('validate: rejects non-object config', () => {
  const r = validate({ config: 'bad' });
  assert.ok(!r.valid);
  assert.ok(r.errors.some((e) => e.includes('config must be an object')));
});

test('validate: rejects invalid onError', () => {
  const r = validate({ config: { onError: 'explode' } });
  assert.ok(!r.valid);
  assert.ok(r.errors.some((e) => e.includes('onError')));
});

test('validate: accepts valid onError values', () => {
  assert.ok(validate({ config: { onError: 'skip'  } }).valid);
  assert.ok(validate({ config: { onError: 'abort' } }).valid);
});

test('validate: rejects invalid logRetentionDays', () => {
  for (const bad of [0, -1, 1.5, 'fourteen']) {
    const r = validate({ config: { logRetentionDays: bad } });
    assert.ok(!r.valid, `Expected invalid for ${JSON.stringify(bad)}`);
  }
});

test('validate: accepts positive integer logRetentionDays', () => {
  assert.ok(validate({ config: { logRetentionDays: 7  } }).valid);
  assert.ok(validate({ config: { logRetentionDays: 30 } }).valid);
});

test('validate: rejects invalid logLevel', () => {
  const r = validate({ config: { logLevel: 'verbose' } });
  assert.ok(!r.valid);
  assert.ok(r.errors.some((e) => e.includes('logLevel')));
});

test('validate: accepts all valid log levels', () => {
  for (const level of ['debug', 'info', 'warn', 'error']) {
    assert.ok(validate({ config: { logLevel: level } }).valid, `Expected valid for ${level}`);
  }
});

test('validate: rejects non-array descriptors', () => {
  const r = validate({ descriptors: 'not-an-array' });
  assert.ok(!r.valid);
  assert.ok(r.errors.some((e) => e.includes('descriptors must be an array')));
});

test('validate: rejects descriptor with missing name', () => {
  const r = validate({ descriptors: [{ path: '/x', enabled: true }] });
  assert.ok(!r.valid);
  assert.ok(r.errors.some((e) => e.includes('.name must be a non-empty string')));
});

test('validate: rejects descriptor with empty name', () => {
  const r = validate({ descriptors: [{ name: '  ', path: '/x', enabled: true }] });
  assert.ok(!r.valid);
  assert.ok(r.errors.some((e) => e.includes('.name must be a non-empty string')));
});

test('validate: rejects descriptor with missing path', () => {
  const r = validate({ descriptors: [{ name: 'x', enabled: true }] });
  assert.ok(!r.valid);
  assert.ok(r.errors.some((e) => e.includes('.path must be a non-empty string')));
});

test('validate: rejects descriptor with non-boolean enabled', () => {
  const r = validate({ descriptors: [{ name: 'x', path: '/x', enabled: 'yes' }] });
  assert.ok(!r.valid);
  assert.ok(r.errors.some((e) => e.includes('.enabled must be a boolean')));
});

test('validate: rejects duplicate descriptor names', () => {
  const r = validate({ descriptors: [
    { name: 'dup', path: '/a', enabled: true },
    { name: 'dup', path: '/b', enabled: false },
  ]});
  assert.ok(!r.valid);
  assert.ok(r.errors.some((e) => e.includes('"dup" is not unique')));
});

test('validate: reports multiple errors at once', () => {
  const r = validate({ descriptors: [
    { name: '', path: '', enabled: 'yes' },
  ]});
  assert.ok(!r.valid);
  assert.ok(r.errors.length >= 3);
});

test('validate: uses provided source label in error messages', () => {
  const r = validate(null, 'custom-source');
  assert.ok(r.errors[0].startsWith('custom-source:'));
});

// ── merge ─────────────────────────────────────────────────────────────────────

test('merge: both null gives empty registry with defaults', () => {
  const r = merge(null, null);
  assert.deepEqual(r.config, CONFIG_DEFAULTS);
  assert.deepEqual(r.descriptors, []);
});

test('merge: global only — uses its config and descriptors', () => {
  const global_ = {
    config: { onError: 'abort' },
    descriptors: [{ name: 'a', path: '/a', enabled: true }],
  };
  const r = merge(global_, null);
  assert.equal(r.config.onError, 'abort');
  assert.equal(r.descriptors.length, 1);
  assert.equal(r.descriptors[0].name, 'a');
});

test('merge: local config wins over global config', () => {
  const global_ = { config: { onError: 'abort', logLevel: 'debug' } };
  const local   = { config: { onError: 'skip'  } };
  const r = merge(global_, local);
  assert.equal(r.config.onError,  'skip');   // local wins
  assert.equal(r.config.logLevel, 'debug');  // global retained
});

test('merge: global descriptors come before local descriptors', () => {
  const global_ = { descriptors: [{ name: 'g', path: '/g', enabled: true }] };
  const local   = { descriptors: [{ name: 'l', path: '/l', enabled: true }] };
  const r = merge(global_, local);
  assert.equal(r.descriptors[0].name, 'g');
  assert.equal(r.descriptors[1].name, 'l');
});

test('merge: defaults fill in missing config keys', () => {
  const r = merge({ config: { onError: 'abort' } }, null);
  assert.equal(r.config.logLevel,         CONFIG_DEFAULTS.logLevel);
  assert.equal(r.config.logRetentionDays, CONFIG_DEFAULTS.logRetentionDays);
});

test('merge: does not mutate input objects', () => {
  const global_ = { config: { onError: 'abort' }, descriptors: [] };
  const local   = { config: { onError: 'skip'  }, descriptors: [] };
  merge(global_, local);
  assert.equal(global_.config.onError, 'abort');
  assert.equal(local.config.onError,   'skip');
});

// ── resolveDescriptorPaths ────────────────────────────────────────────────────

test('resolveDescriptorPaths: resolves relative paths against registryDir', () => {
  const registry = {
    descriptors: [{ name: 'a', path: './my-desc', enabled: true }]
  };
  const fakePath = {
    isAbsolute: (p) => p.startsWith('/'),
    resolve:    (base, rel) => `/resolved/${rel.replace('./', '')}`,
  };
  const result = resolveDescriptorPaths(registry, '/some/dir', fakePath);
  assert.equal(result.descriptors[0].path, '/resolved/my-desc');
});

test('resolveDescriptorPaths: leaves absolute paths unchanged', () => {
  const registry = {
    descriptors: [{ name: 'a', path: '/abs/path', enabled: true }]
  };
  const fakePath = {
    isAbsolute: (p) => p.startsWith('/'),
    resolve:    () => { throw new Error('should not be called'); },
  };
  const result = resolveDescriptorPaths(registry, '/some/dir', fakePath);
  assert.equal(result.descriptors[0].path, '/abs/path');
});

test('resolveDescriptorPaths: does not mutate input', () => {
  const registry = {
    descriptors: [{ name: 'a', path: './rel', enabled: true }]
  };
  const original = registry.descriptors[0].path;
  const fakePath = {
    isAbsolute: () => false,
    resolve:    () => '/resolved',
  };
  resolveDescriptorPaths(registry, '/dir', fakePath);
  assert.equal(registry.descriptors[0].path, original);
});
