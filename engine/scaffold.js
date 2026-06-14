'use strict';

/**
 * engine/scaffold.js
 *
 * Generates a new build descriptor folder containing:
 *   .env          — empty template with common placeholders
 *   assets/       — empty directory (with .gitkeep)
 *   build.js      — starter template with stock API documented
 *
 * All filesystem operations are injectable for testing.
 */

const nodePath = require('node:path');
const nodeFs   = require('node:fs');

// ── File templates ────────────────────────────────────────────────────────────

function buildJsTemplate(name) {
  return `'use strict';

/**
 * ${name}/build.js
 *
 * MANTLE build descriptor entry point.
 * Export an async \`main\` function — the engine calls it with the stock bundle.
 */

module.exports = {
  async main(stock) {
    const { log, env, readAsset, shell, paths, fs, path } = stock;

    log.info('Starting build: ${name}');

    // ── Path resolution ───────────────────────────────────────────────────
    //
    // Use stock.resolvePath(envKey) for paths outside the descriptor
    // (source projects, output dirs, external tools). Relative values are
    // anchored to the directory where \`mantle run\` is invoked (cwd).
    //
    //   const outputDir = stock.resolvePath('OUTPUT_DIR');
    //   // .env: OUTPUT_DIR=./dist  →  /cwd/dist
    //
    // Use stock.resolveAssetPath(envKey) for files that ship with the
    // descriptor (icons, templates, configs). Drop the file into assets/
    // and reference it by filename only. Relative values are anchored to
    // this descriptor's assets/ folder.
    //
    //   const iconPath = stock.resolveAssetPath('APP_ICON');
    //   // .env: APP_ICON=MyApp.icns  →  /descriptor/assets/MyApp.icns
    //
    // Both methods throw immediately when the variable is empty, so you
    // get a clear error rather than a cryptic ENOENT later.
    // Absolute paths always pass through unchanged.

    // Your build logic here.
    // Examples:
    //   const template = readAsset('template.html');
    //   const output   = template.replace('{{VERSION}}', env.VERSION);
    //   await fs.writeFile(path.join(stock.resolvePath('OUTPUT_DIR'), 'index.html'), output);
    //   shell('npm run compile', { cwd: stock.resolvePath('SOURCE_DIR') });

    log.info('Done: ${name}');
  },
};
`;
}

const dotEnvTemplate = `# .env — descriptor environment variables
# Variables already set in the shell environment take precedence over values here.
# Leave sensitive values (passwords, tokens) blank and set them in the shell or CI.
#
# Add this file to .gitignore if it contains secrets.

# Example:
# OUTPUT_DIR=./dist
# APP_NAME=My App
`;

const gitkeepContent = '';

// ── Scaffold ──────────────────────────────────────────────────────────────────

/**
 * Generate a new descriptor folder at the given absolute path.
 *
 * @param {object} options
 * @param {string}  options.name        - Descriptor name (used in templates)
 * @param {string}  options.destPath    - Absolute path where the folder is created
 * @param {object}  [options.fileIO]    - Injectable: { exists, mkdir, write }
 * @throws {Error} if destPath already exists
 */
function scaffold({ name, destPath, fileIO = realFileIO }) {
  if (fileIO.exists(destPath)) {
    throw new Error(`Descriptor folder already exists: ${destPath}`);
  }

  const assetsDir = nodePath.join(destPath, 'assets');

  fileIO.mkdir(destPath);
  fileIO.mkdir(assetsDir);
  fileIO.write(nodePath.join(destPath,    'build.js'),          buildJsTemplate(name));
  fileIO.write(nodePath.join(destPath,    '.env'),              dotEnvTemplate);
  fileIO.write(nodePath.join(assetsDir,   '.gitkeep'),          gitkeepContent);
}

// ── Real I/O ──────────────────────────────────────────────────────────────────

const realFileIO = {
  exists(p)         { return nodeFs.existsSync(p); },
  mkdir(p)          { nodeFs.mkdirSync(p, { recursive: true }); },
  write(p, content) { nodeFs.writeFileSync(p, content, 'utf8'); },
};

module.exports = { scaffold, buildJsTemplate, dotEnvTemplate, realFileIO };
