/**
 * Structural declarations for the host services this plugin uses.
 *
 * The plugin runs inside many DeepSeek Harness versions. Importing a concrete
 * `@deepseek-ai/dsh-*` package would pin one build and fail to load on the
 * others, so every host surface is declared here and reached through
 * {@link optionalService}, which returns `undefined` when the host does not
 * provide it. A missing surface degrades the plugin, never the host.
 *
 * @module dsh-dotclaude/host
 */

import type { Context } from '@deepseek-ai/cordis'

/** Result a command handler settles with. */
export type CommandResultLike =
  | { readonly kind: 'success'; readonly text?: string }
  | { readonly kind: 'error'; readonly text: string }

/** One settled model-facing user message handed to `Agent.followup`. */
export interface UserMessageLike {
  readonly id: string
  readonly role: 'user'
  readonly content: readonly { readonly type: 'text'; readonly text: string }[]
  readonly source: { readonly kind: 'user' }
}

/** The agent surface a command handler receives. */
export interface AgentLike {
  readonly session: SessionLike
  readonly ctx: Context
  /** Queue an ordinary follow-up turn and wake the driver. */
  followup(message: UserMessageLike): void
}

/** Minimal session surface: the durable log accepts log-only plugin events. */
export interface SessionLike {
  readonly id: string
  append(type: string, data: unknown): unknown
}

/** One invocation of a registered human command. */
export interface CommandInvocationLike {
  readonly agent: AgentLike
  readonly rawInput: string
  readonly signal: AbortSignal
}

/** One registered human command. */
export interface CommandDefinitionLike {
  readonly name: string
  readonly description: string
  readonly input?: { readonly hint?: string }
  readonly handler: (invocation: CommandInvocationLike) => CommandResultLike | Promise<CommandResultLike>
}

/** The host's human-command registry. */
export interface CommandsServiceLike {
  register(definition: CommandDefinitionLike): () => void
}

/** The host's per-session working-directory service. */
export interface WorkingDirectoryServiceLike {
  get(session: SessionLike): string
}

/** The optional dsh-tui status-line seam. */
export interface TuiStatusServiceLike {
  set(key: string, text: string | undefined): (() => void) | void
}

/** The host's system-prompt section registry. */
export interface SystemPromptSectionLike {
  readonly name: string
  readonly order?: number
  readonly text: string
}

/** The host's system-prompt service. */
export interface SystemPromptServiceLike {
  section(section: SystemPromptSectionLike): unknown
}

/** One tool call about to run. */
export interface ToolExecutionLike {
  readonly name: string
  readonly arguments: unknown
  readonly agent?: AgentLike | undefined
}

/** The permission decision a `tools/pre-execute` listener returns. */
export type PreToolDecisionLike =
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny'; readonly reason: string }
  | { readonly kind: 'cancel' }
  | { readonly kind: 'ask'; readonly reason?: string }

/** Host surfaces this plugin probes for, all optional. */
export interface HostServices {
  readonly commands?: CommandsServiceLike | undefined
  readonly workingDirectory?: WorkingDirectoryServiceLike | undefined
  readonly tuiStatus?: TuiStatusServiceLike | undefined
  readonly systemPrompt?: SystemPromptServiceLike | undefined
}

/**
 * Read one optional host service.
 *
 * The generic parameter is the caller's structural declaration; nothing here
 * validates the host's implementation, so every use site still checks the
 * members it calls before calling them.
 * @param ctx - plugin context to read the service from.
 * @param name - host service name.
 * @returns the service when the host provides it, otherwise `undefined`.
 */
export function optionalService<K extends keyof HostServices & string>(
  ctx: Context,
  name: K,
): HostServices[K] {
  const host = ctx as Context & HostServices
  const get = (host as { get?: (name: string, strict?: boolean) => unknown }).get
  if (typeof get !== 'function') return undefined
  return get.call(host, name, false) as HostServices[K]
}

/**
 * Narrow an arbitrary value to the agent surface a command handler needs.
 * @param value - candidate from a host event or invocation.
 * @returns the value when it carries a session and `followup`, otherwise `undefined`.
 */
export function asAgent(value: unknown): AgentLike | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as Partial<AgentLike>
  if (typeof candidate.followup !== 'function') return undefined
  const session = candidate.session
  if (typeof session !== 'object' || session === null) return undefined
  return candidate as AgentLike
}
