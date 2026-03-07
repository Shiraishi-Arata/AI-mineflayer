const fs = require("fs")

let memory = {
  visited: []
}

// Save memory to disk
function saveMemory() {
  fs.writeFileSync("memory.json", JSON.stringify(memory, null, 2))
}

// Add new visited coordinate
function addVisited(pos) {
  memory.visited.push({x: pos.x, y: pos.y, z: pos.z})
  saveMemory()
}

// Check if a position was visited (radius = 2 blocks)
function isVisited(pos) {
  return memory.visited.some(p =>
    Math.abs(p.x - pos.x) < 2 &&
    Math.abs(p.y - pos.y) < 2 &&
    Math.abs(p.z - pos.z) < 2
  )
}

module.exports = { memory, addVisited, isVisited }
