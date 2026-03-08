/**
 * bot/navigation.js
 *
 * Pathfinder-based movement.
 *
 * Key fixes:
 *  - Movements constructor: new Movements(bot) not new Movements(bot, mcData)
 *    (mcData argument was removed in mineflayer-pathfinder >= 2.x)
 *  - explore() uses GoalXZ so Y coordinate is ignored on uneven terrain
 *  - Every step is logged so failures are visible in the console
 *  - Stuck watchdog aborts navigation if bot doesn't move within timeout
 */

'use strict';

const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const Vec3                              = require('vec3');
const { createLogger }                  = require('../utils/logger');

const log = createLogger('Navigation');

const { GoalNear, GoalXZ, GoalBlock, GoalFollow } = goals;

const STUCK_TIMEOUT_MS  = 10000;  // ms without movement before declaring stuck
const STUCK_MOVE_THRESH = 0.5;    // blocks -- threshold for "did move"

class Navigation {
  constructor(bot, config) {
    this.bot    = bot;
    this.config = config;
    this.busy   = false;

    // Load pathfinder plugin
    try {
      bot.loadPlugin(pathfinder);
      log.info('Pathfinder plugin loaded');
    } catch (e) {
      log.error('Failed to load pathfinder plugin!', { error: e.message });
      log.error('Run: npm install mineflayer-pathfinder');
    }

    // Apply movement settings -- wrapped so a failure here is visible
    this._applyMovementSettings();

    log.info('Navigation initialised');
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Move to within `range` blocks of target.
   */
  async moveTo(target, range = 2) {
    const botPos = this.bot.entity?.position;
    if (!botPos) {
      log.warn('moveTo: no bot position');
      return false;
    }

    const dist = botPos.distanceTo(target);
    log.info(`moveTo: target=(${Math.round(target.x)},${Math.round(target.y)},${Math.round(target.z)}) dist=${dist.toFixed(1)} range=${range}`);

    if (dist <= range) {
      log.info('moveTo: already within range');
      return true;
    }

    if (this.busy) {
      log.debug('moveTo: nav busy, waiting for idle...');
      await this._waitForIdle(8000);
    }

    this.busy = true;
    const goal = new GoalNear(target.x, target.y, target.z, range);

    try {
      await Promise.race([
        this.bot.pathfinder.goto(goal),
        this._stuckWatchdog(),
      ]);
      const finalDist = this.bot.entity?.position?.distanceTo(target) ?? 999;
      log.info(`moveTo: arrived, dist now=${finalDist.toFixed(1)}`);
      return true;
    } catch (err) {
      log.warn(`moveTo: failed -- ${err.message}`);
      try { this.bot.pathfinder.stop(); } catch { /* ignore */ }
      return false;
    } finally {
      this.busy = false;
    }
  }

  /**
   * Move to a block position.
   */
  async moveToBlock(blockPos) {
    const botPos = this.bot.entity?.position;
    if (!botPos) return false;

    const dist = botPos.distanceTo(blockPos);
    if (dist <= 3) return true;

    if (this.busy) await this._waitForIdle(8000);
    this.busy = true;

    log.info(`moveToBlock: (${Math.floor(blockPos.x)},${Math.floor(blockPos.y)},${Math.floor(blockPos.z)}) dist=${dist.toFixed(1)}`);

    const goal = new GoalBlock(Math.floor(blockPos.x), Math.floor(blockPos.y), Math.floor(blockPos.z));
    try {
      await Promise.race([
        this.bot.pathfinder.goto(goal),
        this._stuckWatchdog(),
      ]);
      return true;
    } catch (err) {
      log.warn(`moveToBlock: failed -- ${err.message}`);
      try { this.bot.pathfinder.stop(); } catch { /* ignore */ }
      return false;
    } finally {
      this.busy = false;
    }
  }

  /**
   * Explore by walking to a random XZ point.
   * Uses GoalXZ so Y is determined automatically by pathfinder.
   */
  async explore(radius = 32, attempts = 5) {
    const botPos = this.bot.entity?.position;
    if (!botPos) {
      log.warn('explore: no bot position');
      return false;
    }

    log.info(`explore: radius=${radius}, attempts=${attempts}`);
    log.info(`explore: current pos=(${botPos.x.toFixed(1)},${botPos.y.toFixed(1)},${botPos.z.toFixed(1)})`);

    for (let i = 0; i < attempts; i++) {
      if (this.busy) {
        log.debug('explore: stopping busy nav before new attempt');
        this.stop();
        await this._sleep(300);
      }

      // Pick a random XZ destination, biased toward outer half of radius
      const angle = Math.random() * Math.PI * 2;
      const dist  = (radius * 0.4) + Math.random() * (radius * 0.6);
      const tx    = Math.round(botPos.x + Math.cos(angle) * dist);
      const tz    = Math.round(botPos.z + Math.sin(angle) * dist);

      log.info(`explore attempt ${i + 1}/${attempts}: target XZ=(${tx},${tz}) dist=${dist.toFixed(0)}`);

      this.busy = true;
      const goal = new GoalXZ(tx, tz);

      try {
        await Promise.race([
          this.bot.pathfinder.goto(goal),
          this._stuckWatchdog(12000),
        ]);
        const pos = this.bot.entity?.position;
        log.info(`explore: arrived at (${pos?.x.toFixed(1)},${pos?.z.toFixed(1)})`);
        this.busy = false;
        return true;

      } catch (err) {
        log.warn(`explore attempt ${i + 1} failed: ${err.message}`);
        try { this.bot.pathfinder.stop(); } catch { /* ignore */ }
        this.busy = false;
        await this._sleep(500);
      }
    }

    log.warn('explore: all attempts failed');
    return false;
  }

  /**
   * Flee from a danger position.
   */
  async fleeFrom(dangerPos, escapeDist = 20) {
    const botPos = this.bot.entity?.position;
    if (!botPos) return false;

    const diff        = botPos.clone().subtract(dangerPos);
    const currentDist = diff.norm();

    log.info(`fleeFrom: danger=${JSON.stringify(dangerPos)} currentDist=${currentDist.toFixed(1)}`);

    if (currentDist >= escapeDist) {
      log.info('fleeFrom: already far enough');
      return true;
    }

    const norm    = diff.normalize();
    const fleePos = new Vec3(
      Math.round(botPos.x + norm.x * escapeDist),
      botPos.y,
      Math.round(botPos.z + norm.z * escapeDist)
    );

    return this.moveTo(fleePos, 3);
  }

  /** Immediately stop pathfinding. */
  stop() {
    try { this.bot.pathfinder.stop(); } catch { /* not active */ }
    this.busy = false;
    log.debug('Navigation stopped');
  }

  isMoving() { return this.busy; }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Apply movement settings to pathfinder.
   *
   * FIX: new Movements(bot) -- the mcData second argument was REMOVED in
   * mineflayer-pathfinder v2. Passing it causes a silent internal error that
   * leaves the pathfinder with broken/no movement settings, causing the bot
   * to never move despite pathfinder.goto() being called.
   */
  _applyMovementSettings() {
    try {
      // v2+ API: only pass bot
      const movements = new Movements(this.bot);

      const pfCfg = this.config.pathfinder ?? {};
      movements.allowParkour = pfCfg.movementAllowParkour ?? true;
      movements.canDig       = pfCfg.movementCanDig       ?? true;
      movements.maxDropDown  = pfCfg.maxDropDown          ?? 4;

      this.bot.pathfinder.setMovements(movements);
      log.info('Movement settings applied (v2 API)');

    } catch (e) {
      log.error('_applyMovementSettings FAILED', { error: e.message });
      log.error('Pathfinder may not work -- check mineflayer-pathfinder is installed');
    }
  }

  /**
   * Rejects if bot position has not changed by STUCK_MOVE_THRESH blocks
   * within timeoutMs milliseconds.
   */
  _stuckWatchdog(timeoutMs = STUCK_TIMEOUT_MS) {
    return new Promise((_, reject) => {
      let lastPos   = this.bot.entity?.position?.clone();
      let movedAny  = false;

      const interval = setInterval(() => {
        const cur = this.bot.entity?.position;
        if (!cur || !lastPos) return;
        const d = cur.distanceTo(lastPos);
        if (d >= STUCK_MOVE_THRESH) {
          movedAny = true;
          lastPos  = cur.clone();
        }
      }, 800);

      setTimeout(() => {
        clearInterval(interval);
        if (!movedAny) {
          log.warn(`stuckWatchdog: bot did not move in ${timeoutMs}ms -- aborting`);
          reject(new Error('STUCK'));
        }
        // If bot moved, goto() will resolve on its own -- no action needed here
      }, timeoutMs);
    });
  }

  async _waitForIdle(maxMs) {
    const deadline = Date.now() + maxMs;
    while (this.busy && Date.now() < deadline) {
      await this._sleep(200);
    }
    if (this.busy) {
      log.warn('_waitForIdle: timed out, forcing stop');
      this.stop();
    }
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

module.exports = Navigation;