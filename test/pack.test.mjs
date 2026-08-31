/**
 * v0.2 pack/unpack 迁移测试。
 *
 * - 往返：打包 → 解包 → 内容一致；.git / index.json / vectors 派生物被排除。
 * - 分离 git 目录（.git 文件指向 gitDir）也被排除。
 * - 防逃逸：档案内 .. / 绝对路径 / 空段被拒绝。
 * - CLI：usage 退出码、pack/unpack 成功路径。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

import { main } from '../dist/cli.js'
import { packLibrary, separateGitDir, unpackLibrary } from '../dist/pack.js'

async function makeTestRoot() {
  const root = await mkdtemp(join(tmpdir(), 'dm3t-pack-root-'))
  await mkdir(join(root, 'runtime'), { recursive: true })
  await mkdir(join(root, 'docs', 'notes'), { recursive: true })
  await mkdir(join(root, 'spaces'), { recursive: true })
  await mkdir(join(root, 'vectors'), { recursive: true })
  await mkdir(join(root, 'diag'), { recursive: true })
  await mkdir(join(root, '.git'), { recursive: true })
  await writeFile(join(root, 'runtime', '2026-08-28.md'), '# 2026-08-28\n- user: hello\n')
  await writeFile(join(root, 'docs', 'notes', 'a.md'), '## note\n内容\n')
  await writeFile(join(root, 'spaces', 'pref-x.md'), '---\nkind: preference\n---\n摘要\n')
  await writeFile(join(root, 'meta.json'), '{"schemaVersion":1}\n')
  await writeFile(join(root, 'audit.jsonl'), '{"op":"audit"}\n')
  await writeFile(join(root, 'index.json'), '{"stale":true}\n')
  await writeFile(join(root, 'vectors', 'v.json'), '[1,2,3]\n')
  await writeFile(join(root, 'diag', 'events.jsonl'), '{"level":"error"}\n')
  await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  return root
}

async function listRel(root, prefix = '') {
  const out = []
  let names = []
  try {
    names = await readdir(join(root, prefix), { withFileTypes: true })
  } catch {
    return out
  }
  for (const name of names) {
    const rel = prefix === '' ? name.name : `${prefix}/${name.name}`
    if (name.isDirectory()) out.push(...(await listRel(root, rel)))
    else out.push(rel)
  }
  return out
}

test('pack: 往返迁移——内容一致、派生物排除', async () => {
  const root = await makeTestRoot()
  const target = await mkdtemp(join(tmpdir(), 'dm3t-pack-target-'))
  const archive = join(tmpdir(), `dm3t-pack-${Date.now()}.dmmem`)
  try {
    const result = await packLibrary(root, archive)
    assert.equal(result.fileCount, 5) // runtime + docs + spaces + meta + audit
    assert.ok(result.bytes > 0)
    const unpacked = await unpackLibrary(archive, target)
    assert.equal(unpacked.fileCount, 5)
    assert.equal(await readFile(join(target, 'runtime', '2026-08-28.md'), 'utf8'), '# 2026-08-28\n- user: hello\n')
    assert.equal(await readFile(join(target, 'docs', 'notes', 'a.md'), 'utf8'), '## note\n内容\n')
    assert.equal(await readFile(join(target, 'spaces', 'pref-x.md'), 'utf8'), '---\nkind: preference\n---\n摘要\n')
    assert.equal(await readFile(join(target, 'meta.json'), 'utf8'), '{"schemaVersion":1}\n')
    assert.equal(await readFile(join(target, 'audit.jsonl'), 'utf8'), '{"op":"audit"}\n')
    // 派生物不迁移（可重建）
    const rels = await listRel(target)
    assert.ok(!rels.includes('index.json'))
    assert.ok(!rels.some((r) => r.startsWith('vectors/')))
    assert.ok(!rels.some((r) => r.startsWith('diag/')))
    assert.ok(!rels.some((r) => r.startsWith('.git')))
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(target, { recursive: true, force: true })
    await rm(archive, { force: true })
  }
})

test('pack: 分离 git 目录（.git 文件）被排除', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dm3t-pack-gd-'))
  const gitDir = join(root, 'meta-git')
  try {
    await mkdir(join(root, 'runtime'))
    await writeFile(join(root, 'runtime', '2026-08-28.md'), '# 2026-08-28\n')
    await writeFile(join(root, '.git'), `gitdir: ${gitDir.replace(/\\/g, '/')}\n`)
    await mkdir(gitDir, { recursive: true })
    await writeFile(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n')
    assert.equal(await separateGitDir(root), gitDir)
    const archive = join(tmpdir(), `dm3t-pack-gd-${Date.now()}.dmmem`)
    try {
      const result = await packLibrary(root, archive)
      assert.equal(result.fileCount, 1)
      const unpacked = await unpackLibrary(archive, await mkdtemp(join(tmpdir(), 'dm3t-pack-gd-t-')))
      assert.equal(unpacked.fileCount, 1)
    } finally {
      await rm(archive, { force: true })
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('pack: 无 .git 时 separateGitDir 返回 null', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dm3t-pack-nogit-'))
  try {
    assert.equal(await separateGitDir(root), null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('pack: 解包防逃逸（.. / 绝对路径 / 空段拒绝）', async () => {
  const target = await mkdtemp(join(tmpdir(), 'dm3t-pack-esc-'))
  const archive = join(tmpdir(), `dm3t-pack-esc-${Date.now()}.dmmem`)
  try {
    for (const bad of ['../evil.md', 'C:/abs.md', '/abs.md', 'a//b.md']) {
      const buf = gzipSync(
        Buffer.from(JSON.stringify({ schemaVersion: 1, kind: 'dmmem-pack', exportedAt: new Date().toISOString(), rootName: 'x', files: [{ path: bad, content: 'x' }] }), 'utf8'),
      )
      await writeFile(archive, buf)
      await assert.rejects(() => unpackLibrary(archive, target), /非法路径/)
    }
  } finally {
    await rm(target, { recursive: true, force: true })
    await rm(archive, { force: true })
  }
})

test('pack: 损坏档案拒绝', async () => {
  const target = await mkdtemp(join(tmpdir(), 'dm3t-pack-corrupt-'))
  const archive = join(tmpdir(), `dm3t-pack-corrupt-${Date.now()}.dmmem`)
  try {
    await writeFile(archive, 'not gzip')
    await assert.rejects(() => unpackLibrary(archive, target), /损坏|JSON/)
  } finally {
    await rm(target, { recursive: true, force: true })
    await rm(archive, { force: true })
  }
})

test('cli: 用法错误退出码 2，pack/unpack 成功退出码 0', async () => {
  const root = await makeTestRoot()
  const archive = join(tmpdir(), `dm3t-cli-${Date.now()}.dmmem`)
  const target = await mkdtemp(join(tmpdir(), 'dm3t-cli-t-'))
  try {
    assert.equal(await main([]), 2)
    assert.equal(await main(['pack']), 2)
    assert.equal(await main(['unpack']), 2)
    assert.equal(await main(['pack', root, '--out', archive]), 0)
    assert.ok((await readFile(archive)).length > 0)
    assert.equal(await main(['unpack', archive, target]), 0)
    // 目标目录恢复出 runtime 流水
    assert.equal(await readFile(join(target, 'runtime', '2026-08-28.md'), 'utf8'), '# 2026-08-28\n- user: hello\n')
    assert.equal(await main(['pack', '/nonexistent-root-xyz']), 1)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(archive, { force: true })
    await rm(target, { recursive: true, force: true })
  }
})