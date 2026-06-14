'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { Logger, formatLine, formatTimestamp, formatDate, colourLine, LEVELS } = require('../logger');

// ── Pure formatters ───────────────────────────────────────────────────────────

test('formatTimestamp: produces YYYY-MM-DD HH:MM:SS', () => {
  const d = new Date('2024-11-03T09:14:22Z');
  // Use UTC offset-aware: construct with local time values explicitly
  const local = new Date(2024, 10, 3, 9, 14, 22); // month is 0-based
  const ts    = formatTimestamp(local);
  assert.match(ts, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.ok(ts.startsWith('2024-11-03'));
});

test('formatDate: produces YYYY-MM-DD', () => {
  const d = new Date(2024, 10, 3); // Nov 3 2024
  assert.equal(formatDate(d), '2024-11-03');
});

test('formatDate: pads month and day', () => {
  const d = new Date(2024, 0, 5); // Jan 5 2024
  assert.equal(formatDate(d), '2024-01-05');
});

test('formatLine: contains timestamp, level, scope, message', () => {
  const d    = new Date(2024, 10, 3, 9, 14, 22);
  const line = formatLine('info', 'my-desc', 'Hello world', d);
  assert.ok(line.includes('[INFO ]'));
  assert.ok(line.includes('[my-desc]'));
  assert.ok(line.includes('Hello world'));
  assert.ok(line.includes('2024-11-03'));
});

test('formatLine: pads level to 5 chars', () => {
  const d    = new Date(2024, 10, 3, 9, 0, 0);
  const line = formatLine('warn', 'x', 'msg', d);
  assert.ok(line.includes('[WARN ]'));
});

test('colourLine: returns unchanged line when isTTY is false', () => {
  const line = '[2024-11-03 09:14:22] [INFO ] [x] msg';
  assert.equal(colourLine('info', line, false), line);
});

test('colourLine: adds ANSI codes when isTTY is true', () => {
  const line = 'test line';
  const coloured = colourLine('error', line, true);
  assert.ok(coloured.includes('\x1b['));
  assert.ok(coloured.includes(line));
  assert.ok(coloured.endsWith('\x1b[0m'));
});

// ── Logger class ──────────────────────────────────────────────────────────────

function makeMockIO(now = new Date(2024, 10, 3, 9, 14, 22)) {
  const consoleLines = [];
  const fileLines    = [];
  const deletedFiles = [];
  const listedFiles  = [];

  return {
    consoleLines, fileLines, deletedFiles, listedFiles,
    io: {
      writeToConsole: (level, line) => consoleLines.push({ level, line }),
      appendToFile:   (path, line)  => fileLines.push({ path, line }),
      listLogFiles:   (dir)         => listedFiles,
      deleteFile:     (p)           => deletedFiles.push(p),
      now:            ()            => now,
    },
  };
}

test('Logger: emits to console and file', () => {
  const { consoleLines, fileLines, io } = makeMockIO();
  const logger = new Logger({ scope: 'test', logsDir: '/tmp/logs', io });
  logger.info('hello');
  assert.equal(consoleLines.length, 1);
  assert.equal(fileLines.length, 1);
  assert.ok(fileLines[0].line.includes('hello'));
  assert.ok(fileLines[0].line.includes('[test]'));
});

test('Logger: file path uses date from now()', () => {
  const { fileLines, io } = makeMockIO(new Date(2024, 10, 3, 9, 0, 0));
  const logger = new Logger({ scope: 'x', logsDir: '/logs', io });
  logger.info('msg');
  assert.ok(fileLines[0].path.includes('build-2024-11-03.log'));
});

test('Logger: respects minimum log level', () => {
  const { consoleLines, io } = makeMockIO();
  const logger = new Logger({ scope: 'x', logsDir: '/logs', logLevel: 'warn', io });
  logger.debug('debug msg');
  logger.info('info msg');
  logger.warn('warn msg');
  logger.error('error msg');
  assert.equal(consoleLines.length, 2);
  assert.ok(consoleLines.every((l) => l.level === 'warn' || l.level === 'error'));
});

test('Logger: debug level emits everything', () => {
  const { consoleLines, io } = makeMockIO();
  const logger = new Logger({ scope: 'x', logsDir: '/logs', logLevel: 'debug', io });
  logger.debug('d'); logger.info('i'); logger.warn('w'); logger.error('e');
  assert.equal(consoleLines.length, 4);
});

test('Logger: rotate deletes files older than retentionDays', () => {
  const now = new Date(2024, 10, 20, 9, 0, 0); // Nov 20 2024
  const { deletedFiles, io } = makeMockIO(now);
  // Provide files: one old (Nov 1), one recent (Nov 15), one future-safe (Nov 20)
  io.listLogFiles = () => [
    '/logs/build-2024-11-01.log',
    '/logs/build-2024-11-15.log',
    '/logs/build-2024-11-20.log',
  ];
  const logger = new Logger({ scope: 'x', logsDir: '/logs', retentionDays: 7, io });
  logger.rotate();
  // Cutoff: Nov 20 - 7 = Nov 13 → delete anything before Nov 13
  assert.ok(deletedFiles.includes('/logs/build-2024-11-01.log'));
  assert.ok(!deletedFiles.includes('/logs/build-2024-11-15.log'));
  assert.ok(!deletedFiles.includes('/logs/build-2024-11-20.log'));
});

test('Logger: rotate does not crash when logsDir has no files', () => {
  const { io } = makeMockIO();
  io.listLogFiles = () => [];
  const logger = new Logger({ scope: 'x', logsDir: '/logs', io });
  assert.doesNotThrow(() => logger.rotate());
});

test('Logger: coerces message to string', () => {
  const { consoleLines, io } = makeMockIO();
  const logger = new Logger({ scope: 'x', logsDir: '/logs', io });
  logger.info(42);
  assert.ok(consoleLines[0].line.includes('42'));
});
