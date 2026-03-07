const explore = require("./skills/explore")

async function execute(bot, action) {

  if(action.includes("explore")) {
    await explore(bot)
  }

}

module.exports = execute
