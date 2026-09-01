import { test } from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join, parse, resolve } from 'node:path'
import { resolveRoot, safeJoin, layerDirs, runtimeFileName } from '../dist/paths.js'

// 平台无关的绝对基准根：Windows -> C:\ws，Unix -> /ws
const ws = join(parse(process.cwd()).root, 'ws')
// 平台无关的另一个绝对位置：Windows -> C:\mem，Unix -> /mem
const absOther = resolve(parse(ws).root, 'mem')
const norm = (p) => p.replaceAll('\\', '/')

test('paths: resolveRoot 相对基于工作区根', () => {
  assert.equal(norm(resolveRoot(ws, '.memory')), norm(join(ws, '.memory')))
  assert.equal(norm(resolveRoot(ws, '.memory/')), norm(join(ws, '.memory'))) // resolve 归一化尾斜杠
})

test('paths: resolveRoot 绝对原样', () => {
  assert.equal(resolveRoot(ws, absOther), absOther)
})

test('paths: resolveRoot user scope 基于用户主目录（全局一库）', () => {
  const home = homedir().replaceAll('\\', '/')
  assert.equal(norm(resolveRoot(ws, '.memory', 'user')), home + '/.memory')
  // 绝对路径在 user scope 下仍原样（可覆盖全局库位置）
  assert.equal(resolveRoot(ws, absOther, 'user'), absOther)
})

test('paths: safeJoin 正常拼接', () => {
  const root = resolveRoot(ws, '.memory')
  assert.equal(norm(safeJoin(root, 'spaces', 'a.md')), norm(join(root, 'spaces', 'a.md')))
})

test('paths: safeJoin 拒绝 .. 逃逸', () => {
  const root = resolveRoot(ws, '.memory')
  assert.throws(() => safeJoin(root, '..', 'secret.txt'), /escapes memory root/)
  assert.throws(() => safeJoin(root, 'spaces', '..', '..', 'x'), /escapes memory root/)
})

test('paths: safeJoin 拒绝绝对路径片段', () => {
  const root = resolveRoot(ws, '.memory')
  assert.throws(() => safeJoin(root, absOther), /escapes memory root/)
})

test('paths: layerDirs 三层目录', () => {
  const root = resolveRoot(ws, '.memory')
  const dirs = layerDirs(root)
  assert.equal(norm(dirs.runtime), norm(join(root, 'runtime')))
  assert.equal(norm(dirs.docs), norm(join(root, 'docs')))
  assert.equal(norm(dirs.spaces), norm(join(root, 'spaces')))
})

test('paths: runtimeFileName 格式', () => {
  const name = runtimeFileName(new Date(2026, 0, 5, 12))
  assert.equal(name, '2026-01-05.md')
})