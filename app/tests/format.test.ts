/**
 * fmtSize / fmtSpeed / fmtEta / fmtRange 的行为契约（G22 单测基建）。
 * 单位换算固定 1KB=1024；速度非正显示 0 B/s；ETA>30 天显示 —。
 * 这些规则是给用户看的显示契约，改格式先改测试。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
// ESM 之谜：node 只认带 .js 的 specifier，TS 会把它映射回 .ts——两头都通。
import { fmtSize, fmtSpeed, fmtEta, fmtRange, fmtProgress, fileName, dirName } from '../src/shared/format.js'

test('fmtSize: B 不保留小数', () => {
  assert.equal(fmtSize(0), '0 B')
  assert.equal(fmtSize(1023), '1023 B')
  assert.equal(fmtSize(512), '512 B')
})

test('fmtSize: 从 KB 起保留 1 位小数, 1024 进制', () => {
  assert.equal(fmtSize(1024), '1.0 KB')
  assert.equal(fmtSize(1536), '1.5 KB')
  assert.equal(fmtSize(1024 * 1024), '1.0 MB')
  assert.equal(fmtSize(1024 ** 4), '1.0 TB')
})

test('fmtSize: 空/负数/非有限数都显示破折号', () => {
  assert.equal(fmtSize(null), '—')
  assert.equal(fmtSize(undefined), '—')
  assert.equal(fmtSize(-1), '—')
  assert.equal(fmtSize(Number.NaN), '—')
  assert.equal(fmtSize(Number.POSITIVE_INFINITY), '—')
})

test('fmtSpeed: 非正速度显示 0 B/s', () => {
  assert.equal(fmtSpeed(0), '0 B/s')
  assert.equal(fmtSpeed(-5), '0 B/s')
  assert.equal(fmtSpeed(null), '0 B/s')
  assert.equal(fmtSpeed(2048), '2.0 KB/s')
})

test('fmtEta: 空/<=0/超 30 天显示 —', () => {
  assert.equal(fmtEta(null), '—')
  assert.equal(fmtEta(0), '—')
  assert.equal(fmtEta(86400 * 30 + 1), '—')
})

test('fmtEta: 小时/分钟/秒分段', () => {
  assert.equal(fmtEta(5), '5s')
  assert.equal(fmtEta(65), '1m 5s')
  assert.equal(fmtEta(3661), '1h 1m')
  assert.equal(fmtEta(7200), '2h 0m')
})

test('fmtRange: 单位相同时省略重复单位', () => {
  assert.equal(fmtRange(1024, 2048), '1.0 / 2.0 KB')
  assert.equal(fmtRange(1024, 1048576), '1.0 KB / 1.0 MB')
  assert.equal(fmtRange(512, 1024), '512 B / 1.0 KB')
})

test('fmtProgress: 非有限数显示 0.0%', () => {
  assert.equal(fmtProgress(0.5), '50.0%')
  assert.equal(fmtProgress(1), '100.0%')
  assert.equal(fmtProgress(null), '0.0%')
  assert.equal(fmtProgress(Number.NaN), '0.0%')
})

test('fileName: 同时认正反斜杠', () => {
  assert.equal(fileName('C:\\games\\a.exe'), 'a.exe')
  assert.equal(fileName('/home/user/game.sh'), 'game.sh')
  assert.equal(fileName('plain'), 'plain')
})

test('dirName: 无分隔符返回空串', () => {
  assert.equal(dirName('a.exe'), '')
  assert.equal(dirName('C:\\a.exe'), 'C:')
  assert.equal(dirName('/a/b'), '/a')
})
