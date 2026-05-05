/**
 * Catalogue of slash commands shown in the chat-input autocomplete popup.
 * Source-of-truth lives in `cli/parser.ts`'s `parseUiLine`; this is just
 * the user-visible list with descriptions.
 */

export interface SlashCommand {
  command: string
  /** Optional argument hint — shown dim after the command. */
  args?: string
  description: string
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { command: "/model", args: "[name]", description: "pick or switch the model" },
  { command: "/mode", args: "[default|auto|plan|bypass]", description: "permission mode" },
  { command: "/permissions", args: "[list|remove|clear]", description: "view or clear saved rules" },
  { command: "/plan-mode", args: "[on|off|toggle]", description: "agent plans only — no file writes" },
  { command: "/memory", args: "[list|forget|clear|show]", description: "browse or prune persistent memory" },
  { command: "/remember", args: "<text>", description: "save a fact to memory" },
  { command: "/chats", description: "list / pick chat sessions" },
  { command: "/billing", description: "manage subscription" },
  { command: "/usage", description: "show token / credit usage" },
  { command: "/login", description: "log in" },
  { command: "/register", description: "create an account" },
  { command: "/logout", description: "sign out" },
  { command: "/whoami", description: "show current user" },
  { command: "/continue", args: "[hint]", description: "resume the previous task" },
  { command: "/plan", args: "<task>", description: "plan a task without executing" },
  { command: "/implement", args: "<task>", description: "implement a task" },
  { command: "/exit", description: "quit sys" },
]

export function matchSlashCommands(buffer: string): SlashCommand[] {
  if (!buffer.startsWith("/")) return []
  const head = buffer.split(" ")[0].toLowerCase()
  if (head === "/") return SLASH_COMMANDS
  return SLASH_COMMANDS.filter((c) => c.command.toLowerCase().startsWith(head))
}
