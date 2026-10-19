import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { findProjectRoot, invalidateAssets, readAssets } from '../lib/types/discover.js'
import { resolveConfig } from '../lib/types/config.js'

const base = mkdtempSync(join(tmpdir(), 'dotclaude-'))
const project = join(base, 'repo')
const nested = join(project, 'packages', 'app')
const userHome = join(base, 'home')
const otherHome = join(base, 'other-home')

const settings = {
  projectCommands: true,
  userCommands: true,
  enforceDeny: true,
  inlineFiles: true,
  registerCommands: true,
  promptSection: true,
  statusLine: true,
  maxCommandBytes: 4096,
  maxInlineBytes: 4096,
  extraRoots: [],
}

function write(path, text) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

before(() => {
  mkdirSync(join(project, '.git'), { recursive: true })
  mkdirSync(nested, { recursive: true })
  write(join(project, '.claude', 'commands', 'review.md'), '---\ndescription: Review a change\n---\nCheck $1')
  write(join(project, '.claude', 'commands', 'db', 'migrate.md'), 'Migrate the database')
  write(join(project, '.claude', 'commands', '9bad.md'), 'unregistrable')
  write(join(project, '.claude', 'commands', 'big.md'), 'x'.repeat(5000))
  write(join(project, '.claude', 'commands', '.hidden.md'), 'ignored')
  write(join(project, '.claude', 'settings.json'), JSON.stringify({
    permissions: { deny: ['Bash(git push:*)'], allow: ['Read'] },
  }))
  write(join(project, '.claude', 'settings.local.json'), JSON.stringify({
    permissions: { deny: ['Write'] },
  }))
  write(join(project, '.claude', 'settings.broken.json'), '{')
  write(join(userHome, '.claude', 'commands', 'review.md'), '---\ndescription: User review\n---\nuser body')
  write(join(userHome, '.claude', 'commands', 'deploy.md'), '---\ndescription: Deploy\n---\ndeploy body')
  mkdirSync(otherHome, { recursive: true })
  try {
    symlinkSync(join(project, '.claude', 'commands', 'review.md'), join(project, '.claude', 'commands', 'link.md'))
  } catch {
    // Symlinks are unavailable on some filesystems; the assertion below still holds.
  }
})

after(() => {
  rmSync(base, { recursive: true, force: true })
})

test('findProjectRoot stops at the git root', () => {
  assert.equal(findProjectRoot(nested), project)
})

test('findProjectRoot falls back to the working directory without a git root', () => {
  assert.equal(findProjectRoot(userHome), userHome)
})

test('readAssets flattens namespaces and skips unregistrable, oversized, hidden, and linked files', () => {
  invalidateAssets()
  const assets = readAssets(nested, settings, userHome)
  const names = assets.commands.map(command => command.name)
  assert.deepEqual(names, ['db-migrate', 'deploy', 'review'])
  assert.equal(assets.projectRoot, project)
  assert.ok(assets.issues.some(issue => issue.path?.endsWith('9bad.md')))
  assert.ok(assets.issues.some(issue => issue.path?.endsWith('big.md')))
  assert.ok(assets.issues.some(issue => issue.message.includes('symbolic links')))
})

test('a project command shadows the user command of the same name', () => {
  const assets = readAssets(nested, settings, userHome)
  const review = assets.commands.find(command => command.name === 'review')
  assert.equal(review.origin, 'project')
  assert.equal(review.description, 'Review a change')
})

test('user commands load when the project has none', () => {
  const assets = readAssets(userHome, settings, userHome)
  assert.deepEqual(assets.commands.map(command => command.name), ['deploy', 'review'])
  assert.ok(assets.commands.every(command => command.origin === 'user'))
})

test('deny rules merge settings.json and settings.local.json in file order', () => {
  const assets = readAssets(nested, settings, userHome)
  assert.deepEqual(assets.deny.map(rule => rule.raw), ['Bash(git push:*)', 'Write'])
  assert.deepEqual(assets.allow, ['Read'])
})

test('isolation: a user root without .claude contributes nothing', () => {
  const assets = readAssets(join(otherHome, '..', 'other-home'), settings, otherHome)
  assert.deepEqual(assets.commands, [])
  assert.equal(assets.userRoot, undefined)
})

test('project commands can be disabled while user commands stay on', () => {
  const assets = readAssets(nested, { ...settings, projectCommands: false }, userHome)
  assert.ok(assets.commands.every(command => command.origin === 'user'))
  assert.equal(assets.projectRoot, undefined)
})

test('deny enforcement can be disabled', () => {
  const assets = readAssets(nested, { ...settings, enforceDeny: false }, userHome)
  assert.deepEqual(assets.deny, [])
  assert.deepEqual(assets.allow, [])
})

test('resolveConfig fills every default', () => {
  const resolved = resolveConfig({})
  assert.equal(resolved.projectCommands, true)
  assert.equal(resolved.maxCommandBytes, 64 * 1024)
  assert.deepEqual(resolved.extraRoots, [])
})
