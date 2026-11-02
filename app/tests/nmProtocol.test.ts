/**
 * 浏览器扩展 ↔ HaneHana 的 native messaging 契约单测。
 *
 * 为什么这条链必须有测试：宿主进程、扩展 service worker、主应用是三个互不共享
 * 内存的上下文，字段名或帧格式对不上时没有任何栈可查，用户只看到「点了没反应」。
 * 这里钉住的就是那条看不见的接缝：字段名、取值范围、帧的字节布局。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  NM_EXTENSION_ID,
  NM_HOST_NAME,
  NM_MAX_CLIENT_MESSAGE,
  NM_MAX_HOST_MESSAGE,
  NM_PROTOCOL_VERSION,
  NmFrameDecoder,
  encodeNmFrame,
  nmRequestHeaders,
  validateNmDeliver,
} from '../src/shared/nmProtocol.js'

test('契约常量: 扩展 ID 必须是 32 个 a-p 字符（Chrome 的 ID 形状）', () => {
  // 宿主清单的 allowed_origins 要写死这个 origin，形状不对 Chrome 会直接拒收。
  assert.match(NM_EXTENSION_ID, /^[a-p]{32}$/)
  assert.equal(NM_EXTENSION_ID.length, 32)
})

test('契约常量: 宿主名与协议版本', () => {
  assert.equal(NM_HOST_NAME, 'com.lxfebd.hanehana')
  assert.equal(NM_PROTOCOL_VERSION, 1)
  // Chrome 规定的两个硬上限：宿主→浏览器 1 MiB，浏览器→宿主 64 MiB。
  assert.equal(NM_MAX_HOST_MESSAGE, 1024 * 1024)
  assert.equal(NM_MAX_CLIENT_MESSAGE, 64 * 1024 * 1024)
})

test('validateNmDeliver: 最小合法请求通过，且不夹带未知字段', () => {
  const r = validateNmDeliver({ v: 1, action: 'deliver', url: 'https://e.com/a.zip' })
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.value.url, 'https://e.com/a.zip')
  assert.equal(r.value.v, 1)
  assert.equal(r.value.action, 'deliver')
  // 未知键必须被丢掉：扩展将来多带字段不该让旧宿主行为变形。
  const r2 = validateNmDeliver({
    v: 1,
    action: 'deliver',
    url: 'https://e.com/a.zip',
    evil: 'x',
    headers: { Cookie: 'a=1' },
  })
  assert.equal(r2.ok, true)
  if (!r2.ok) return
  assert.deepEqual(Object.keys(r2.value).sort(), ['action', 'url', 'v'])
})

test('validateNmDeliver: 版本与动作不对一律拒', () => {
  assert.equal(validateNmDeliver({ v: 2, action: 'deliver', url: 'https://e.com/a' }).ok, false)
  assert.equal(validateNmDeliver({ v: 1, action: 'hack', url: 'https://e.com/a' }).ok, false)
  assert.equal(validateNmDeliver({ v: 1, action: 'deliver' }).ok, false)
})

test('validateNmDeliver: 只认 http/https，file:// 与 data: 都挡掉', () => {
  // 这两个协议能读本机文件或直接塞内容，放行等于把本机交出去。
  for (const u of ['file:///C:/Windows/win.ini', 'data:text/plain;base64,AA', 'ftp://e.com/a', 'smb://e/a']) {
    const r = validateNmDeliver({ v: 1, action: 'deliver', url: u })
    assert.equal(r.ok, false, `不该放行：${u}`)
  }
  assert.equal(validateNmDeliver({ v: 1, action: 'deliver', url: 'http://e.com/a' }).ok, true)
  assert.equal(validateNmDeliver({ v: 1, action: 'deliver', url: 'HTTPS://E.COM/a' }).ok, true)
})

test('validateNmDeliver: 长度超限与类型不对都拒', () => {
  const long = 'https://e.com/' + 'x'.repeat(5000)
  assert.equal(validateNmDeliver({ v: 1, action: 'deliver', url: long }).ok, false)
  assert.equal(
    validateNmDeliver({ v: 1, action: 'deliver', url: 'https://e.com/a', filename: 'x'.repeat(300) }).ok,
    false,
  )
  assert.equal(
    validateNmDeliver({ v: 1, action: 'deliver', url: 'https://e.com/a', cookie: 123 }).ok,
    false,
  )
  // 非对象（数组、null、字符串）也要拒。
  assert.equal(validateNmDeliver(null).ok, false)
  assert.equal(validateNmDeliver([]).ok, false)
  assert.equal(validateNmDeliver('https://e.com/a').ok, false)
})

test('validateNmDeliver: 可选字段去空白，空串按「没给」处理', () => {
  const r = validateNmDeliver({
    v: 1,
    action: 'deliver',
    url: '  https://e.com/a.zip  ',
    filename: '  a.zip  ',
    title: '   ',
  })
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.value.url, 'https://e.com/a.zip')
  assert.equal(r.value.filename, 'a.zip')
  // 只有空白的 title 不该变成一个空字符串字段。
  assert.equal('title' in r.value, false)
})

test('nmRequestHeaders: 只映射 Referer / Cookie / User-Agent', () => {
  const r = validateNmDeliver({
    v: 1,
    action: 'deliver',
    url: 'https://e.com/a.zip',
    referer: 'https://e.com/page',
    cookie: 'sid=1',
    userAgent: 'UA/1.0',
    title: '标题',
  })
  assert.equal(r.ok, true)
  if (!r.ok) return
  const h = nmRequestHeaders(r.value)
  assert.deepEqual(h, { Referer: 'https://e.com/page', Cookie: 'sid=1', 'User-Agent': 'UA/1.0' })
  // 标题不是请求头，不能混进去。
  assert.equal('标题' in h, false)
  // 没给可选字段时不该产生空头。
  const r2 = validateNmDeliver({ v: 1, action: 'deliver', url: 'https://e.com/a.zip' })
  if (r2.ok) assert.deepEqual(nmRequestHeaders(r2.value), {})
})

test('encodeNmFrame: 4 字节小端长度 + UTF-8 JSON', () => {
  const frame = encodeNmFrame({ ok: true })
  assert.equal(frame.readUInt32LE(0), frame.length - 4)
  assert.deepEqual(JSON.parse(frame.subarray(4).toString('utf8')), { ok: true })
})

test('encodeNmFrame: 长度按字节算，不是字符数', () => {
  // 中文一个字 3 字节：按字符数写长度会让 Chrome 把帧切错位置。
  const frame = encodeNmFrame({ t: '羽花' })
  const body = frame.subarray(4)
  assert.equal(frame.readUInt32LE(0), body.length)
  assert.equal(body.length, Buffer.byteLength(JSON.stringify({ t: '羽花' }), 'utf8'))
  assert.ok(body.length > JSON.stringify({ t: '羽花' }).length)
})

test('encodeNmFrame: 超过上限抛错（不能悄悄截断）', () => {
  assert.throws(() => encodeNmFrame({ t: 'x'.repeat(2000) }, 100))
})

test('NmFrameDecoder: 一次一帧能解出', () => {
  const d = new NmFrameDecoder()
  const r = d.push(encodeNmFrame({ v: 1, action: 'deliver', url: 'https://e.com/a' }))
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.messages.length, 1)
  assert.deepEqual(r.messages[0], { v: 1, action: 'deliver', url: 'https://e.com/a' })
})

test('NmFrameDecoder: 帧被切成任意块也能拼回来', () => {
  // 管道读是任意切分的：一帧 300KB 的 JSON 会被拆成几十块，
  // 半帧当完整帧解析 = 直接失败。
  const frame = encodeNmFrame({ url: 'https://e.com/' + 'x'.repeat(300000) })
  const d = new NmFrameDecoder()
  let got: unknown[] = []
  for (let i = 0; i < frame.length; i += 7) {
    const r = d.push(frame.subarray(i, i + 7))
    assert.equal(r.ok, true)
    if (!r.ok) return
    got = got.concat(r.messages)
  }
  assert.equal(got.length, 1)
})

test('NmFrameDecoder: 一块里两帧都解出来', () => {
  const d = new NmFrameDecoder()
  const both = Buffer.concat([encodeNmFrame({ n: 1 }), encodeNmFrame({ n: 2 })])
  const r = d.push(both)
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.deepEqual(r.messages, [{ n: 1 }, { n: 2 }])
})

test('NmFrameDecoder: 长度超限与坏 JSON 都报错', () => {
  const d = new NmFrameDecoder()
  const bad = Buffer.alloc(8)
  bad.writeUInt32LE(999999999, 0)
  const r = d.push(bad)
  assert.equal(r.ok, false)

  const d2 = new NmFrameDecoder()
  const junk = Buffer.concat([Buffer.from([3, 0, 0, 0]), Buffer.from('abc', 'utf8')])
  const r2 = d2.push(junk)
  assert.equal(r2.ok, false)
})
