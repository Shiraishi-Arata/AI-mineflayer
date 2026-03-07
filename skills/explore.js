const { goals } = require("mineflayer-pathfinder")
const { GoalNear } = goals
const { addVisited, isVisited } = require("../memory") // adjust path if needed

module.exports = async function explore(bot) {

  if (!bot.entity) return

  let x, z
  let attempts = 0

  // Try up to 10 times to find an unvisited spot
  do {
    x = bot.entity.position.x + (Math.random() * 10 - 5)
    z = bot.entity.position.z + (Math.random() * 10 - 5)
    attempts++
  } while(isVisited({x, y: bot.entity.position.y, z}) && attempts < 10)

  const target = {x, y: bot.entity.position.y, z}

  // Set pathfinding goal
  bot.pathfinder.setGoal(new GoalNear(target.x, target.y, target.z, 1))

  // Add to visited memory
  addVisited(target)

  console.log(`Exploring new spot: x=${Math.floor(target.x)}, z=${Math.floor(target.z)}`)
}
