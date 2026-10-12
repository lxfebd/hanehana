/**
 * explainError/errorLine 错误翻译契约测试。
 *
 * 查表顺序是产品语义，改错会让用户看到牛头不对马嘴的提示：
 *   1. 有稳定码 → 查 codeRules（http_status 特殊：拼回 "http N" 走原文规则）；
 *   2. 没码/码不认识 → 原文过 rules 正则（顺序敏感，具体模式在前）；
 *   3. 都不中 → unknownTitle + 永远保留原文（排查要用）。
 * errorLine 是任务行副标题：说发生了什么 + 一句下一步，advice 超 40 码点截断
 * （按码点切，不能把 emoji/生僻字的代理对劈成 U+FFFD）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
// ESM 之谜：node 只认带 .js 的 specifier，TS 会把它映射回 .ts——两头都通。
import { explainError, errorLine } from '../src/shared/errors.js'

test('未知错误回落：标题是兜底、原文永远保留', () => {
  const e = explainError('some weird failure', '', null)
  assert.equal(e?.title, '下载中断')
  assert.ok(e?.advice, '兜底也要有 advice')
  assert.equal(e?.raw, 'some weird failure')
})

test('空输入返回 null', () => {
  assert.equal(explainError('', '', null), null)
  assert.equal(explainError(null, '', null), null)
  assert.equal(explainError('', null, null), null)
})

test('码优先：有稳定码就不去过原文规则', () => {
  // 原文看起来像「网络中断」，但码说 checksum_mismatch —— 必须听码的
  const e = explainError('network error', 'checksum_mismatch', null)
  assert.equal(e?.title, '文件内容和站点给的校验和对不上')
})

test('码不认识时回落原文规则', () => {
  const e = explainError('Connection reset by peer', 'some_new_code', null)
  assert.equal(e?.title, '网络传输中断')
})

test('http_status 码：params.status 拼回原文规则（403 与 500 处置相反）', () => {
  const e403 = explainError('raw', 'http_status', { status: 403 })
  assert.equal(e403?.title, '服务器拒绝访问（需要登录或链接已过期）')
  const e500 = explainError('raw', 'http_status', { status: 500 })
  assert.equal(e500?.title, '站点服务器出错')
})

test('http_status 码：params.status 缺失时拿原文兜底', () => {
  const e = explainError('no file size', 'http_status', null)
  assert.equal(e?.title, '服务器不肯告诉文件多大')
})

test('engine_missing 码：advice 用 params.hint（开发/安装态不同）', () => {
  const e = explainError('engine not found', 'engine_missing', { hint: 'cd engine-rs && cargo build --release' })
  assert.equal(e?.title, '下载引擎不可用')
  assert.equal(e?.advice, 'cd engine-rs && cargo build --release')
})

test('engine_missing 码：没有 hint 时回落原文', () => {
  const e = explainError('engine not found', 'engine_missing', null)
  assert.equal(e?.title, '下载引擎不可用')
  assert.equal(e?.advice, 'engine not found')
})

test('原文规则顺序敏感：具体模式（http 403）排前面胜过裸 4xx', () => {
  const e = explainError('http 403 Forbidden', '', null)
  assert.equal(e?.title, '服务器拒绝访问（需要登录或链接已过期）')
})

test('原文规则：磁盘空间不足（中英文都认）', () => {
  assert.equal(explainError('os error 112', '', null)?.title, '磁盘空间不足')
  assert.equal(explainError('no space left on device', '', null)?.title, '磁盘空间不足')
  assert.equal(explainError('磁盘空间不足', '', null)?.title, '磁盘空间不足')
})

test('原文规则：Range 不支持', () => {
  assert.equal(explainError('range request on every attempt', '', null)?.title, '这台服务器不支持分段下载')
})

test('errorLine：短 advice 不截断、长 advice 按码点截断不劈代理对', () => {
  // 短：直接 title · advice
  const short = errorLine('http 404', '', null)
  assert.equal(short, '链接指向的文件不存在了 · 这个直链已经失效，回站点换一个镜像重新下载。')
  // 长：checksum_mismatch 的 advice 超 40 码点 → 截断加 …
  const long = errorLine('checksum mismatch', 'checksum_mismatch', null)
  assert.ok(long.endsWith('…'), '超长 advice 以 … 收尾')
  assert.ok(long.length < 100, '截断后不会撑爆任务行')
  // 截断后不能有 U+FFFD（代理对被劈开的乱码）
  assert.ok(!long.includes('\uFFFD'), '不得出现替换字符')
})
