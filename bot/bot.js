/**
 * bot/bot.js
 *
 * Main entry point. Uses a continuous async while-loop so tasks fully
 * complete before the next one starts (prevents pathfinder interruption).
 * Every significant step is logged so you can see exactly what is happening.
 */

'use strict';

const mineflayer       = require('mineflayer');
const path             = require('path');
const fs               = require('fs');
const Sensors          = require('./sensors');
const Navigation       = require('./navigation');
const Actions          = require('./actions');
const AIClient         = require('./aiClient');
const { createLogger } = require('../utils/logger');

const log = createLogger('Bot');

// -- Config -------------------------------------------------------------------
const CONFIG_PATH = path.join(__dirname, '..', 'config', 'config.json');
let config;
try {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  log.info('Config loaded', { host: config.minecraft?.host, port: config.minecraft?.port });
} catch (e) {
  console.error('Cannot read config/config.json:', e.message);
  process.exit(1);
}

// -- State --------------------------------------------------------------------
let bot, sensors, nav, actions, aiClient;
let agentRunning      = false;
let emergencyOverride = false;
let currentTaskQueue  = [];
const taskHistory     = [];
const MAX_HISTORY     = 50;
const MIN_TICK_DELAY  = 1500;   // minimum ms between ticks

// -- Bot creation -------------------------------------------------------------
function createBot() {
  log.info('Connecting...', {
    host    : config.minecraft.host,
    port    : config.minecraft.port,
    username: config.minecraft.username,
    version : config.minecraft.version,
  });

  bot = mineflayer.createBot({
    host    : config.minecraft.host,
    port    : config.minecraft.port,
    username: config.minecraft.username,
    version : config.minecraft.version,
    auth    : config.minecraft.auth ?? 'offline',
  });

  bot._recentChat = [];
  bot.once('spawn',  onSpawn);
  bot.on('chat',     onChat);
  bot.on('death',    onDeath);
  bot.on('kicked',   onKicked);
  bot.on('error',    onError);
  bot.on('end',      onEnd);
  bot.on('health',   onHealthChange);
}

// -- Events -------------------------------------------------------------------
async function onSpawn() {
  const pos = bot.entity?.position;
  log.info(`Spawned at (${pos?.x?.toFixed(1)},${pos?.y?.toFixed(1)},${pos?.z?.toFixed(1)})`);

  sensors  = new Sensors(bot, config);
  nav      = new Navigation(bot, config);
  actions  = new Actions(bot, nav, config);
  aiClient = new AIClient(config);

  log.info('Waiting 3s for world to load...');
  await sleep(3000);

  // Verify pathfinder is working by checking movements are set
  const pfOk = !!bot.pathfinder?.movements;
  log.info(`Pathfinder movements set: ${pfOk}`);
  if (!pfOk) {
    log.warn('Pathfinder movements NOT set -- bot will not move! Check mineflayer-pathfinder install.');
  }

  const plannerOk = await aiClient.healthCheck();
  log.info(`AI planner reachable: ${plannerOk}`);

  bot.chat('AI Bot online!');
  startLoop();
}

function onChat(username, message) {
  if (username === bot.username) return;
  log.info(`<${username}> ${message}`);
  bot._recentChat.push({ username, message, timestamp: new Date().toISOString() });
  if (bot._recentChat.length > 5) bot._recentChat.shift();
  handleCommand(username, message.toLowerCase().trim());
}

function handleCommand(username, msg) {
  if (msg === 'stop' || msg === 'bot stop') {
    agentRunning = false;
    nav.stop();
    currentTaskQueue = [];
    bot.chat('Stopped.');
  } else if (msg === 'start' || msg === 'bot start') {
    if (!agentRunning) startLoop();
    bot.chat('Started!');
  } else if (msg === 'explore') {
    currentTaskQueue = [{ name: 'explore', params: { radius: 32 }, priority: 1 }];
    bot.chat('Exploring!');
  } else if (msg === 'status' || msg === 'bot status') {
    const ctx = sensors.gatherContext();
    bot.chat(`HP:${ctx.vitals.health} Food:${ctx.vitals.food} Pos:(${ctx.position.x},${ctx.position.y},${ctx.position.z}) Queue:${currentTaskQueue.length}`);
  } else if (msg === 'where' || msg === 'pos') {
    const p = bot.entity?.position;
    bot.chat(`I am at ${p ? `(${p.x.toFixed(0)},${p.y.toFixed(0)},${p.z.toFixed(0)})` : 'unknown'}`);
  }
}

function onDeath() {
  log.warn('Bot died! Will respawn...');
  agentRunning     = false;
  emergencyOverride= false;
  nav.stop();
  currentTaskQueue = [];
  setTimeout(() => { if (bot.entity) startLoop(); }, 6000);
}

function onKicked(reason) {
  log.warn(`Kicked: ${reason}`);
  agentRunning = false;
  setTimeout(createBot, 10000);
}

function onError(e)  { log.error('Bot error', { error: e.message }); }

function onEnd(reason) {
  log.warn(`Disconnected: ${reason}`);
  agentRunning = false;
  setTimeout(createBot, 10000);
}

function onHealthChange() {
  const hp   = bot.health ?? 20;
  const food = bot.food   ?? 20;
  if (hp <= 4 && !emergencyOverride) {
    log.warn(`EMERGENCY: health=${hp}, injecting flee+eat`);
    emergencyOverride = true;
    currentTaskQueue  = [
      { name: 'flee_danger', params: {}, priority: 0 },
      { name: 'eat',         params: {}, priority: 1 },
    ];
    nav.stop();
  } else if (food <= 4 && !emergencyOverride) {
    log.warn(`EMERGENCY: food=${food}, injecting eat`);
    emergencyOverride = true;
    currentTaskQueue  = [{ name: 'eat', params: {}, priority: 0 }];
  }
}

// -- Agent loop ---------------------------------------------------------------
function startLoop() {
  if (agentRunning) return;
  agentRunning = true;
  log.info('Agent loop started');
  runLoop();
}

async function runLoop() {
  while (agentRunning) {
    if (!bot.entity) { await sleep(1000); continue; }
    try {
      await tick();
    } catch (e) {
      log.error('Tick threw uncaught error', { error: e.message, stack: e.stack?.slice(0, 300) });
    }
    await sleep(MIN_TICK_DELAY);
  }
  log.info('Agent loop exited');
}

async function tick() {
  // 1. Gather context
  const context = sensors.gatherContext();
  const pos     = context.position;
  log.info(`=== TICK === pos=(${pos.x},${pos.y},${pos.z}) hp=${context.vitals.health} food=${context.vitals.food} time=${context.time.period} queue=${currentTaskQueue.length}`);

  // 2. Request plan if queue empty
  if (!emergencyOverride && currentTaskQueue.length === 0) {
    log.ai('Queue empty -- fetching plan from AI...');
    let plan;
    try {
      plan = await aiClient.requestPlan(context, taskHistory);
    } catch (e) {
      log.error('requestPlan threw', { error: e.message });
      plan = { goal: 'fallback', tasks: [{ name: 'explore', params: { radius: 32 }, priority: 1 }] };
    }

    log.ai(`Plan: goal="${plan.goal}" tasks=${plan.tasks?.length ?? 0} source=${plan.source ?? '?'}`);
    if (plan.tasks?.length) {
      plan.tasks.forEach((t, i) => log.ai(`  task[${i}]: ${t.name} ${JSON.stringify(t.params)}`));
    }

    currentTaskQueue = [...(plan.tasks ?? [])].sort((a, b) => (a.priority ?? 1) - (b.priority ?? 1));
    bot.chat(`Goal: ${plan.goal} (${currentTaskQueue.length} tasks)`);
  }

  // 3. Execute next task
  if (currentTaskQueue.length === 0) {
    log.warn('Queue still empty after plan fetch -- sleeping 3s');
    await sleep(3000);
    return;
  }

  const task      = currentTaskQueue.shift();
  const startTime = Date.now();
  log.task(`>> START task="${task.name}" params=${JSON.stringify(task.params)} remaining=${currentTaskQueue.length}`);

  let result = { success: false, message: 'not run' };
  try {
    result = await actions.executeTask(task);
  } catch (e) {
    result = { success: false, message: `threw: ${e.message}` };
    log.error(`Task "${task.name}" threw exception`, { error: e.message });
  }

  const elapsed = Date.now() - startTime;
  log.task(`<< END task="${task.name}" success=${result.success} ms=${elapsed} msg="${result.message}"`);

  // 4. Record result
  const entry = { taskName: task.name, params: task.params, success: result.success,
                  message: result.message, duration: elapsed, timestamp: new Date().toISOString() };
  taskHistory.push(entry);
  if (taskHistory.length > MAX_HISTORY) taskHistory.shift();
  aiClient.reportResult({ ...entry, context }).catch(() => {});

  if (emergencyOverride && currentTaskQueue.length === 0) {
    emergencyOverride = false;
    log.info('Emergency override cleared');
  }
}

// -- Util ---------------------------------------------------------------------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

process.on('unhandledRejection', r  => log.error('UnhandledRejection', { reason: String(r) }));
process.on('uncaughtException',  e  => log.error('UncaughtException', { error: e.message }));
process.on('SIGINT', () => { agentRunning = false; bot?.quit('shutdown'); process.exit(0); });

// -- Start --------------------------------------------------------------------
log.info('=== Minecraft AI Bot ===');
createBot();