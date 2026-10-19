/**
 * dsh-dotclaude — run a Claude Code project's `.claude/` assets inside
 * DeepSeek Harness.
 *
 * Two capabilities, both resolved lazily from the Session working directory:
 * project slash commands (as `/claude run <name>` everywhere, and as their own
 * slash command on hosts that allow agent-scoped registration) and
 * `permissions.deny` enforcement through the tool pre-execute waterfall.
 *
 * Every host surface is optional. A host without the command registry, the
 * working-directory service, or the dsh-tui status seam loads this plugin and
 * does nothing, which is the only acceptable failure mode for a bundle that
 * users install beside unknown neighbours.
 *
 * @module dsh-dotclaude
 */

import { randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Config, resolveConfig } from './config.ts'
import type { Config as ConfigShape, ResolvedConfig } from './config.ts'
import { expandCommand, splitArguments } from './command-file.ts'
import type { ClaudeCommand } from './command-file.ts'
import { invalidateAssets, resolveAssets } from './discover.ts'
import type { DiscoveryIssue, ResolvedAssets } from './discover.ts'
import './events.ts'
import { matchedDeny } from './permissions.ts'
import {
  asAgent,
  optionalService,
} from './host.ts'
import type {
  AgentLike,
  CommandInvocationLike,
  CommandResultLike,
  CommandsServiceLike,
  TuiStatusServiceLike,
  UserMessageLike,
} from './host.ts'

export { Config, resolveConfig } from './config.ts'
export type { Config as DotclaudeConfig } from './config.ts'
export { findProjectRoot, invalidateAssets, readAssets, resolveAssets } from './discover.ts'
export { expandCommand, parseCommandFile, parseFrontMatter, splitArguments } from './command-file.ts'
export { globMatcher, matchedDeny, parsePermissionRule, parseSettings, subjectOf } from './permissions.ts'

/** Cordis plugin name used by the profile row. */
export const name = 'dotclaude'

/** Human-facing command owned by this plugin. */
const COMMAND_NAME = 'claude'

/** Status-line key; the dsh-tui grammar is `plugin` or `plugin:item`. */
const STATUS_KEY = 'dotclaude'

/** Expanded command bodies and the files they inlined. */
interface Launch {
  readonly command: ClaudeCommand
  readonly text: string
  readonly inlined: readonly string[]
}

/** Per-agent state kept only while the agent lives. */
interface AgentState {
  readonly assets: ResolvedAssets
  readonly registered: readonly string[]
}

/**
 * Apply the plugin.
 * @param ctx - plugin context; every host contribution unwinds with it.
 * @param config - validated configuration; omitted keys use defaults.
 */
export function apply(ctx: Context, config: ConfigShape): void {
  const settings = resolveConfig(config)
  const agents = new Map<string, AgentState>()
  const status = settings.statusLine ? optionalService(ctx, 'tuiStatus') : undefined

  /** Resolve the working directory of one agent, when the host exposes it. */
  const cwdOf = (agent: AgentLike): string | undefined => {
    const directory = optionalService(ctx, 'workingDirectory')
    if (directory === undefined || typeof directory.get !== 'function') return undefined
    try {
      return directory.get(agent.session)
    } catch {
      return undefined
    }
  }

  /** Publish the aggregate command count on hosts with the dsh-tui status seam. */
  const renderStatus = (): void => {
    if (status === undefined || typeof status.set !== 'function') return
    let total = 0
    for (const state of agents.values()) total += state.assets.commands.length
    try {
      status.set(STATUS_KEY, total === 0 ? undefined : `claude ${total} cmd`)
    } catch {
      // A host that rejects the key is a host without a usable status line.
    }
  }

  ctx.effect(() => () => {
    if (status === undefined || typeof status.set !== 'function') return
    try {
      status.set(STATUS_KEY, undefined)
    } catch {
      // Disposal must not throw.
    }
  })

  // --- project commands as their own slash commands -----------------------
  ctx.on('agent/created', payload => {
    const agent = asAgent((payload as { agent?: unknown }).agent)
    if (agent === undefined) return
    const cwd = cwdOf(agent)
    if (cwd === undefined) return
    const assets = resolveAssets(cwd, settings)
    const registered: string[] = []
    if (settings.registerCommands) {
      const registry = optionalService(agent.ctx, 'commands')
      if (registry !== undefined && typeof registry.register === 'function') {
        const taken = existingCommandNames(registry, agent)
        for (const command of assets.commands) {
          if (taken.has(command.name)) continue
          try {
            registry.register(defineProjectCommand(command, cwd, settings))
            registered.push(command.name)
          } catch {
            // A rejected registration must not fail the agent.
          }
        }
      }
    }
    agents.set(String(agent.session.id), { assets, registered })
    addPromptSection(agent, assets, settings)
    renderStatus()
  })

  ctx.on('agent/disposed', payload => {
    const agent = asAgent((payload as { agent?: unknown }).agent)
    if (agent === undefined) return
    agents.delete(String(agent.session.id))
    renderStatus()
  })

  // --- permissions.deny ---------------------------------------------------
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!settings.enforceDeny) return next()
    const agent = asAgent(exec.agent)
    const cwd = agent === undefined ? undefined : cwdOf(agent)
    if (cwd === undefined) return next()
    const rule = matchedDeny(resolveAssets(cwd, settings).deny, exec.name, exec.arguments)
    if (rule === undefined) return next()
    return { kind: 'deny', reason: `${rule.raw} from .claude/settings.json (dsh-dotclaude)` }
  })

  // --- the human command --------------------------------------------------
  const commands = optionalService(ctx, 'commands')
  if (commands === undefined || typeof commands.register !== 'function') return
  ctx.effect(() => commands.register({
    name: COMMAND_NAME,
    description: "List, run, or inspect this project's .claude assets",
    input: { hint: 'list | run <name> [args] | doctor | reload' },
    handler: invocation => runCommand(invocation, settings, cwdOf),
  }))
}

/**
 * Read the command names the host already exposes to this agent.
 * @param registry - command registry.
 * @param agent - agent whose view is queried.
 * @returns names that must not be shadowed; empty when the host cannot list.
 */
function existingCommandNames(registry: CommandsServiceLike, agent: AgentLike): Set<string> {
  const list = (registry as { list?: (agent: AgentLike) => readonly { name: string }[] }).list
  if (typeof list !== 'function') return new Set()
  try {
    return new Set(list.call(registry, agent).map(descriptor => descriptor.name))
  } catch {
    return new Set()
  }
}

/**
 * Wrap one project command as a host command definition.
 * @param command - parsed project command.
 * @param agent - agent the registration is scoped to.
 * @param settings - resolved plugin configuration.
 * @returns the definition to register.
 */
function defineProjectCommand(
  command: ClaudeCommand,
  cwd: string,
  settings: ResolvedConfig,
): {
  name: string
  description: string
  input?: { hint: string }
  handler: (invocation: CommandInvocationLike) => CommandResultLike
} {
  return {
    name: command.name,
    description: `${command.description} (${command.origin}: ${command.sourcePath})`,
    ...(command.argumentHint === undefined ? {} : { input: { hint: command.argumentHint } }),
    handler: invocation => launch(invocation, command, settings, cwd),
  }
}

/**
 * Expand one command and submit it as the agent's next turn.
 * @param invocation - the host's command invocation.
 * @param command - command to expand.
 * @param settings - resolved plugin configuration.
 * @param cwd - project directory used to resolve inlined files, when known.
 * @returns the settled command result.
 */
function launch(
  invocation: CommandInvocationLike,
  command: ClaudeCommand,
  settings: ResolvedConfig,
  cwd: string | undefined,
): CommandResultLike {
  const rawInput = invocation.rawInput.trim()
  const expanded = expandCommand(command.body, {
    rawInput,
    arguments: splitArguments(rawInput),
    ...(settings.inlineFiles && cwd !== undefined
      ? { readFile: (path: string) => readWithinProject(cwd, path, settings.maxInlineBytes) }
      : {}),
  })
  if (expanded.text.trim() === '') {
    return { kind: 'error', text: `/${command.name} expands to an empty prompt` }
  }
  const message: UserMessageLike = {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: expanded.text }],
    source: { kind: 'user' },
  }
  invocation.agent.followup(message)
  const inlined = expanded.files.filter(file => file.text !== undefined).length
  const skipped = expanded.files.length - inlined
  return {
    kind: 'success',
    text: `Ran /${command.name} from ${command.sourcePath}`
      + (inlined === 0 ? '' : `; inlined ${inlined} file${inlined === 1 ? '' : 's'}`)
      + (skipped === 0 ? '' : `; ${skipped} reference${skipped === 1 ? '' : 's'} unavailable`),
  }
}

/**
 * Read one file referenced by a command body.
 * @param cwd - project directory; relative references resolve here.
 * @param path - reference text from the body.
 * @param limit - largest accepted file, in bytes.
 * @returns the file text, or `undefined` when it is missing or too large.
 */
function readWithinProject(cwd: string, path: string, limit: number): string | undefined {
  const absolute = isAbsolute(path) ? path : resolve(cwd, path)
  try {
    if (statSync(absolute).size > limit) return undefined
    return readFileSync(absolute, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * Add the stable system-prompt section that announces project commands.
 * @param agent - agent whose prompt the section belongs to.
 * @param assets - resolved assets.
 * @param settings - resolved plugin configuration.
 */
function addPromptSection(agent: AgentLike, assets: ResolvedAssets, settings: ResolvedConfig): void {
  if (!settings.promptSection || assets.commands.length === 0) return
  const lines = [
    'The project defines Claude Code commands. Run one with `/claude run <name> [arguments]`; its body is expanded into your next turn.',
    '',
    ...assets.commands.map(command => `- ${command.name}: ${command.description}`),
  ]
  const text = lines.join('\n')
  const prompt = optionalService(agent.ctx, 'systemPrompt')
  if (prompt !== undefined && typeof prompt.section === 'function') {
    try {
      prompt.section({ name: 'dotclaude:commands', order: 60, text })
      return
    } catch {
      // Fall through to the injected form below.
    }
  }
  const inject = (agent.ctx as { inject?: (keys: string[], callback: (scoped: Context) => void) => unknown }).inject
  if (typeof inject !== 'function') return
  try {
    inject.call(agent.ctx, ['systemPrompt'], (scoped: Context) => {
      const service = optionalService(scoped, 'systemPrompt')
      service?.section({ name: 'dotclaude:commands', order: 60, text })
    })
  } catch {
    // A host without prompt sections simply keeps the prompt unchanged.
  }
}

/**
 * Execute `/claude`.
 * @param invocation - host invocation carrying the raw input and agent.
 * @param settings - resolved plugin configuration.
 * @param cwdOf - working-directory lookup.
 * @returns the settled command result.
 */
function runCommand(
  invocation: CommandInvocationLike,
  settings: ResolvedConfig,
  cwdOf: (agent: AgentLike) => string | undefined,
): CommandResultLike {
  try {
    const cwd = cwdOf(invocation.agent)
    if (cwd === undefined) {
      return { kind: 'error', text: '/claude needs a Session working directory, which this host does not expose' }
    }
    const [verb = 'list', ...rest] = splitArguments(invocation.rawInput)
    switch (verb) {
      case 'list':
        return { kind: 'success', text: renderList(resolveAssets(cwd, settings)) }
      case 'run': {
        const [target, ...argument] = rest
        if (target === undefined) return { kind: 'error', text: 'Usage: /claude run <name> [arguments]' }
        const assets = resolveAssets(cwd, settings)
        const command = assets.commands.find(entry => entry.name === target)
        if (command === undefined) {
          const known = assets.commands.map(entry => entry.name).join(', ')
          return {
            kind: 'error',
            text: `No .claude command named "${target}" in ${cwd}.`
              + (known === '' ? ' No commands were found.' : ` Known: ${known}`),
          }
        }
        const remaining = invocation.rawInput.trim().replace(/^run\s+\S+\s*/u, '')
        return launch(
          { agent: invocation.agent, rawInput: remaining, signal: invocation.signal },
          command,
          settings,
          cwd,
        )
      }
      case 'doctor':
        return { kind: 'success', text: renderReport(resolveAssets(cwd, settings)) }
      case 'reload': {
        invalidateAssets()
        const assets = resolveAssets(cwd, settings)
        return {
          kind: 'success',
          text: `Reloaded: ${assets.commands.length} command(s), ${assets.deny.length} deny rule(s)`,
        }
      }
      default:
        return { kind: 'error', text: `Unknown subcommand "${verb}". Try list, run, doctor, or reload.` }
    }
  } catch (error) {
    return { kind: 'error', text: `/claude failed: ${(error as Error).message}` }
  }
}

/**
 * Render the command catalog.
 * @param assets - resolved assets.
 * @returns one line per command, or an explanation of the empty case.
 */
export function renderList(assets: ResolvedAssets): string {
  if (assets.commands.length === 0) {
    return `No .claude commands resolved from ${assets.cwd}`
      + (assets.projectRoot === undefined ? '' : ` (project root ${assets.projectRoot})`)
  }
  const lines = [
    `${assets.commands.length} .claude command(s) from ${assets.projectRoot ?? assets.cwd}:`,
    ...assets.commands.map(command => `  /claude run ${command.name} — ${command.description} [${command.origin}]`),
  ]
  if (assets.deny.length > 0) lines.push(`  ${assets.deny.length} deny rule(s) enforced`)
  return lines.join('\n')
}

/**
 * Render the provenance and problem report.
 * @param assets - resolved assets.
 * @returns a human-readable report.
 */
export function renderReport(assets: ResolvedAssets): string {
  const lines = [
    'dsh-dotclaude report',
    `  working directory: ${assets.cwd}`,
    `  project root:      ${assets.projectRoot ?? '(none)'}`,
    `  user root:         ${assets.userRoot ?? '(none)'}`,
    `  commands:          ${assets.commands.length}`,
    `  deny rules:        ${assets.deny.length}`,
    `  allow rules:       ${assets.allow.length} (reported, not enforced)`,
  ]
  if (assets.commands.length > 0) {
    lines.push('  resolved commands:')
    for (const command of assets.commands) {
      lines.push(`    ${command.name} [${command.origin}] ${command.sourcePath}`)
    }
  }
  if (assets.deny.length > 0) {
    lines.push('  enforced deny rules:')
    for (const rule of assets.deny) lines.push(`    ${rule.raw}`)
  }
  if (assets.issues.length > 0) {
    lines.push('  issues:')
    for (const issue of assets.issues) lines.push(`    ${formatIssue(issue)}`)
  } else {
    lines.push('  issues:            none')
  }
  return lines.join('\n')
}

/**
 * Format one discovery issue for the report.
 * @param issue - recorded problem.
 * @returns a single indented line.
 */
function formatIssue(issue: DiscoveryIssue): string {
  return issue.path === undefined ? issue.message : `${issue.path}: ${issue.message}`
}

export default apply
