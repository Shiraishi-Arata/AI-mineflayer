/**
 * bot/aiClient.js
 *
 * HTTP bridge between the Mineflayer bot and the Python AI planner.
 *
 * Responsibilities:
 *  - POST bot context to the Python /plan endpoint
 *  - Receive and validate the structured task plan response
 *  - Handle network errors gracefully with retries and fallback tasks
 *  - Log all AI communication events
 */

'use strict';

const axios            = require('axios');
const { createLogger } = require('../utils/logger');

const log = createLogger('AIClient');

// Fallback task plan returned when the AI planner is unreachable
const FALLBACK_PLAN = {
  goal    : 'explore_and_survive',
  tasks   : [
    { name: 'explore', params: { radius: 32 }, priority: 1 },
    { name: 'collect_wood', params: { count: 8 }, priority: 2 },
  ],
  reasoning: 'AI planner unavailable -- using safe fallback plan',
  source   : 'fallback',
};

class AIClient {
  /**
   * @param {object} config - config.json contents
   */
  constructor(config) {
    this.config       = config;
    this.plannerUrl   = config.ai?.plannerUrl  ?? 'http://localhost:5000';
    this.timeoutMs    = config.ai?.timeoutMs   ?? 30000;
    this.maxRetries   = config.ai?.maxRetries  ?? 3;
    this.requestCount = 0;   // total requests made (for logging)

    log.info('AIClient initialised', {
      plannerUrl : this.plannerUrl,
      timeoutMs  : this.timeoutMs,
    });
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Sends the bot context to the Python planner and returns a structured
   * task plan.
   *
   * @param {object} context  - snapshot from Sensors.gatherContext()
   * @param {object} [history] - optional recent task history for continuity
   * @returns {Promise<object>} task plan with { goal, tasks, reasoning }
   */
  async requestPlan(context, history = []) {
    this.requestCount++;
    const reqId = this.requestCount;

    log.ai(`[req#${reqId}] Requesting plan from AI planner`);

    const payload = {
      context,
      history : history.slice(-10),   // send last 10 task results for context
      request_id: reqId,
      timestamp : new Date().toISOString(),
    };

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await axios.post(
          `${this.plannerUrl}/plan`,
          payload,
          {
            timeout : this.timeoutMs,
            headers : { 'Content-Type': 'application/json' },
          }
        );

        const plan = response.data;
        log.ai(`[req#${reqId}] Plan received`, {
          goal      : plan.goal,
          taskCount : plan.tasks?.length ?? 0,
          attempt,
        });

        return this._validatePlan(plan);

      } catch (err) {
        const isLast = attempt === this.maxRetries;
        log.warn(`[req#${reqId}] Planner request failed (attempt ${attempt}/${this.maxRetries})`, {
          error: err.message,
          code : err.code,
        });

        if (!isLast) {
          // Exponential back-off: 1s, 2s, 4s
          const delay = 1000 * Math.pow(2, attempt - 1);
          log.debug(`Retrying in ${delay}ms`);
          await this._sleep(delay);
        }
      }
    }

    // All retries exhausted -- return fallback
    log.warn(`[req#${reqId}] All retries exhausted. Using fallback plan.`);
    return FALLBACK_PLAN;
  }

  /**
   * Notifies the planner of a completed task result (for learning).
   * This is fire-and-forget -- failures are silently ignored.
   *
   * @param {object} result - { taskName, success, duration, context }
   */
  async reportResult(result) {
    try {
      await axios.post(
        `${this.plannerUrl}/result`,
        result,
        { timeout: 5000 }
      );
      log.ai('Task result reported', { task: result.taskName, success: result.success });
    } catch {
      // Learning endpoint failure is non-critical -- log at debug level
      log.debug('Could not report task result to planner (non-critical)');
    }
  }

  /**
   * Checks whether the Python planner is reachable.
   * @returns {Promise<boolean>}
   */
  async healthCheck() {
    try {
      const res = await axios.get(`${this.plannerUrl}/health`, { timeout: 3000 });
      log.info('Planner health check OK', res.data);
      return true;
    } catch {
      log.warn('Planner health check FAILED -- is task_planner.py running?');
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Validates and normalises the plan returned by the AI planner.
   * Ensures the plan always has the expected shape even if the LLM
   * produces slightly malformed JSON.
   */
  _validatePlan(plan) {
    if (!plan || typeof plan !== 'object') {
      log.warn('Invalid plan structure -- using fallback');
      return FALLBACK_PLAN;
    }

    // Ensure tasks array exists and each task has a name
    const tasks = Array.isArray(plan.tasks) ? plan.tasks : [];
    const validTasks = tasks
      .filter(t => t && typeof t.name === 'string')
      .map(t => ({
        name    : t.name,
        params  : t.params  ?? {},
        priority: t.priority ?? 1,
        reason  : t.reason  ?? '',
      }));

    if (validTasks.length === 0) {
      log.warn('Plan contained no valid tasks -- inserting explore fallback');
      validTasks.push({ name: 'explore', params: { radius: 32 }, priority: 1, reason: 'fallback' });
    }

    return {
      goal      : plan.goal       ?? 'autonomous_survival',
      tasks     : validTasks,
      reasoning : plan.reasoning  ?? '',
      source    : plan.source     ?? 'ai',
    };
  }

  _sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }
}

module.exports = AIClient;