English | [简体中文](README.zh.md)

# dsh-dotclaude

Run a **Claude Code project's `.claude/` assets inside DeepSeek Harness** — project slash commands that expand their prompt, and `permissions.deny` rules enforced against the host's tools. No host patches. Nothing is loaded when the host or the project does not have the pieces.

DeepSeek Harness already reads `CLAUDE.md`, and official bridges already cover Claude Code hooks and plugin mods. This plugin fills the part that is still missing: the **command and permission half** of a `.claude/` directory.

## What it does

| `.claude/` source | Effect in DSH |
|---|---|
| `.claude/commands/**/*.md` (project) | `/claude run <name> [args]`, plus a `/name` slash command on new agents |
| `~/.claude/commands/**/*.md` (user) | Same, with the project command shadowing a user command of the same name |
| `.claude/settings.json` → `permissions.deny` | Denies the matching host tool call before it runs |
| `.claude/settings.local.json` → `permissions.deny` | Same, merged after the project file |
| `permissions.allow` / `ask` | **Reported only** — never used to widen what the user must approve |

Command bodies support the substitution forms that matter without a shell:

- `$ARGUMENTS` — the raw text after the command name
- `$1` … `$9` — positional arguments, splitting honouring quotes
- `@path` — inlined file contents (size-capped; a missing file is left as literal text and reported)

Front matter read: `description`, `argument-hint`. `allowed-tools` and `model` are ignored and reported as unsupported.

## Install

```sh
dsh plugin --profile web add dsh-dotclaude
```

Restart the host. The bundle mounts one row, `dotclaude`.

From a checkout:

```sh
dsh plugin --profile web add link:/path/to/dsh-dotclaude
```

## Use

```
/claude                # list the resolved commands and where they came from
/claude list           # same
/claude run <name> [args]
/claude doctor         # provenance, deny rules, and every issue found while reading
/claude reload         # drop the read cache and re-resolve
```

On hosts whose command registry supports agent-scoped registration, each resolved command is also registered as its own slash command on every new agent — `/review`, `/db-migrate` — skipping any name the host already exposes. `/claude run <name>` works everywhere, including hosts that register no scoped commands.

When a host exposes a system-prompt section registry, one stable section names the available commands. When a host exposes the dsh-tui status seam, the aggregate command count appears as `claude N cmd`.

## Configure

Every key has a default, so `config: {}` is a complete configuration.

| Key | Default | Meaning |
|---|---|---|
| `projectCommands` | `true` | Read `.claude/commands` from the Session working directory's project root |
| `userCommands` | `true` | Read `~/.claude/commands` |
| `enforceDeny` | `true` | Enforce `permissions.deny` |
| `inlineFiles` | `true` | Inline `@path` references |
| `registerCommands` | `true` | Register each command as its own slash command on new agents |
| `promptSection` | `true` | Add the system-prompt section listing commands |
| `statusLine` | `true` | Publish the count on the dsh-tui status line when that seam exists |
| `maxCommandBytes` | `65536` | Skip larger command files |
| `maxInlineBytes` | `65536` | Skip larger inlined files |
| `extraRoots` | `[]` | Reserved; no extra scan roots yet |

Override through the profile patch layer:

```yaml
- id: dotclaude
  config:
    promptSection: false
```

`promptSection` and `statusLine` are the two keys with a visible cost: the section adds tokens to every request in that agent, and the status line occupies one dsh-tui status slot.

## Project root

The project root is the nearest ancestor containing `.git`; without one it is the working directory itself. A home directory that carries `.claude` is treated as the **user-level** root, never as a project, so `~/.claude` is not scanned twice.

## Permissions

Rules use Claude Code's grammar — `Tool` or `Tool(specifier)` — and the Claude Code tool names, mapped to the host's tools (`Bash`→`bash`, `Read`→`read`, `MultiEdit`→`edit`, `WebFetch`→`web_fetch`, `Task`→`subagent`, and so on).

- `Bash(git push:*)` denies that command and any argument list under it.
- `Read(./src/**)` denies paths under `src/`, with `**` crossing segments and `*` staying inside one.
- An unknown tool name or an unparsable entry is reported by `/claude doctor` and does not deny anything.

Only `deny` is enforced. An `allow` entry never bypasses the host's approval policy, because widening permission from a file the model could write is not a trade this plugin makes.

## What is deliberately out of scope

- `.claude/agents/*.md`, `.claude/skills/`, `.mcp.json` — not read.
- `!` bash execution inside a command body.
- Claude Code hooks and plugin mods — use the official `@deepseek-ai/dsh-hooks-claude-code` and `@deepseek-ai/dsh-experimental-claude-code-mods` bridges.
- `permissions.allow` / `ask` enforcement.
- Rewriting or writing any `.claude/` file.

## Compatibility

The plugin depends only on Cordis 4 and probes every host service with `ctx.get(name, false)`. A missing service degrades one feature; it never fails the host.

| Host | Result |
|---|---|
| DSH 0.2.1-rc.2, Web profile | Boots; project commands, deny rules, prompt section active; no status line |
| dsh-tui 0.16.1 beside it | Composes and boots; status-line seam available |
| dsh-tui 0.14.0 | The host itself refuses it on 0.2.1-rc.2 (`incompatible with dsh`); nothing this plugin can change |

The version boundary above is checked by `scripts/host-smoke.sh` under `DOTCLAUDE_MATRIX=1`.

## Test

Four gates, all runnable locally:

```sh
npm run typecheck                      # 1. types
npm run build && npm test              # 2. unit + host-double integration (52 tests)
DOTCLAUDE_MATRIX=1 ./scripts/host-smoke.sh   # 3. real host compose+boot; 4. dsh-tui matrix
```

The host smoke test needs a DeepSeek Harness checkout (`HARNESS=/path/to/checkout`) and installs into a throwaway `DSH_HOME`; it never touches your real profile.

## Security

- The plugin reads `.claude/` and never writes to it.
- Inlined `@path` files reach the model, so a command file that inlines a secret sends it. Only run command files you trust, as with Claude Code.
- Deny rules fail **open** on an unreadable or malformed settings file, and the failure is reported by `/claude doctor` instead of being silent. If you need fail-closed behaviour, do not depend on this plugin as your only boundary.

## License

MIT.
