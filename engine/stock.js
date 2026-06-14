'use strict';

/**
 * engine/stock.js
 *
 * Builds the stock utility bundle injected into every descriptor's main().
 *
 * All functions that have side effects (shell, readAsset, file writes) accept
 * injectable dependencies so they can be tested without touching disk.
 *
 * The public API is buildStock(descriptor, config, options) which returns:
 *   { log, env, readAsset, shell, paths, fs, path }
 */

const nodePath   = require('node:path');
const nodeFs     = require('node:fs');
const nodeFsP    = require('node:fs/promises');
const { execSync } = require('node:child_process');
const { Logger } = require('./logger');
const dotenv     = require('dotenv');

// ── env loading ───────────────────────────────────────────────────────────────

/**
 * Load and parse a descriptor's .env file.
 *
 * dotenv's default behaviour: variables already set in process.env are NOT
 * overridden — shell/CI environment values take precedence over .env values.
 * Variables defined as empty strings in .env are loaded as empty strings
 * unless the shell has set them to something non-empty.
 *
 * @param {string}   descriptorRoot  - Absolute path to the descriptor folder.
 * @param {object}   [fileIO]        - Injectable: { exists, read }
 * @param {Function} [dotenvParse]   - Injectable dotenv.parse (default: real)
 * @returns {object}                   Flat key→value map of resolved env vars.
 */
function loadEnv(
  descriptorRoot,
  fileIO    = { exists: nodeFs.existsSync, read: (p) => nodeFs.readFileSync(p, 'utf8') },
  dotenvParse = dotenv.parse
) {
  const envPath = nodePath.join(descriptorRoot, '.env');
  if (!fileIO.exists(envPath)) return {};

  const raw    = fileIO.read(envPath);
  const parsed = dotenvParse(raw);   // { KEY: 'value', ... }

  // Apply dotenv's precedence rule manually so tests can inject a clean env.
  // For each key in the .env file: use the existing process.env value if set
  // and non-empty, otherwise use the .env value.
  const result = {};
  for (const [key, value] of Object.entries(parsed)) {
    result[key] = (process.env[key] !== undefined && process.env[key] !== '')
      ? process.env[key]
      : value;
  }
  return result;
}

/**
 * Check that all required env variables have non-empty values.
 *
 * "Required" variables are those declared in the .env file whose value
 * is still empty string after resolution (i.e. not set in .env and not
 * set in the shell environment).
 *
 * Returns an array of missing variable names.
 * Returns an empty array if everything is satisfied.
 *
 * @param {object} env  - Resolved env map (output of loadEnv).
 * @returns {string[]}
 */
function findMissingEnv(env) {
  return Object.entries(env)
    .filter(([, v]) => v === '' || v === undefined || v === null)
    .map(([k]) => k);
}

// ── shell ─────────────────────────────────────────────────────────────────────

/**
 * Run a shell command synchronously, returning trimmed stdout.
 * Throws on non-zero exit with a clear message including stderr.
 *
 * @param {string}   command
 * @param {object}   [options]          - { cwd?, env?, encoding? }
 * @param {Function} [execFn]           - Injectable execSync (default: real)
 * @returns {string}                      Trimmed stdout
 */
function runShell(command, options = {}, execFn = execSync) {
  try {
    const result = execFn(command, {
      cwd:      options.cwd,
      env:      options.env || process.env,
      encoding: 'utf8',
      stdio:    ['pipe', 'pipe', 'pipe'],
      ...options,
    });
    return typeof result === 'string' ? result.trim() : '';
  } catch (err) {
    const stderr = err.stderr ? String(err.stderr).trim() : '';
    const msg    = stderr || err.message || `Command failed: ${command}`;
    throw new Error(`shell: ${msg}\n  command: ${command}`);
  }
}

// ── readAsset ─────────────────────────────────────────────────────────────────

/**
 * Read a file from the descriptor's assets/ folder.
 *
 * @param {string}   assetsDir      - Absolute path to descriptor's assets/ folder.
 * @param {string}   relativePath   - Path relative to assets/.
 * @param {object}   [options]      - { binary?: boolean, encoding?: string }
 *                                    binary:true or encoding:null → returns Buffer
 * @param {object}   [fileIO]       - Injectable: { read, readBinary }
 * @returns {string|Buffer}
 */
function readAsset(
  assetsDir,
  relativePath,
  options = {},
  fileIO  = {
    read:       (p) => nodeFs.readFileSync(p, 'utf8'),
    readBinary: (p) => nodeFs.readFileSync(p),
  }
) {
  const fullPath = nodePath.resolve(assetsDir, relativePath);

  // Security: prevent path traversal out of assets/
  if (!fullPath.startsWith(assetsDir)) {
    throw new Error(
      `readAsset: path traversal detected — "${relativePath}" escapes assets directory`
    );
  }

  const isBinary = options.binary === true || options.encoding === null;
  return isBinary
    ? fileIO.readBinary(fullPath)
    : fileIO.read(fullPath);
}

// ── buildStock ────────────────────────────────────────────────────────────────

/**
 * Build the complete stock bundle for one descriptor invocation.
 *
 * @param {object} descriptor          - Registry descriptor entry (name, path, enabled)
 * @param {object} config              - Merged engine config (onError, logLevel, etc.)
 * @param {object} [options]           - Injectable overrides for testing
 * @param {object} [options.fileIO]    - { exists, read, readBinary }
 * @param {object} [options.logIO]     - Logger I/O override (see logger.js)
 * @param {Function} [options.execFn] - execSync override
 * @param {Function} [options.dotenvParse] - dotenv.parse override
 * @returns {object}  The stock bundle: { log, env, readAsset, shell, paths, fs, path }
 */
function buildStock(descriptor, config, options = {}) {
  const {
    fileIO      = { exists: nodeFs.existsSync,
                    read:   (p) => nodeFs.readFileSync(p, 'utf8'),
                    readBinary: (p) => nodeFs.readFileSync(p) },
    logIO       = undefined,
    execFn      = execSync,
    dotenvParse = dotenv.parse,
  } = options;

  const descriptorRoot = descriptor.path;
  const assetsDir      = nodePath.join(descriptorRoot, 'assets');
  const logsDir        = nodePath.join(descriptorRoot, 'logs');

  // Logger
  const loggerOpts = {
    scope:         descriptor.name,
    logsDir,
    logLevel:      config.logLevel      || 'info',
    retentionDays: config.logRetentionDays || 14,
  };
  if (logIO) loggerOpts.io = logIO;
  const log = new Logger(loggerOpts);

  // Env
  const env = loadEnv(descriptorRoot, fileIO, dotenvParse);

  // Resolved paths
  const paths = {
    root:   descriptorRoot,
    assets: assetsDir,
    logs:   logsDir,
  };

  return {
    /** Scoped logger — .info(), .warn(), .error(), .debug() */
    log,

    /** Resolved .env values (shell env takes precedence over .env file) */
    env,

    /**
     * Read a file from this descriptor's assets/ folder.
     * @param {string} relativePath
     * @param {{ binary?: boolean, encoding?: string }} [opts]
     * @returns {string|Buffer}
     */
    readAsset(relativePath, opts) {
      return readAsset(assetsDir, relativePath, opts, fileIO);
    },

    /**
     * Run a shell command; returns trimmed stdout.
     * Throws on non-zero exit.
     * @param {string} command
     * @param {{ cwd?: string, env?: object }} [opts]
     * @returns {string}
     */
    shell(command, opts) {
      return runShell(command, opts, execFn);
    },

    /** Absolute paths for root, assets, and logs directories */
    paths,

    /** node:fs/promises — convenience re-export */
    fs: nodeFsP,

    /** node:path — convenience re-export */
    path: nodePath,
  };
}

module.exports = { buildStock, loadEnv, findMissingEnv, runShell, readAsset };
