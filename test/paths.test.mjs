import { test } from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { resolveRoot, safeJoin, layerDirs, runtimeFileName } from '../dist/paths.js'

test('paths: resolveRoot 相对基于工作区根', () => {
  assert.equal(resolveRoot('C:/ws', '.memory').replaceAll('\\', '/'), 'C:/ws/.memory')
  assert.equal(resolveRoot('C:/ws', '.memory/').replaceAll('\\', '/'), 'C:/ws/.memory') // resolve 归一化尾斜杠
})

test('paths: resolveRoot 绝对原样', () => {
  assert.equal(resolveRoot('C:/ws', 'D:/mem'), 'D:/mem')
})

test('paths: resolveRoot user scope 基于用户主目录（全局一库）', () => {
  const home = homedir().replaceAll('\\', '/')
  assert.equal(resolveRoot('C:/ws', '.memory', 'user').replaceAll('\\', '/'), home + '/.memory')
  // 绝对路径在 user scope 下仍原样（可覆盖全局库位置）
  assert.equal(resolveRoot('C:/ws', 'D:/mem', 'user'), 'D:/mem')
})

test('paths: safeJoin 正常拼接', () => {
  const root = resolveRoot('C:/ws', '.memory')
  assert.equal(safeJoin(root, 'spaces', 'a.md').replaceAll('\\', '/'), 'C:/ws/.memory/spaces/a.md')
})

test('paths: safeJoin 拒绝 .. 逃逸', () => {
  const root = resolveRoot('C:/ws', '.memory')
  assert.throws(() => safeJoin(root, '..', 'secret.txt'), /escapes memory root/)
  assert.throws(() => safeJoin(root, 'spaces', '..', '..', 'x'), /escapes memory root/)
})

test('paths: safeJoin 拒绝绝对路径片段', () => {
  const root = resolveRoot('C:/ws', '.memory')
  assert.throws(() => safeJoin(root, 'D:/elsewhere'), /escapes memory root/)
})

test('paths: layerDirs 三层目录', () => {
  const root = resolveRoot('C:/ws', '.memory')
  const dirs = layerDirs(root)
  assert.equal(dirs.runtime.replaceAll('\\', '/'), 'C:/ws/.memory/runtime')
  assert.equal(dirs.docs.replaceAll('\\', '/'), 'C:/ws/.memory/docs')
  assert.equal(dirs.spaces.replaceAll('\\', '/'), 'C:/ws/.memory/spaces')
})

test('paths: runtimeFileName 格式', () => {
  const name = runtimeFileName(new Date(2026, 0, 5, 12))
  assert.equal(name, '2026-01-05.md')
})