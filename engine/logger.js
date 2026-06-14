'use strict';

/**
 * engine/logger.js
 *
 * Structured logger used by the engine and injected into descriptors
 * as stock.log.
 *
 * Features:
 *   - Four levels: debug, info, warn, error
 *   - Each Logger instance is scoped to a descriptor name (shown in output)
 *   - Writes to console (with colour when TTY) and to a daily rotating
 *     log file in the descriptor's logs/ folder
 *   - Log file rotation: files older than logRetentionDays are deleted
 *   - All I/O is injectable so the core formatting logic is unit-testable
 *     without touching disk or console
 *
 * Testability design:
 *   Logger accepts an `io` object with { writeToConsole, appendToFile,
 *   listLogFiles, deleteFile, now } — tests inject mocks.
 */

const fs   = require('node:fs');
const path = require('node:path');

// ── Level ordering ────────────────────────────────────────────────────────────

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

// ── Formatting ────────────────────────────────────────────────────────────────

/**
 * Format a log timestamp as "YYYY-MM-DD HH:MM:SS".
 * Pure function — injectable date for testing.
 *
 * @param {Date} date
 * @returns {string}
 */
function formatTimestamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/**
 * Format a log date as "YYYY-MM-DD" (used for log file names).
 * @param {Date} date
 * @returns {string}
 */
function formatDate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Build a structured log line (no colour, suitable for disk).
 *
 * @param {string} level      - "debug"|"info"|"warn"|"error"
 * @param {string} scope      - Descriptor name or "mantle"
 * @param {string} message
 * @param {Date}   date
 * @returns {string}
 */
function formatLine(level, scope, message, date) {
  const ts    = formatTimestamp(date);
  const lvl   = level.toUpperCase().padEnd(5);
  return `[${ts}] [${lvl}] [${scope}] ${message}`;
}

/**
 * Apply ANSI colour to a log line for console output.
 * Only applied when the process has a TTY.
 *
 * @param {string} level
 * @param {string} line   - Already-formatted line from formatLine()
 * @param {boolean} isTTY
 * @returns {string}
 */
function colourLine(level, line, isTTY) {
  if (!isTTY) return line;
  const colours = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' };
  const reset   = '\x1b[0m';
  return `${colours[level] || ''}${line}${reset}`;
}

// ── Real I/O ──────────────────────────────────────────────────────────────────

const realIO = {
  writeToConsole(level, line) {
    const coloured = colourLine(level, line, Boolean(process.stdout.isTTY));
    if (level === 'error' || level === 'warn') {
      process.stderr.write(coloured + '\n');
    } else {
      process.stdout.write(coloured + '\n');
    }
  },
  appendToFile(filePath, line) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, line + '\n', 'utf8');
  },
  listLogFiles(logsDir) {
    if (!fs.existsSync(logsDir)) return [];
    return fs.readdirSync(logsDir)
      .filter((f) => f.startsWith('build-') && f.endsWith('.log'))
      .map((f) => path.join(logsDir, f));
  },
  deleteFile(filePath) {
    try { fs.unlinkSync(filePath); } catch (_) {}
  },
  now() { return new Date(); },
};

// ── Logger class ──────────────────────────────────────────────────────────────

class Logger {
  /**
   * @param {object} options
   * @param {string}  options.scope           - Label shown in every line (descriptor name or "mantle")
   * @param {string}  options.logsDir         - Absolute path to the descriptor's logs/ folder
   * @param {string}  [options.logLevel]      - Minimum level to emit (default "info")
   * @param {number}  [options.retentionDays] - Days to keep log files (default 14)
   * @param {object}  [options.io]            - Injectable I/O (default: realIO)
   */
  constructor({
    scope,
    logsDir,
    logLevel      = 'info',
    retentionDays = 14,
    io            = realIO,
  }) {
    this._scope     = scope;
    this._logsDir   = logsDir;
    this._minLevel  = LEVELS[logLevel] ?? LEVELS.info;
    this._retention = retentionDays;
    this._io        = io;
  }

  debug(message)  { this._emit('debug', message); }
  info(message)   { this._emit('info',  message); }
  warn(message)   { this._emit('warn',  message); }
  error(message)  { this._emit('error', message); }

  /**
   * Rotate old log files: delete any build-*.log files in logsDir
   * whose date portion is older than retentionDays ago.
   * Called automatically at the start of each descriptor run.
   */
  rotate() {
    const cutoff = new Date(this._io.now());
    cutoff.setDate(cutoff.getDate() - this._retention);
    const cutoffStr = formatDate(cutoff);   // "YYYY-MM-DD"

    for (const filePath of this._io.listLogFiles(this._logsDir)) {
      const base = path.basename(filePath);          // "build-2024-11-01.log"
      const dateStr = base.slice(6, 16);              // "2024-11-01"
      if (dateStr < cutoffStr) {
        this._io.deleteFile(filePath);
      }
    }
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  _emit(level, message) {
    if ((LEVELS[level] ?? 0) < this._minLevel) return;

    const now     = this._io.now();
    const line    = formatLine(level, this._scope, String(message), now);
    const logFile = path.join(this._logsDir, `build-${formatDate(now)}.log`);

    this._io.writeToConsole(level, line);
    this._io.appendToFile(logFile, line);
  }
}

// ── Engine-level logger (scope = "mantle") ────────────────────────────────────

/**
 * Create a logger scoped to "mantle" itself (not a descriptor).
 * Writes only to console — no disk output.
 *
 * @param {string} [logLevel]
 * @returns {Logger}
 */
function createEngineLogger(logLevel = 'info') {
  return new Logger({
    scope:    'mantle',
    logsDir:  '/dev/null',    // never written to
    logLevel,
    io: {
      ...realIO,
      appendToFile() {},     // no-op — engine log goes to console only
      listLogFiles() { return []; },
      deleteFile()   {},
    },
  });
}

module.exports = { Logger, createEngineLogger, formatLine, formatTimestamp, formatDate, colourLine, LEVELS };
