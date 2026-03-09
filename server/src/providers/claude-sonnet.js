/**
 * Claude Sonnet provider adapter
 *
 * Balanced default paid model for normal implementation,
 * file edits, bug fixing, and typical daily coding tasks.
 *
 * Replace the mock flow below with actual Claude Sonnet API integration.
 */

export async function callClaudeSonnetAdapter(payload) {
  // TODO: Replace with real Claude Sonnet API call
  // The contract is: return a normalized response shape
  return mockClaudeSonnetFlow(payload)
}

function mockClaudeSonnetFlow(payload) {
  if (!payload.toolResult) {
    if (payload.command === "/pull") {
      return {
        kind: "needs_tool",
        tool: "write_file",
        args: {
          path: "sysbase/patterns/example-pattern.md",
          content: "# Example Pattern\n\nSynced from shared server source.\n"
        },
        content: "Provider claude-sonnet-4 requested sysbase sync.",
        usage: { inputTokens: 900, outputTokens: 120 }
      }
    }

    if (payload.command === "/plan") {
      return {
        kind: "needs_tool",
        tool: "write_file",
        args: {
          path: `sysbase/plans/${slugify(payload.userMessage)}.md`,
          content: `# Plan: ${payload.userMessage}\n\n## Objective\n${payload.task.goal}\n\n## Steps\n\n1. Inspect project structure\n2. Identify dependencies\n3. Scaffold required files\n4. Implement core logic\n5. Add tests\n6. Verify\n`
        },
        content: "Provider claude-sonnet-4 generated a detailed plan.",
        usage: { inputTokens: 1200, outputTokens: 200 }
      }
    }

    return {
      kind: "needs_tool",
      tool: "list_directory",
      args: { path: "." },
      content: "Provider claude-sonnet-4 is inspecting the repo.",
      usage: { inputTokens: 900, outputTokens: 120 }
    }
  }

  if (payload.toolResult.tool === "list_directory") {
    const entries = payload.toolResult.result.entries || []

    if (entries.length === 0) {
      return {
        kind: "needs_tool",
        tool: "create_directory",
        args: { path: "src" },
        content: "Repo is empty. Creating project structure.",
        usage: { inputTokens: 1400, outputTokens: 180 }
      }
    }

    return {
      kind: "needs_tool",
      tool: "write_file",
      args: {
        path: "src/app.js",
        content: 'export function app() {\n  return "hello from claude-sonnet"\n}\n'
      },
      content: "Creating application file.",
      usage: { inputTokens: 1400, outputTokens: 180 }
    }
  }

  if (payload.toolResult.tool === "create_directory") {
    return {
      kind: "needs_tool",
      tool: "write_file",
      args: {
        path: "package.json",
        content: '{\n  "name": "sys-generated-app",\n  "type": "module"\n}\n'
      },
      content: "Writing package.json.",
      usage: { inputTokens: 1700, outputTokens: 220 }
    }
  }

  if (payload.toolResult.tool === "write_file") {
    return {
      kind: "completed",
      content: "Task completed successfully.",
      summary: {
        model: "claude-sonnet-4",
        wroteFile: payload.toolResult.result.path || null
      },
      usage: { inputTokens: 700, outputTokens: 80 }
    }
  }

  if (payload.toolResult.tool === "read_file") {
    return {
      kind: "needs_tool",
      tool: "edit_file",
      args: {
        path: payload.toolResult.result.path,
        patch: "// updated by claude-sonnet agent\n" + (payload.toolResult.result.content || "")
      },
      content: "Editing file.",
      usage: { inputTokens: 1800, outputTokens: 220 }
    }
  }

  if (payload.toolResult.tool === "edit_file") {
    return {
      kind: "completed",
      content: "File updated and task completed.",
      summary: {
        model: "claude-sonnet-4",
        editedFile: payload.toolResult.result.path || null
      },
      usage: { inputTokens: 800, outputTokens: 90 }
    }
  }

  return {
    kind: "completed",
    content: "Done.",
    usage: { inputTokens: 500, outputTokens: 50 }
  }
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
}
