/**
 * Resolve one working directory's `.claude/` assets: command files and
 * permission rules, with the provenance a report needs.
 *
 * Reads are synchronous and cached briefly, because the permission check runs
 * on every tool call. Cache entries expire by age and by a miss on the
 * settings file's modification time.
 *
 * @module dsh-dotclaude/discover
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import type { ResolvedConfig } from './config.ts'
import { parseCommandFile } from './command-file.ts'
import type { ClaudeCommand } from './command-file.ts'
import { parseSettings } from './permissions.ts'
import type { PermissionRule } from './permissions.ts'

/** One problem discovered while reading project assets. */
export interface DiscoveryIssue {
  /** Path the problem concerns, when it is file-specific. */
  readonly path?: string
  /** Human-readable explanation. */
  readonly message: string
}

/** Everything one working directory contributes. */
export interface ResolvedAssets {
  /** Working directory the assets were resolved for. */
  readonly cwd: string
  /** Nearest ancestor holding `.claude/`, or the git root when no `.claude/` exists. */
  readonly projectRoot?: string
  /** User-level root (`~/.claude`), when it exists. */
  readonly userRoot?: string
  /** Effective commands; a project command shadows a user command of the same name. */
  readonly commands: readonly ClaudeCommand[]
  /** Deny rules in file order. */
  readonly deny: readonly PermissionRule[]
  /** Allow rules, reported but never enforced. */
  readonly allow: readonly string[]
  /** Everything that failed to load. */
  readonly issues: readonly DiscoveryIssue[]
}

const CACHE_TTL_MS = 1500
const MAX_DEPTH = 4

interface CacheEntry {
  readonly at: number
  readonly assets: ResolvedAssets
}

const cache = new Map<string, CacheEntry>()

/**
 * Drop every cached resolution. Used by `/claude reload` and by tests.
 */
export function invalidateAssets(): void {
  cache.clear()
}

/**
 * Whether a directory exists and is readable.
 * @param path - absolute candidate path.
 * @returns whether the path exists.
 */
function exists(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * Find the directory whose `.claude/` applies to a working directory.
 *
 * The nearest ancestor containing `.claude/` wins. When none does, the git
 * root is used so a repository without Claude config still reports a root.
 * @param cwd - absolute working directory.
 * @returns the resolved root, or `undefined` at the filesystem boundary.
 */
export function findProjectRoot(cwd: string): string | undefined {
  let directory = resolve(cwd)
  for (;;) {
    if (exists(join(directory, '.git'))) return directory
    const parent = dirname(directory)
    if (parent === directory) return resolve(cwd)
    directory = parent
  }
}

/**
 * List Markdown files below a directory, sorted for deterministic output.
 * @param root - absolute directory.
 * @param issues - collector for unreadable entries.
 * @returns relative paths with `/` separators.
 */
function listMarkdown(root: string, issues: DiscoveryIssue[], depth = 0): string[] {
  if (depth > MAX_DEPTH) return []
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const found: string[] = []
  for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith('.')) continue
    const absolute = join(root, entry.name)
    if (entry.isSymbolicLink()) {
      issues.push({ path: absolute, message: 'symbolic links are not followed' })
      continue
    }
    if (entry.isDirectory()) {
      for (const nested of listMarkdown(absolute, issues, depth + 1)) found.push(`${entry.name}/${nested}`)
      continue
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) found.push(entry.name)
  }
  return found
}

/**
 * Read every command file under one `.claude` root.
 * @param claudeRoot - absolute path to a `.claude` directory.
 * @param origin - whether the root belongs to the project or the user.
 * @param config - resolved plugin configuration.
 * @param issues - collector for read and parse problems.
 * @returns parsed commands in path order.
 */
function readCommands(
  claudeRoot: string,
  origin: 'project' | 'user',
  config: ResolvedConfig,
  issues: DiscoveryIssue[],
): ClaudeCommand[] {
  const directory = join(claudeRoot, 'commands')
  if (!exists(directory)) return []
  const commands: ClaudeCommand[] = []
  for (const relativePath of listMarkdown(directory, issues)) {
    const absolute = join(directory, ...relativePath.split('/'))
    let text: string
    try {
      const stat = statSync(absolute)
      if (stat.size > config.maxCommandBytes) {
        issues.push({ path: absolute, message: `skipped: ${stat.size} bytes exceeds maxCommandBytes` })
        continue
      }
      text = readFileSync(absolute, 'utf8')
    } catch (error) {
      issues.push({ path: absolute, message: `unreadable: ${(error as Error).message}` })
      continue
    }
    const parsed = parseCommandFile({ sourcePath: absolute, relativePath, text, origin })
    if (parsed === undefined) {
      issues.push({ path: absolute, message: 'skipped: file name does not map to a valid command name' })
      continue
    }
    commands.push(parsed)
  }
  return commands
}

/**
 * Merge project and user commands, letting the project name win.
 * @param project - project commands.
 * @param user - user commands.
 * @returns the effective command list, sorted by name.
 */
function mergeCommands(project: readonly ClaudeCommand[], user: readonly ClaudeCommand[]): ClaudeCommand[] {
  const merged = new Map<string, ClaudeCommand>()
  for (const command of user) merged.set(command.name, command)
  for (const command of project) merged.set(command.name, command)
  return [...merged.values()].toSorted((left, right) => left.name.localeCompare(right.name))
}

/**
 * Read the deny and allow rules from a `.claude` root.
 * @param claudeRoot - absolute path to a `.claude` directory.
 * @param issues - collector for parse problems.
 * @returns deny rules in file order and reported allow rules.
 */
function readPermissions(
  claudeRoot: string,
  issues: DiscoveryIssue[],
): { deny: PermissionRule[]; allow: string[] } {
  const deny: PermissionRule[] = []
  const allow: string[] = []
  for (const file of ['settings.json', 'settings.local.json']) {
    const absolute = join(claudeRoot, file)
    if (!exists(absolute)) continue
    let value: unknown
    try {
      value = JSON.parse(readFileSync(absolute, 'utf8'))
    } catch (error) {
      issues.push({ path: absolute, message: `unreadable: ${(error as Error).message}` })
      continue
    }
    const parsed = parseSettings(value, file)
    deny.push(...parsed.deny)
    allow.push(...parsed.allow)
    for (const issue of parsed.issues) issues.push({ path: absolute, message: issue })
  }
  return { deny, allow }
}

/**
 * Resolve one working directory's assets.
 * @param cwd - absolute working directory.
 * @param config - resolved plugin configuration.
 * @returns cached-or-fresh asset resolution.
 */
export function resolveAssets(cwd: string, config: ResolvedConfig): ResolvedAssets {
  return resolveAssetsAt(cwd, config, homedir())
}

/**
 * Resolve assets with an explicit user-level root.
 *
 * The override exists for tests and for a host that relocates the user
 * configuration directory; production calls use `~`.
 * @param cwd - absolute working directory.
 * @param config - resolved plugin configuration.
 * @param userHome - directory whose `.claude` is the user-level root.
 * @returns cached-or-fresh asset resolution.
 */
export function resolveAssetsAt(cwd: string, config: ResolvedConfig, userHome: string): ResolvedAssets {
  const key = `${resolve(cwd)}\u0000${resolve(userHome)}`
  const cached = cache.get(key)
  const now = Date.now()
  if (cached !== undefined && now - cached.at < CACHE_TTL_MS) return cached.assets
  const assets = readAssets(cwd, config, userHome)
  cache.set(key, { at: now, assets })
  return assets
}

/**
 * Read assets without consulting the cache.
 * @param cwd - absolute working directory.
 * @param config - resolved plugin configuration.
 * @returns the fresh resolution.
 */
export function readAssets(cwd: string, config: ResolvedConfig, userHome: string = homedir()): ResolvedAssets {
  const issues: DiscoveryIssue[] = []
  const discoveredRoot = config.projectCommands ? findProjectRoot(cwd) : undefined
  // A home directory that happens to carry `.claude` is the user-level root, not a project.
  const projectRoot = discoveredRoot !== undefined && resolve(discoveredRoot) === resolve(userHome)
    ? undefined
    : discoveredRoot
  const projectClaude = projectRoot === undefined ? undefined : join(projectRoot, '.claude')
  const userClaude = join(userHome, '.claude')
  const userRoot = config.userCommands && exists(userClaude) ? userClaude : undefined
  const projectCommands = projectClaude !== undefined && exists(projectClaude)
    ? readCommands(projectClaude, 'project', config, issues)
    : []
  const userCommands = userRoot === undefined ? [] : readCommands(userRoot, 'user', config, issues)
  const permissionRoots = [projectClaude, userRoot].filter((value): value is string => value !== undefined)
  const deny: PermissionRule[] = []
  const allow: string[] = []
  if (config.enforceDeny) {
    for (const root of permissionRoots) {
      const parsed = readPermissions(root, issues)
      deny.push(...parsed.deny)
      allow.push(...parsed.allow)
    }
  }
  return {
    cwd,
    ...(projectRoot === undefined ? {} : { projectRoot }),
    ...(userRoot === undefined ? {} : { userRoot }),
    commands: mergeCommands(projectCommands, userCommands),
    deny,
    allow,
    issues,
  }
}
