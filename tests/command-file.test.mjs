import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  commandNameFromPath,
  derivedDescription,
  expandCommand,
  parseCommandFile,
  parseFrontMatter,
  splitArguments,
} from '../lib/types/command-file.js'

test('parseFrontMatter reads single-line scalars and keeps the body', () => {
  const parsed = parseFrontMatter('---\ndescription: Review a change\nargument-hint: <path>\n---\nBody line\n')
  assert.deepEqual(parsed.data, { description: 'Review a change', 'argument-hint': '<path>' })
  assert.equal(parsed.body, 'Body line\n')
})

test('parseFrontMatter strips one layer of quotes', () => {
  assert.deepEqual(parseFrontMatter('---\ndescription: "quoted: value"\n---\nbody').data, {
    description: 'quoted: value',
  })
})

test('parseFrontMatter treats a file without a closing fence as body-only', () => {
  const text = '---\ndescription: broken\nbody'
  assert.deepEqual(parseFrontMatter(text), { data: {}, body: text })
})

test('parseFrontMatter ignores lines that are not key scalars', () => {
  assert.deepEqual(parseFrontMatter('---\n- a list\nkey: v\n---\nx').data, { key: 'v' })
})

test('commandNameFromPath flattens namespaces and lowercases', () => {
  assert.equal(commandNameFromPath('review.md'), 'review')
  assert.equal(commandNameFromPath('db/migrate.md'), 'db-migrate')
  assert.equal(commandNameFromPath('DB/Migrate.md'), 'db-migrate')
})

test('commandNameFromPath rejects names the host grammar forbids', () => {
  assert.equal(commandNameFromPath('9lives.md'), undefined)
  assert.equal(commandNameFromPath('has space.md'), undefined)
  assert.equal(commandNameFromPath('a/b/c/deep.md'), 'a-b-c-deep')
})

test('derivedDescription skips blank lines and headings', () => {
  assert.equal(derivedDescription('\n# Title\n\nDo the thing\nmore'), 'Do the thing')
  assert.equal(derivedDescription(''), 'No description')
  assert.equal(derivedDescription('x'.repeat(200)).length, 120)
})

test('splitArguments honours quotes', () => {
  assert.deepEqual(splitArguments('one two'), ['one', 'two'])
  assert.deepEqual(splitArguments('"one two" three'), ['one two', 'three'])
  assert.deepEqual(splitArguments("'a b' c"), ['a b', 'c'])
  assert.deepEqual(splitArguments('   '), [])
})

test('expandCommand substitutes $ARGUMENTS and positional arguments', () => {
  const expanded = expandCommand('run $1 on $2\nall: $ARGUMENTS', {
    rawInput: 'a b c',
    arguments: ['a', 'b', 'c'],
  })
  assert.equal(expanded.text, 'run a on b\nall: a b c')
  assert.deepEqual(expanded.files, [])
})

test('expandCommand leaves out-of-range positional references empty', () => {
  const expanded = expandCommand('$9', { rawInput: '', arguments: [] })
  assert.equal(expanded.text, '')
})

test('expandCommand inlines @references through the supplied reader', () => {
  const expanded = expandCommand('see @src/a.ts and @missing.ts', {
    rawInput: '',
    arguments: [],
    readFile: path => (path === 'src/a.ts' ? 'export {}' : undefined),
  })
  assert.match(expanded.text, /see <file path="src\/a\.ts">\nexport \{\}\n<\/file>/)
  assert.match(expanded.text, /@missing\.ts/)
  assert.deepEqual(expanded.files.map(file => file.path), ['src/a.ts', 'missing.ts'])
  assert.equal(expanded.files[1].error, 'not found or unreadable')
})

test('expandCommand does not inline @references without a reader', () => {
  const expanded = expandCommand('mail me@example.com', { rawInput: '', arguments: [] })
  assert.equal(expanded.text, 'mail me@example.com')
  assert.deepEqual(expanded.files, [])
})

test('parseCommandFile keeps origin and source path', () => {
  const command = parseCommandFile({
    sourcePath: '/p/.claude/commands/review.md',
    relativePath: 'review.md',
    text: '---\ndescription: Review\n---\nCheck $1',
    origin: 'project',
  })
  assert.equal(command.name, 'review')
  assert.equal(command.description, 'Review')
  assert.equal(command.origin, 'project')
  assert.equal(command.sourcePath, '/p/.claude/commands/review.md')
})
