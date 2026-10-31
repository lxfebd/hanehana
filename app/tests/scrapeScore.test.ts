/**
 * scrapeScore 契约测试（2026-10-31 刮削选错修复的实测锚点）：
 * 同名作/YMGal 外传撞车/清洗梯降权/矛盾淘汰/跨源互验，每个都钉一条。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normTitle, scoreCandidate, pickAuto, crossKey, contradicts, pickProducerId } from '../src/shared/scrapeScore.js'
import type { Game, ScrapeCandidate } from '../src/shared/types.js'

function makeGame(over: Partial<Game>): Game {
  return {
    id: 'g1',
    dir: 'C:/games/x',
    exePath: 'C:/games/x/x.exe',
    rawTitle: 'Clannad',
    title: 'Clannad',
    tags: [],
    categories: [],
    sources: [],
    playMs: 0,
    useLE: false,
    useMagpie: false,
    addedAt: 0,
    favorite: false,
    ...over,
  }
}

function makeCand(over: Partial<ScrapeCandidate>): ScrapeCandidate {
  return { provider: 'vndb', id: 'v4', title: 'Clannad', ...over }
}

test('normTitle：小写 + 去空白标点，中文/日文保留', () => {
  assert.equal(normTitle('Summer Pockets'), 'summerpockets')
  assert.equal(normTitle('夏日口袋'), '夏日口袋')
  assert.equal(normTitle('【Key】Clannad [EX]'), 'keyclannadex')
})

test('标题完全相等 = 100', () => {
  assert.equal(scoreCandidate(makeGame({ rawTitle: 'Clannad' }), makeCand({ title: 'CLANNAD' })), 100)
})

test('别名命中也算完全相等（VNDB aliases 撞车要认出本体）', () => {
  const c = makeCand({ title: 'Summer Pockets', aliases: ['夏日口袋'] })
  assert.equal(scoreCandidate(makeGame({ rawTitle: '夏日口袋' }), c), 100)
})

test('包含关系 = 75', () => {
  assert.equal(scoreCandidate(makeGame({ rawTitle: 'eden' }), makeCand({ title: 'eden -they were only two-' })), 75)
})

test('矛盾开发商 → 0（双方都有值且归一化不等才淘汰）', () => {
  const g = makeGame({ developer: 'Key' })
  assert.equal(scoreCandidate(g, makeCand({ title: 'Clannad', developer: 'SAGA PLANETS' })), 0)
  assert.equal(contradicts(g, makeCand({ title: 'Clannad' })), false)
})

test('矛盾年份 → 0；相差 1 年容忍', () => {
  const g = makeGame({ releaseDate: '2004-04-28' })
  assert.equal(scoreCandidate(g, makeCand({ title: 'Clannad', releaseDate: '2020-01-01' })), 0)
  const near = scoreCandidate(g, makeCand({ title: 'Clannad', releaseDate: '2005-07-29' }))
  assert.ok(near > 0, '相差 1 年不算矛盾, got ' + near)
})

test('一致性加成：开发商+年份都一致仍封顶 100，不升档', () => {
  const g = makeGame({ developer: 'Key', releaseDate: '2004-04-28' })
  assert.equal(scoreCandidate(g, makeCand({ title: 'Clannad', developer: 'Key', releaseDate: '2004-04-28' })), 100)
})

test('清洗梯放宽词命中（queryStep>0）封顶 75，进不了自动档', () => {
  const g = makeGame({ rawTitle: 'Clannad' })
  const c = makeCand({ title: 'Clannad', queryStep: 2 })
  assert.equal(scoreCandidate(g, c), 75)
})

test('pickAuto：跨源互验通过（同 title+developer 出现 2 个源）→ 自动应用', () => {
  const g = makeGame({ rawTitle: 'Clannad', developer: 'Key' })
  const rs = [
    makeCand({ provider: 'vndb', id: 'v4', title: 'Clannad', developer: 'Key' }),
    makeCand({ provider: 'ymgal', id: '123', title: 'Clannad', developer: 'Key' }),
    makeCand({ provider: 'bangumi', id: '8', title: 'CLANNAD 外传', developer: 'Key' }),
  ]
  const pick = pickAuto(g, rs)
  assert.ok(pick, '应自动应用')
  assert.equal(pick.provider, 'vndb')
})

test('pickAuto：单源唯一 100 也不自动应用（YMGal 撞车实测案例）', () => {
  // 搜 夏日口袋，YMGal 第一条是外传 Reflection Blue，chineseName 恰好叫 夏日口袋
  const g = makeGame({ rawTitle: '夏日口袋' })
  const rs = [makeCand({ provider: 'ymgal', id: '26435', title: '夏日口袋', developer: 'VISUAL ARTS' })]
  assert.equal(scoreCandidate(g, rs[0]), 100)
  assert.equal(pickAuto(g, rs), null)
})

test('pickAuto：同分但不同游戏（key 不同）→ 真冲突进待确认', () => {
  const g = makeGame({ rawTitle: 'eden' })
  const rs = [
    makeCand({ id: 'a', title: 'Eden', developer: 'X社' }),
    makeCand({ provider: 'ymgal', id: 'b', title: 'Eden', developer: 'Y社' }),
  ]
  assert.equal(pickAuto(g, rs), null)
})

test('pickAuto：同 key 同分跨源（同一游戏在两源同现）→ 放行自动应用', () => {
  const g = makeGame({ rawTitle: 'eden' })
  const rs = [
    makeCand({ id: 'a', title: 'Eden', developer: 'X社' }),
    makeCand({ provider: 'ymgal', id: 'b', title: 'Eden', developer: 'X社' }),
  ]
  const pick = pickAuto(g, rs)
  assert.ok(pick)
})

test('pickAuto：最高分 <80 → null', () => {
  const g = makeGame({ rawTitle: '不存在的游戏名xyz' })
  const rs = [makeCand({ title: '完全不相关' })]
  assert.equal(pickAuto(g, rs), null)
})

test('crossKey：同名不同开发商 key 不同，不会互相壮胆', () => {
  const a = makeCand({ title: 'AIR', developer: 'Key' })
  const b = makeCand({ title: 'AIR', developer: '小厂' })
  assert.notEqual(crossKey(a), crossKey(b))
})

test('pickAuto：同名不同社，单源各自 100 但 key 不同 → 仍不自动（防同名作误杀）', () => {
  const g = makeGame({ rawTitle: 'AIR' })
  const rs = [makeCand({ id: 'v1', title: 'AIR', developer: 'Key' })]
  assert.equal(scoreCandidate(g, rs[0]), 100)
  assert.equal(pickAuto(g, rs), null)
})

test('pickProducerId：归一精确匹配优先于前缀命中（Key vs Key Fans Club，实测 VNDB 搜 Key 前 5 条）', () => {
  const list = [
    { id: 'p720', name: 'Key Fans Club' },
    { id: 'p24', name: 'Key' },
  ]
  assert.equal(pickProducerId('Key', list), 'p24')
  assert.equal(pickProducerId('key', [{ id: 'p1', name: 'KEY STAFF' }]), 'p1')
  assert.equal(pickProducerId('Key', []), undefined)
  assert.equal(pickProducerId('', list), undefined)
})

test('封面软信号：sexual/violence >=2 降权 15，阈值以下不罚', () => {
  const g = makeGame({ rawTitle: 'Clannad' })
  // 包含关系基础分 75
  assert.equal(scoreCandidate(g, makeCand({ title: 'Clannad HD' })), 75)
  assert.equal(scoreCandidate(g, makeCand({ title: 'Clannad HD', coverSexual: 2 })), 60)
  assert.equal(scoreCandidate(g, makeCand({ title: 'Clannad HD', coverViolence: 3 })), 60)
  assert.equal(scoreCandidate(g, makeCand({ title: 'Clannad HD', coverSexual: 1 })), 75)
})

test('封面软信号：votecount 加 min(6, floor(log10(v+1)))，与降权叠加后夹 0..100', () => {
  const g = makeGame({ rawTitle: 'Clannad' })
  assert.equal(scoreCandidate(g, makeCand({ title: 'Clannad HD', coverVotecount: 100 })), 77)
  assert.equal(scoreCandidate(g, makeCand({ title: 'Clannad HD', coverSexual: 2, coverVotecount: 10 })), 61)
})