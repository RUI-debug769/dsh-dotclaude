import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  globMatcher,
  mapToolName,
  matchedDeny,
  parsePermissionRule,
  parseSettings,
  subjectOf,
} from '../lib/types/permissions.js'

test('mapToolName translates the Claude Code tool set', () => {
  assert.equal(mapToolName('Bash'), 'bash')
  assert.equal(mapToolName('Read'), 'read')
  assert.equal(mapToolName('MultiEdit'), 'edit')
  assert.equal(mapToolName('WebFetch'), 'web_fetch')
  assert.equal(mapToolName('Task'), 'subagent')
  assert.equal(mapToolName('nope'), undefined)
})

test('a bare tool name denies every call of that tool', () => {
  const rule = parsePermissionRule('Write')
  assert.equal(rule.tool, 'write')
  assert.equal(rule.matches, undefined)
})

test('a bash prefix rule matches the command and its arguments', () => {
  const rule = parsePermissionRule('Bash(git push:*)')
  assert.equal(rule.matches('git push'), true)
  assert.equal(rule.matches('git push --force origin main'), true)
  assert.equal(rule.matches('git pull'), false)
})

test('a bash exact rule matches only that command', () => {
  const rule = parsePermissionRule('Bash(rm -rf /)')
  assert.equal(rule.matches('rm -rf /'), true)
  assert.equal(rule.matches('rm -rf /tmp'), false)
})

test('a path rule matches inside the project and not outside it', () => {
  const rule = parsePermissionRule('Read(./src/**)')
  assert.equal(rule.matches('src/a.ts'), true)
  assert.equal(rule.matches('./src/deep/a.ts'), true)
  assert.equal(rule.matches('docs/a.ts'), false)
})

test('a single-star path rule stays within one segment', () => {
  const matcher = globMatcher('src/*.ts', { path: true })
  assert.equal(matcher('src/a.ts'), true)
  assert.equal(matcher('src/deep/a.ts'), false)
})

test('an unknown tool name is not a rule', () => {
  assert.equal(parsePermissionRule('Teleport(x)'), undefined)
  assert.equal(parsePermissionRule('   '), undefined)
})

test('parseSettings separates deny, allow, and ask, and reports malformed entries', () => {
  const parsed = parseSettings({
    permissions: {
      deny: ['Bash(git push:*)', 42],
      allow: ['Read'],
      ask: ['Edit'],
    },
  }, 'settings.json')
  assert.equal(parsed.deny.length, 1)
  assert.deepEqual(parsed.allow, ['Read'])
  assert.deepEqual(parsed.ask, ['Edit'])
  assert.equal(parsed.issues.length, 1)
  assert.match(parsed.issues[0], /non-string/u)
})

test('parseSettings reports a non-object document and a non-object permissions field', () => {
  assert.match(parseSettings(null, 's').issues[0], /not a JSON object/u)
  assert.match(parseSettings({ permissions: [] }, 's').issues[0], /not an object/u)
})

test('parseSettings reports unsupported deny rules instead of dropping them silently', () => {
  const parsed = parseSettings({ permissions: { deny: ['Teleport(x)'] } }, 'settings.json')
  assert.equal(parsed.deny.length, 0)
  assert.match(parsed.issues[0], /unsupported deny rule/u)
})

test('subjectOf reads the argument each tool compares against', () => {
  assert.equal(subjectOf('bash', { command: 'ls' }), 'ls')
  assert.equal(subjectOf('read', { file_path: '/a.ts' }), '/a.ts')
  assert.equal(subjectOf('read', { path: '/a.ts' }), '/a.ts')
  assert.equal(subjectOf('web_fetch', { url: 'https://x' }), 'https://x')
  assert.equal(subjectOf('bash', {}), undefined)
  assert.equal(subjectOf('bash', null), undefined)
})

test('matchedDeny requires both the tool and the specifier to match', () => {
  const rules = [parsePermissionRule('Bash(git push:*)'), parsePermissionRule('Write')]
  assert.equal(matchedDeny(rules, 'bash', { command: 'git push' })?.raw, 'Bash(git push:*)')
  assert.equal(matchedDeny(rules, 'bash', { command: 'ls' }), undefined)
  assert.equal(matchedDeny(rules, 'write', { file_path: '/x' })?.raw, 'Write')
  assert.equal(matchedDeny(rules, 'read', { file_path: '/x' }), undefined)
})

test('a specifier rule without a usable subject does not deny', () => {
  const rules = [parsePermissionRule('Bash(git push:*)')]
  assert.equal(matchedDeny(rules, 'bash', {}), undefined)
})
