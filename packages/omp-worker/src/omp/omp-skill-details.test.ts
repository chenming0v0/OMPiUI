import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { readDiscoveredSkill } from './omp-skill-details.js'

const integration = process.env.OMPI_OMP_SETTINGS_INTEGRATION === '1'

test('skill details reject paths that are not in the session discovery list', async () => {
  await assert.rejects(readDiscoveredSkill('.', [], 'other', '/private/SKILL.md'), { code: 'SKILL_NOT_FOUND' })
  const skills = [{ name: 'registered', filePath: '/skills/registered/SKILL.md' }]
  await assert.rejects(readDiscoveredSkill('.', skills, 'other', skills[0].filePath), { code: 'SKILL_NOT_FOUND' })
  await assert.rejects(readDiscoveredSkill('.', skills, 'registered', '/skills/registered/secret.txt'), { code: 'SKILL_NOT_FOUND' })
})

test('skill details reject missing files and containment escapes', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'ompiui-skill-access-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const filePath = path.join(root, 'SKILL.md')
  const skills = [{ name: 'fixture', filePath }]
  await assert.rejects(readDiscoveredSkill(root, skills, 'fixture', filePath), { code: 'SKILL_FILE_UNAVAILABLE' })
  writeFileSync(filePath, '---\nname: fixture\n---\n')
  const containRoot = path.join(root, 'allowed')
  mkdirSync(containRoot)
  await assert.rejects(readDiscoveredSkill(root, [{ ...skills[0], containRoot }], 'fixture', filePath), { code: 'SKILL_PATH_CHANGED' })
  const link = path.join(containRoot, 'SKILL.md')
  try { symlinkSync(filePath, link) } catch { return }
  await assert.rejects(readDiscoveredSkill(root, [{ name: 'fixture', filePath: link, containRoot }], 'fixture', link), { code: 'SKILL_PATH_CHANGED' })
})

test('official parser preserves custom metadata without writing the skill', { skip: !integration }, async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'ompiui-skill-metadata-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const filePath = path.join(root, 'SKILL.md')
  const content = '---\nname: fixture\ndescription: >\n  Full multiline\n  description\nallowed-tools: [Read, Bash]\ncustom:\n  enabled: false\n  count: 0\n  missing: null\n  blank: ""\n  nested: { values: [one, two] }\n---\nBody must not be returned.\n'
  writeFileSync(filePath, content)
  const before = statSync(filePath).mtimeMs
  const result = await readDiscoveredSkill(root, [{ name: 'fixture', filePath }], 'fixture', filePath)
  assert.deepEqual(result.frontmatter, {
    name: 'fixture', description: 'Full multiline description\n', 'allowed-tools': ['Read', 'Bash'],
    custom: { enabled: false, count: 0, missing: null, blank: '', nested: { values: ['one', 'two'] } },
  })
  assert.equal(result.body, undefined)
  assert.equal(readFileSync(filePath, 'utf8'), content)
  assert.equal(statSync(filePath).mtimeMs, before)
})

test('official parser distinguishes empty metadata from invalid YAML and non-JSON values', { skip: !integration }, async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'ompiui-skill-invalid-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const filePath = path.join(root, 'SKILL.md')
  const skills = [{ name: 'fixture', filePath }]
  for (const content of ['Plain body', '---\n---\nBody', '---\n{}\n---\nBody']) {
    writeFileSync(filePath, content)
    assert.deepEqual(await readDiscoveredSkill(root, skills, 'fixture', filePath), { frontmatter: {} })
  }
  for (const header of ['name: [', '- list', 'plain scalar', 'null']) {
    writeFileSync(filePath, `---\n${header}\n---\n`)
    await assert.rejects(readDiscoveredSkill(root, skills, 'fixture', filePath), { code: 'SKILL_FRONTMATTER_INVALID' })
  }
  writeFileSync(filePath, '---\nname: missing delimiter\n')
  await assert.rejects(readDiscoveredSkill(root, skills, 'fixture', filePath), { code: 'SKILL_FRONTMATTER_INVALID' })
  for (const [header, code] of [['value: .inf', 'SKILL_METADATA_NOT_JSON'], ['value: &loop { self: *loop }', 'SKILL_FRONTMATTER_INVALID']]) {
    writeFileSync(filePath, `---\n${header}\n---\n`)
    await assert.rejects(readDiscoveredSkill(root, skills, 'fixture', filePath), { code })
  }
})
