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

    // Your build logic here.
    // Examples:
    //   const template = await readAsset('template.html');
    //   const output   = template.replace('{{VERSION}}', env.VERSION);
    //   await fs.writeFile(path.join(paths.root, 'dist', 'index.html'), output);
    //   await shell('npm run compile', { cwd: env.PROJECT_DIR });

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
