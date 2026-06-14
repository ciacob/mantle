'use strict';

/**
 * engine/schema.js
 *
 * JSON schema definition and validation for mantle.json registry files.
 * Pure functions — no I/O, no side effects, fully unit-testable.
 *
 * Schema:
 *   {
 *     "config": {                        // optional
 *       "onError": "skip" | "abort",
 *       "logRetentionDays": number,
 *       "logLevel": "debug"|"info"|"warn"|"error"
 *     },
 *     "descriptors": [                   // optional (may be empty)
 *       {
 *         "name":    string,             // required, non-empty, unique
 *         "path":    string,             // required, non-empty
 *         "enabled": boolean             // required
 *       }
 *     ]
 *   }
 */

// ── Constants ─────────────────────────────────────────────────────────────────

const VALID_ON_ERROR   = new Set(['skip', 'abort']);
const VALID_LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error']);

const CONFIG_DEFAULTS = {
  onError:          'skip',
  logRetentionDays: 14,
  logLevel:         'info',
};

// ── Validation ────────────────────────────────────────────────────────────────

/**
 * Validate a parsed mantle.json object.
 *
 * Returns `{ valid: true }` on success.
 * Returns `{ valid: false, errors: string[] }` on failure.
 *
 * Does not throw — callers decide how to handle errors.
 *
 * @param {unknown} obj       - Parsed JSON value.
 * @param {string}  [source]  - Human-readable source label for error messages.
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validate(obj, source = 'mantle.json') {
  const errors = [];

  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    errors.push(`${source}: root must be a JSON object`);
    return { valid: false, errors };
  }

  // ── config ──────────────────────────────────────────────────────────────────
  if ('config' in obj) {
    const cfg = obj.config;
    if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) {
      errors.push(`${source}: config must be an object`);
    } else {
      if ('onError' in cfg && !VALID_ON_ERROR.has(cfg.onError)) {
        errors.push(
          `${source}: config.onError must be "skip" or "abort", got "${cfg.onError}"`
        );
      }
      if ('logRetentionDays' in cfg) {
        const v = cfg.logRetentionDays;
        if (!Number.isInteger(v) || v < 1) {
          errors.push(
            `${source}: config.logRetentionDays must be a positive integer, got ${JSON.stringify(v)}`
          );
        }
      }
      if ('logLevel' in cfg && !VALID_LOG_LEVELS.has(cfg.logLevel)) {
        errors.push(
          `${source}: config.logLevel must be one of debug/info/warn/error, got "${cfg.logLevel}"`
        );
      }
    }
  }

  // ── descriptors ─────────────────────────────────────────────────────────────
  if ('descriptors' in obj) {
    const descs = obj.descriptors;
    if (!Array.isArray(descs)) {
      errors.push(`${source}: descriptors must be an array`);
    } else {
      const seenNames = new Set();
      descs.forEach((d, i) => {
        const prefix = `${source}: descriptors[${i}]`;
        if (d === null || typeof d !== 'object' || Array.isArray(d)) {
          errors.push(`${prefix} must be an object`);
          return;
        }
        if (typeof d.name !== 'string' || d.name.trim() === '') {
          errors.push(`${prefix}.name must be a non-empty string`);
        } else {
          if (seenNames.has(d.name)) {
            errors.push(`${prefix}.name "${d.name}" is not unique`);
          }
          seenNames.add(d.name);
        }
        if (typeof d.path !== 'string' || d.path.trim() === '') {
          errors.push(`${prefix}.path must be a non-empty string`);
        }
        if (typeof d.enabled !== 'boolean') {
          errors.push(`${prefix}.enabled must be a boolean`);
        }
      });
    }
  }

  return errors.length === 0
    ? { valid: true,  errors: [] }
    : { valid: false, errors };
}

// ── Merging ───────────────────────────────────────────────────────────────────

/**
 * Merge a global registry object and a local registry object into one
 * effective registry.
 *
 * Rules:
 *   - config: deep merge; local values win over global values.
 *             Missing keys fall back to CONFIG_DEFAULTS.
 *   - descriptors: global first, then local (preserving order within each).
 *                  Duplicate names across the two files are allowed —
 *                  both entries are kept (they are different descriptors
 *                  that happen to share a name across different registries).
 *
 * Either argument may be null (meaning that registry file was not found).
 *
 * @param {object|null} global
 * @param {object|null} local
 * @returns {{ config: object, descriptors: object[] }}
 */
function merge(global_, local) {
  const globalConfig  = (global_ && global_.config)      || {};
  const localConfig   = (local   && local.config)        || {};
  const globalDescs   = (global_ && global_.descriptors) || [];
  const localDescs    = (local   && local.descriptors)   || [];

  const config = {
    ...CONFIG_DEFAULTS,
    ...globalConfig,
    ...localConfig,         // local wins
  };

  const descriptors = [...globalDescs, ...localDescs];

  return { config, descriptors };
}

// ── Normalisation ─────────────────────────────────────────────────────────────

/**
 * Resolve descriptor paths in a registry object relative to the directory
 * that contained the registry file.
 *
 * Paths that are already absolute are left unchanged.
 * Returns a new object — does not mutate the input.
 *
 * @param {object} registry     - Merged registry (output of merge()).
 * @param {string} registryDir  - Absolute directory of the registry file.
 * @param {object} [pathMod]    - Injectable path module (default: node:path).
 * @returns {object}              New registry with resolved descriptor paths.
 */
function resolveDescriptorPaths(registry, registryDir, pathMod = require('node:path')) {
  return {
    ...registry,
    descriptors: registry.descriptors.map((d) => ({
      ...d,
      path: pathMod.isAbsolute(d.path)
        ? d.path
        : pathMod.resolve(registryDir, d.path),
    })),
  };
}

module.exports = { validate, merge, resolveDescriptorPaths, CONFIG_DEFAULTS, VALID_ON_ERROR, VALID_LOG_LEVELS };
