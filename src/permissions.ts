/**
 * `.claude/settings.json` permission rules and their enforcement against host
 * tool calls.
 *
 * Claude Code writes rules as `Tool` or `Tool(specifier)`. Only `deny` is
 * enforced: the host's own approval policy still decides everything else, and
 * an `allow` entry never widens what a user already has to approve.
 *
 * @module dsh-dotclaude/permissions
 */

/** One parsed permission rule. */
export interface PermissionRule {
  /** Host tool name the rule applies to. */
  readonly tool: string
  /** Raw rule text, kept for reports. */
  readonly raw: string
  /** Specifier matcher; absent means "every call of this tool". */
  readonly matches?: (subject: string) => boolean
}

/** Outcome of reading a settings document. */
export interface ParsedSettings {
  readonly deny: readonly PermissionRule[]
  readonly allow: readonly string[]
  readonly ask: readonly string[]
  readonly issues: readonly string[]
}

/**
 * Map a Claude Code tool name to the host tool that implements it.
 * @param name - tool name as written in the settings file.
 * @returns the host tool name, or `undefined` for a tool this host does not have.
 */
export function mapToolName(name: string): string | undefined {
  switch (name.toLowerCase()) {
    case 'bash':
    case 'bashoutput':
    case 'killbash':
      return 'bash'
    case 'read':
      return 'read'
    case 'write':
      return 'write'
    case 'edit':
    case 'multiedit':
    case 'notebookedit':
      return 'edit'
    case 'glob':
      return 'glob'
    case 'grep':
      return 'grep'
    case 'webfetch':
      return 'web_fetch'
    case 'websearch':
      return 'web_search'
    case 'task':
      return 'subagent'
    case 'todowrite':
      return 'todo_write'
    default:
      return undefined
  }
}

/** Escape one literal chunk for use inside a RegExp. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * Compile a glob into a matcher.
 *
 * Both the pattern and the subject lose a leading `./` or `/` before
 * comparison, so `Read(./src/**)` and `Read(/src/**)` match a `file_path` of
 * `src/a.ts`, `./src/a.ts`, or `/src/a.ts`.
 * @param pattern - glob text with `*`, `**`, and `?`.
 * @param options - `path` treats `*` as a single segment; `command` lets `*` cross spaces.
 * @returns a predicate over candidate text.
 */
export function globMatcher(pattern: string, options: { path: boolean }): (subject: string) => boolean {
  const source = compileGlob(pattern.replace(/^\.\//u, '').replace(/^\/+/u, ''), options.path)
  const regexp = new RegExp(`^${source}$`, 'u')
  return subject => regexp.test(subject.replace(/^\.\//u, '').replace(/^\/+/u, '')) || regexp.test(subject)
}

/**
 * Translate glob syntax into a regular-expression source.
 * @param pattern - normalized glob.
 * @param path - whether `*` must stay inside one path segment.
 * @returns the regular-expression source without anchors.
 */
function compileGlob(pattern: string, path: boolean): string {
  const single = path ? '[^/]*' : '.*'
  const one = path ? '[^/]' : '.'
  let source = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]
    if (character === '*' && pattern[index + 1] === '*') {
      source += '.*'
      index += 1
    } else if (character === '*') {
      source += single
    } else if (character === '?') {
      source += one
    } else {
      source += escapeRegExp(character ?? '')
    }
  }
  return source
}

/**
 * Parse one permission rule.
 * @param text - rule text, for example `Bash(git push:*)` or `Read(./src/**)`.
 * @returns the parsed rule, or `undefined` when the text is empty or malformed.
 */
export function parsePermissionRule(text: string): PermissionRule | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  const open = trimmed.indexOf('(')
  const close = trimmed.lastIndexOf(')')
  const toolPart = open < 0 ? trimmed : trimmed.slice(0, open)
  const tool = mapToolName(toolPart.trim())
  if (tool === undefined) return undefined
  if (open < 0 || close < open) return { tool, raw: trimmed }
  const specifier = trimmed.slice(open + 1, close).trim()
  if (specifier === '' || specifier === '*') return { tool, raw: trimmed }
  if (tool === 'bash') {
    // `git push:*` denies a command prefix; `npm test` denies that exact command.
    const prefix = specifier.endsWith(':*') ? specifier.slice(0, -2) : undefined
    if (prefix !== undefined) {
      const matcher = globMatcher(prefix.trim(), { path: false })
      return {
        tool,
        raw: trimmed,
        matches: subject => subject === prefix.trim() || subject.startsWith(`${prefix.trim()} `) || matcher(subject),
      }
    }
    const exact = globMatcher(specifier, { path: false })
    return { tool, raw: trimmed, matches: exact }
  }
  const candidate = specifier.replace(/^\.\//u, '')
  const matcher = globMatcher(candidate, { path: true })
  return { tool, raw: trimmed, matches: matcher }
}

/**
 * Read the permission arrays out of one settings document.
 * @param value - parsed JSON document, or any other value.
 * @param label - document name used in issue text.
 * @returns parsed rules and any file-level problems.
 */
export function parseSettings(value: unknown, label: string): ParsedSettings {
  const issues: string[] = []
  const deny: PermissionRule[] = []
  const allow: string[] = []
  const ask: string[] = []
  if (typeof value !== 'object' || value === null) {
    return { deny, allow, ask, issues: [`${label}: document is not a JSON object`] }
  }
  const permissions = (value as { permissions?: unknown }).permissions
  if (permissions === undefined) return { deny, allow, ask, issues }
  if (typeof permissions !== 'object' || permissions === null || Array.isArray(permissions)) {
    return { deny, allow, ask, issues: [`${label}: permissions is not an object`] }
  }
  for (const key of ['deny', 'allow', 'ask'] as const) {
    const entry = (permissions as Record<string, unknown>)[key]
    if (entry === undefined) continue
    if (!Array.isArray(entry)) {
      issues.push(`${label}: permissions.${key} is not an array`)
      continue
    }
    for (const item of entry) {
      if (typeof item !== 'string') {
        issues.push(`${label}: permissions.${key} contains a non-string entry`)
        continue
      }
      if (key === 'deny') {
        const rule = parsePermissionRule(item)
        if (rule === undefined) issues.push(`${label}: unsupported deny rule "${item}"`)
        else deny.push(rule)
      } else if (key === 'allow') allow.push(item)
      else ask.push(item)
    }
  }
  return { deny, allow, ask, issues }
}

/**
 * Extract the argument a rule's specifier is compared against.
 * @param tool - host tool name.
 * @param args - parsed tool arguments.
 * @returns the subject text, or `undefined` when the tool call carries none.
 */
export function subjectOf(tool: string, args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const record = args as Record<string, unknown>
  const pick = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = record[key]
      if (typeof value === 'string') return value
    }
    return undefined
  }
  switch (tool) {
    case 'bash':
      return pick('command', 'cmd')
    case 'read':
    case 'write':
    case 'edit':
      return pick('file_path', 'path')
    case 'web_fetch':
      return pick('url')
    case 'web_search':
      return pick('query')
    case 'grep':
    case 'glob':
      return pick('pattern', 'path')
    default:
      return undefined
  }
}

/**
 * Decide whether one tool call is denied.
 * @param rules - deny rules in file order.
 * @param tool - host tool name.
 * @param args - parsed tool arguments.
 * @returns the matching rule, or `undefined` when nothing denies the call.
 */
export function matchedDeny(
  rules: readonly PermissionRule[],
  tool: string,
  args: unknown,
): PermissionRule | undefined {
  const subject = subjectOf(tool, args)
  for (const rule of rules) {
    if (rule.tool !== tool) continue
    if (rule.matches === undefined) return rule
    if (subject !== undefined && rule.matches(subject)) return rule
  }
  return undefined
}
