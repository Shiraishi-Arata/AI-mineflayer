/**
 * utils/logger.js
 *
 * Colour-coded, timestamped, structured logger for the Minecraft AI Bot.
 *
 * Features:
 *  - Six log levels: debug / info / warn / error / task / ai
 *  - Each level has a distinct ANSI colour for easy console scanning
 *  - All output is also written to a rolling daily log file in /logs
 *  - Factory function createLogger(moduleName) returns a scoped logger
 *
 * Usage:
 *   const { createLogger } = require('../utils/logger');
 *   const log = createLogger('MyModule');
 *   log.info('Something happened', { key: 'value' });
 *   log.error('It broke', { error: err.message });
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// -- ANSI colour codes ---------------------------------------------------------
const C = {
  reset : '\x1b[0m',
  bold  : '\x1b[1m',
  dim   : '\x1b[2m',
  debug : '\x1b[36m',   // cyan
  info  : '\x1b[32m',   // green
  warn  : '\x1b[33m',   // yellow
  error : '\x1b[31m',   // red
  task  : '\x1b[35m',   // magenta  -- task lifecycle events
  ai    : '\x1b[34m',   // blue     -- AI communication events
};

// -- Numeric priority for each level (used for filtering) ---------------------
const PRIORITY = { debug: 0, info: 1, warn: 2, error: 3, task: 1, ai: 1 };

// -- Log file setup ------------------------------------------------------------
const LOGS_DIR  = path.join(__dirname, '..', 'logs');
const TODAY_STR = new Date().toISOString().slice(0, 10);   // YYYY-MM-DD
const LOG_FILE  = path.join(LOGS_DIR, `bot-${TODAY_STR}.log`);

// Create logs directory if needed
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

// Append-mode write stream shared by all logger instances
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });

// -- Core write function -------------------------------------------------------

/**
 * Emits a single log line to both stdout and the log file.
 *
 * @param {string} level  - one of debug/info/warn/error/task/ai
 * @param {string} module - scoped module name shown in the line
 * @param {string} msg    - human-readable message
 * @param {object} [meta] - optional structured data (pretty-printed on new line)
 */
function _write(level, module, msg, meta) {
  const ts    = new Date().toISOString();
  const col   = C[level] ?? C.info;
  const label = level.toUpperCase().padEnd(5);

  // -- Coloured console line -------------------------------------------------
  let consoleLine = `${C.dim}[${ts}]${C.reset} ` +
                    `${col}${C.bold}${label}${C.reset} ` +
                    `${C.bold}[${module}]${C.reset} ` +
                    msg;

  if (meta !== undefined) {
    // Pretty-print objects; show primitives inline
    const metaStr = typeof meta === 'object'
      ? JSON.stringify(meta, null, 2)
                       .split('\n')
                       .map(l => `  ${l}`)
                       .join('\n')
      : String(meta);
    consoleLine += `\n${C.dim}${metaStr}${C.reset}`;
  }
  console.log(consoleLine);

  // -- Plain file line -------------------------------------------------------
  const fileMeta = meta !== undefined ? ` | ${JSON.stringify(meta)}` : '';
  logStream.write(`[${ts}] ${label} [${module}] ${msg}${fileMeta}\n`);
}

// -- Public factory ------------------------------------------------------------

/**
 * Creates a scoped logger with methods for each log level.
 *
 * @param {string} moduleName - identifier shown in every log line for this scope
 * @param {string} [minLevel='debug'] - minimum level to emit (for filtering)
 * @returns {{ debug, info, warn, error, task, ai }}
 */
function createLogger(moduleName, minLevel = 'debug') {
  const minPriority = PRIORITY[minLevel] ?? 0;

  /**
   * Builds a log method for the given level.
   * Each method signature: log.info(message, optionalMeta?)
   */
  const method = (level) => (msg, meta) => {
    if ((PRIORITY[level] ?? 0) >= minPriority) {
      _write(level, moduleName, String(msg), meta);
    }
  };

  return {
    debug : method('debug'),
    info  : method('info'),
    warn  : method('warn'),
    error : method('error'),
    task  : method('task'),
    ai    : method('ai'),
  };
}

// -- Root logger for bootstrap/startup messages --------------------------------
const rootLogger = createLogger('ROOT');

module.exports = { createLogger, rootLogger };