'use strict';

/**
 * sample-descriptors/task-primer-nacre/tests/build.test.js
 *
 * Unit tests for the pure and context-injected helpers exported by build.js.
 * main() itself is not tested here — it is a thin orchestrator of these helpers.
 *
 * Run from the descriptor root:
 *   node --test tests/build.test.js
 *
 * Or from anywhere:
 *   node --test /path/to/task-primer-nacre/tests/build.test.js
 */

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const nodePath = require('node:path');

const {
  validateEnv,
  safeName,
  escXml,
  patchPackageJson,
  outerInfoPlist,
  buildNacreConfig,
  resolveEnvPaths,
  resolveOptionalSteps,
  exists,
  applyPackageJsonPatch,
  writeNacreConfig,
} = require('../build');

// ── validateEnv ───────────────────────────────────────────────────────────────

test('validateEnv: returns empty array when all required vars are set', () => {
  const env = { FOO: 'bar', BAZ: 'qux' };
  assert.deepEqual(validateEnv(env, ['FOO', 'BAZ']), []);
});

test('validateEnv: returns missing keys', () => {
  const env = { FOO: 'bar', BAZ: '' };
  assert.deepEqual(validateEnv(env, ['FOO', 'BAZ']), ['BAZ']);
});

test('validateEnv: treats whitespace-only values as missing', () => {
  const env = { FOO: '   ' };
  assert.deepEqual(validateEnv(env, ['FOO']), ['FOO']);
});

test('validateEnv: treats undefined and null as missing', () => {
  const env = { A: undefined, B: null, C: 'ok' };
  const missing = validateEnv(env, ['A', 'B', 'C']);
  assert.ok(missing.includes('A'));
  assert.ok(missing.includes('B'));
  assert.ok(!missing.includes('C'));
});

test('validateEnv: returns all missing keys from a realistic env', () => {
  const env = {
    SOURCE_DIR: '/src', APP_NAME: 'My App', APP_BUNDLE_ID: '',
    APP_VERSION: '1.0', APP_ICON: '', OUTPUT_DIR: './dist',
    NACRE_DIR: '/nacre', PKG_BIN: '',
  };
  const missing = validateEnv(env, [
    'SOURCE_DIR', 'APP_NAME', 'APP_BUNDLE_ID', 'APP_VERSION',
    'APP_ICON', 'OUTPUT_DIR', 'NACRE_DIR', 'PKG_BIN',
  ]);
  assert.deepEqual(missing.sort(), ['APP_BUNDLE_ID', 'APP_ICON', 'PKG_BIN']);
});

test('validateEnv: empty required array returns empty array', () => {
  assert.deepEqual(validateEnv({ A: '' }, []), []);
});

// ── safeName ──────────────────────────────────────────────────────────────────

test('safeName: leaves alphanumeric, dot, underscore, hyphen unchanged', () => {
  assert.equal(safeName('my-app_1.0'), 'my-app_1.0');
});

test('safeName: replaces spaces with hyphens', () => {
  assert.equal(safeName('My App Name'), 'My-App-Name');
});

test('safeName: replaces special characters', () => {
  assert.equal(safeName('App (Beta)!'), 'App--Beta--');
});

test('safeName: handles empty string', () => {
  assert.equal(safeName(''), '');
});

test('safeName: handles unicode characters', () => {
  const result = safeName('Ünïcödé App');
  // All non-safe chars replaced with hyphen
  assert.ok(!result.includes('ü') && !result.includes('Ü'));
  assert.ok(result.endsWith('App'));
});

// ── escXml ────────────────────────────────────────────────────────────────────

test('escXml: leaves plain ASCII unchanged', () => {
  assert.equal(escXml('hello world'), 'hello world');
});

test('escXml: escapes ampersand', () => {
  assert.equal(escXml('Cats & Dogs'), 'Cats &amp; Dogs');
});

test('escXml: escapes less-than and greater-than', () => {
  assert.equal(escXml('<tag>'), '&lt;tag&gt;');
});

test('escXml: escapes double and single quotes', () => {
  assert.equal(escXml('"hello"'), '&quot;hello&quot;');
  assert.equal(escXml("it's"), 'it&apos;s');
});

test('escXml: escapes multiple special characters', () => {
  const result = escXml('A & <B> "C" \'D\'');
  assert.ok(result.includes('&amp;'));
  assert.ok(result.includes('&lt;'));
  assert.ok(result.includes('&gt;'));
  assert.ok(result.includes('&quot;'));
  assert.ok(result.includes('&apos;'));
});

test('escXml: coerces non-string input', () => {
  assert.equal(escXml(42),   '42');
  assert.equal(escXml(null), 'null');
});

// ── patchPackageJson ──────────────────────────────────────────────────────────

test('patchPackageJson: sets browser.product to nacre', () => {
  const result = patchPackageJson({ name: 'myapp' }, 'com.example.app');
  assert.equal(result.taskPrimer.browser.product, 'nacre');
});

test('patchPackageJson: sets appBundleId', () => {
  const result = patchPackageJson({ name: 'myapp' }, 'com.example.app');
  assert.equal(result.taskPrimer.appBundleId, 'com.example.app');
});

test('patchPackageJson: preserves existing taskPrimer fields', () => {
  const pkg = { taskPrimer: { appName: 'My App', webPort: 3000 } };
  const result = patchPackageJson(pkg, 'com.example.app');
  assert.equal(result.taskPrimer.appName,  'My App');
  assert.equal(result.taskPrimer.webPort,  3000);
});

test('patchPackageJson: preserves existing browser fields', () => {
  const pkg = { taskPrimer: { browser: { buildId: 'stable', debugPort: 9222 } } };
  const result = patchPackageJson(pkg, 'com.example.app');
  assert.equal(result.taskPrimer.browser.buildId,   'stable');
  assert.equal(result.taskPrimer.browser.debugPort,  9222);
  assert.equal(result.taskPrimer.browser.product,   'nacre');
});

test('patchPackageJson: preserves top-level package.json fields', () => {
  const pkg = { name: 'myapp', version: '1.0.0', scripts: { test: 'jest' } };
  const result = patchPackageJson(pkg, 'com.example.app');
  assert.equal(result.name,    'myapp');
  assert.equal(result.version, '1.0.0');
  assert.deepEqual(result.scripts, { test: 'jest' });
});

test('patchPackageJson: does not mutate the input', () => {
  const pkg = { taskPrimer: { browser: { product: 'chrome' } } };
  patchPackageJson(pkg, 'com.example.app');
  assert.equal(pkg.taskPrimer.browser.product, 'chrome');
});

// ── outerInfoPlist ────────────────────────────────────────────────────────────

function parsePlistValues(xml) {
  // Minimal key-value extraction: pairs of <key>K</key>\n  <string>V</string>
  const result = {};
  const re = /<key>([^<]+)<\/key>\s*<(?:string|true|false)>?([^<]*)/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    result[m[1]] = m[2];
  }
  return result;
}

test('outerInfoPlist: contains CFBundleName', () => {
  const xml    = outerInfoPlist({ appName: 'My App', bundleId: 'com.x', version: '1.0', executable: 'myapp' });
  const values = parsePlistValues(xml);
  assert.equal(values.CFBundleName, 'My App');
});

test('outerInfoPlist: contains CFBundleIdentifier', () => {
  const xml    = outerInfoPlist({ appName: 'X', bundleId: 'com.example.test', version: '2.0', executable: 'x' });
  const values = parsePlistValues(xml);
  assert.equal(values.CFBundleIdentifier, 'com.example.test');
});

test('outerInfoPlist: contains CFBundleVersion and short version', () => {
  const xml    = outerInfoPlist({ appName: 'X', bundleId: 'com.x', version: '3.1.4', executable: 'x' });
  const values = parsePlistValues(xml);
  assert.equal(values.CFBundleVersion,            '3.1.4');
  assert.equal(values.CFBundleShortVersionString, '3.1.4');
});

test('outerInfoPlist: contains CFBundleExecutable', () => {
  const xml    = outerInfoPlist({ appName: 'X', bundleId: 'com.x', version: '1', executable: 'my-binary' });
  const values = parsePlistValues(xml);
  assert.equal(values.CFBundleExecutable, 'my-binary');
});

test('outerInfoPlist: XML-escapes app name with special characters', () => {
  const xml = outerInfoPlist({ appName: 'A & B', bundleId: 'com.x', version: '1', executable: 'x' });
  assert.ok(xml.includes('A &amp; B'), 'Expected escaped ampersand in plist');
  assert.ok(!xml.includes('A & B'),    'Raw ampersand must not appear in output');
});

test('outerInfoPlist: is valid-looking XML (starts with declaration)', () => {
  const xml = outerInfoPlist({ appName: 'X', bundleId: 'com.x', version: '1', executable: 'x' });
  assert.ok(xml.startsWith('<?xml'));
  assert.ok(xml.includes('</plist>'));
});

// ── buildNacreConfig ──────────────────────────────────────────────────────────

test('buildNacreConfig: produces correct app section', () => {
  const cfg = buildNacreConfig({
    appName:    'My App',
    bundleId:   'com.example.app',
    version:    '1.2.3',
    iconPath:   '/abs/icon.icns',
    nacreOutDir: '/out/nacre',
  });
  assert.equal(cfg.app.name,     'My App');
  assert.equal(cfg.app.bundleId, 'com.example.app');
  assert.equal(cfg.app.version,  '1.2.3');
  assert.equal(cfg.app.icon,     '/abs/icon.icns');
});

test('buildNacreConfig: produces correct output section', () => {
  const cfg = buildNacreConfig({
    appName: 'X', bundleId: 'com.x', version: '1',
    iconPath: '/icon.icns', nacreOutDir: '/dist/nacre',
  });
  assert.equal(cfg.output.dir, '/dist/nacre');
});

test('buildNacreConfig: is JSON-serialisable', () => {
  const cfg = buildNacreConfig({
    appName: 'X', bundleId: 'com.x', version: '1',
    iconPath: '/icon.icns', nacreOutDir: '/out',
  });
  assert.doesNotThrow(() => JSON.stringify(cfg));
});

// ── resolveEnvPaths ───────────────────────────────────────────────────────────

test('resolveEnvPaths: resolves relative paths against baseDir', () => {
  const env    = { SRC: './project', OUT: './dist' };
  const fakePath = {
    isAbsolute: (p) => p.startsWith('/'),
    resolve:    (base, p) => `${base}/${p.replace('./', '')}`,
  };
  const result = resolveEnvPaths(env, ['SRC', 'OUT'], '/base', fakePath);
  assert.equal(result.SRC, '/base/project');
  assert.equal(result.OUT, '/base/dist');
});

test('resolveEnvPaths: leaves absolute paths unchanged', () => {
  const env    = { SRC: '/absolute/path' };
  const fakePath = {
    isAbsolute: (p) => p.startsWith('/'),
    resolve:    () => { throw new Error('should not call resolve'); },
  };
  const result = resolveEnvPaths(env, ['SRC'], '/base', fakePath);
  assert.equal(result.SRC, '/absolute/path');
});

test('resolveEnvPaths: omits keys with empty values', () => {
  const env    = { SRC: '/abs', EMPTY: '' };
  const fakePath = { isAbsolute: () => true, resolve: (_, p) => p };
  const result = resolveEnvPaths(env, ['SRC', 'EMPTY'], '/base', fakePath);
  assert.ok('SRC'   in result);
  assert.ok(!('EMPTY' in result));
});

test('resolveEnvPaths: omits keys not present in env', () => {
  const env    = { SRC: '/abs' };
  const fakePath = { isAbsolute: () => true, resolve: (_, p) => p };
  const result = resolveEnvPaths(env, ['SRC', 'MISSING'], '/base', fakePath);
  assert.ok(!('MISSING' in result));
});

test('resolveEnvPaths: returns empty object for empty keys array', () => {
  const result = resolveEnvPaths({ SRC: '/x' }, [], '/base', nodePath);
  assert.deepEqual(result, {});
});

// ── resolveOptionalSteps ──────────────────────────────────────────────────────

test('resolveOptionalSteps: canSign true when APPLE_IDENTITY set', () => {
  const { canSign } = resolveOptionalSteps({ APPLE_IDENTITY: 'Developer ID: Me' });
  assert.ok(canSign);
});

test('resolveOptionalSteps: canSign false when APPLE_IDENTITY missing', () => {
  const { canSign } = resolveOptionalSteps({});
  assert.ok(!canSign);
});

test('resolveOptionalSteps: canNotarize true when all three notarization vars set', () => {
  const { canNotarize } = resolveOptionalSteps({
    APPLE_ID: 'me@example.com', APPLE_PASSWORD: 'xxxx', APPLE_TEAM_ID: 'TEAM123',
  });
  assert.ok(canNotarize);
});

test('resolveOptionalSteps: canNotarize false when any notarization var missing', () => {
  assert.ok(!resolveOptionalSteps({ APPLE_ID: 'x', APPLE_PASSWORD: 'y' }).canNotarize);
  assert.ok(!resolveOptionalSteps({ APPLE_ID: 'x', APPLE_TEAM_ID: 'z' }).canNotarize);
  assert.ok(!resolveOptionalSteps({ APPLE_PASSWORD: 'y', APPLE_TEAM_ID: 'z' }).canNotarize);
});

test('resolveOptionalSteps: both false when env is empty', () => {
  const result = resolveOptionalSteps({});
  assert.ok(!result.canSign);
  assert.ok(!result.canNotarize);
});

test('resolveOptionalSteps: canSign and canNotarize are independent', () => {
  const result = resolveOptionalSteps({
    APPLE_IDENTITY: 'Developer ID: Me',
    // No notarization vars
  });
  assert.ok(result.canSign);
  assert.ok(!result.canNotarize);
});

// ── exists (context-injected) ─────────────────────────────────────────────────

test('exists: returns true when fs.access resolves', async () => {
  const mockFs = { access: async () => {} };
  assert.ok(await exists(mockFs, '/any/path'));
});

test('exists: returns false when fs.access rejects', async () => {
  const mockFs = { access: async () => { throw new Error('ENOENT'); } };
  assert.ok(!await exists(mockFs, '/missing/path'));
});

// ── applyPackageJsonPatch (context-injected) ──────────────────────────────────

test('applyPackageJsonPatch: reads, patches, and writes back', async () => {
  const original = { name: 'myapp', taskPrimer: { appName: 'My App' } };
  let written;
  const mockFs = {
    readFile:  async () => JSON.stringify(original),
    writeFile: async (_, content) => { written = content; },
  };
  const result = await applyPackageJsonPatch(mockFs, '/pkg.json', 'com.example.app');

  assert.equal(result.taskPrimer.browser.product,   'nacre');
  assert.equal(result.taskPrimer.appBundleId,        'com.example.app');
  assert.equal(result.taskPrimer.appName,            'My App');

  // Written content should be valid JSON with the patch applied
  const parsed = JSON.parse(written);
  assert.equal(parsed.taskPrimer.browser.product, 'nacre');
});

test('applyPackageJsonPatch: written JSON ends with newline', async () => {
  let written;
  const mockFs = {
    readFile:  async () => '{"name":"x"}',
    writeFile: async (_, c) => { written = c; },
  };
  await applyPackageJsonPatch(mockFs, '/pkg.json', 'com.x');
  assert.ok(written.endsWith('\n'));
});

test('applyPackageJsonPatch: throws on invalid JSON', async () => {
  const mockFs = {
    readFile:  async () => '{not valid json}',
    writeFile: async () => {},
  };
  await assert.rejects(
    () => applyPackageJsonPatch(mockFs, '/pkg.json', 'com.x'),
    SyntaxError
  );
});

// ── writeNacreConfig (context-injected) ──────────────────────────────────────

test('writeNacreConfig: writes JSON-stringified config', async () => {
  let writtenPath, writtenContent;
  const mockFs = {
    writeFile: async (p, c) => { writtenPath = p; writtenContent = c; },
  };
  const config = { app: { name: 'X' }, output: { dir: '/out' } };
  await writeNacreConfig(mockFs, '/cfg.json', config);

  assert.equal(writtenPath, '/cfg.json');
  const parsed = JSON.parse(writtenContent);
  assert.deepEqual(parsed, config);
});

test('writeNacreConfig: written JSON is pretty-printed', async () => {
  let written;
  const mockFs = { writeFile: async (_, c) => { written = c; } };
  await writeNacreConfig(mockFs, '/cfg.json', { app: { name: 'X' } });
  // Pretty-printed JSON has newlines inside
  assert.ok(written.includes('\n'));
});

test('writeNacreConfig: written content ends with newline', async () => {
  let written;
  const mockFs = { writeFile: async (_, c) => { written = c; } };
  await writeNacreConfig(mockFs, '/cfg.json', {});
  assert.ok(written.endsWith('\n'));
});
