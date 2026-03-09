export function parseCliInput(argv) {
  const [first, ...rest] = argv

  if (!first) {
    return { mode: "ui" }
  }

  if (first === "ui") {
    return { mode: "ui" }
  }

  if (first === "login") return { mode: "login" }
  if (first === "register") return { mode: "register" }
  if (first === "logout") return { mode: "logout" }
  if (first === "whoami" || first === "user") return { mode: "whoami" }
  if (first === "chats" || first === "chat") return { mode: "chats" }
  if (first === "delete" && rest[0] === "chat") return { mode: "delete-chat" }
  if (first === "billing" || first === "subscribe" || first === "plans") return { mode: "billing" }
  if (first === "usage") return { mode: "usage" }

  if (first === "model" || first === "models") {
    return {
      mode: "model",
      model: rest[0] || null
    }
  }

  if (first === "plan") {
    return {
      mode: "run",
      command: "/plan",
      prompt: rest.join(" ").trim()
    }
  }

  if (first === "implement") {
    return {
      mode: "run",
      command: "/implement",
      prompt: rest.join(" ").trim()
    }
  }

  if (first === "pull") {
    return {
      mode: "run",
      command: "/pull",
      prompt: ""
    }
  }

  if (first === "continue" || first === "cont") {
    return {
      mode: "run",
      command: "/continue",
      prompt: rest.length > 0 ? rest.join(" ").trim() : "continue the previous task"
    }
  }

  if (first === "stash") {
    return {
      mode: "run",
      command: "/stash",
      prompt: rest.join(" ").trim()
    }
  }

  if (first.startsWith("/")) {
    return {
      mode: "run",
      command: first,
      prompt: rest.join(" ").trim()
    }
  }

  // Detect "continue" as a plain prompt too
  const fullPrompt = [first, ...rest].join(" ").trim()
  if (fullPrompt.toLowerCase() === "continue" || fullPrompt.toLowerCase() === "continue the previous task") {
    return {
      mode: "run",
      command: "/continue",
      prompt: "continue the previous task"
    }
  }

  // Guard: reject bare command-like words that aren't valid commands
  // Prompts must be quoted (sys "do something") or be clearly not a command word
  const COMMAND_WORDS = new Set([
    "login", "register", "logout", "whoami", "user", "chats", "chat",
    "delete", "billing", "subscribe", "plans", "usage", "model", "models",
    "plan", "implement", "pull", "stash", "ui", "help"
  ])
  if (COMMAND_WORDS.has(first.toLowerCase())) {
    console.log(`  Unknown command: sys ${fullPrompt}`)
    console.log(`  Did you mean a prompt? Use quotes: sys "${fullPrompt}"`)
    return { mode: "noop" }
  }

  return {
    mode: "run",
    command: null,
    prompt: fullPrompt
  }
}

export function parseUiLine(line) {
  const trimmed = line.trim()

  if (!trimmed) {
    return null
  }

  if (trimmed === "/exit" || trimmed === "/quit") {
    return { mode: "exit" }
  }

  if (trimmed === "/login") return { mode: "login" }
  if (trimmed === "/register") return { mode: "register" }
  if (trimmed === "/logout") return { mode: "logout" }
  if (trimmed === "/whoami" || trimmed === "/user") return { mode: "whoami" }
  if (trimmed === "/chats" || trimmed === "/chat") return { mode: "chats" }
  if (trimmed === "/delete chat" || trimmed === "/deletechat") return { mode: "delete-chat" }
  if (trimmed === "/billing" || trimmed === "/subscribe" || trimmed === "/plans") return { mode: "billing" }
  if (trimmed === "/usage") return { mode: "usage" }

  if (trimmed === "/model" || trimmed.startsWith("/model ")) {
    return {
      mode: "model",
      model: trimmed === "/model" ? null : trimmed.replace("/model", "").trim()
    }
  }

  if (trimmed === "/pull") {
    return {
      mode: "run",
      command: "/pull",
      prompt: ""
    }
  }

  if (trimmed === "/continue" || trimmed === "/cont" || trimmed.startsWith("/continue ")) {
    const extra = trimmed.replace(/^\/cont(inue)?/, "").trim()
    return {
      mode: "run",
      command: "/continue",
      prompt: extra || "continue the previous task"
    }
  }

  if (trimmed.startsWith("/plan ")) {
    return {
      mode: "run",
      command: "/plan",
      prompt: trimmed.replace("/plan", "").trim()
    }
  }

  if (trimmed.startsWith("/implement ")) {
    return {
      mode: "run",
      command: "/implement",
      prompt: trimmed.replace("/implement", "").trim()
    }
  }

  if (trimmed.startsWith("/stash ")) {
    return {
      mode: "run",
      command: "/stash",
      prompt: trimmed.replace("/stash", "").trim()
    }
  }

  if (trimmed.startsWith("/")) {
    const [command, ...rest] = trimmed.split(" ")
    return {
      mode: "run",
      command,
      prompt: rest.join(" ").trim()
    }
  }

  // Detect "continue" typed as plain text in interactive mode
  if (trimmed.toLowerCase() === "continue" || trimmed.toLowerCase() === "cont") {
    return {
      mode: "run",
      command: "/continue",
      prompt: "continue the previous task"
    }
  }

  return {
    mode: "run",
    command: null,
    prompt: trimmed
  }
}
