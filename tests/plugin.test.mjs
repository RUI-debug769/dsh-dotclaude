import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

// `os.homedir()` reads $HOME on POSIX, so isolating it here keeps the plugin's
// user-level lookup inside the fixture and off the developer's own `~/.claude`.
const sandbox = mkdtempSync(join(tmpdir(), 'dotclaude-plugin-'))
process.env.HOME = join(sandbox, 'home')

const { apply, name } = await import('../lib/types/index.js')
const { createAgent, createCommandRegistry, createHost, createWorkingDirectory } = await import('./fake-host.mjs')

const repo = join(sandbox, 'repo')
const home = join(sandbox, 'home')

function write(path, text) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

before(() => {
  mkdirSync(join(repo, '.git'), { recursive: true })
  write(join(repo, '.claude', 'commands', 'review.md'), '---\ndescription: Review a change\nargument-hint: <path>\n---\nCheck $1')
  write(join(repo, '.claude', 'commands', 'db', 'migrate.md'), '---\ndescription: Migrate\n---\nMigrate now')
  write(join(home, '.claude', 'commands', 'deploy.md'), '---\ndescription: Deploy\n---\nDeploy $ARGUMENTS')
  write(join(repo, '.claude', 'settings.json'), JSON.stringify({
    permissions: { deny: ['Bash(git push:*)', 'Write'] },
  }))
})

after(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

function hostWith({ taken = [], cwd = repo, statusCalls = [], sections = [] } = {}) {
  const registry = createCommandRegistry({ taken })
  const agent = createAgent({ cwd, services: { commands: registry, systemPrompt: { section: s => sections.push(s) } } })
  const tuiStatus = { set: (key, text) => { statusCalls.push([key, text]) } }
  const host = createHost({
    services: {
      commands: registry,
      workingDirectory: createWorkingDirectory({ [agent.session.id]: cwd }),
      tuiStatus,
      systemPrompt: { section: s => sections.push(s) },
    },
  })
  apply(host.ctx, {})
  return { host, registry, agent, statusCalls, sections }
}

test('the plugin exports the Cordis contract and registers nothing without a host command registry', () => {
  assert.equal(name, 'dotclaude')
  const host = createHost({})
  assert.doesNotThrow(() => apply(host.ctx, {}))
  assert.equal(host.listeners.get('tools/pre-execute')?.length, 1)
})

test('agent creation registers project commands and skips names the host already exposes', async () => {
  const { host, registry, agent } = hostWith({ taken: ['review'] })
  await host.emit('agent/created', { agent })
  const scoped = registry.registered.map(definition => definition.name).filter(value => value !== 'claude')
  assert.deepEqual(scoped, ['db-migrate', 'deploy'])
})

test('a registered project command expands into the next turn', async () => {
  const { host, registry, agent } = hostWith()
  await host.emit('agent/created', { agent })
  const review = registry.registered.find(definition => definition.name === 'review')
  const result = review.handler({ agent, rawInput: 'src/a.ts', signal: new AbortController().signal })
  assert.equal(result.kind, 'success')
  assert.equal(agent.messages.length, 1)
  assert.equal(agent.messages[0].role, 'user')
  assert.equal(agent.messages[0].content[0].text, 'Check src/a.ts')
})

test('the resolution finds user-level commands when the project has none of that name', async () => {
  const { registry } = hostWith()
  const claude = registry.registered.find(definition => definition.name === 'claude')
  const { host, agent } = hostWith()
  await host.emit('agent/created', { agent })
  const result = claude.handler({ agent, rawInput: 'list', signal: new AbortController().signal })
  assert.match(result.text, /deploy/u)
})

test('/claude run expands $ARGUMENTS and inlines nothing it cannot read', async () => {
  const { host, registry, agent } = hostWith()
  await host.emit('agent/created', { agent })
  const claude = registry.registered.find(definition => definition.name === 'claude')
  const result = claude.handler({ agent, rawInput: 'run deploy production', signal: new AbortController().signal })
  assert.equal(result.kind, 'success')
  assert.equal(agent.messages.at(-1).content[0].text, 'Deploy production')
})

test('/claude run preserves quoted arguments in the expanded prompt', () => {
  const { registry, agent } = hostWith()
  const claude = registry.registered.find(definition => definition.name === 'claude')
  claude.handler({ agent, rawInput: 'run deploy "a b" c', signal: new AbortController().signal })
  assert.equal(agent.messages.at(-1).content[0].text, 'Deploy "a b" c')
})

test('/claude run reports an unknown command with the known names', () => {
  const { registry, agent } = hostWith()
  const claude = registry.registered.find(definition => definition.name === 'claude')
  const result = claude.handler({ agent, rawInput: 'run nope', signal: new AbortController().signal })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /review/u)
})

test('/claude doctor lists provenance, deny rules, and allow-rule policy', () => {
  const { registry, agent } = hostWith()
  const claude = registry.registered.find(definition => definition.name === 'claude')
  const result = claude.handler({ agent, rawInput: 'doctor', signal: new AbortController().signal })
  assert.match(result.text, /dsh-dotclaude report/u)
  assert.match(result.text, /Bash\(git push:\*\)/u)
  assert.match(result.text, /reported, not enforced/u)
})

test('/claude reload clears the cache and reports the new count', () => {
  const { registry, agent } = hostWith()
  const claude = registry.registered.find(definition => definition.name === 'claude')
  const result = claude.handler({ agent, rawInput: 'reload', signal: new AbortController().signal })
  assert.match(result.text, /Reloaded: 3 command/u)
})

test('an unknown subcommand is an error, not a throw', () => {
  const { registry, agent } = hostWith()
  const claude = registry.registered.find(definition => definition.name === 'claude')
  const result = claude.handler({ agent, rawInput: 'wat', signal: new AbortController().signal })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /Unknown subcommand/u)
})

test('the permission waterfall denies a matching call and delegates everything else', async () => {
  const { host, agent } = hostWith()
  let delegated = 0
  const next = async () => {
    delegated += 1
    return { kind: 'allow' }
  }
  const denied = await host.emit('tools/pre-execute', {
    name: 'bash',
    arguments: { command: 'git push origin' },
    agent,
  }, next)
  assert.equal(denied.kind, 'deny')
  assert.match(denied.reason, /Bash\(git push:\*\)/u)
  assert.equal(delegated, 0)

  const allowed = await host.emit('tools/pre-execute', { name: 'bash', arguments: { command: 'ls' }, agent }, next)
  assert.deepEqual(allowed, { kind: 'allow' })
  assert.equal(delegated, 1)
})

test('the permission waterfall leaves a call alone when the host does not expose a working directory', async () => {
  const registry = createCommandRegistry()
  const host = createHost({ services: { commands: registry } })
  apply(host.ctx, {})
  const agent = createAgent({ cwd: repo })
  let delegated = 0
  const decision = await host.emit('tools/pre-execute', {
    name: 'bash',
    arguments: { command: 'git push origin' },
    agent,
  }, async () => {
    delegated += 1
    return { kind: 'allow' }
  })
  assert.deepEqual(decision, { kind: 'allow' })
  assert.equal(delegated, 1)
})

test('the status line publishes the aggregate count and clears on disposal', async () => {
  const statusCalls = []
  const { host, agent } = hostWith({ statusCalls })
  await host.emit('agent/created', { agent })
  assert.deepEqual(statusCalls.at(-1), ['dotclaude', 'claude 3 cmd'])
  host.dispose()
  assert.deepEqual(statusCalls.at(-1), ['dotclaude', undefined])
})

test('agent disposal removes the agent from the aggregate count', async () => {
  const statusCalls = []
  const { host, agent } = hostWith({ statusCalls })
  await host.emit('agent/created', { agent })
  await host.emit('agent/disposed', { agent })
  assert.deepEqual(statusCalls.at(-1), ['dotclaude', undefined])
})

test('the prompt section names every resolved command', async () => {
  const sections = []
  const { host, agent } = hostWith({ sections })
  await host.emit('agent/created', { agent })
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'dotclaude:commands')
  assert.match(sections[0].text, /db-migrate: Migrate/u)
  assert.match(sections[0].text, /review: Review a change/u)
})

test('registerCommands can be turned off while the dispatcher keeps working', async () => {
  const registry = createCommandRegistry()
  const agent = createAgent({ cwd: repo, services: { commands: registry } })
  const host = createHost({
    services: {
      commands: registry,
      workingDirectory: createWorkingDirectory({ [agent.session.id]: repo }),
    },
  })
  apply(host.ctx, { registerCommands: false })
  const before = registry.registered.length
  await host.emit('agent/created', { agent })
  assert.equal(registry.registered.length, before)
})

test('/claude reports a missing working directory instead of throwing', () => {
  const registry = createCommandRegistry()
  const host = createHost({ services: { commands: registry } })
  apply(host.ctx, {})
  const agent = createAgent({ cwd: repo })
  const claude = registry.registered.find(definition => definition.name === 'claude')
  const result = claude.handler({ agent, rawInput: 'list', signal: new AbortController().signal })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /working directory/u)
})
