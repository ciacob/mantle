'use strict';

/**
 * sample-descriptors/task-primer-nacre/build.js
 *
 * MANTLE build descriptor: package a task-primer project into a macOS .app
 * bundle that uses nacre as its UI layer.
 *
 * Pipeline:
 *   1. Validate environment variables and source project
 *   2. Copy source project to a temporary build location
 *   3. Patch package.json: set browser.product = "nacre", appBundleId
 *   4. Run pkg to produce a Mach-O binary
 *   5. Assemble the outer .app bundle around the Mach-O
 *   6. Build the nacre .app bundle (node nacre/scripts/build.js)
 *   7. Copy the nacre bundle into the outer .app/Contents/Resources/
 *   8. Code-sign the bundle (if APPLE_IDENTITY is set)
 *   9. Notarize and staple (if APPLE_ID / APPLE_PASSWORD / APPLE_TEAM_ID set)
 *
 * All logic that can be pure or context-injected lives in the exported
 * helpers below main(). main() is an orchestrator only — it calls helpers
 * and acts on their results. See tests/ for coverage.
 */

const nodePath = require('node:path');

// ── Pure helpers ──────────────────────────────────────────────────────────────

/**
 * Return an array of key names whose values are missing (empty, null,
 * undefined) from the given env map, filtered to those in `required`.
 *
 * @param {object}   env       - Flat key→value map (from stock.env)
 * @param {string[]} required  - Keys that must be non-empty
 * @returns {string[]}           Missing key names
 */
function validateEnv(env, required) {
  return required.filter((k) => !env[k] || String(env[k]).trim() === '');
}

/**
 * Produce a filesystem-safe binary name from an app name.
 * Replaces any character that is not alphanumeric, dot, underscore,
 * or hyphen with a hyphen.
 *
 * @param {string} appName
 * @returns {string}
 */
function safeName(appName) {
  return String(appName).replace(/[^a-zA-Z0-9._-]/g, '-');
}

/**
 * Escape a string for safe embedding as XML character data.
 *
 * @param {string} str
 * @returns {string}
 */
function escXml(str) {
  return String(str)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&apos;');
}

/**
 * Return a new package.json object patched for nacre mode.
 * Does not mutate the input.
 *
 * Changes:
 *   taskPrimer.appBundleId = bundleId
 *   taskPrimer.browser.product = "nacre"
 *   All other browser.* keys are preserved.
 *
 * @param {object} pkgJson    - Parsed package.json object
 * @param {string} bundleId   - CFBundleIdentifier value
 * @returns {object}            New patched object
 */
function patchPackageJson(pkgJson, bundleId) {
  const tp      = pkgJson.taskPrimer || {};
  const mainFile = pkgJson.main || 'main.js';
  return {
    ...pkgJson,
    // pkg requires a `bin` field to locate the entry point
    bin: pkgJson.bin || mainFile,
    // Declare dynamically-loaded assets so pkg bundles them into the binary.
    // ui/ contains the web frontend; tasks/ contains user task modules.
    // Adjust if your project uses different paths.
    pkg: {
      ...(pkgJson.pkg || {}),
      assets: [
        ...((pkgJson.pkg && pkgJson.pkg.assets) || []),
        'ui/**',
        'tasks/**',
      ],
    },
    taskPrimer: {
      ...tp,
      appBundleId: bundleId,
      browser: {
        ...(tp.browser || {}),
        product: 'nacre',
      },
    },
  };
}

/**
 * Generate a minimal Info.plist XML string for the outer .app bundle.
 *
 * @param {object} opts
 * @param {string} opts.appName
 * @param {string} opts.bundleId
 * @param {string} opts.version
 * @param {string} opts.executable  - CFBundleExecutable (the Mach-O binary name)
 * @returns {string}
 */
function outerInfoPlist({ appName, bundleId, version, executable }) {
  const x = escXml;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>${x(appName)}</string>
  <key>CFBundleDisplayName</key>
  <string>${x(appName)}</string>
  <key>CFBundleIdentifier</key>
  <string>${x(bundleId)}</string>
  <key>CFBundleVersion</key>
  <string>${x(version)}</string>
  <key>CFBundleShortVersionString</key>
  <string>${x(version)}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleExecutable</key>
  <string>${x(executable)}</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSPrincipalClass</key>
  <string>NSApplication</string>
</dict>
</plist>
`;
}

/**
 * Build the nacre config object that will be written to a temporary
 * nacre.config.json before invoking nacre's build script.
 *
 * @param {object} opts
 * @param {string} opts.appName
 * @param {string} opts.bundleId
 * @param {string} opts.version
 * @param {string} opts.iconPath     - Absolute path to .icns file
 * @param {string} opts.nacreOutDir  - Absolute path where nacre writes its output
 * @returns {object}                   nacre config object (ready to JSON.stringify)
 */
function buildNacreConfig({ appName, bundleId, version, iconPath, nacreOutDir }) {
  return {
    app: {
      name:     appName,
      bundleId,
      version,
      icon:     iconPath,
    },
    output: {
      dir: nacreOutDir,
    },
  };
}

/**
 * Resolve a set of env variable values to absolute paths, relative to a
 * base directory when they are not already absolute.
 *
 * Returns a plain object mapping each key to its resolved absolute path.
 * Keys whose value is empty or absent are omitted from the result.
 *
 * @param {object}   env      - Flat key→value env map
 * @param {string[]} keys     - Env variable names to resolve
 * @param {string}   baseDir  - Directory to resolve relative paths against
 * @param {object}   [path]   - Injectable path module (default: node:path)
 * @returns {object}            { KEY: '/absolute/path', ... }
 */
function resolveEnvPaths(env, keys, baseDir, path = nodePath) {
  const result = {};
  for (const key of keys) {
    const value = env[key];
    if (!value || String(value).trim() === '') continue;
    result[key] = path.isAbsolute(value)
      ? value
      : path.resolve(baseDir, value);
  }
  return result;
}

/**
 * Determine which optional signing / notarization steps are available
 * based on the resolved env map.
 *
 * @param {object} env  - Resolved env map
 * @returns {{ canSign: boolean, canNotarize: boolean }}
 */
function resolveOptionalSteps(env) {
  return {
    canSign:      Boolean(env.APPLE_IDENTITY),
    canNotarize:  Boolean(env.APPLE_ID && env.APPLE_PASSWORD && env.APPLE_TEAM_ID),
  };
}

// ── Async context-injected helpers ────────────────────────────────────────────

/**
 * Check whether a path exists, using an injectable fs module.
 *
 * @param {object} fs   - fs/promises or compatible mock
 * @param {string} p    - Path to check
 * @returns {Promise<boolean>}
 */
async function exists(fs, p) {
  try { await fs.access(p); return true; }
  catch (_) { return false; }
}

/**
 * Read, patch, and write back a package.json file.
 *
 * @param {object} fs          - fs/promises or compatible mock
 * @param {string} filePath    - Absolute path to package.json
 * @param {string} bundleId    - Bundle ID to inject
 * @returns {Promise<object>}    The patched package.json object
 */
async function applyPackageJsonPatch(fs, filePath, bundleId) {
  const raw     = await fs.readFile(filePath, 'utf8');
  const pkgJson = JSON.parse(raw);
  const patched = patchPackageJson(pkgJson, bundleId);
  await fs.writeFile(filePath, JSON.stringify(patched, null, 2) + '\n', 'utf8');
  return patched;
}

/**
 * Write a nacre config JSON file to disk.
 *
 * @param {object} fs          - fs/promises or compatible mock
 * @param {string} filePath    - Absolute destination path
 * @param {object} config      - nacre config object (from buildNacreConfig)
 * @returns {Promise<void>}
 */
async function writeNacreConfig(fs, filePath, config) {
  await fs.writeFile(filePath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

// ── main — orchestrator only ──────────────────────────────────────────────────

module.exports = {
  async main(stock) {
    const { log, env, shell, fs, path } = stock;

    // ── Step 1: Validate ────────────────────────────────────────────────────

    log.info('Step 1/9 — Validating environment');

    const REQUIRED = [
      'SOURCE_DIR', 'APP_NAME', 'APP_BUNDLE_ID', 'APP_VERSION',
      'APP_ICON',   'OUTPUT_DIR', 'NACRE_DIR',    'PKG_BIN',
    ];
    const missing = validateEnv(env, REQUIRED);
    if (missing.length > 0) {
      throw new Error(`Missing required variables: ${missing.join(', ')}`);
    }

    // Resolve paths using the stock utilities:
    //   resolvePath      — anchors relative values to process.cwd()
    //   resolveAssetPath — anchors relative values to this descriptor's assets/
    const sourceDir = stock.resolvePath('SOURCE_DIR');
    const nacrDir   = stock.resolvePath('NACRE_DIR');
    const outputDir = stock.resolvePath('OUTPUT_DIR');
    const iconPath  = stock.resolveAssetPath('APP_ICON');
    const pkgJsonPath = path.join(sourceDir, 'package.json');
    const nacreScript = path.join(nacrDir, 'scripts', 'build.js');

    for (const [label, p] of [
      ['SOURCE_DIR',      sourceDir],
      ['package.json',    pkgJsonPath],
      ['NACRE_DIR',       nacrDir],
      ['nacre build.js',  nacreScript],
      ['APP_ICON',        iconPath],
    ]) {
      if (!(await exists(fs, p))) {
        throw new Error(`${label} not found: ${p}`);
      }
    }

    const { canSign, canNotarize } = resolveOptionalSteps(env);
    log.info(`Source project : ${sourceDir}`);
    log.info(`nacre repo     : ${nacrDir}`);
    log.info(`Output dir     : ${outputDir}`);
    log.info(`Signing        : ${canSign ? 'yes' : 'skipped (APPLE_IDENTITY not set)'}`);
    log.info(`Notarization   : ${canNotarize ? 'yes' : 'skipped (credentials not set)'}`);

    // ── Step 2: Copy source to build location ───────────────────────────────

    log.info('Step 2/9 — Copying source project to build location');

    const buildDir = path.join(outputDir, '_build');
    await fs.rm(buildDir, { recursive: true, force: true });
    await fs.mkdir(buildDir, { recursive: true });

    // Exclude .git, .browsers (large, not needed for packaging) and
    // any existing node_modules (reinstalled below for a clean prod tree).
    shell(
      `rsync -a --exclude='.git' --exclude='.browsers' --exclude='node_modules' ` +
      `"${sourceDir}/" "${buildDir}/"`
    );
    log.info(`Build location : ${buildDir}`);

    // ── Step 3: Patch package.json ──────────────────────────────────────────

    log.info('Step 3/9 — Patching package.json for nacre mode');

    const pkgJsonBuild = path.join(buildDir, 'package.json');
    await applyPackageJsonPatch(fs, pkgJsonBuild, env.APP_BUNDLE_ID);
    log.info('package.json patched: browser.product=nacre, appBundleId set');

    // Reinstall production dependencies so pkg can bundle them
    log.info('Installing production dependencies for pkg…');
    shell('npm install --omit=dev', { cwd: buildDir, stream: true });

    // ── Step 4: Run pkg ─────────────────────────────────────────────────────

    const pkgTarget = env.PKG_TARGET || 'node20-macos-arm64';
    log.info('Step 4/9 — Packaging with pkg');
    log.info(`Target         : ${pkgTarget}`);
    log.warn('First run may take ~10 min to build the Node.js base binary from source.');
    log.warn('Subsequent runs use the pkg cache and complete in seconds.');
    log.info('pkg output is suppressed — compiler warnings are expected and harmless.');

    const macOSDir   = path.join(outputDir, '_macos');
    const binaryName = safeName(env.APP_NAME);
    const binaryPath = path.join(macOSDir, binaryName);

    await fs.mkdir(macOSDir, { recursive: true });

    // Run pkg in a child process with stdio fully suppressed.
    // The compiler flood (thousands of C++ lines) is expected and harmless —
    // surfacing it swamps the terminal and log files to no benefit.
    // On failure we get the exit code; the user can run pkg manually to see details.
    await new Promise((resolve, reject) => {
      const { spawn } = require('node:child_process');
      const pkgArgs = [
        pkgJsonBuild,
        '--target',    pkgTarget,
        '--output',    binaryPath,
      ];
      log.info(`Running: ${env.PKG_BIN} ${pkgArgs.join(' ')}`);
      const child = spawn(env.PKG_BIN, pkgArgs, {
        cwd:   buildDir,
        stdio: 'ignore',   // suppress all output
      });
      child.on('error', (err) => reject(new Error(`pkg spawn error: ${err.message}`)));
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(
          `pkg exited with code ${code}.\n` +
          `  Run manually to see details:\n` +
          `  cd "${buildDir}" && ${env.PKG_BIN} "${pkgJsonBuild}" ` +
          `--target ${pkgTarget} --output "${binaryPath}"`
        ));
      });
    });
    log.info(`Mach-O binary  : ${binaryPath}`);

    // ── Step 5: Assemble outer .app bundle ──────────────────────────────────

    log.info('Step 5/9 — Assembling outer .app bundle');

    const appName    = env.APP_NAME;
    const appBundle  = path.join(outputDir, `${appName}.app`);
    const contents   = path.join(appBundle, 'Contents');
    const appMacOS   = path.join(contents,  'MacOS');
    const appRes     = path.join(contents,  'Resources');

    await fs.rm(appBundle, { recursive: true, force: true });
    await fs.mkdir(appMacOS, { recursive: true });
    await fs.mkdir(appRes,   { recursive: true });

    // The real Mach-O binary is stored with a "-bin" suffix.
    const realBinaryDest = path.join(appMacOS, binaryName + '-bin');
    await fs.copyFile(binaryPath, realBinaryDest);
    shell(`chmod +x "${realBinaryDest}"`);

    // Write a launcher shell script as CFBundleExecutable.
    // macOS has no built-in mechanism for passing fixed arguments to a .app
    // binary at launch time, so we use a thin shell wrapper that always
    // passes --ui --autoexit — the flags task-primer requires to run as a
    // UI application and exit cleanly when the window is closed.
    // Any arguments passed by macOS (e.g. -psn_* process serial number) are
    // forwarded via "$@" so the system handshake still works.
    const launcherPath = path.join(appMacOS, binaryName);
    const launcherScript = [
      '#!/bin/sh',
      `# Launcher for ${appName}`,
      `# Always runs task-primer in UI mode with clean exit on window close.`,
      `DIR="$(cd "$(dirname "$0")" && pwd)"`,
      `exec "$DIR/${binaryName}-bin" --ui --autoexit "$@"`,
    ].join('\n') + '\n';

    await fs.writeFile(launcherPath, launcherScript, 'utf8');
    shell(`chmod +x "${launcherPath}"`);

    // Info.plist — CFBundleExecutable points to the launcher script
    const plist = outerInfoPlist({
      appName,
      bundleId:   env.APP_BUNDLE_ID,
      version:    env.APP_VERSION,
      executable: binaryName,   // same name as launcher
    });
    await fs.writeFile(path.join(contents, 'Info.plist'), plist, 'utf8');
    shell(`cp "${iconPath}" "${path.join(appRes, 'AppIcon.icns')}"`);
    log.info(`Outer bundle   : ${appBundle}`);

    // ── Step 6: Build nacre bundle ──────────────────────────────────────────

    log.info('Step 6/9 — Building nacre bundle');

    const nacreOutDir    = path.join(outputDir, '_nacre');
    const nacreConfigPath = path.join(outputDir, '_nacre.config.json');
    const nacreConfig    = buildNacreConfig({
      appName:    env.APP_NAME,
      bundleId:   env.APP_BUNDLE_ID,
      version:    env.APP_VERSION,
      iconPath,
      nacreOutDir,
    });
    await writeNacreConfig(fs, nacreConfigPath, nacreConfig);
    shell(`node "${nacreScript}" --config "${nacreConfigPath}"`);

    const nacreBundle = path.join(nacreOutDir, `${env.APP_NAME}.app`);
    if (!(await exists(fs, nacreBundle))) {
      throw new Error(`nacre build did not produce expected bundle: ${nacreBundle}`);
    }
    log.info(`nacre bundle   : ${nacreBundle}`);

    // ── Step 7: Place nacre bundle inside outer .app ────────────────────────

    log.info('Step 7/9 — Placing nacre bundle inside outer .app');

    const nacreDest = path.join(appRes, `${env.APP_NAME}.app`);
    await fs.rm(nacreDest, { recursive: true, force: true });
    shell(`cp -R "${nacreBundle}" "${nacreDest}"`);
    log.info(`nacre placed at: ${nacreDest}`);

    // ── Step 8: Code-sign ───────────────────────────────────────────────────

    if (canSign) {
      log.info('Step 8/9 — Code-signing');
      shell(
        `codesign --deep --force --sign "${env.APPLE_IDENTITY}" ` +
        `--options runtime "${appBundle}"`
      );
      log.info('Code-signing complete');
    } else {
      log.warn('Step 8/9 — Skipped (APPLE_IDENTITY not set)');
    }

    // ── Step 9: Notarize and staple ─────────────────────────────────────────

    if (canNotarize) {
      log.info('Step 9/9 — Notarizing');
      const zipPath = `${appBundle}.zip`;
      shell(`ditto -c -k --keepParent "${appBundle}" "${zipPath}"`);
      shell(
        `xcrun notarytool submit "${zipPath}" ` +
        `--apple-id "${env.APPLE_ID}" ` +
        `--password "${env.APPLE_PASSWORD}" ` +
        `--team-id "${env.APPLE_TEAM_ID}" ` +
        `--wait`
      );
      shell(`xcrun stapler staple "${appBundle}"`);
      await fs.rm(zipPath, { force: true });
      log.info('Notarization and stapling complete');
    } else {
      log.warn('Step 9/9 — Skipped (notarization credentials not set)');
    }

    // ── Cleanup ─────────────────────────────────────────────────────────────

    await fs.rm(buildDir,      { recursive: true, force: true });
    await fs.rm(macOSDir,      { recursive: true, force: true });
    await fs.rm(nacreOutDir,   { recursive: true, force: true });
    await fs.rm(nacreConfigPath, { force: true });

    log.info(`\n✓ Build complete: ${appBundle}\n`);
  },

  // ── Exported for testing ──────────────────────────────────────────────────
  validateEnv,
  safeName,
  escXml,
  patchPackageJson,
  outerInfoPlist,
  buildNacreConfig,
  resolveOptionalSteps,
  exists,
  applyPackageJsonPatch,
  writeNacreConfig,
};
