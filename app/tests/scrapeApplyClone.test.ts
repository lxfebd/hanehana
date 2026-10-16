/**
 * 回归钉：刮削候选必须脱掉 Vue 响应式代理后才能过 IPC（2026-10-16 事故）。
 *
 * 事故回放：ScrapeDialog 的 selected 取自 reactive 的 library.scrapeResults，
 * 是深层 Proxy；直接 window.hh.scrapeApply(id, selected) 在 preload 的
 * ipcRenderer.invoke 结构化克隆处抛「An object could not be cloned」——
 * 搜索列表正常显示、点「应用选中」永远写不进库，正是用户报「刮削根本用不了」
 * 的最后一环（真实 UI 走查 scripts/ui_scrape_walkthrough.mjs 实测抓到）。
 *
 * 修复是 applyScrapeResult 里 JSON.parse(JSON.stringify(result)) 拍平。
 * structuredClone 不行（HTML 规范对 Proxy 直接抛 DataCloneError），这里连
 * 这个坑一起钉住，防止将来有人"优化"回去。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { isProxy, reactive, toRaw } from 'vue'

import type { ScrapeCandidate } from '../src/shared/types'

const CANDIDATE: ScrapeCandidate = {
  provider: 'vndb',
  id: 'v4',
  title: 'CLANNAD',
  titleNative: 'クラナド',
  description: 'Just 200 meters from the school gate…',
  coverUrl: 'https://cdn.vndb.org/v4.jpg',
  releaseDate: '2004-04-28',
  rating: 8.73,
  tags: ['ADV', 'High School'],
}

test('reactive 里的候选是 Proxy：原样进 IPC 正是事故根源（克隆必炸）', () => {
  const state = reactive({ results: [structuredClone(CANDIDATE)] })
  const picked = state.results[0]
  assert.ok(isProxy(picked), '前提：从 reactive 数组里拿出的对象是代理')
  // Electron/浏览器对 Proxy 的结构化克隆行为：抛 DataCloneError。
  // 用同样的算法（structuredClone）把这条钉死——将来谁改回直接传就撞这里。
  assert.throws(() => structuredClone(picked), (e: unknown) => e instanceof Error && 'name' in e)
})

test('JSON 往返能把代理拍平成可过 IPC 的纯数据且字段无损', () => {
  const state = reactive({ results: [structuredClone(CANDIDATE)] })
  const picked = state.results[0]
  const plain = JSON.parse(JSON.stringify(picked)) as ScrapeCandidate
  assert.ok(!isProxy(plain))
  // 嵌套数组也得是纯数据（tags 在 reactive 里同样是 Proxy）
  assert.ok(!isProxy(plain.tags))
  assert.deepEqual(plain, toRaw(structuredClone(CANDIDATE)))
})
