[English](README.md) | 简体中文

# dsh-dotclaude

在 **DeepSeek Harness 里直接跑 Claude Code 项目的 `.claude/`**：项目斜杠命令会展开成提示词，`permissions.deny` 会在工具调用前真正生效。不 patch 宿主；宿主或项目没有对应文件时，插件什么也不做。

DSH 已经原生读取 `CLAUDE.md`，Claude Code 的 hooks 与插件 mods 也有官方桥接。这个插件补的是仍然空着的那一半：**`.claude/` 里的命令与权限**。

## 做什么

| `.claude/` 来源 | 在 DSH 里的效果 |
|---|---|
| `.claude/commands/**/*.md`（项目） | `/claude run <名称> [参数]`；新会话上还会注册成独立的 `/名称` |
| `~/.claude/commands/**/*.md`（用户级） | 同上；同名时项目命令覆盖用户命令 |
| `.claude/settings.json` 的 `permissions.deny` | 命中的工具调用在执行前被拒绝 |
| `.claude/settings.local.json` 的 `permissions.deny` | 同上，在项目文件之后合并 |
| `permissions.allow` / `ask` | **只报告，不执行**——绝不用来放宽用户本应确认的操作 |

命令正文支持三种替换：

- `$ARGUMENTS` —— 命令名之后的原始文本
- `$1` … `$9` —— 位置参数，按引号规则切分
- `@路径` —— 内联文件内容（有大小上限；读不到时保留原文并在报告里列出）

读取的 front matter：`description`、`argument-hint`。`allowed-tools` 与 `model` 忽略，并会在报告里标明不支持。

## 安装

```sh
dsh plugin --profile web add dsh-dotclaude
```

重启宿主。插件只挂一行：`dotclaude`。

从本地目录安装：

```sh
dsh plugin --profile web add link:/path/to/dsh-dotclaude
```

## 使用

```
/claude                # 列出解析到的命令及其来源
/claude list           # 同上
/claude run <名称> [参数]
/claude doctor         # 来源、deny 规则、读取过程中发现的全部问题
/claude reload         # 清缓存并重新解析
```

如果宿主的命令注册表支持按 agent 作用域注册，每个解析到的命令还会注册成独立斜杠命令（`/review`、`/db-migrate`），并跳过宿主已占用的名字。`/claude run <名称>` 在任何宿主上都可用。

宿主提供 system prompt 段注册表时，会加一个稳定的段落列出可用命令；宿主提供 dsh-tui 状态行接缝时，会显示 `claude N cmd`。

## 配置

每个键都有默认值，`config: {}` 就是完整配置。

| 键 | 默认 | 含义 |
|---|---|---|
| `projectCommands` | `true` | 从会话工作目录的项目根读取 `.claude/commands` |
| `userCommands` | `true` | 读取 `~/.claude/commands` |
| `enforceDeny` | `true` | 执行 `permissions.deny` |
| `inlineFiles` | `true` | 内联 `@路径` |
| `registerCommands` | `true` | 新会话上把每个命令注册成独立斜杠命令 |
| `promptSection` | `true` | 加一段列出命令的 system prompt |
| `statusLine` | `true` | 有 dsh-tui 状态行接缝时显示数量 |
| `maxCommandBytes` | `65536` | 超过则跳过该命令文件 |
| `maxInlineBytes` | `65536` | 超过则跳过该内联文件 |
| `extraRoots` | `[]` | 预留，暂不扫描额外根目录 |

通过 profile 的补丁层覆盖：

```yaml
- id: dotclaude
  config:
    promptSection: false
```

`promptSection` 与 `statusLine` 是仅有的两个有可见代价的开关：前者会给该 agent 的每次请求加 token，后者占用一个 dsh-tui 状态位。

## 项目根

项目根是最近的含 `.git` 的祖先目录；没有则就是工作目录本身。带 `.claude` 的家目录会被当作**用户级**根，不会重复扫描。

## 权限

规则沿用 Claude Code 语法 `Tool` 或 `Tool(specifier)`，工具名也沿用 Claude Code 的，再映射到宿主工具（`Bash`→`bash`、`Read`→`read`、`MultiEdit`→`edit`、`WebFetch`→`web_fetch`、`Task`→`subagent` 等）。

- `Bash(git push:*)` 拒绝该命令及其任意后续参数。
- `Read(./src/**)` 拒绝 `src/` 下的路径，`**` 跨层、`*` 不跨层。
- 未知工具名或无法解析的条目会由 `/claude doctor` 报出，且不拒绝任何调用。

只执行 `deny`。`allow` 永远不会绕过宿主的审批策略——从一个模型可能写入的文件里放宽权限，不是这个插件愿意做的交换。

## 明确不做

- `.claude/agents/*.md`、`.claude/skills/`、`.mcp.json` —— 不读。
- 命令正文里的 `!` bash 执行。
- Claude Code hooks 与插件 mods —— 用官方的 `@deepseek-ai/dsh-hooks-claude-code` 与 `@deepseek-ai/dsh-experimental-claude-code-mods`。
- `permissions.allow` / `ask` 的执行。
- 写回或改写任何 `.claude/` 文件。

## 兼容性

插件只依赖 Cordis 4，所有宿主服务都用 `ctx.get(name, false)` 探测。缺一个服务就少一个功能，绝不让宿主启动失败。

| 宿主 | 结果 |
|---|---|
| DSH 0.2.1-rc.2 + Web profile | 正常启动；项目命令、deny 规则、prompt 段生效；无状态行 |
| 同时装 dsh-tui 0.16.1 | 正常组合与启动；状态行接缝可用 |
| dsh-tui 0.14.0 | 宿主自己拒绝它（`incompatible with dsh`），与本插件无关 |

以上边界由 `scripts/host-smoke.sh` 在 `DOTCLAUDE_MATRIX=1` 下实测。

## 测试

四道门，本地都能跑：

```sh
npm run typecheck                            # 1. 类型
npm run build && npm test                    # 2. 单测 + 宿主替身集成（52 个）
DOTCLAUDE_MATRIX=1 ./scripts/host-smoke.sh   # 3. 真实宿主组合+启动；4. dsh-tui 版本矩阵
```

宿主冒烟需要一个 deepseek-harness 检出（`HARNESS=/path/to/checkout`），并且只往一次性的 `DSH_HOME` 里装，不碰你真实的 profile。

## 安全

- 插件只读 `.claude/`，从不写回。
- 内联的 `@路径` 内容会进入模型上下文——会内联密钥的命令文件等于把密钥发出去。只运行你信任的命令文件，这一点与 Claude Code 一致。
- settings 文件损坏或无法读取时，deny 规则**失败开放**（fail open），并由 `/claude doctor` 明确报出，而不是静默。如果你需要 fail-closed，请不要只依赖这个插件。

## 许可

MIT。
