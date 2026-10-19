/**
 * Deployment-varying knobs. Every key has a default, so a profile that mounts
 * the plugin with no `config` block gets a working, quiet plugin.
 *
 * @module dsh-dotclaude/config
 */

import z from '@deepseek-ai/schemastery'

/** Plugin configuration as written in `cordis.yml` or `cordis.patch.yml`. */
export interface Config {
  /** Discover `.claude/commands` from the Session working directory and its ancestors. */
  projectCommands?: boolean
  /** Also read `~/.claude/commands`; a project command of the same name wins. */
  userCommands?: boolean
  /** Enforce `permissions.deny` from `.claude/settings.json` and `.claude/settings.local.json`. */
  enforceDeny?: boolean
  /** Inline `@path` references in a command body from the project directory. */
  inlineFiles?: boolean
  /** Register each discovered project command as its own slash command on new agents. */
  registerCommands?: boolean
  /** Add one stable system-prompt section listing the project's commands. */
  promptSection?: boolean
  /** Publish the resolved asset count on the dsh-tui status line when that seam exists. */
  statusLine?: boolean
  /** Largest command file read, in bytes. */
  maxCommandBytes?: number
  /** Largest total inline file content substituted into one prompt, in bytes. */
  maxInlineBytes?: number
  /** Extra absolute project directories to scan, in addition to the Session working directory. */
  extraRoots?: string[]
}

/** Configuration after defaults are applied. */
export interface ResolvedConfig {
  readonly projectCommands: boolean
  readonly userCommands: boolean
  readonly enforceDeny: boolean
  readonly inlineFiles: boolean
  readonly registerCommands: boolean
  readonly promptSection: boolean
  readonly statusLine: boolean
  readonly maxCommandBytes: number
  readonly maxInlineBytes: number
  readonly extraRoots: readonly string[]
}

/** Validated schema; the host passes the parsed value to `apply`. */
export const Config: z<Config> = z.object({
  projectCommands: z.boolean().default(true),
  userCommands: z.boolean().default(true),
  enforceDeny: z.boolean().default(true),
  inlineFiles: z.boolean().default(true),
  registerCommands: z.boolean().default(true),
  promptSection: z.boolean().default(true),
  statusLine: z.boolean().default(true),
  maxCommandBytes: z.number().default(64 * 1024),
  maxInlineBytes: z.number().default(64 * 1024),
  extraRoots: z.array(z.string()).default([]),
})

/**
 * Apply defaults to an already-validated configuration.
 * @param config - configuration value supplied by the host.
 * @returns the complete configuration.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  return {
    projectCommands: config.projectCommands ?? true,
    userCommands: config.userCommands ?? true,
    enforceDeny: config.enforceDeny ?? true,
    inlineFiles: config.inlineFiles ?? true,
    registerCommands: config.registerCommands ?? true,
    promptSection: config.promptSection ?? true,
    statusLine: config.statusLine ?? true,
    maxCommandBytes: config.maxCommandBytes ?? 64 * 1024,
    maxInlineBytes: config.maxInlineBytes ?? 64 * 1024,
    extraRoots: config.extraRoots ?? [],
  }
}
