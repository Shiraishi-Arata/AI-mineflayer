// skillGenerator.js
const fs = require("fs")
const path = require("path")
const fetch = global.fetch || require("node-fetch") // Node 18+ has fetch

async function generateSkill(goal, memory) {

    const prompt = `
You are a Minecraft AI coding assistant.
Write a JavaScript function for a Mineflayer bot to achieve the goal: "${goal}".
The bot can use:
- bot.pathfinder
- bot.chat
- bot.inventory
- bot.findBlock
Return only valid JS code for a function named skill(bot). Do not include explanations.
Memory: ${JSON.stringify(memory)}
    `

    const response = await fetch("http://localhost:11434/api/generate", {
        method: "POST",
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify({
            model:"phi3",
            prompt: prompt,
            stream: false
        })
    })

    const data = await response.json()
    const code = data.response.trim()

    // Save skill
    const skillName = `skill_${Date.now()}.js`
    const filePath = path.join(__dirname, "skills", skillName)
    fs.writeFileSync(filePath, code)

    return skillName
}

module.exports = generateSkill
