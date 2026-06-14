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
 *   9. Notarize and staple (if APPLE_ID / APPLE_PASSWORD / APPLE_TEAM_ID are set)
 *
 * Requirements:
 *   - macOS (steps 4–9 are macOS-only)
 *   - Xcode Command Line Tools (codesign, notarytool, stapler, plutil)
 *   - pkg installed (globally or via PKG_BIN)
 *   - nacre repo cloned and shim compiled (swift build -c release)
 *
 * See .env.template for all required and optional environment variables.
 */

const nodePath = require('node:path');

module.exports = {
  async main(stock) {
    const { log, env, shell, fs, path } = stock;

    // ── Step 1: Validate ────────────────────────────────────────────────────

    log.info('Step 1/9 — Validating environment');

    const required = [
      'SOURCE_DIR', 'APP_NAME', 'APP_BUNDLE_ID', 'APP_VERSION',
      'APP_ICON',   'OUTPUT_DIR', 'NACRE_DIR',    'PKG_BIN',
    ];
    for (const key of required) {
      if (!env[key]) throw new Error(`Missing required variable: ${key}`);
    }

    const sourceDir  = path.resolve(env.SOURCE_DIR);
    const nacrDir    = path.resolve(env.NACRE_DIR);
    const outputDir  = path.resolve(env.OUTPUT_DIR);
    const pkgJsonPath = path.join(sourceDir, 'package.json');

    if (!(await exists(fs, sourceDir))) {
      throw new Error(`SOURCE_DIR does not exist: ${sourceDir}`);
    }
    if (!(await exists(fs, pkgJsonPath))) {
      throw new Error(`No package.json found in SOURCE_DIR: ${pkgJsonPath}`);
    }
    if (!(await exists(fs, nacrDir))) {
      throw new Error(`NACRE_DIR does not exist: ${nacrDir}`);
    }

    const nacreScript = path.join(nacrDir, 'scripts', 'build.js');
    if (!(await exists(fs, nacreScript))) {
      throw new Error(`nacre build script not found: ${nacreScript}`);
    }

    log.info(`Source project : ${sourceDir}`);
    log.info(`nacre repo     : ${nacrDir}`);
    log.info(`Output dir     : ${outputDir}`);

    // ── Step 2: Copy source to build location ───────────────────────────────

    log.info('Step 2/9 — Copying source project to build location');

    const buildDir = path.join(outputDir, '_build');
    await fs.rm(buildDir, { recursive: true, force: true });
    await fs.mkdir(buildDir, { recursive: true });
    shell(`cp -R "${sourceDir}/." "${buildDir}"`);
    // Remove node_modules — pkg will bundle dependencies
    await fs.rm(path.join(buildDir, 'node_modules'), { recursive: true, force: true });

    log.info(`Build location : ${buildDir}`);

    // ── Step 3: Patch package.json ──────────────────────────────────────────

    log.info('Step 3/9 — Patching package.json for nacre mode');

    const pkgJsonBuild = path.join(buildDir, 'package.json');
    const pkgJson      = JSON.parse(await fs.readFile(pkgJsonBuild, 'utf8'));

    pkgJson.taskPrimer             = pkgJson.taskPrimer || {};
    pkgJson.taskPrimer.appBundleId = env.APP_BUNDLE_ID;
    pkgJson.taskPrimer.browser     = {
      ...(pkgJson.taskPrimer.browser || {}),
      product: 'nacre',
    };

    await fs.writeFile(pkgJsonBuild, JSON.stringify(pkgJson, null, 2) + '\n', 'utf8');
    log.info('package.json patched: browser.product=nacre, appBundleId set');

    // ── Step 4: Run pkg ─────────────────────────────────────────────────────

    log.info('Step 4/9 — Packaging with pkg');

    const macOSDir   = path.join(outputDir, '_macos');
    const binaryName = safeName(env.APP_NAME);
    const binaryPath = path.join(macOSDir, binaryName);

    await fs.mkdir(macOSDir, { recursive: true });

    const pkgTarget = env.PKG_TARGET || 'node20-macos-arm64';
    shell(
      `"${env.PKG_BIN}" "${pkgJsonBuild}" ` +
      `--target ${pkgTarget} ` +
      `--output "${binaryPath}"`,
      { cwd: buildDir }
    );

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

    // Copy Mach-O binary
    await fs.copyFile(binaryPath, path.join(appMacOS, binaryName));
    shell(`chmod +x "${path.join(appMacOS, binaryName)}"`);

    // Write Info.plist for the outer bundle
    const outerPlist = outerInfoPlist({
      appName,
      bundleId:   env.APP_BUNDLE_ID,
      version:    env.APP_VERSION,
      executable: binaryName,
    });
    await fs.writeFile(path.join(contents, 'Info.plist'), outerPlist, 'utf8');

    // Copy icon
    const iconSrc = path.resolve(env.APP_ICON);
    if (!(await exists(fs, iconSrc))) throw new Error(`APP_ICON not found: ${iconSrc}`);
    shell(`cp "${iconSrc}" "${path.join(appRes, 'AppIcon.icns')}"`);

    log.info(`Outer bundle   : ${appBundle}`);

    // ── Step 6: Build nacre bundle ──────────────────────────────────────────

    log.info('Step 6/9 — Building nacre bundle');

    // Write a temporary nacre config file
    const nacrConfig = {
      app:    { name: appName, bundleId: env.APP_BUNDLE_ID,
                version: env.APP_VERSION, icon: iconSrc },
      output: { dir: path.join(outputDir, '_nacre') },
    };
    const nacrConfigPath = path.join(outputDir, '_nacre.config.json');
    await fs.writeFile(nacrConfigPath, JSON.stringify(nacrConfig, null, 2), 'utf8');

    shell(`node "${nacreScript}" --config "${nacrConfigPath}"`);

    const nacrBundle = path.join(outputDir, '_nacre', `${appName}.app`);
    if (!(await exists(fs, nacrBundle))) {
      throw new Error(`nacre build did not produce expected bundle: ${nacrBundle}`);
    }
    log.info(`nacre bundle   : ${nacrBundle}`);

    // ── Step 7: Copy nacre bundle into outer .app/Contents/Resources/ ───────

    log.info('Step 7/9 — Placing nacre bundle inside outer .app');

    const nacrDest = path.join(appRes, `${appName}.app`);
    await fs.rm(nacrDest, { recursive: true, force: true });
    shell(`cp -R "${nacrBundle}" "${nacrDest}"`);
    log.info(`nacre placed at: ${nacrDest}`);

    // ── Step 8: Code-sign ───────────────────────────────────────────────────

    if (env.APPLE_IDENTITY) {
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

    const canNotarize = env.APPLE_ID && env.APPLE_PASSWORD && env.APPLE_TEAM_ID;

    if (canNotarize) {
      log.info('Step 9/9 — Notarizing (this may take several minutes)');

      // Zip for submission
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
      log.warn('Step 9/9 — Skipped (APPLE_ID / APPLE_PASSWORD / APPLE_TEAM_ID not set)');
    }

    // ── Cleanup ─────────────────────────────────────────────────────────────

    await fs.rm(buildDir,       { recursive: true, force: true });
    await fs.rm(macOSDir,       { recursive: true, force: true });
    await fs.rm(path.join(outputDir, '_nacre'), { recursive: true, force: true });
    await fs.rm(nacrConfigPath, { force: true });

    log.info(`\n✓ Build complete: ${appBundle}\n`);
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

async function exists(fs, p) {
  try { await fs.access(p); return true; }
  catch (_) { return false; }
}

/** Produce a filesystem-safe binary name from an app name. */
function safeName(appName) {
  return appName.replace(/[^a-zA-Z0-9._-]/g, '-');
}

/** Generate a minimal Info.plist for the outer .app bundle. */
function outerInfoPlist({ appName, bundleId, version, executable }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>${escXml(appName)}</string>
  <key>CFBundleDisplayName</key>
  <string>${escXml(appName)}</string>
  <key>CFBundleIdentifier</key>
  <string>${escXml(bundleId)}</string>
  <key>CFBundleVersion</key>
  <string>${escXml(version)}</string>
  <key>CFBundleShortVersionString</key>
  <string>${escXml(version)}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleExecutable</key>
  <string>${escXml(executable)}</string>
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

function escXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
