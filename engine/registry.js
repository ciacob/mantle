'use strict';

/**
 * engine/registry.js
 *
 * Loads, merges, validates, and mutates mantle.json registry files.
 *
 * Load strategy:
 *   1. Look for <cwd>/mantle.json  (local)
 *   2. Look for ~/.mantle.json     (global)
 *   3. Merge: global first, local overrides config, descriptors concatenated
 *   4. Validate each file individually before merge
 *
 * Mutation strategy:
 *   - CLI writes to local registry by default
 *   - CLI writes to global registry when --global flag is set
 *   - If local registry doesn't exist yet, it is created on first write
 *
 * All filesystem operations are injectable for testing.
 */

const nodePath = require('node:path');
const nodeFs   = require('node:fs');
const nodeOs   = require('node:os');
const { validate, merge, resolveDescriptorPaths } = require('./schema');

// ── Path helpers ──────────────────────────────────────────────────────────────

/**
 * Return the path to the local registry file.
 * @param {string} [cwd]  - Working directory (default: process.cwd())
 * @returns {string}
 */
function localRegistryPath(cwd = process.cwd()) {
  return nodePath.join(cwd, 'mantle.json');
}

/**
 * Return the path to the global registry file.
 * @param {string} [home] - Home directory (default: os.homedir())
 * @returns {string}
 */
function globalRegistryPath(home = nodeOs.homedir()) {
  return nodePath.join(home, '.mantle.json');
}

// ── Low-level file I/O (injectable) ──────────────────────────────────────────

const realFileIO = {
  exists(p)        { return nodeFs.existsSync(p); },
  read(p)          { return nodeFs.readFileSync(p, 'utf8'); },
  write(p, data)   { nodeFs.writeFileSync(p, data, 'utf8'); },
};

// ── Parsing ───────────────────────────────────────────────────────────────────

/**
 * Parse and validate a registry JSON string.
 *
 * @param {string} jsonStr  - Raw JSON content.
 * @param {string} filePath - Path label used in error messages.
 * @returns {{ ok: true, data: object } | { ok: false, error: string }}
 */
function parseAndValidate(jsonStr, filePath) {
  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    return { ok: false, error: `${filePath}: invalid JSON — ${err.message}` };
  }

  const result = validate(parsed, filePath);
  if (!result.valid) {
    return { ok: false, error: result.errors.join('\n') };
  }

  return { ok: true, data: parsed };
}

// ── Load ──────────────────────────────────────────────────────────────────────

/**
 * Load, validate, and merge the global and local registry files.
 *
 * @param {object} [options]
 * @param {string}  [options.cwd]       - Working directory (default: process.cwd())
 * @param {string}  [options.home]      - Home directory (default: os.homedir())
 * @param {object}  [options.fileIO]    - Injectable file I/O
 * @param {object}  [options.pathMod]   - Injectable path module
 *
 * @returns {{
 *   registry:       object,     // merged effective registry
 *   localPath:      string,     // path checked for local registry
 *   globalPath:     string,     // path checked for global registry
 *   localFound:     boolean,
 *   globalFound:    boolean,
 *   localData:      object|null,
 *   globalData:     object|null,
 * }}
 *
 * @throws {Error} if neither registry file exists, or if any found file
 *                 contains invalid JSON or fails schema validation.
 */
function load({
  cwd     = process.cwd(),
  home    = nodeOs.homedir(),
  fileIO  = realFileIO,
  pathMod = nodePath,
} = {}) {
  const localPath  = localRegistryPath(cwd);
  const globalPath = globalRegistryPath(home);

  const localFound  = fileIO.exists(localPath);
  const globalFound = fileIO.exists(globalPath);

  if (!localFound && !globalFound) {
    throw new Error(
      `No registry found.\n` +
      `  Checked: ${localPath}\n` +
      `  Checked: ${globalPath}\n` +
      `  Run "mantle init" to create a local registry, or ` +
      `"mantle init --global" for a global one.`
    );
  }

  let localData  = null;
  let globalData = null;

  if (localFound) {
    const result = parseAndValidate(fileIO.read(localPath), localPath);
    if (!result.ok) throw new Error(result.error);
    localData = result.data;
  }

  if (globalFound) {
    const result = parseAndValidate(fileIO.read(globalPath), globalPath);
    if (!result.ok) throw new Error(result.error);
    globalData = result.data;
  }

  // Merge global + local, then resolve relative descriptor paths
  const merged = merge(globalData, localData);

  // Resolve paths relative to their source registry file
  let registry = { ...merged, descriptors: [] };

  if (globalData && globalData.descriptors) {
    const globalDir = pathMod.dirname(globalPath);
    const resolved  = resolveDescriptorPaths(
      { descriptors: globalData.descriptors },
      globalDir,
      pathMod
    );
    registry.descriptors.push(...resolved.descriptors);
  }

  if (localData && localData.descriptors) {
    const localDir  = pathMod.dirname(localPath);
    const resolved  = resolveDescriptorPaths(
      { descriptors: localData.descriptors },
      localDir,
      pathMod
    );
    registry.descriptors.push(...resolved.descriptors);
  }

  return { registry, localPath, globalPath, localFound, globalFound, localData, globalData };
}

// ── Mutation helpers ──────────────────────────────────────────────────────────

/**
 * Read and parse a single registry file, returning its raw object
 * (or a minimal empty registry if the file doesn't exist yet).
 *
 * @param {string} filePath
 * @param {object} fileIO
 * @returns {object}  Raw registry object (not merged, not resolved)
 */
function readRaw(filePath, fileIO) {
  if (!fileIO.exists(filePath)) {
    return { descriptors: [] };
  }
  const result = parseAndValidate(fileIO.read(filePath), filePath);
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

/**
 * Write a registry object to a file as formatted JSON.
 * @param {string} filePath
 * @param {object} data
 * @param {object} fileIO
 */
function writeRaw(filePath, data, fileIO) {
  fileIO.write(filePath, JSON.stringify(data, null, 2) + '\n');
}

// ── Mutations ─────────────────────────────────────────────────────────────────

/**
 * Add a descriptor entry to a registry file.
 * Throws if a descriptor with the same name already exists in that file.
 *
 * @param {string}  filePath
 * @param {object}  descriptor  - { name, path, enabled }
 * @param {object}  [fileIO]
 */
function addDescriptor(filePath, descriptor, fileIO = realFileIO) {
  const data = readRaw(filePath, fileIO);
  if (!data.descriptors) data.descriptors = [];
  if (data.descriptors.some((d) => d.name === descriptor.name)) {
    throw new Error(
      `Descriptor "${descriptor.name}" already exists in ${filePath}`
    );
  }
  data.descriptors.push(descriptor);
  writeRaw(filePath, data, fileIO);
}

/**
 * Mutate a descriptor's `enabled` field in a registry file.
 * Throws if the descriptor is not found.
 *
 * @param {string}  filePath
 * @param {string}  name
 * @param {boolean} enabled
 * @param {object}  [fileIO]
 */
function setEnabled(filePath, name, enabled, fileIO = realFileIO) {
  const data = readRaw(filePath, fileIO);
  const desc = (data.descriptors || []).find((d) => d.name === name);
  if (!desc) {
    throw new Error(`Descriptor "${name}" not found in ${filePath}`);
  }
  desc.enabled = enabled;
  writeRaw(filePath, data, fileIO);
}

/**
 * Move a descriptor one position up or down in a registry file.
 * Throws if the descriptor is not found or already at the boundary.
 *
 * @param {string}  filePath
 * @param {string}  name
 * @param {'up'|'down'} direction
 * @param {object}  [fileIO]
 */
function moveDescriptor(filePath, name, direction, fileIO = realFileIO) {
  const data  = readRaw(filePath, fileIO);
  const descs = data.descriptors || [];
  const idx   = descs.findIndex((d) => d.name === name);

  if (idx === -1) {
    throw new Error(`Descriptor "${name}" not found in ${filePath}`);
  }

  const newIdx = direction === 'up' ? idx - 1 : idx + 1;

  if (newIdx < 0) {
    throw new Error(`Descriptor "${name}" is already first in ${filePath}`);
  }
  if (newIdx >= descs.length) {
    throw new Error(`Descriptor "${name}" is already last in ${filePath}`);
  }

  // Swap
  [descs[idx], descs[newIdx]] = [descs[newIdx], descs[idx]];
  writeRaw(filePath, data, fileIO);
}

/**
 * Write a config block to a registry file (merges with existing config).
 *
 * @param {string} filePath
 * @param {object} configPatch  - Partial config object to merge in
 * @param {object} [fileIO]
 */
function setConfig(filePath, configPatch, fileIO = realFileIO) {
  const data   = readRaw(filePath, fileIO);
  data.config  = { ...(data.config || {}), ...configPatch };
  writeRaw(filePath, data, fileIO);
}

module.exports = {
  localRegistryPath,
  globalRegistryPath,
  parseAndValidate,
  load,
  addDescriptor,
  setEnabled,
  moveDescriptor,
  setConfig,
  readRaw,
  writeRaw,
  realFileIO,
};
