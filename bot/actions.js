/**
 * bot/actions.js
 *
 * Task execution module.
 * Translates structured task objects (produced by the AI planner) into actual
 * Mineflayer actions: chopping wood, mining ore, crafting items, eating food,
 * building simple structures, attacking mobs, sleeping, etc.
 *
 * Each public method:
 *  - is async and returns { success: bool, message: string }
 *  - logs what it's doing at each significant step
 *  - handles errors gracefully (never crashes the bot loop)
 */

'use strict';

const Vec3             = require('vec3');
const { createLogger } = require('../utils/logger');

const log = createLogger('Actions');

// Maximum dig distance -- blocks further than this are skipped
const MAX_DIG_RANGE = 4.5;

class Actions {
  /**
   * @param {import('mineflayer').Bot} bot  - the Mineflayer bot instance
   * @param {Navigation}              nav  - Navigation module instance
   * @param {object}                  config
   */
  constructor(bot, nav, config) {
    this.bot    = bot;
    this.nav    = nav;
    this.config = config;
    log.info('Actions module initialised');
  }

  // -------------------------------------------------------------------------
  // Primary task dispatcher
  // -------------------------------------------------------------------------

  /**
   * Dispatches a single task object to the appropriate handler.
   * Task format: { name: string, params: object }
   *
   * @param {object} task
   * @returns {Promise<{success: boolean, message: string}>}
   */
  async executeTask(task) {
    const { name, params = {} } = task;
    log.task(`Executing task: ${name}`, params);

    try {
      switch (name) {
        case 'explore':           return await this.explore(params);
        case 'collect_wood':      return await this.collectWood(params);
        case 'collect_stone':     return await this.collectBlock('cobblestone', params);
        case 'collect_coal':      return await this.collectOre('coal_ore', params);
        case 'collect_iron':      return await this.collectOre('iron_ore', params);
        case 'collect_food':      return await this.collectFood(params);
        case 'eat':               return await this.eat(params);
        case 'craft_planks':      return await this.craftPlanks(params);
        case 'craft_crafting_table': return await this.craftCraftingTable(params);
        case 'craft_sticks':      return await this.craftSticks(params);
        case 'craft_wooden_pickaxe': return await this.craftTool('wooden_pickaxe', params);
        case 'craft_stone_pickaxe':  return await this.craftTool('stone_pickaxe', params);
        case 'craft_iron_pickaxe':   return await this.craftTool('iron_pickaxe', params);
        case 'craft_wooden_sword':   return await this.craftTool('wooden_sword', params);
        case 'craft_stone_sword':    return await this.craftTool('stone_sword', params);
        case 'build_shelter':     return await this.buildShelter(params);
        case 'place_crafting_table': return await this.placeBlock('crafting_table', params);
        case 'place_furnace':     return await this.placeBlock('furnace', params);
        case 'smelt_iron':        return await this.smeltOre('iron_ore', 'iron_ingot', params);
        case 'attack_mob':        return await this.attackMob(params);
        case 'flee_danger':       return await this.fleeDanger(params);
        case 'sleep':             return await this.sleep(params);
        case 'wait':              return await this.wait(params);
        default:
          log.warn(`Unknown task: ${name}`);
          return { success: false, message: `Unknown task: ${name}` };
      }
    } catch (err) {
      log.error(`Task "${name}" threw an exception`, { error: err.message });
      return { success: false, message: err.message };
    }
  }

  // -------------------------------------------------------------------------
  // Task implementations
  // -------------------------------------------------------------------------

  /** Explore: walk to a random nearby location. */
  async explore(params) {
    const radius = params.radius ?? this.config.bot?.explorationRadius ?? 32;
    log.info('Exploring', { radius });
    const ok = await this.nav.explore(radius);
    return ok
      ? { success: true,  message: `Explored with radius ${radius}` }
      : { success: false, message: 'Could not find an accessible exploration target' };
  }

  /**
   * Collect wood: find the nearest log block, walk to it, and mine it.
   * Repeats until the requested count is reached or no more logs are found.
   */
  async collectWood(params) {
    const count   = params.count ?? 8;
    const logTypes = ['oak_log','birch_log','spruce_log','jungle_log','acacia_log','dark_oak_log'];
    return this._collectBlockType(logTypes, count, 'wood log');
  }

  /**
   * Collect a specific surface block by name (e.g. cobblestone).
   */
  async collectBlock(blockName, params) {
    const count = params.count ?? 16;
    return this._collectBlockType([blockName], count, blockName);
  }

  /**
   * Collect ore: find the nearest matching ore block, navigate, and mine.
   */
  async collectOre(oreName, params) {
    const count = params.count ?? 8;
    return this._collectBlockType([oreName], count, oreName);
  }

  /**
   * Collect food by killing nearby passive mobs or harvesting crops.
   */
  async collectFood(params) {
    const botPos = this.bot.entity?.position;
    if (!botPos) return { success: false, message: 'No position' };

    // First try crops
    const cropNames  = ['wheat','carrots','potatoes','beetroots'];
    for (const crop of cropNames) {
      const block = this.bot.findBlock({ matching: b => b.name === crop, maxDistance: 32 });
      if (block && block.metadata === 7) {   // fully grown
        log.info('Harvesting crop', { crop, pos: block.position });
        const moved = await this.nav.moveTo(block.position, 2);
        if (moved) {
          try {
            await this.bot.dig(block);
            return { success: true, message: `Harvested ${crop}` };
          } catch (e) { /* try next */ }
        }
      }
    }

    // Then try killing a passive mob for meat
    const meatMobs = ['cow', 'pig', 'sheep', 'chicken'];
    for (const mobType of meatMobs) {
      const entity = this._findNearestEntity(mobType, 32);
      if (entity) {
        return await this.attackMob({ targetName: mobType, entityId: entity.id });
      }
    }

    return { success: false, message: 'No food source found nearby' };
  }

  /** Eat food from inventory to restore hunger. */
  async eat(params) {
    const foodNames = [
      'bread','cooked_beef','cooked_pork','cooked_chicken','cooked_mutton',
      'cooked_rabbit','cooked_cod','cooked_salmon','apple','carrot','potato',
      'baked_potato','pumpkin_pie',
    ];

    for (const foodName of foodNames) {
      const item = this.bot.inventory.findInventoryItem(this.bot.registry.itemsByName[foodName]?.id);
      if (item) {
        log.info(`Eating ${foodName}`);
        try {
          await this.bot.equip(item, 'hand');
          await this.bot.consume();
          return { success: true, message: `Ate ${foodName}` };
        } catch (e) {
          log.warn(`Failed to eat ${foodName}`, { error: e.message });
        }
      }
    }

    return { success: false, message: 'No edible food in inventory' };
  }

  /**
   * Craft wooden planks from logs in the inventory (2x2 grid craft).
   */
  async craftPlanks(params) {
    const count = params.count ?? 8;
    log.info('Crafting planks', { count });
    return this._craftItem('oak_planks', count, null);
  }

  /** Craft a crafting table from 4 planks. */
  async craftCraftingTable(params) {
    log.info('Crafting crafting table');
    return this._craftItem('crafting_table', 1, null);
  }

  /** Craft sticks from 2 planks. */
  async craftSticks(params) {
    const count = params.count ?? 8;
    return this._craftItem('stick', count, null);
  }

  /**
   * Craft a specific tool -- requires a crafting table to be placed nearby
   * or one already in the world.
   */
  async craftTool(toolName, params) {
    log.info(`Crafting ${toolName}`);
    const table = this._findNearestBlock('crafting_table', 8);
    if (!table) {
      log.warn('No crafting table nearby -- placing one first');
      await this.placeBlock('crafting_table', {});
    }
    return this._craftItem(toolName, 1, 'crafting_table');
  }

  /**
   * Place a block from inventory at a suitable surface near the bot.
   * Used for crafting tables, furnaces, etc.
   */
  async placeBlock(blockName, params) {
    const itemId = this.bot.registry.itemsByName[blockName]?.id;
    if (!itemId) return { success: false, message: `Unknown block: ${blockName}` };

    const item = this.bot.inventory.findInventoryItem(itemId);
    if (!item) return { success: false, message: `No ${blockName} in inventory` };

    // Find a flat surface adjacent to the bot
    const botPos  = this.bot.entity.position.floored();
    const offsets = [[1,0,0],[-1,0,0],[0,0,1],[0,0,-1]];

    for (const [dx, dy, dz] of offsets) {
      const target    = botPos.offset(dx, dy, dz);
      const above     = botPos.offset(dx, dy + 1, dz);
      const blockAt   = this.bot.blockAt(target);
      const blockAbove= this.bot.blockAt(above);

      if (blockAt && blockAt.name !== 'air' && blockAbove && blockAbove.name === 'air') {
        try {
          await this.bot.equip(item, 'hand');
          await this.bot.placeBlock(blockAt, new Vec3(0, 1, 0));
          log.info(`Placed ${blockName}`, { pos: target });
          return { success: true, message: `Placed ${blockName} at ${JSON.stringify(target)}` };
        } catch (e) {
          log.warn(`Failed to place ${blockName}`, { error: e.message });
        }
      }
    }

    return { success: false, message: `Could not find a surface to place ${blockName}` };
  }

  /**
   * Build a rudimentary 3-high shelter of dirt/cobblestone around the bot.
   * Forms a 3x3 walled column that the bot can duck inside overnight.
   */
  async buildShelter(params) {
    log.info('Building emergency shelter');
    const botPos = this.bot.entity.position.floored();

    // Prefer cobblestone, fall back to dirt, then planks
    const materialPrefs = ['cobblestone', 'dirt', 'oak_planks'];
    let materialId = null;
    let materialName = '';

    for (const mat of materialPrefs) {
      const id = this.bot.registry.itemsByName[mat]?.id;
      if (id && this.bot.inventory.findInventoryItem(id)) {
        materialId   = id;
        materialName = mat;
        break;
      }
    }

    if (!materialId) {
      return { success: false, message: 'No shelter material in inventory' };
    }

    log.info(`Building with ${materialName}`);

    // Place 4 walls at height 0 and 1
    const wallOffsets = [
      [1,0,0],[-1,0,0],[0,0,1],[0,0,-1],
      [1,1,0],[-1,1,0],[0,1,1],[0,1,-1],
    ];

    let placed = 0;
    for (const [dx, dy, dz] of wallOffsets) {
      const targetPos  = botPos.offset(dx, dy, dz);
      const targetBlock= this.bot.blockAt(targetPos);
      if (!targetBlock || targetBlock.name !== 'air') continue;

      const referenceBlock = this.bot.blockAt(targetPos.offset(0, -1, 0));
      if (!referenceBlock || referenceBlock.name === 'air') continue;

      try {
        const item = this.bot.inventory.findInventoryItem(materialId);
        if (!item) break;
        await this.bot.equip(item, 'hand');
        await this.bot.placeBlock(referenceBlock, new Vec3(0, 1, 0));
        placed++;
        await this._sleep(150);
      } catch (e) {
        log.debug('Wall block placement failed', { error: e.message });
      }
    }

    return placed > 0
      ? { success: true,  message: `Built shelter walls (${placed} blocks placed)` }
      : { success: false, message: 'Could not place any shelter blocks' };
  }

  /** Smelt ore in a nearby furnace. */
  async smeltOre(oreInput, outputItem, params) {
    log.info(`Smelting ${oreInput} -> ${outputItem}`);
    const furnace = this._findNearestBlock('furnace', 6);
    if (!furnace) return { success: false, message: 'No furnace nearby' };

    try {
      await this.nav.moveToBlock(furnace.position);
      const furnaceWindow = await this.bot.openFurnace(furnace);

      const ore  = this.bot.inventory.findInventoryItem(
                     this.bot.registry.itemsByName[oreInput]?.id);
      const fuel = this.bot.inventory.findInventoryItem(
                     this.bot.registry.itemsByName['coal']?.id
                   ) ?? this.bot.inventory.findInventoryItem(
                     this.bot.registry.itemsByName['oak_planks']?.id);

      if (!ore)  { furnaceWindow.close(); return { success: false, message: `No ${oreInput}` }; }
      if (!fuel) { furnaceWindow.close(); return { success: false, message: 'No fuel' }; }

      await furnaceWindow.putInput(ore, null, ore.count);
      await furnaceWindow.putFuel(fuel, null, Math.min(fuel.count, 8));

      // Wait for at least one output
      await new Promise(resolve => setTimeout(resolve, 12000));
      const result = furnaceWindow.outputItem();
      if (result) {
        await furnaceWindow.takeOutput();
        furnaceWindow.close();
        return { success: true, message: `Smelted ${result.count}x ${outputItem}` };
      }
      furnaceWindow.close();
      return { success: false, message: 'Smelting timed out with no output' };

    } catch (e) {
      return { success: false, message: e.message };
    }
  }

  /** Attack the nearest hostile mob or a specific named mob. */
  async attackMob(params) {
    const targetName = params.targetName ?? null;
    let entity = null;

    if (params.entityId) {
      entity = this.bot.entities[params.entityId];
    } else {
      entity = this._findNearestEntity(targetName, 24);
    }

    if (!entity) return { success: false, message: `No target found: ${targetName}` };

    const targetPos = entity.position;
    log.info('Attacking mob', { name: entity.name, pos: targetPos });

    // Move close enough to attack
    const moved = await this.nav.moveTo(targetPos, 2);
    if (!moved) return { success: false, message: 'Could not reach mob' };

    // Equip best weapon
    await this._equipBestWeapon();

    // Attack loop -- up to 30 hits or entity death
    let hits = 0;
    while (hits < 30 && this.bot.entities[entity.id]) {
      try {
        await this.bot.attack(entity);
        await this._sleep(600);   // approximate attack cooldown
        hits++;
      } catch (e) {
        break;
      }
    }

    const survived = !this.bot.entities[entity.id];
    return survived
      ? { success: true,  message: `Killed ${entity.name} after ${hits} hits` }
      : { success: false, message: `Failed to kill ${entity.name}` };
  }

  /** Flee from the nearest danger position. */
  async fleeDanger(params) {
    const dangerPos = params.dangerPos
      ? new Vec3(params.dangerPos.x, params.dangerPos.y, params.dangerPos.z)
      : this._findNearestHostilePosition();

    if (!dangerPos) return { success: false, message: 'No danger position found' };

    log.info('Fleeing from danger', { dangerPos });
    const ok = await this.nav.fleeFrom(dangerPos, params.distance ?? 20);
    return ok
      ? { success: true,  message: 'Successfully fled from danger' }
      : { success: false, message: 'Could not flee -- path blocked' };
  }

  /** Find and sleep in a nearby bed. */
  async sleep(params) {
    const bedNames = [
      'white_bed','red_bed','blue_bed','black_bed','brown_bed',
      'green_bed','cyan_bed','gray_bed','light_gray_bed','lime_bed',
      'magenta_bed','orange_bed','pink_bed','purple_bed','yellow_bed',
      'light_blue_bed',
    ];

    const bed = this.bot.findBlock({
      matching : b => bedNames.includes(b.name),
      maxDistance: 32,
    });

    if (!bed) return { success: false, message: 'No bed found nearby' };

    await this.nav.moveTo(bed.position, 2);
    try {
      await this.bot.sleep(bed);
      log.info('Sleeping in bed');
      return { success: true, message: 'Sleeping until morning' };
    } catch (e) {
      return { success: false, message: `Could not sleep: ${e.message}` };
    }
  }

  /** Simple idle wait. */
  async wait(params) {
    const ms = (params.seconds ?? 5) * 1000;
    log.info(`Waiting ${ms / 1000}s`);
    await this._sleep(ms);
    return { success: true, message: `Waited ${ms / 1000}s` };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Generic block collection: finds the nearest matching block, walks to it,
   * mines it, and repeats until `count` items are in inventory or no blocks remain.
   */
  async _collectBlockType(blockNames, count, label) {
    log.info(`Collecting ${count}x ${label}`);
    let collected = 0;

    while (collected < count) {
      // Find the nearest matching block
      const block = this.bot.findBlock({
        matching    : b => blockNames.includes(b.name),
        maxDistance : this.config.bot?.explorationRadius ?? 32,
      });

      if (!block) {
        log.warn(`No ${label} found nearby`, { collected });
        break;
      }

      // Navigate to within digging range
      const reached = await this.nav.moveTo(block.position, MAX_DIG_RANGE);
      if (!reached) {
        log.debug('Could not reach block, trying next');
        continue;
      }

      // Equip the best tool for the job
      await this._equipBestTool(block.name);

      // Mine the block
      try {
        await this.bot.dig(block);
        collected++;
        log.debug(`Collected ${label} (${collected}/${count})`);
        await this._sleep(200);   // brief pause between digs
      } catch (e) {
        log.warn(`Dig failed for ${block.name}`, { error: e.message });
        break;
      }
    }

    return collected > 0
      ? { success: true,  message: `Collected ${collected}x ${label}` }
      : { success: false, message: `Could not collect any ${label}` };
  }

  /**
   * Generic craft helper.
   * Uses the bot's recipe system to craft `count` of `itemName`.
   * If `requiresTableName` is provided, uses a crafting table block nearby.
   */
  async _craftItem(itemName, count, requiresTableName) {
    const itemId = this.bot.registry.itemsByName[itemName]?.id;
    if (itemId === undefined) return { success: false, message: `Unknown item: ${itemName}` };

    const recipes = this.bot.recipesFor(itemId, null, 1, requiresTableName
      ? this._findNearestBlock(requiresTableName, 8)
      : null);

    if (!recipes || recipes.length === 0) {
      return { success: false, message: `No recipe found for ${itemName} -- missing ingredients?` };
    }

    try {
      await this.bot.craft(recipes[0], count, requiresTableName
        ? this._findNearestBlock(requiresTableName, 8)
        : null);
      log.info(`Crafted ${count}x ${itemName}`);
      return { success: true, message: `Crafted ${count}x ${itemName}` };
    } catch (e) {
      return { success: false, message: `Crafting failed: ${e.message}` };
    }
  }

  /** Finds the nearest block with any of the given names within maxDistance. */
  _findNearestBlock(blockName, maxDistance) {
    return this.bot.findBlock({
      matching    : b => b.name === blockName,
      maxDistance,
    });
  }

  /** Finds the nearest entity matching the given name within maxDistance. */
  _findNearestEntity(entityName, maxDistance) {
    const botPos = this.bot.entity?.position;
    if (!botPos) return null;

    let nearest = null;
    let minDist = Infinity;

    for (const entity of Object.values(this.bot.entities)) {
      if (!entity || !entity.name || entity === this.bot.entity) continue;
      if (entityName && entity.name !== entityName) continue;
      const d = entity.position?.distanceTo(botPos) ?? Infinity;
      if (d < minDist && d <= maxDistance) {
        nearest = entity;
        minDist = d;
      }
    }
    return nearest;
  }

  /** Returns the position of the nearest hostile mob, or null. */
  _findNearestHostilePosition() {
    const hostiles = ['zombie','skeleton','creeper','spider'];
    for (const name of hostiles) {
      const e = this._findNearestEntity(name, 24);
      if (e) return e.position;
    }
    return null;
  }

  /**
   * Equips the most appropriate tool for the given block type.
   * e.g. pickaxe for stone/ore, axe for logs.
   */
  async _equipBestTool(blockName) {
    let toolType = 'hand';

    if (['stone','cobblestone','iron_ore','coal_ore','gold_ore','diamond_ore',
         'deepslate_iron_ore','deepslate_coal_ore','deepslate_diamond_ore'].includes(blockName)) {
      toolType = 'pickaxe';
    } else if (blockName.includes('log') || blockName.includes('wood')) {
      toolType = 'axe';
    } else if (['dirt','grass_block','sand','gravel'].includes(blockName)) {
      toolType = 'shovel';
    }

    if (toolType === 'hand') return;

    // Look for the best matching tool in inventory
    const toolPriority = ['diamond','iron','stone','golden','wooden'];
    for (const material of toolPriority) {
      const itemName = `${material}_${toolType}`;
      const itemId   = this.bot.registry.itemsByName[itemName]?.id;
      if (!itemId) continue;
      const item = this.bot.inventory.findInventoryItem(itemId);
      if (item) {
        await this.bot.equip(item, 'hand');
        return;
      }
    }
  }

  /** Equips the best available sword or axe for combat. */
  async _equipBestWeapon() {
    const weapons  = ['diamond_sword','iron_sword','stone_sword','wooden_sword',
                      'diamond_axe','iron_axe'];
    for (const w of weapons) {
      const id   = this.bot.registry.itemsByName[w]?.id;
      const item = id ? this.bot.inventory.findInventoryItem(id) : null;
      if (item) {
        await this.bot.equip(item, 'hand');
        return;
      }
    }
  }

  /** Promisified sleep. */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = Actions;