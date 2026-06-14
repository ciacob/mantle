'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { run }  = require('../runner');

// ── Fixtures ──────────────────────────────────────────────────────────────────

const BASE_CONFIG = { onError: 'skip', logLevel: 'info', logRetentionDays: 14 };

function makeDescriptor(name, enabled = true) {
  return { name, path: `/fake/${name}`, enabled };
}

function makeStock() {
  return {
    log:   { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, rotate: () => {} },
    env:   { REQUIRED_VAR: 'set' },
    paths: {},
    fs:    {},
    path:  {},
    readAsset() {},
    shell() {},
  };
}

function makeLoadDescriptor(mainFn) {
  return (_path) => mainFn;
}

function makeBuildStock(overrideEnv = {}) {
  return (_desc, _config) => ({
    ...makeStock(),
    env: { REQUIRED_VAR: 'set', ...overrideEnv },
  });
}

// ── Basic execution ───────────────────────────────────────────────────────────

test('run: executes enabled descriptors in order', async () => {
  const order = [];
  const descs = [makeDescriptor('a'), makeDescriptor('b'), makeDescriptor('c')];

  await run(descs, BASE_CONFIG, {
    loadDescriptor: (path) => async () => { order.push(path); },
    buildStockFn:   makeBuildStock(),
  });

  assert.deepEqual(order, ['/fake/a', '/fake/b', '/fake/c']);
});

test('run: skips disabled descriptors', async () => {
  const ran = [];
  const descs = [makeDescriptor('a', true), makeDescriptor('b', false), makeDescriptor('c', true)];

  await run(descs, BASE_CONFIG, {
    loadDescriptor: (path) => async () => { ran.push(path); },
    buildStockFn:   makeBuildStock(),
  });

  assert.deepEqual(ran, ['/fake/a', '/fake/c']);
});

test('run: returns ok results for successful descriptors', async () => {
  const descs   = [makeDescriptor('x')];
  const results = await run(descs, BASE_CONFIG, {
    loadDescriptor: makeLoadDescriptor(async () => {}),
    buildStockFn:   makeBuildStock(),
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'ok');
  assert.equal(results[0].name,   'x');
  assert.equal(results[0].error,  null);
});

test('run: returns empty results when no descriptors enabled', async () => {
  const descs   = [makeDescriptor('x', false)];
  const results = await run(descs, BASE_CONFIG, {
    loadDescriptor: makeLoadDescriptor(async () => {}),
    buildStockFn:   makeBuildStock(),
  });
  assert.equal(results.length, 0);
});

// ── Error handling ────────────────────────────────────────────────────────────

test('run: onError=skip continues after failure', async () => {
  const ran = [];
  const descs = [makeDescriptor('a'), makeDescriptor('b'), makeDescriptor('c')];

  await run(descs, BASE_CONFIG, {
    onError: 'skip',
    loadDescriptor: (path) => async () => {
      ran.push(path);
      if (path.includes('b')) throw new Error('b failed');
    },
    buildStockFn: makeBuildStock(),
  });

  assert.deepEqual(ran, ['/fake/a', '/fake/b', '/fake/c']);
});

test('run: onError=abort stops after first failure', async () => {
  const ran = [];
  const descs = [makeDescriptor('a'), makeDescriptor('b'), makeDescriptor('c')];

  const results = await run(descs, BASE_CONFIG, {
    onError: 'abort',
    loadDescriptor: (path) => async () => {
      ran.push(path);
      if (path.includes('b')) throw new Error('b failed');
    },
    buildStockFn: makeBuildStock(),
  });

  assert.deepEqual(ran, ['/fake/a', '/fake/b']);
  assert.ok(results.some((r) => r.name === 'c' && r.status === 'skipped'));
});

test('run: failed descriptor has status=failed and error set', async () => {
  const descs   = [makeDescriptor('x')];
  const results = await run(descs, BASE_CONFIG, {
    loadDescriptor: makeLoadDescriptor(async () => { throw new Error('boom'); }),
    buildStockFn:   makeBuildStock(),
  });

  assert.equal(results[0].status,        'failed');
  assert.equal(results[0].error.message, 'boom');
});

test('run: loadDescriptor error produces failed result', async () => {
  const descs   = [makeDescriptor('x')];
  const results = await run(descs, BASE_CONFIG, {
    loadDescriptor: (_path) => { throw new Error('no build.js'); },
    buildStockFn:   makeBuildStock(),
  });

  assert.equal(results[0].status, 'failed');
  assert.ok(results[0].error.message.includes('no build.js'));
});

// ── only option ───────────────────────────────────────────────────────────────

test('run: only option runs just the named descriptor', async () => {
  const ran   = [];
  const descs = [makeDescriptor('a'), makeDescriptor('b'), makeDescriptor('c')];

  await run(descs, BASE_CONFIG, {
    only: 'b',
    loadDescriptor: (path) => async () => { ran.push(path); },
    buildStockFn:   makeBuildStock(),
  });

  assert.deepEqual(ran, ['/fake/b']);
});

test('run: only option runs disabled descriptor', async () => {
  const ran   = [];
  const descs = [makeDescriptor('disabled', false)];

  await run(descs, BASE_CONFIG, {
    only: 'disabled',
    loadDescriptor: (path) => async () => { ran.push(path); },
    buildStockFn:   makeBuildStock(),
  });

  assert.equal(ran.length, 1);
});

test('run: only option throws when name not found', async () => {
  const descs = [makeDescriptor('a')];
  await assert.rejects(
    () => run(descs, BASE_CONFIG, {
      only: 'nonexistent',
      loadDescriptor: makeLoadDescriptor(async () => {}),
      buildStockFn:   makeBuildStock(),
    }),
    /not found in registry/
  );
});

// ── Reporter ──────────────────────────────────────────────────────────────────

test('run: reporter receives start and done events', async () => {
  const events = [];
  const descs  = [makeDescriptor('x')];

  await run(descs, BASE_CONFIG, {
    loadDescriptor: makeLoadDescriptor(async () => {}),
    buildStockFn:   makeBuildStock(),
    report: (e) => events.push(e),
  });

  assert.ok(events.some((e) => e.type === 'start' && e.name === 'x'));
  assert.ok(events.some((e) => e.type === 'done'  && e.name === 'x'));
});

test('run: reporter receives error event on failure', async () => {
  const events = [];
  const descs  = [makeDescriptor('x')];

  await run(descs, BASE_CONFIG, {
    loadDescriptor: makeLoadDescriptor(async () => { throw new Error('oops'); }),
    buildStockFn:   makeBuildStock(),
    report: (e) => events.push(e),
  });

  const errEvent = events.find((e) => e.type === 'error');
  assert.ok(errEvent);
  assert.equal(errEvent.name, 'x');
  assert.ok(errEvent.error.message.includes('oops'));
});

test('run: reporter receives skip event for unreached descriptors', async () => {
  const events = [];
  const descs  = [makeDescriptor('a'), makeDescriptor('b')];

  await run(descs, BASE_CONFIG, {
    onError: 'abort',
    loadDescriptor: makeLoadDescriptor(async () => { throw new Error('fail'); }),
    buildStockFn:   makeBuildStock(),
    report: (e) => events.push(e),
  });

  assert.ok(events.some((e) => e.type === 'skip' && e.name === 'b'));
});
