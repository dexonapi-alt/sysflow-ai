import { getAuthToken } from "./sysbase.js"

const SERVER_URL = process.env.SYS_SERVER_URL || "http://localhost:3000"

export async function callServer(payload) {
  // 5 minute timeout — local LLMs on CPU can be very slow
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 300000)

  // Use JWT auth token if logged in, fallback to legacy SYS_TOKEN
  const authToken = await getAuthToken()
  const bearerToken = authToken || process.env.SYS_TOKEN || "YOUR_TOKEN"

  try {
    const res = await fetch(`${SERVER_URL}/agent/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearerToken}`
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    })

    if (!res.ok) {
      const text = await res.text()
      // Parse usage limit responses so the agent can show a friendly message
      if (res.status === 429) {
        try {
          const data = JSON.parse(text)
          if (data.status === "usage_limit") {
            const err = new Error(data.error || "Usage limit reached")
            err.code = "USAGE_LIMIT"
            err.plan = data.plan
            throw err
          }
        } catch (e) {
          if (e.code === "USAGE_LIMIT") throw e
        }
      }
      throw new Error(`Server error ${res.status}: ${text}`)
    }

    return res.json()
  } finally {
    clearTimeout(timeout)
  }
}
