const mineflayer = require("mineflayer")
const { pathfinder } = require("mineflayer-pathfinder")

const askAI = require("./planner")
const execute = require("./executor")

const bot = mineflayer.createBot({
  host:"Hot-Snow.play.hosting",
  username:"Misaki"
})

bot.loadPlugin(pathfinder)

async function think(){

  const state = `
Health: ${bot.health}
Food: ${bot.food}
Position: ${bot.entity.position}
`

  const action = await askAI(state)

  console.log("AI decided:",action)

  execute(bot,action)

}

bot.once("spawn",()=>{

  console.log("AI ready")

  setInterval(think,5000)

})

let busy = false

async function think() {
  if(busy) return
  busy = true

  const state = `Health: ${bot.health}\nFood: ${bot.food}`
  const action = await askAI(state)
  execute(bot, action)

  busy = false
}

bot.on('stuck', () => {
  console.log("Bot is stuck, trying to move around")
  think() // pick new action
})
