#!/usr/bin/env node
'use strict';

/**
 * cli.js
 *
 * MANTLE command-line interface.
 *
 * Usage:
 *   mantle new <name> [--path <dir>] [--global]
 *   mantle list
 *   mantle enable <name>  [--global]
 *   mantle disable <name> [--global]
 *   mantle move <name> up|down [--global]
 *   mantle run [<name>] [--on-error skip|abort]
 *   mantle init [--global]
 */

const nodePath = require('node:path');
const nodeOs   = require('node:os');
const { run, load, registry, init } = require('./engine/index');
const { localRegistryPath, globalRegistryPath,
        writeRaw, readRaw, realFileIO } = require('./engine/registry');
const { scaffold } = require('./engine/scaffold');
const { createEngineLogger } = require('./engine/logger');

const log = createEngineLogger();

// ── Argument parsing ──────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args     = argv.slice(2);
  const command  = args[0];
  const flags    = {};
  const positional = [];

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--global')                   { flags.global = true; }
    else if (args[i] === '--path' && args[i+1])   { flags.path = args[++i]; }
    else if (args[i] === '--on-error' && args[i+1]){ flags.onError = args[++i]; }
    else if (args[i] === '--cwd' && args[i+1])    { flags.cwd = nodePath.resolve(args[++i]); }
    else if (!args[i].startsWith('--'))            { positional.push(args[i]); }
  }

  // --cwd changes working directory for the entire invocation
  if (flags.cwd) process.chdir(flags.cwd);

  return { command, flags, positional };
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function cmdNew(positional, flags) {
  const name = positional[0];
  if (!name) { log.error('Usage: mantle new <name> [--path <dir>] [--global]'); process.exit(1); }

  const baseDir  = flags.path
    ? nodePath.resolve(flags.path)
    : process.cwd();
  const destPath = nodePath.join(baseDir, name);

  // Scaffold the folder
  scaffold({ name, destPath });
  log.info(`Scaffolded descriptor: ${destPath}`);

  // Register it (disabled by default)
  const targetPath = flags.global
    ? globalRegistryPath(nodeOs.homedir())
    : localRegistryPath(process.cwd());

  try {
    const data = readRaw(targetPath, realFileIO);
    if (!data.descriptors) data.descriptors = [];
    if (!data.descriptors.some((d) => d.name === name)) {
      data.descriptors.push({ name, path: destPath, enabled: false });
      writeRaw(targetPath, data, realFileIO);
      log.info(`Registered "${name}" in ${targetPath} (disabled by default)`);
      log.info(`Run "mantle enable ${name}" to enable it`);
    }
  } catch (err) {
    log.warn(`Could not auto-register descriptor: ${err.message}`);
    log.info(`Add it manually to ${targetPath}`);
  }
}

function cmdList() {
  let result;
  try {
    result = load({ cwd: process.cwd() });
  } catch (err) {
    log.error(err.message);
    process.exit(1);
  }

  const { registry: reg, localFound, globalFound, localPath, globalPath } = result;

  if (localFound)  log.info(`Local registry:  ${localPath}`);
  if (globalFound) log.info(`Global registry: ${globalPath}`);

  const descs = reg.descriptors;
  if (descs.length === 0) {
    console.log('\n  (no descriptors registered)\n');
    return;
  }

  const nameW = Math.max(4, ...descs.map((d) => d.name.length));
  const header = `  ${'#'.padEnd(3)}  ${'Name'.padEnd(nameW)}  Status`;
  const divider = `  ${'─'.repeat(header.length - 2)}`;

  console.log('');
  console.log(header);
  console.log(divider);
  descs.forEach((d, i) => {
    const status  = d.enabled ? '\x1b[32menabled\x1b[0m' : '\x1b[90mdisabled\x1b[0m';
    console.log(`  ${String(i + 1).padEnd(3)}  ${d.name.padEnd(nameW)}  ${status}`);
  });
  console.log('');
}

function cmdEnable(positional, flags) {
  const name = positional[0];
  if (!name) { log.error('Usage: mantle enable <name> [--global]'); process.exit(1); }
  try {
    registry.enable(name, { global: flags.global });
    log.info(`Enabled "${name}"`);
  } catch (err) {
    log.error(err.message);
    process.exit(1);
  }
}

function cmdDisable(positional, flags) {
  const name = positional[0];
  if (!name) { log.error('Usage: mantle disable <name> [--global]'); process.exit(1); }
  try {
    registry.disable(name, { global: flags.global });
    log.info(`Disabled "${name}"`);
  } catch (err) {
    log.error(err.message);
    process.exit(1);
  }
}

function cmdMove(positional, flags) {
  const name      = positional[0];
  const direction = positional[1];
  if (!name || !['up','down'].includes(direction)) {
    log.error('Usage: mantle move <name> up|down [--global]');
    process.exit(1);
  }
  try {
    registry.move(name, direction, { global: flags.global });
    log.info(`Moved "${name}" ${direction}`);
  } catch (err) {
    log.error(err.message);
    process.exit(1);
  }
}

async function cmdRun(positional, flags) {
  const only    = positional[0] || null;
  const onError = flags.onError || null;
  try {
    const results = await run({ cwd: process.cwd(), only, onError });
    const failed  = results.filter((r) => r.status === 'failed');
    if (failed.length > 0) process.exit(1);
  } catch (err) {
    log.error(err.message);
    process.exit(1);
  }
}

function cmdInitRegistry(flags) {
  const targetPath = flags.global
    ? globalRegistryPath(nodeOs.homedir())
    : localRegistryPath(process.cwd());

  if (realFileIO.exists(targetPath)) {
    log.info(`Registry already exists: ${targetPath}`);
    return;
  }
  writeRaw(targetPath, { descriptors: [] }, realFileIO);
  log.info(`Created registry: ${targetPath}`);
}

function printHelp() {
  console.log(`
MANTLE — Modular Automation eNgine for Task and Lifecycle Execution

Usage:
  mantle new <name> [--path <dir>] [--global]   Scaffold + register a new descriptor
  mantle list                                    List registered descriptors
  mantle enable  <name>  [--global]              Enable a descriptor
  mantle disable <name>  [--global]              Disable a descriptor
  mantle move    <name>  up|down  [--global]     Reorder a descriptor
  mantle run     [<name>] [--on-error skip|abort] Run descriptors
  mantle init    [--global]                      Create an empty registry file

Flags:
  --global          Write to ~/.mantle.json instead of ./mantle.json
  --cwd <dir>       Treat <dir> as the working directory (useful when mantle is not on PATH)
  --path <dir>      Base directory for "mantle new"
  --on-error        skip (default) or abort on first error
`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const { command, flags, positional } = parseArgs(process.argv);

  switch (command) {
    case 'new':     await cmdNew(positional, flags);   break;
    case 'list':         cmdList();                    break;
    case 'enable':       cmdEnable(positional, flags); break;
    case 'disable':      cmdDisable(positional, flags);break;
    case 'move':         cmdMove(positional, flags);   break;
    case 'run':     await cmdRun(positional, flags);   break;
    case 'init':         cmdInitRegistry(flags);       break;
    case 'help':
    case '--help':
    case '-h':           printHelp();                  break;
    default:
      if (command) log.error(`Unknown command: "${command}"`);
      printHelp();
      if (command) process.exit(1);
  }
}

main().catch((err) => {
  console.error('[mantle] Unexpected error:', err.message);
  process.exit(1);
});
