'use strict';

/**
 * engine/index.js
 *
 * Public programmatic API for MANTLE.
 *
 * Usage:
 *   const mantle = require('mantle');
 *
 *   await mantle.run();
 *   await mantle.run({ onError: 'abort' });
 *   await mantle.run({ only: 'my-descriptor' });
 *
 *   const { registry } = await mantle.load();
 *   await mantle.registry.enable('my-descriptor');
 */

const nodeOs   = require('node:os');
const { load: loadRegistry, addDescriptor, setEnabled,
        moveDescriptor, setConfig, localRegistryPath,
        globalRegistryPath } = require('./registry');
const { run: runDescriptors } = require('./runner');
const { createEngineLogger }  = require('./logger');
const { scaffold }            = require('./scaffold');

// ── run ───────────────────────────────────────────────────────────────────────

/**
 * Load the registry and run descriptors.
 *
 * @param {object} [options]
 * @param {string}  [options.cwd]      - Working directory (default: process.cwd())
 * @param {string}  [options.only]     - Run only the named descriptor
 * @param {string}  [options.onError]  - 'skip'|'abort' (overrides registry config)
 * @returns {Promise<import('./runner').DescriptorResult[]>}
 */
async function run(options = {}) {
  const { cwd = process.cwd(), only, onError } = options;
  const log = createEngineLogger();

  const { registry, localPath, globalPath, localFound, globalFound } =
    loadRegistry({ cwd });

  // Log which registries were found
  if (localFound)  log.info(`Using local registry:  ${localPath}`);
  else             log.info(`No local mantle.json found in ${cwd} — using global registry only`);
  if (globalFound) log.info(`Using global registry: ${globalPath}`);

  const runOpts = {
    only,
    onError: onError || registry.config.onError,
    report({ type, name, error }) {
      if (type === 'start') log.info(`→ Running: ${name}`);
      if (type === 'done')  log.info(`✓ Done:    ${name}`);
      if (type === 'skip')  log.warn(`↷ Skipped: ${name} (aborted by previous error)`);
      if (type === 'error') log.error(`✗ Failed:  ${name} — ${error.message}`);
    },
  };

  return runDescriptors(registry.descriptors, registry.config, runOpts);
}

// ── load ──────────────────────────────────────────────────────────────────────

/**
 * Load and return the effective registry (without running anything).
 * Useful for programmatic inspection.
 *
 * @param {object} [options]
 * @param {string}  [options.cwd]
 * @returns {{ registry, localPath, globalPath, localFound, globalFound }}
 */
function load(options = {}) {
  return loadRegistry(options);
}

// ── registry mutations ────────────────────────────────────────────────────────

/**
 * Get the target registry file path.
 * @param {boolean} global_  - If true, returns global path; otherwise local.
 * @param {string}  [cwd]
 * @returns {string}
 */
function _targetPath(global_, cwd = process.cwd()) {
  return global_
    ? globalRegistryPath(nodeOs.homedir())
    : localRegistryPath(cwd);
}

const registry = {
  /**
   * Add a new descriptor entry to the registry.
   * @param {object}  descriptor  - { name, path, enabled }
   * @param {object}  [opts]      - { global?: boolean, cwd?: string }
   */
  add(descriptor, opts = {}) {
    addDescriptor(_targetPath(opts.global, opts.cwd), descriptor);
  },

  /**
   * Enable a descriptor by name.
   * @param {string}  name
   * @param {object}  [opts]  - { global?: boolean, cwd?: string }
   */
  enable(name, opts = {}) {
    setEnabled(_targetPath(opts.global, opts.cwd), name, true);
  },

  /**
   * Disable a descriptor by name.
   * @param {string}  name
   * @param {object}  [opts]  - { global?: boolean, cwd?: string }
   */
  disable(name, opts = {}) {
    setEnabled(_targetPath(opts.global, opts.cwd), name, false);
  },

  /**
   * Move a descriptor up or down in the run order.
   * @param {string}  name
   * @param {'up'|'down'} direction
   * @param {object}  [opts]  - { global?: boolean, cwd?: string }
   */
  move(name, direction, opts = {}) {
    moveDescriptor(_targetPath(opts.global, opts.cwd), name, direction);
  },

  /**
   * Update global engine configuration.
   * @param {object}  configPatch  - Partial config to merge
   * @param {object}  [opts]       - { global?: boolean, cwd?: string }
   */
  configure(configPatch, opts = {}) {
    setConfig(_targetPath(opts.global, opts.cwd), configPatch);
  },
};

// ── scaffold ──────────────────────────────────────────────────────────────────

/**
 * Scaffold a new descriptor folder.
 * @param {string}  name
 * @param {string}  destPath  - Absolute path where the folder should be created
 */
function init(name, destPath) {
  scaffold({ name, destPath });
}

module.exports = { run, load, registry, init };
