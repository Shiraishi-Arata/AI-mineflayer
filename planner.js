async function askAI(state) {

  const response = await fetch("http://localhost:11434/api/generate", {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({
      model:"phi3",
      prompt:`
You are a Minecraft AI.

State:
${state}

Available actions:
- explore
- mine stone
- follow player
- idle

Reply only with the action name.
`,
      stream:false
    })
  })

  const data = await response.json()
  return data.response.trim()

}

module.exports = askAI
