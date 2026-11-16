/**
 * 条件轮询：闸门脚本里「等状态」的唯一正确姿势。
 *
 * 为什么固定 sleep 是坏味道：
 *  - 慢机假红：首次渲染/磁盘/网络慢一点，sleep(500) 不够，断言就在状态还没到位时跑掉，
 *    报出来的是「产品坏了」，其实是探针跑早了——假红会让人开始不信任闸门。
 *  - 快机白等：状态 20ms 就绪，sleep(2000) 照样空等满 2 秒；几十处叠加，闸门总时长被
 *    sleep 支配，而不是被被测行为支配。
 *  - 没有信息：`sleep(500)` 之后断言失败，报错只有断言本身；人不知道探针在等什么、
 *    当时看到了什么，只能重跑一次碰运气。
 * 因此：等页面/浮层/数据出现、等某个 class 或文字出现、等数量变化 → 一律 waitFor；
 * 只有「真的在等动画/过渡时长」才保留 sleep，并在行尾注明「动画时长，不是等状态」。
 *
 * 为什么超时错误要带 label：失败信息能自证。
 * 抛出的错误里同时给出 label（在等什么）与最后一次取值（当时看到什么）以及最后一次
 * 异常，看起来就是一条可复现的线索，不用再重跑一次才知道卡在哪一步。
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 最后一次取值的安全字符串化（值可能是 DOM 快照、循环引用对象、undefined）。 */
function describe(value) {
  if (value === undefined) return 'undefined'
  if (typeof value === 'string') return JSON.stringify(value.length > 300 ? value.slice(0, 300) + '…' : value)
  try {
    const s = JSON.stringify(value)
    return s === undefined ? String(value) : s.length > 300 ? s.slice(0, 300) + '…' : s
  } catch {
    return String(value)
  }
}

/**
 * 条件轮询：反复求值 pred，直到返回真值（真值原样返回，便于顺手拿到元素/计数）。
 * 超时抛出带 label 与「最后一次取值/异常」的错误。
 * @param {() => any | Promise<any>} pred 判定函数（可以返回 Promise）
 * @param {{ timeoutMs?: number, intervalMs?: number, label?: string }} [opts]
 */
export async function waitFor(pred, { timeoutMs = 15000, intervalMs = 100, label = '' } = {}) {
  const t0 = Date.now()
  let last
  let lastErr
  for (;;) {
    try {
      last = await pred()
      lastErr = undefined
      if (last) return last
    } catch (e) {
      // 页面重载/上下文销毁期间 ev() 会抛——这本身也是「还没到位」，算进轮询而不是直接炸。
      lastErr = e
    }
    const spent = Date.now() - t0
    if (spent >= timeoutMs) {
      const detail = lastErr
        ? `最后一次异常=${String(lastErr && lastErr.message ? lastErr.message : lastErr)}`
        : `最后一次取值=${describe(last)}`
      throw new Error(`等待超时 ${timeoutMs}ms：${label || '未命名条件'}（${detail}）`)
    }
    await sleep(Math.min(intervalMs, Math.max(1, timeoutMs - spent)))
  }
}

/**
 * 不抛版本：条件在超时内成立返回 true，否则 false。
 * 用于「这项本来就允许不出现，出现与否由后面的断言判」的分支（例如可选的展开钮）。
 */
export async function tryWaitFor(pred, opts = {}) {
  try {
    await waitFor(pred, opts)
    return true
  } catch {
    return false
  }
}

export { sleep }
