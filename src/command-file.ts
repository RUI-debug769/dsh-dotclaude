/**
 * Command-file parsing and prompt expansion for `.claude/commands/*.md`.
 *
 * A Claude Code command file is YAML front matter followed by a prompt body.
 * This module reads the subset the plugin can honour without a YAML
 * dependency, and expands the substitution forms the body may use.
 *
 * @module dsh-dotclaude/command-file
 */

/** One parsed command file. */
export interface ClaudeCommand {
  /** Flattened command name, matching the host slash-command grammar. */
  readonly name: string
  /** One-line summary shown in discovery output. */
  readonly description: string
  /** Optional input hint from `argument-hint`. */
  readonly argumentHint?: string
  /** Raw body, before substitution. */
  readonly body: string
  /** Absolute path the body came from. */
  readonly sourcePath: string
  /** Whether the file came from the project tree or the user-level tree. */
  readonly origin: 'project' | 'user'
}

/** Command names accepted by the host registry. */
const COMMAND_NAME = /^[a-z][a-z0-9_-]*$/u

/** Front-matter delimiter. */
const FENCE = '---'

/**
 * Split YAML front matter from a Markdown body.
 *
 * Only single-line scalars are recognised. A file without front matter, or
 * with an unterminated block, is treated as body-only rather than rejected,
 * because a command that still prompts is more useful than a parse error.
 * @param text - complete file contents.
 * @returns front-matter scalars and the remaining body.
 */
export function parseFrontMatter(text: string): { data: Record<string, string>; body: string } {
  const normalized = text.replace(/^\uFEFF/u, '')
  const lines = normalized.split('\n')
  if (lines[0]?.trim() !== FENCE) return { data: {}, body: normalized }
  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === FENCE)
  if (closing < 0) return { data: {}, body: normalized }
  const data: Record<string, string> = {}
  for (const line of lines.slice(1, closing)) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/u.exec(line)
    if (match === null) continue
    const key = match[1]
    const raw = match[2] ?? ''
    const value = stripQuotes(raw.trim())
    if (key !== undefined && value !== '') data[key] = value
  }
  return { data, body: lines.slice(closing + 1).join('\n') }
}

/**
 * Remove one layer of matching quotes from a scalar.
 * @param value - trimmed scalar text.
 * @returns the unquoted value.
 */
function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return value.slice(1, -1)
  }
  return value
}

/**
 * Turn a path relative to a commands directory into a command name.
 *
 * Claude Code namespaces commands by subdirectory with `:`, which the host
 * grammar rejects, so each separator becomes `-`: `db/migrate.md` reads as
 * `db-migrate`.
 * @param relativePath - path below the commands directory, with `/` separators.
 * @returns the flattened name, or `undefined` when it cannot match the host grammar.
 */
export function commandNameFromPath(relativePath: string): string | undefined {
  const withoutExtension = relativePath.replace(/\.md$/iu, '')
  const flattened = withoutExtension
    .split('/')
    .filter(segment => segment !== '' && segment !== '.' && segment !== '..')
    .map(segment => segment.toLowerCase())
    .join('-')
  return COMMAND_NAME.test(flattened) ? flattened : undefined
}

/**
 * Derive a description when the file declares none.
 * @param body - prompt body.
 * @returns the first non-empty, non-heading line, truncated for a one-line catalog.
 */
export function derivedDescription(body: string): string {
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    return trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed
  }
  return 'No description'
}

/**
 * Read one command file into a parsed command.
 * @param input - absolute path, relative path below the commands directory, raw text, and origin.
 * @returns the parsed command, or `undefined` when the name cannot be registered.
 */
export function parseCommandFile(input: {
  readonly sourcePath: string
  readonly relativePath: string
  readonly text: string
  readonly origin: 'project' | 'user'
}): ClaudeCommand | undefined {
  const name = commandNameFromPath(input.relativePath)
  if (name === undefined) return undefined
  const { data, body } = parseFrontMatter(input.text)
  const description = data['description'] ?? derivedDescription(body)
  const argumentHint = data['argument-hint']
  return {
    name,
    description,
    ...(argumentHint === undefined ? {} : { argumentHint }),
    body: body.trim(),
    sourcePath: input.sourcePath,
    origin: input.origin,
  }
}

/**
 * Split a raw input string into positional arguments, honouring single and
 * double quotes the way a shell would.
 * @param raw - text following the command name.
 * @returns the argument list.
 */
export function splitArguments(raw: string): string[] {
  const args: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined
  let started = false
  for (const character of raw) {
    if (quote !== undefined) {
      if (character === quote) quote = undefined
      else current += character
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      started = true
      continue
    }
    if (/\s/u.test(character)) {
      if (started || current !== '') {
        args.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += character
    started = true
  }
  if (started || current !== '') args.push(current)
  return args
}

/** A file the body asked to inline. */
export interface InlineFile {
  /** Project-relative path exactly as written in the body. */
  readonly path: string
  /** File contents, or `undefined` when the file could not be read. */
  readonly text?: string
  /** Why the file was not inlined. */
  readonly error?: string
}

/** Resolved substitution inputs. */
export interface ExpansionContext {
  /** Raw input following the command name. */
  readonly rawInput: string
  /** Positional arguments split from `rawInput`. */
  readonly arguments: readonly string[]
  /** Reads one project-relative reference; returns `undefined` when unavailable. */
  readonly readFile?: (path: string) => string | undefined
}

/**
 * Expand `$ARGUMENTS`, `$1`–`$9`, and `@path` references in a command body.
 *
 * `$ARGUMENTS` and positional arguments are always expanded. `@path`
 * references are only inlined when a reader is supplied, so a command that
 * mentions an address is never silently rewritten with file contents.
 * @param body - raw command body.
 * @param context - invocation input and optional file reader.
 * @returns the expanded prompt and every inlined file outcome.
 */
export function expandCommand(body: string, context: ExpansionContext): { text: string; files: InlineFile[] } {
  const files: InlineFile[] = []
  let text = body.split('$ARGUMENTS').join(context.rawInput)
  text = text.replace(/\$([1-9])/gu, (match, index: string) => context.arguments[Number(index) - 1] ?? '')
  if (context.readFile === undefined) return { text, files }
  const readFile = context.readFile
  text = text.replace(/(^|[\s(])@([A-Za-z0-9._/-]+)/gu, (match, prefix: string, path: string) => {
    const content = readFile(path)
    if (content === undefined) {
      files.push({ path, error: 'not found or unreadable' })
      return match
    }
    files.push({ path, text: content })
    return `${prefix}<file path="${path}">\n${content}\n</file>`
  })
  return { text, files }
}
