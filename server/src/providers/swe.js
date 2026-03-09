/**
 * SWE provider adapter
 *
 * This is the free/default exploration model.
 * Used for repo exploration, initial planning, broad code search,
 * low-cost reasoning, and first-pass scaffolding ideas.
 *
 * Replace the mock flow below with actual SWE API integration.
 */

const runState = new Map()

function getRunState(runId) {
  if (!runState.has(runId)) {
    runState.set(runId, { step: 0, tree: [], steps: null })
  }
  const state = runState.get(runId)
  const currentStep = state.step
  state.step++
  return { state, currentStep }
}

export async function callSweAdapter(payload) {
  // TODO: Replace with real SWE API call
  // Store directory tree on first call
  if (payload.directoryTree && payload.directoryTree.length > 0) {
    if (!runState.has(payload.runId)) {
      runState.set(payload.runId, { step: 0, tree: payload.directoryTree, steps: null })
    } else {
      runState.get(payload.runId).tree = payload.directoryTree
    }
  }

  const { state, currentStep } = getRunState(payload.runId)

  if (payload.command === "/plan") {
    return planFlow(payload, state, currentStep)
  }
  if (payload.command === "/pull") {
    return pullFlow(payload, state, currentStep)
  }
  if (payload.command === "/stash") {
    return stashFlow(payload, state, currentStep)
  }

  return defaultFlow(payload, state, currentStep)
}

function defaultFlow(payload, state, step) {
  // Build steps dynamically — lazy init once per run
  if (!state.steps) {
    state.steps = buildDefaultSteps(state.tree)
  }

  if (step < state.steps.length) {
    return state.steps[step]
  }

  // Final completion
  runState.delete(payload.runId)
  return {
    kind: "completed",
    reasoning: "Everything is in place. The auth system has JWT tokens, password hashing with scrypt, route guards, full CRUD, and tests. I'll save the pattern to sysbase for the team.",
    content: "Task completed. All files created, edited, and tested.",
    summary: {
      model: "swe",
      memoryUpdated: true,
      patternSaved: "Always check token expiry before decode"
    },
    usage: t(600, 60)
  }
}

function taskDef() {
  return {
    title: "Build auth system",
    goal: "Create a complete JWT-based authentication system with signup, login, route guards, user management, and tests.",
    steps: [
      { id: "understand", label: "Understand codebase" },
      { id: "structure", label: "Set up project structure" },
      { id: "utils", label: "Create utility modules" },
      { id: "services", label: "Build service layer" },
      { id: "middleware", label: "Add auth middleware" },
      { id: "routes", label: "Create API routes" },
      { id: "wiring", label: "Wire up app entry point" },
      { id: "deps", label: "Add dependencies" },
      { id: "tests", label: "Write tests" },
      { id: "sysbase", label: "Save patterns to sysbase" }
    ]
  }
}

function buildDefaultSteps(tree) {
  const steps = []
  const existingFiles = tree.filter((e) => e.type === "file").map((e) => e.name)
  const existingDirs = tree.filter((e) => e.type === "directory").map((e) => e.name)
  const hasFiles = existingFiles.length > 0
  const task = taskDef()

  // Phase 1: Read existing files as a batch to gather context
  if (hasFiles) {
    steps.push({ kind: "needs_tool", tool: "batch_read", args: { paths: existingFiles },
      reasoning: "Let me read through the existing files to understand the codebase before making any changes.",
      task,
      taskStep: "understand",
      usage: t(900, 110) })
  } else {
    // Empty project - first step is mkdir, but still show task
    steps.push({ kind: "needs_tool", tool: "create_directory", args: { path: "src" },
      reasoning: "This is a fresh project. I'll scaffold the full directory structure for the auth system.",
      task,
      taskStep: "understand",
      usage: t(600, 70) })
  }

  // Phase 2: Create directory structure
  const dirs = ["src", "src/routes", "src/services", "src/middleware", "src/utils", "src/__tests__"]
  const dirsToCreate = dirs.filter((d) => !existingDirs.includes(d))
  // Skip "src" if we already created it as the first step (empty project)
  const remainingDirs = !hasFiles ? dirsToCreate.filter((d) => d !== "src") : dirsToCreate
  if (remainingDirs.length > 0) {
    steps.push({ kind: "needs_tool", tool: "create_directory", args: { path: remainingDirs[0] },
      reasoning: hasFiles
        ? "Now that I understand the codebase, I'll set up the directory structure for the auth system."
        : null,
      taskStep: "structure",
      usage: t(600, 70) })
    for (let i = 1; i < remainingDirs.length; i++) {
      steps.push({ kind: "needs_tool", tool: "create_directory", args: { path: remainingDirs[i] }, usage: t(600, 70) })
    }
  }

  // Phase 3: Create base files if they don't exist
  if (!existingFiles.includes("package.json")) {
    steps.push({ kind: "needs_tool", tool: "write_file",
      args: { path: "package.json", content: `{\n  "name": "auth-app",\n  "type": "module",\n  "scripts": {\n    "start": "node src/app.js",\n    "dev": "node --watch src/app.js"\n  }\n}\n` },
      reasoning: "I'll create the package.json first with ESM support and basic scripts.",
      usage: t(800, 100) })
  }

  if (!existingFiles.includes("src/app.js")) {
    steps.push({ kind: "needs_tool", tool: "write_file",
      args: { path: "src/app.js", content: `// entry point\nconsole.log("app starting")\n` },
      reasoning: "Creating a minimal app entry point. I'll wire up the routes after all modules are built.",
      usage: t(700, 90) })
  }

  // Phase 4: Write utility modules
  steps.push({ kind: "needs_tool", tool: "write_file",
    taskStep: "utils",
    args: { path: "src/utils/jwt.js", content: `import jwt from "jsonwebtoken"\n\nconst SECRET = process.env.JWT_SECRET || "dev-secret"\n\nexport function signToken(payload) {\n  return jwt.sign(payload, SECRET, { expiresIn: "7d" })\n}\n\nexport function verifyToken(token) {\n  return jwt.verify(token, SECRET)\n}\n\nexport function decodeToken(token) {\n  return jwt.decode(token)\n}\n` },
    reasoning: "I'll build the auth system bottom-up. Starting with the JWT utility -- this handles token signing, verification, and decoding. Using jsonwebtoken with a configurable secret.",
    usage: t(1200, 180) })

  steps.push({ kind: "needs_tool", tool: "write_file",
    args: { path: "src/utils/hash.js", content: `import crypto from "node:crypto"\n\nexport function hashPassword(password) {\n  const salt = crypto.randomBytes(16).toString("hex")\n  const hash = crypto.scryptSync(password, salt, 64).toString("hex")\n  return salt + ":" + hash\n}\n\nexport function verifyPassword(password, stored) {\n  const [salt, hash] = stored.split(":")\n  const attempt = crypto.scryptSync(password, salt, 64).toString("hex")\n  return hash === attempt\n}\n` },
    reasoning: "Now the password hashing utility. Using scrypt with random salt -- this is more secure than bcrypt for this use case and doesn't require native bindings.",
    usage: t(1200, 180) })

  // Phase 5: Write services
  steps.push({ kind: "needs_tool", tool: "write_file",
    taskStep: "services",
    args: { path: "src/services/auth-service.js", content: `import { hashPassword, verifyPassword } from "../utils/hash.js"\nimport { signToken } from "../utils/jwt.js"\n\nconst users = new Map()\n\nexport async function signup({ email, password, name }) {\n  if (users.has(email)) throw new Error("User already exists")\n  const hashed = hashPassword(password)\n  const user = { id: crypto.randomUUID(), email, name, password: hashed, createdAt: new Date().toISOString() }\n  users.set(email, user)\n  const token = signToken({ userId: user.id, email: user.email })\n  return { user: { id: user.id, email: user.email, name: user.name }, token }\n}\n\nexport async function login({ email, password }) {\n  const user = users.get(email)\n  if (!user) throw new Error("Invalid credentials")\n  if (!verifyPassword(password, user.password)) throw new Error("Invalid credentials")\n  const token = signToken({ userId: user.id, email: user.email })\n  return { user: { id: user.id, email: user.email, name: user.name }, token }\n}\n\nexport async function getProfile(userId) {\n  for (const user of users.values()) {\n    if (user.id === userId) return { id: user.id, email: user.email, name: user.name }\n  }\n  throw new Error("User not found")\n}\n` },
    reasoning: "Building the auth service layer. This handles signup with duplicate checking, login with credential validation, and profile retrieval. The service uses the jwt and hash utilities I just created.",
    usage: t(1800, 300) })

  steps.push({ kind: "needs_tool", tool: "write_file",
    args: { path: "src/services/user-service.js", content: `const users = new Map()\n\nexport async function listUsers() {\n  return Array.from(users.values()).map(u => ({ id: u.id, email: u.email, name: u.name }))\n}\n\nexport async function updateUser(userId, updates) {\n  for (const [email, user] of users.entries()) {\n    if (user.id === userId) { Object.assign(user, updates); return { id: user.id, email: user.email, name: user.name } }\n  }\n  throw new Error("User not found")\n}\n\nexport async function deleteUser(userId) {\n  for (const [email, user] of users.entries()) {\n    if (user.id === userId) { users.delete(email); return true }\n  }\n  throw new Error("User not found")\n}\n` },
    reasoning: "Adding a user service for CRUD operations. This will be used by the user management routes.",
    usage: t(1400, 220) })

  // Phase 6: Write middleware
  steps.push({ kind: "needs_tool", tool: "write_file",
    taskStep: "middleware",
    args: { path: "src/middleware/auth-guard.js", content: `import { verifyToken } from "../utils/jwt.js"\n\nexport async function authGuard(request, reply) {\n  const header = request.headers.authorization\n  if (!header || !header.startsWith("Bearer ")) {\n    return reply.code(401).send({ error: "Missing or invalid authorization header" })\n  }\n  try {\n    request.user = verifyToken(header.replace("Bearer ", ""))\n  } catch (err) {\n    return reply.code(401).send({ error: "Invalid or expired token" })\n  }\n}\n` },
    reasoning: "Now I need the auth guard middleware. This intercepts requests, validates the Bearer token, and attaches the decoded user to the request object. Protected routes will use this as a preHandler.",
    usage: t(1300, 200) })

  // Phase 7: Write routes
  steps.push({ kind: "needs_tool", tool: "write_file",
    taskStep: "routes",
    args: { path: "src/routes/auth.js", content: `import { signup, login, getProfile } from "../services/auth-service.js"\nimport { authGuard } from "../middleware/auth-guard.js"\n\nexport async function authRoutes(fastify) {\n  fastify.post("/auth/signup", async (req, reply) => {\n    try { return reply.code(201).send(await signup(req.body)) }\n    catch (err) { return reply.code(400).send({ error: err.message }) }\n  })\n  fastify.post("/auth/login", async (req, reply) => {\n    try { return reply.send(await login(req.body)) }\n    catch (err) { return reply.code(401).send({ error: err.message }) }\n  })\n  fastify.get("/auth/me", { preHandler: [authGuard] }, async (req, reply) => {\n    try { return reply.send(await getProfile(req.user.userId)) }\n    catch (err) { return reply.code(404).send({ error: err.message }) }\n  })\n}\n` },
    reasoning: "Creating the auth routes: POST /auth/signup, POST /auth/login, and GET /auth/me. The /me endpoint is protected by the auth guard.",
    usage: t(1600, 260) })

  steps.push({ kind: "needs_tool", tool: "write_file",
    args: { path: "src/routes/user.js", content: `import { listUsers, updateUser, deleteUser } from "../services/user-service.js"\nimport { authGuard } from "../middleware/auth-guard.js"\n\nexport async function userRoutes(fastify) {\n  fastify.get("/users", { preHandler: [authGuard] }, async (req, reply) => {\n    return reply.send(await listUsers())\n  })\n  fastify.put("/users/:id", { preHandler: [authGuard] }, async (req, reply) => {\n    try { return reply.send(await updateUser(req.params.id, req.body)) }\n    catch (err) { return reply.code(404).send({ error: err.message }) }\n  })\n  fastify.delete("/users/:id", { preHandler: [authGuard] }, async (req, reply) => {\n    try { await deleteUser(req.params.id); return reply.code(204).send() }\n    catch (err) { return reply.code(404).send({ error: err.message }) }\n  })\n}\n` },
    usage: t(1500, 240) })

  steps.push({ kind: "needs_tool", tool: "write_file",
    args: { path: "src/routes/health.js", content: `export async function healthRoutes(fastify) {\n  fastify.get("/health", async () => ({ status: "ok", timestamp: new Date().toISOString() }))\n}\n` },
    usage: t(800, 100) })

  // Phase 8: Read back key files before editing (batched)
  steps.push({ kind: "needs_tool", tool: "batch_read",
    args: { paths: ["src/utils/jwt.js", "src/services/auth-service.js", "src/middleware/auth-guard.js", "src/routes/auth.js", "src/app.js"] },
    reasoning: "All modules are written. Let me read back the key files to verify everything is consistent before I wire up the app entry point.",
    usage: t(900, 110) })

  // Phase 9: Edit app.js
  steps.push({ kind: "needs_tool", tool: "edit_file",
    taskStep: "wiring",
    args: { path: "src/app.js", patch: `import Fastify from "fastify"\nimport { authRoutes } from "./routes/auth.js"\nimport { userRoutes } from "./routes/user.js"\nimport { healthRoutes } from "./routes/health.js"\n\nexport function buildApp() {\n  const app = Fastify({ logger: true })\n  app.register(authRoutes)\n  app.register(userRoutes)\n  app.register(healthRoutes)\n  return app\n}\n\nconst app = buildApp()\napp.listen({ port: 3001, host: "0.0.0.0" }).then(() => {\n  console.log("Auth app listening on http://localhost:3001")\n})\n` },
    reasoning: "Rewriting the entry point to register auth, user, and health route plugins with Fastify.",
    usage: t(1400, 200) })

  // Phase 10: Read and edit package.json
  steps.push({ kind: "needs_tool", tool: "batch_read", args: { paths: ["package.json"] },
    reasoning: "I need to add fastify and jsonwebtoken as dependencies.",
    usage: t(800, 100) })
  steps.push({ kind: "needs_tool", tool: "edit_file",
    taskStep: "deps",
    args: { path: "package.json", patch: `{\n  "name": "auth-app",\n  "type": "module",\n  "scripts": {\n    "start": "node src/app.js",\n    "dev": "node --watch src/app.js"\n  },\n  "dependencies": {\n    "fastify": "^5.3.3",\n    "jsonwebtoken": "^9.0.0"\n  }\n}\n` },
    usage: t(1000, 140) })

  // Phase 11: Write tests
  steps.push({ kind: "needs_tool", tool: "write_file",
    taskStep: "tests",
    args: { path: "src/__tests__/auth.test.js", content: `import { describe, it, assert } from "node:test"\nimport { signup, login } from "../services/auth-service.js"\n\ndescribe("auth-service", () => {\n  it("should signup a new user", async () => {\n    const result = await signup({ email: "test@test.com", password: "pass123", name: "Test" })\n    assert.ok(result.token)\n    assert.strictEqual(result.user.email, "test@test.com")\n  })\n  it("should login existing user", async () => {\n    const result = await login({ email: "test@test.com", password: "pass123" })\n    assert.ok(result.token)\n  })\n  it("should reject wrong password", async () => {\n    try { await login({ email: "test@test.com", password: "wrong" }); assert.fail() }\n    catch (err) { assert.strictEqual(err.message, "Invalid credentials") }\n  })\n})\n` },
    reasoning: "Now I'll add tests. Starting with auth service tests covering signup, login, and rejection flows.",
    usage: t(1300, 200) })

  steps.push({ kind: "needs_tool", tool: "write_file",
    args: { path: "src/__tests__/jwt.test.js", content: `import { describe, it, assert } from "node:test"\nimport { signToken, verifyToken, decodeToken } from "../utils/jwt.js"\n\ndescribe("jwt utils", () => {\n  it("should sign and verify", () => {\n    const token = signToken({ userId: "123", email: "a@b.com" })\n    const decoded = verifyToken(token)\n    assert.strictEqual(decoded.userId, "123")\n  })\n  it("should decode without verify", () => {\n    const token = signToken({ userId: "456" })\n    assert.strictEqual(decodeToken(token).userId, "456")\n  })\n})\n` },
    usage: t(1100, 170) })

  steps.push({ kind: "needs_tool", tool: "write_file",
    args: { path: "src/__tests__/auth-guard.test.js", content: `import { describe, it, assert } from "node:test"\nimport { signToken } from "../utils/jwt.js"\n\ndescribe("auth-guard", () => {\n  it("should accept valid bearer token", () => {\n    const token = signToken({ userId: "123" })\n    assert.ok(("Bearer " + token).startsWith("Bearer "))\n  })\n  it("should reject missing header", () => {\n    assert.ok(!"".startsWith("Bearer "))\n  })\n})\n` },
    usage: t(900, 140) })

  // Phase 12: Save memory to sysbase
  steps.push({ kind: "needs_tool", tool: "write_file",
    taskStep: "sysbase",
    args: { path: "sysbase/patterns/auth-pattern.md", content: `# Auth Pattern\n\n## Structure\n- Routes in src/routes/auth.js\n- Service logic in src/services/auth-service.js\n- JWT utilities in src/utils/jwt.js\n- Password hashing in src/utils/hash.js\n- Auth middleware in src/middleware/auth-guard.js\n\n## Rules\n- Always check token expiry before decode\n- Hash passwords with scrypt + random salt\n- Return 401 for invalid/missing tokens\n` },
    reasoning: "Saving the auth pattern to sysbase so the team can reference this approach in future tasks.",
    usage: t(800, 120) })

  steps.push({ kind: "needs_tool", tool: "write_file",
    args: { path: "sysbase/architecture/auth-flow.md", content: `# Auth Flow Architecture\n\n## Signup\n1. POST /auth/signup -> hash password -> store user -> sign JWT\n\n## Login\n1. POST /auth/login -> verify password -> sign JWT\n\n## Protected Routes\n1. Authorization: Bearer <token> -> auth-guard verifies -> attach user\n` },
    usage: t(800, 120) })

  return steps
}

function planFlow(payload, state, step) {
  const tree = state.tree || []
  const existingFiles = tree.filter((e) => e.type === "file").map((e) => e.name)
  const steps = []

  // Read existing files for context
  for (const file of existingFiles) {
    steps.push({ kind: "needs_tool", tool: "read_file", args: { path: file }, usage: t(700, 100) })
  }
  if (existingFiles.length === 0) {
    steps.push({ kind: "needs_tool", tool: "list_directory", args: { path: "." }, usage: t(500, 80) })
  }

  steps.push({
    kind: "needs_tool",
    tool: "write_file",
    args: {
      path: `sysbase/plans/${slugify(payload.userMessage)}.md`,
      content: `# Plan: ${payload.userMessage}\n\n## Goal\n${payload.task?.goal || payload.userMessage}\n\n## Steps\n\n1. Inspect project structure\n2. Create required directories\n3. Implement service layer\n4. Implement route layer\n5. Add middleware\n6. Add utility modules\n7. Wire up app entry point\n8. Add tests\n9. Update dependencies\n10. Save patterns to sysbase\n`
    },
    usage: t(1000, 180)
  })

  if (step < steps.length) {
    return steps[step]
  }

  runState.delete(payload.runId)
  return {
    kind: "completed",
    content: `Plan saved to sysbase/plans/${slugify(payload.userMessage)}.md`,
    summary: { model: "swe", planFile: `sysbase/plans/${slugify(payload.userMessage)}.md` },
    usage: t(400, 50)
  }
}

function pullFlow(payload, state, step) {
  const steps = [
    {
      kind: "needs_tool",
      tool: "write_file",
      args: {
        path: "sysbase/patterns/shared-error-handling.md",
        content: "# Shared Pattern: Error Handling\n\nAlways wrap route handlers in try/catch.\nReturn structured error responses.\n"
      },
      usage: t(500, 80)
    },
    {
      kind: "needs_tool",
      tool: "write_file",
      args: {
        path: "sysbase/patterns/shared-auth-pattern.md",
        content: "# Shared Pattern: Auth\n\nUse Bearer token auth.\nCheck expiry before decode.\nHash passwords with scrypt.\n"
      },
      usage: t(500, 80)
    }
  ]

  if (step < steps.length) {
    return steps[step]
  }

  runState.delete(payload.runId)
  return {
    kind: "completed",
    content: "Synced shared sysbase patterns.",
    summary: { model: "swe", filesSynced: 2 },
    usage: t(300, 40)
  }
}

function stashFlow(payload, state, step) {
  const steps = [
    {
      kind: "needs_tool",
      tool: "move_file",
      args: {
        from: `sysbase/plans/${payload.userMessage}.md`,
        to: `sysbase/archive/${payload.userMessage}.md`
      },
      usage: t(400, 60)
    }
  ]

  if (step < steps.length) {
    return steps[step]
  }

  runState.delete(payload.runId)
  return {
    kind: "completed",
    content: `Archived ${payload.userMessage} to sysbase/archive.`,
    summary: { model: "swe", archived: payload.userMessage },
    usage: t(300, 40)
  }
}

function t(input, output) {
  return { inputTokens: input, outputTokens: output }
}

function slugify(text) {
  return (text || "untitled")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
}
