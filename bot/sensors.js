/**
 * bot/sensors.js
 *
 * Environment observation module.
 * Scans the bot surroundings and packages everything into a structured
 * "context" object that the AI planner uses for reasoning.
 *
 * Responsibilities:
 *  - Read bot position, health, food, experience
 *  - Scan nearby blocks within a configurable radius
 *  - List visible entities (mobs, players, animals)
 *  - Read full inventory contents
 *  - Determine time of day and weather
 *  - Detect biome name
 *  - Detect immediate dangers (nearby hostiles, low health)
 */

'use strict';

const { createLogger } = require('../utils/logger');

const log = createLogger('Sensors');

// Block categories the AI cares about -- grouped to keep context concise
const RESOURCE_BLOCKS = new Set([
  'oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log',
  'coal_ore', 'iron_ore', 'gold_ore', 'diamond_ore', 'emerald_ore',
  'deepslate_coal_ore', 'deepslate_iron_ore', 'deepslate_gold_ore',
  'deepslate_diamond_ore', 'deepslate_emerald_ore',
  'gravel', 'sand', 'clay', 'water', 'lava',
  'crafting_table', 'furnace', 'chest',
  'wheat', 'carrots', 'potatoes', 'beetroots',
  'cobblestone', 'stone', 'dirt', 'grass_block',
]);

const HOSTILE_MOBS = new Set([
  'zombie', 'skeleton', 'creeper', 'spider', 'enderman',
  'witch', 'phantom', 'drowned', 'husk', 'stray',
  'blaze', 'ghast', 'slime', 'magma_cube', 'pillager',
]);

const PASSIVE_MOBS = new Set([
  'cow', 'pig', 'sheep', 'chicken', 'rabbit',
  'horse', 'donkey', 'llama', 'mooshroom', 'squid',
  'villager', 'iron_golem',
]);

class Sensors {
  /**
   * @param {import('mineflayer').Bot} bot    - the Mineflayer bot instance
   * @param {object}                   config - config.json contents
   */
  constructor(bot, config) {
    this.bot    = bot;
    this.config = config;
    this.radius = config.bot?.explorationRadius ?? 32;
    log.info('Sensors module initialised', { scanRadius: this.radius });
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Gathers the full environment context snapshot.
   * This is the primary method called before every AI query.
   *
   * @returns {object} Structured context ready for the AI planner
   */
  gatherContext() {
    try {
      const ctx = {
        timestamp    : new Date().toISOString(),
        position     : this._getPosition(),
        vitals       : this._getVitals(),
        time         : this._getTimeContext(),
        inventory    : this._getInventory(),
        nearbyBlocks : this._getNearbyBlocks(),
        entities     : this._getNearbyEntities(),
        biome        : this._getBiome(),
        dangers      : this._detectDangers(),
        recentChat   : this._getRecentChat(),
      };

      log.debug('Context snapshot gathered', {
        pos     : ctx.position,
        health  : ctx.vitals.health,
        dangers : ctx.dangers.length,
      });

      return ctx;

    } catch (err) {
      log.error('Failed to gather context', { error: err.message });
      return this._safeMinimalContext();
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /** Returns the bot's current position rounded to 1 decimal place. */
  _getPosition() {
    const pos = this.bot.entity?.position;
    if (!pos) return { x: 0, y: 64, z: 0 };
    return {
      x: Math.round(pos.x * 10) / 10,
      y: Math.round(pos.y * 10) / 10,
      z: Math.round(pos.z * 10) / 10,
    };
  }

  /** Returns health, food, saturation, experience level, and game mode. */
  _getVitals() {
    return {
      health     : Math.round((this.bot.health          ?? 20) * 10) / 10,
      food       : Math.round((this.bot.food            ?? 20) * 10) / 10,
      saturation : Math.round((this.bot.foodSaturation  ??  5) * 10) / 10,
      experience : this.bot.experience?.level ?? 0,
      gameMode   : this.bot.game?.gameMode ?? 'survival',
      isOnGround : this.bot.entity?.onGround ?? true,
    };
  }

  /**
   * Returns time-of-day info and current weather state.
   * Minecraft ticks: Dawn=0, Noon=6000, Dusk=12000, Midnight=18000
   */
  _getTimeContext() {
    const time = this.bot.time?.timeOfDay ?? 0;
    let period;
    if      (time < 1000)  period = 'dawn';
    else if (time < 6000)  period = 'morning';
    else if (time < 9000)  period = 'noon';
    else if (time < 12000) period = 'afternoon';
    else if (time < 13000) period = 'dusk';
    else                   period = 'night';

    return {
      ticks   : time,
      period,
      isDay   : time < 13000,
      isNight : time >= 13000,
      raining : this.bot.isRaining ?? false,
    };
  }

  /**
   * Reads the entire inventory and groups items by category.
   * Returns:
   *   items   : flat list of { name, count, slot }
   *   summary : aggregated counts and tool/armor lists
   */
  _getInventory() {
    const items   = [];
    const summary = { wood: 0, food: 0, stone: 0, ore: 0, tools: [], armor: [], misc: [] };
    const inv     = this.bot.inventory?.items() ?? [];

    for (const item of inv) {
      items.push({ name: item.name, count: item.count, slot: item.slot });

      if (item.name.includes('log') || item.name.includes('planks') || item.name === 'stick') {
        summary.wood += item.count;
      } else if (['bread','apple','carrot','potato','fish','meat','beef','pork','mutton',
                  'chicken','rabbit_stew'].some(f => item.name.includes(f))) {
        summary.food += item.count;
      } else if (item.name.includes('cobblestone') || item.name === 'stone') {
        summary.stone += item.count;
      } else if (item.name.includes('ore') || item.name.includes('ingot') ||
                 ['coal','diamond','emerald','gold_nugget','iron_nugget'].includes(item.name)) {
        summary.ore += item.count;
      } else if (['sword','axe','pickaxe','shovel','hoe','bow','crossbow','trident']
                   .some(t => item.name.includes(t))) {
        summary.tools.push(item.name);
      } else if (['helmet','chestplate','leggings','boots'].some(a => item.name.includes(a))) {
        summary.armor.push(item.name);
      } else {
        if (!summary.misc.includes(item.name)) summary.misc.push(item.name);
      }
    }

    return { items, summary, totalSlots: inv.length };
  }

  /**
   * Scans nearby blocks within the configured radius.
   * Only returns blocks in RESOURCE_BLOCKS -- grouped by name with counts.
   */
  _getNearbyBlocks() {
    const botPos = this.bot.entity?.position;
    if (!botPos) return {};

    const found = {};
    const halfR = Math.floor(this.radius / 2);

    // Sample every 2nd block to avoid lag on large radii
    for (let dx = -halfR; dx <= halfR; dx += 2) {
      for (let dy = -8; dy <= 8; dy += 2) {
        for (let dz = -halfR; dz <= halfR; dz += 2) {
          const block = this.bot.blockAt(botPos.offset(dx, dy, dz));
          if (!block || block.name === 'air') continue;

          if (RESOURCE_BLOCKS.has(block.name)) {
            if (!found[block.name]) {
              found[block.name] = {
                count   : 0,
                nearest : {
                  x: Math.round(block.position.x),
                  y: Math.round(block.position.y),
                  z: Math.round(block.position.z),
                },
              };
            }
            found[block.name].count++;
          }
        }
      }
    }

    log.debug('Block scan complete', { uniqueBlockTypes: Object.keys(found).length });
    return found;
  }

  /**
   * Scans all loaded entities within the configured radius.
   * Separates hostiles, passive mobs, and other players.
   */
  _getNearbyEntities() {
    const botPos = this.bot.entity?.position;
    const result = { hostiles: [], passives: [], players: [] };
    if (!botPos) return result;

    for (const entity of Object.values(this.bot.entities)) {
      if (!entity || !entity.position) continue;
      if (entity === this.bot.entity) continue;    // skip self

      const dist = entity.position.distanceTo(botPos);
      if (dist > this.radius) continue;

      const info = {
        name     : entity.username || entity.name || entity.mobType || 'unknown',
        type     : entity.type,
        distance : Math.round(dist * 10) / 10,
        pos      : {
          x: Math.round(entity.position.x),
          y: Math.round(entity.position.y),
          z: Math.round(entity.position.z),
        },
      };

      if (entity.type === 'player' && entity.username !== this.bot.username) {
        result.players.push(info);
      } else if (HOSTILE_MOBS.has(entity.name)) {
        result.hostiles.push(info);
      } else if (PASSIVE_MOBS.has(entity.name)) {
        result.passives.push(info);
      }
    }

    // Sort hostiles by nearest first so AI can prioritise
    result.hostiles.sort((a, b) => a.distance - b.distance);
    return result;
  }

  /** Returns the biome name at the bot's current position. */
  _getBiome() {
    try {
      const block = this.bot.blockAt(this.bot.entity?.position);
      return block?.biome?.name ?? 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /**
   * Analyses the snapshot for immediate dangers.
   * Returns descriptors with severity levels the AI can prioritise.
   */
  _detectDangers() {
    const dangers  = [];
    const vitals   = this._getVitals();
    const time     = this._getTimeContext();
    const entities = this._getNearbyEntities();

    if (vitals.health <= (this.config.bot?.dangerHealthThreshold ?? 6)) {
      dangers.push({ type: 'low_health', value: vitals.health, severity: 'critical' });
    }
    if (vitals.food <= (this.config.bot?.hungerThreshold ?? 6)) {
      dangers.push({ type: 'hunger', value: vitals.food, severity: 'high' });
    }
    if (time.isNight) {
      dangers.push({ type: 'night_time', period: time.period, severity: 'medium' });
    }

    for (const mob of entities.hostiles) {
      const severity = mob.distance < 8 ? 'critical' : 'high';
      dangers.push({ type: 'hostile_mob', name: mob.name, distance: mob.distance, severity });
    }

    return dangers;
  }

  /**
   * Returns recent chat messages stored by bot.js.
   * The bot appends to bot._recentChat on every 'chat' event.
   */
  _getRecentChat() {
    return this.bot._recentChat ?? [];
  }

  /** Minimal safe fallback context returned when scanning fails. */
  _safeMinimalContext() {
    return {
      timestamp    : new Date().toISOString(),
      position     : { x: 0, y: 64, z: 0 },
      vitals       : { health: 20, food: 20, saturation: 5, experience: 0, gameMode: 'survival' },
      time         : { period: 'unknown', isDay: true, isNight: false, raining: false },
      inventory    : { items: [], summary: {}, totalSlots: 0 },
      nearbyBlocks : {},
      entities     : { hostiles: [], passives: [], players: [] },
      biome        : 'unknown',
      dangers      : [],
      recentChat   : [],
      _error       : 'Context gathered with errors -- using minimal fallback',
    };
  }
}

module.exports = Sensors;