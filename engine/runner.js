'use strict';

/**
 * engine/runner.js
 *
 * Executes an ordered list of descriptor entries.
 *
 * Responsibilities:
 *   - Filter to enabled-only (unless a specific name is targeted)
 *   - For each descriptor: build stock bundle, rotate logs, call main()
 *   - Handle errors per onError policy (skip | abort)
 *   - Report progress via an injectable reporter callback
 *
 * Testability design:
 *   - The real filesystem interaction (require()ing build.js) is behind an
 *     injectable `loadDescriptor` function so tests can provide mock mains.
 *   - The stock bundle construction is injectable via `buildStockFn`.
 *   - The reporter is injectable so tests can capture output without console.
 */

const nodePath  = require('node:path');
const { buildStock } = require('./stock');

// ── Injectable defaults ───────────────────────────────────────────────────────

/**
 * Load and return a descriptor's main function from its build.js.
 * Injectable so tests can substitute mock implementations.
 *
 * @param {string} descriptorPath  - Absolute path to descriptor folder
 * @returns {Function}               Async main(stock) function
 * @throws {Error}                   If build.js is missing or doesn't export main
 */
function realLoadDescriptor(descriptorPath) {
  const buildPath = nodePath.join(descriptorPath, 'build.js');
  let mod;
  try {
    mod = require(buildPath);
  } catch (err) {
    throw new Error(`Cannot load build.js from "${descriptorPath}": ${err.message}`);
  }
  if (typeof mod.main !== 'function') {
    throw new Error(
      `build.js in "${descriptorPath}" must export a "main" function`
    );
  }
  return mod.main;
}

// ── Result types ──────────────────────────────────────────────────────────────

/**
 * @typedef {object} DescriptorResult
 * @property {string}  name     - Descriptor name
 * @property {'ok'|'skipped'|'failed'} status
 * @property {Error|null} error - Set when status === 'failed'
 */

// ── Runner ────────────────────────────────────────────────────────────────────

/**
 * Run an ordered list of descriptors.
 *
 * @param {object[]} descriptors      - Array of descriptor entries from registry
 * @param {object}   config           - Merged engine config
 * @param {object}   [options]
 * @param {string}   [options.only]   - If set, run only the named descriptor
 * @param {string}   [options.onError]- 'skip'|'abort' — overrides config
 * @param {Function} [options.report] - reporter(event) callback; receives:
 *                                      { type: 'start'|'done'|'error'|'skip', name, error? }
 * @param {Function} [options.loadDescriptor]  - Injectable build.js loader
 * @param {Function} [options.buildStockFn]    - Injectable stock builder
 *
 * @returns {Promise<DescriptorResult[]>}
 */
async function run(descriptors, config, options = {}) {
  const {
    only            = null,
    onError         = config.onError || 'skip',
    report          = () => {},
    loadDescriptor  = realLoadDescriptor,
    buildStockFn    = buildStock,
  } = options;

  // Filter: if `only` is set, run just that one regardless of enabled status.
  // Otherwise run all enabled descriptors in order.
  const targets = only
    ? descriptors.filter((d) => d.name === only)
    : descriptors.filter((d) => d.enabled);

  if (only && targets.length === 0) {
    throw new Error(`Descriptor "${only}" not found in registry`);
  }

  const results = [];

  for (const descriptor of targets) {
    report({ type: 'start', name: descriptor.name });

    let mainFn;
    try {
      mainFn = loadDescriptor(descriptor.path);
    } catch (err) {
      results.push({ name: descriptor.name, status: 'failed', error: err });
      report({ type: 'error', name: descriptor.name, error: err });
      if (onError === 'abort') break;
      else continue;
    }

    // Build stock bundle and rotate logs
    let stock;
    try {
      stock = buildStockFn(descriptor, config);
      stock.log.rotate();
    } catch (err) {
      results.push({ name: descriptor.name, status: 'failed', error: err });
      report({ type: 'error', name: descriptor.name, error: err });
      if (onError === 'abort') break;
      else continue;
    }

    // Execute
    try {
      await mainFn(stock);
      results.push({ name: descriptor.name, status: 'ok', error: null });
      report({ type: 'done', name: descriptor.name });
    } catch (err) {
      results.push({ name: descriptor.name, status: 'failed', error: err });
      report({ type: 'error', name: descriptor.name, error: err });
      if (onError === 'abort') break;
    }
  }

  // Mark any descriptors that were never reached (due to abort) as skipped
  const ran = new Set(results.map((r) => r.name));
  for (const d of targets) {
    if (!ran.has(d.name)) {
      results.push({ name: d.name, status: 'skipped', error: null });
      report({ type: 'skip', name: d.name });
    }
  }

  return results;
}

module.exports = { run, realLoadDescriptor };
