/**
 * 本机桥的回环测试：真起一个 TCP 服务、真发真收。
 *
 * 这条链上最容易坏、又最难查的就是「宿主进程 → 本机桥 → 主应用」这一段：
 * 令牌、origin、帧格式（JSON + 换行）任一处对不上，用户看到的都是「扩展点了没反应」。
 * 这里把三道关卡各钉一条：令牌不匹配拒、origin 不匹配拒、正常请求通。
 *
 * 用临时目录当数据目录：绝不能碰用户真实的 ~/.hanehana（那里是任务存档）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:net'
import {
  appendNmPending,
  clearNmPending,
  nmBridgeFile,
  readNmBridgeInfo,
  readNmPending,
  sendToNmBridge,
  startNmBridge,
} from '../src/main/nmBridge.js'
import { NM_EXTENSION_ID } from '../src/shared/nmProtocol.js'

const ORIGIN = `chrome-extension://${NM_EXTENSION_ID}/`

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'hh-nm-bridge-'))
}

/** 等桥把端口写进信息文件（listen 是异步的）。 */
async function waitReady(bridge: { info: { port: number } }, timeoutMs = 3000): Promise<void> {
  const t0 = Date.now()
  while (bridge.info.port === 0) {
    if (Date.now() - t0 > timeoutMs) throw new Error('桥没能在超时内就绪')
    await new Promise((r) => setTimeout(r, 10))
  }
}

test('桥：请求能递到主应用并把回应答带回来', async () => {
  const dir = tempDir()
  const seen: string[] = []
  const bridge = startNmBridge(dir, async (req, origin) => {
    seen.push(req.url)
    assert.equal(origin, ORIGIN)
    return { ok: true, mode: 'engine', taskId: 'abc', dest: '/tmp/a.zip' }
  })
  try {
    await waitReady(bridge)
    const res = await sendToNmBridge(
      dir,
      { v: 1, action: 'deliver', url: 'https://e.com/a.zip' },
      ORIGIN,
    )
    assert.ok(res, '没收到应答')
    assert.equal(res?.ok, true)
    if (res && res.ok) {
      assert.equal(res.mode, 'engine')
      assert.equal(res.taskId, 'abc')
    }
    assert.deepEqual(seen, ['https://e.com/a.zip'])
  } finally {
    bridge.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('桥：origin 不是钉死的那个扩展，一律拒', async () => {
  const dir = tempDir()
  const bridge = startNmBridge(dir, async () => ({ ok: true, mode: 'engine' }))
  try {
    await waitReady(bridge)
    const res = await sendToNmBridge(
      dir,
      { v: 1, action: 'deliver', url: 'https://e.com/a.zip' },
      'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/',
    )
    assert.equal(res?.ok, false)
    if (res && !res.ok) assert.match(res.error, /来源扩展不匹配/)
  } finally {
    bridge.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('桥：令牌不对（信息文件被换掉）一律拒', async () => {
  const dir = tempDir()
  const bridge = startNmBridge(dir, async () => ({ ok: true, mode: 'engine' }))
  try {
    await waitReady(bridge)
    // 模拟别的进程读到了端口、换掉令牌再发：桥必须不认。
    const info = readNmBridgeInfo(dir)
    assert.ok(info)
    writeFileSync(nmBridgeFile(dir), JSON.stringify({ ...info, token: 'wrong-token' }), 'utf8')
    const res = await sendToNmBridge(
      dir,
      { v: 1, action: 'deliver', url: 'https://e.com/a.zip' },
      ORIGIN,
    )
    assert.equal(res?.ok, false)
    if (res && !res.ok) assert.match(res.error, /令牌不匹配/)
  } finally {
    bridge.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('桥：应用没在运行（没有信息文件）时返回 null，交给排队路径', async () => {
  const dir = tempDir()
  const res = await sendToNmBridge(dir, { v: 1, action: 'deliver', url: 'https://e.com/a.zip' }, ORIGIN)
  assert.equal(res, null)
  rmSync(dir, { recursive: true, force: true })
})

test('桥：关闭后信息文件被清掉（别留一个连不上的端口骗宿主进程）', async () => {
  const dir = tempDir()
  const bridge = startNmBridge(dir, async () => ({ ok: true, mode: 'engine' }))
  await waitReady(bridge)
  assert.equal(existsSync(nmBridgeFile(dir)), true)
  bridge.close()
  assert.equal(existsSync(nmBridgeFile(dir)), false)
  rmSync(dir, { recursive: true, force: true })
})

test('排队：写进去读得出来，清空后没了', () => {
  const dir = tempDir()
  assert.deepEqual(readNmPending(dir), [])
  appendNmPending(dir, { v: 1, action: 'deliver', url: 'https://e.com/a.zip' })
  appendNmPending(dir, { v: 1, action: 'deliver', url: 'https://e.com/b.zip', title: '第二个' })
  const got = readNmPending(dir)
  assert.equal(got.length, 2)
  assert.equal(got[0].url, 'https://e.com/a.zip')
  assert.equal(got[1].title, '第二个')
  clearNmPending(dir)
  assert.deepEqual(readNmPending(dir), [])
  rmSync(dir, { recursive: true, force: true })
})

test('排队：坏行跳过，不让一行垃圾把整个队列卡死', () => {
  const dir = tempDir()
  appendNmPending(dir, { v: 1, action: 'deliver', url: 'https://e.com/a.zip' })
  // 手工塞一行坏 JSON（模拟文件被写坏一半）。
  appendFileSync(join(dir, 'nm-pending.jsonl'), '{坏的一行\n', 'utf8')
  appendNmPending(dir, { v: 1, action: 'deliver', url: 'https://e.com/b.zip' })
  const got = readNmPending(dir)
  assert.equal(got.length, 2)
  rmSync(dir, { recursive: true, force: true })
})

// ---- 多字节分片 / 超时语义（修复：逐块 toString 会把跨分片的中文换成 U+FFFD）----

test('桥：中文被切在 TCP 分片里也必须原样到达（按字节攒缓冲）', async () => {
  const dir = tempDir()
  let got: string | undefined
  const bridge = startNmBridge(dir, async (req) => {
    got = req.title
    return { ok: true, mode: 'engine', taskId: 'x', dest: 'D:/下载/中文名.zip' }
  })
  try {
    await waitReady(bridge)
    const info = readNmBridgeInfo(dir)
    assert.ok(info)
    const payload = JSON.stringify({
      token: info.token,
      origin: ORIGIN,
      request: { v: 1, action: 'deliver', url: 'https://e.com/a.zip', title: '中文字标题' },
    })
    const all = Buffer.from(payload + '\n', 'utf8')
    // 找一个多字节字符的中间字节：切在那里，前半段是残缺序列
    const cut = all.indexOf(Buffer.from('中', 'utf8')[0]) + 1
    const done = new Promise<void>((resolve, reject) => {
      const sock = connect({ host: '127.0.0.1', port: info.port }, () => {
        sock.write(all.subarray(0, cut))
        setTimeout(() => {
          sock.write(all.subarray(cut))
          sock.end()
        }, 40)
      })
      let seen = ''
      sock.on('data', (c: Buffer) => {
        seen += c.toString('utf8')
      })
      sock.on('end', () => {
        try {
          assert.match(seen, /"ok":true/)
          resolve()
        } catch (e) {
          reject(e)
        }
      })
      sock.on('error', reject)
    })
    await done
    assert.equal(got, '中文字标题', '跨分片的中文不能变成 U+FFFD')
  } finally {
    bridge.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('桥：连上但不应答 = 超时错误（不是 null，免得误走排队丢 Cookie）', async () => {
  const dir = tempDir()
  const bridge = startNmBridge(dir, () => new Promise(() => {})) // 永不应答
  try {
    await waitReady(bridge)
    const res = await sendToNmBridge(
      dir,
      { v: 1, action: 'deliver', url: 'https://e.com/a.zip' },
      ORIGIN,
      250,
    )
    assert.ok(res, '超时必须给一条 error 应答，不能是 null')
    assert.equal(res?.ok, false)
    if (res && !res.ok) assert.match(res.error, /应答超时/)
  } finally {
    bridge.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
