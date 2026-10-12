/**
 * 引擎 stdout 的行缓冲解析（纯函数）。
 *
 * 引擎通信协议是换行 JSON：stdout 每行一条事件。流式读取天然会切在任意位置
 * ——一条事件可能只到一半、也可能一次到好几条，所以需要「累积缓冲 + 按 \n
 * 切出完整行 + 把剩余半行留给下次」的状态机。这段逻辑从 engine.ts 的
 * onStdout 提取出来，因为它是协议解析的边界行为（半行/超大缓冲/空行），
 * 最容易在改解析时回归，必须用契约测试钉死。
 *
 * 超大缓冲截断的规则（协议侧没有行长度上限，segments 很多的大任务单行能
 * 超 64KiB）：缓冲超过 CHUNK*8 时只留尾部，但要先截到最后一个换行符——
 * 直接 slice(-CHUNK) 会把最后一个 \n 之后的半行也砍掉，那半条事件就永久丢了。
 */
const MAX_BUF = 64 * 1024 * 8

/**
 * 消费累积缓冲，切出完整行。
 * @param buf  上次留下的半行 + 新到的 chunk
 * @returns lines：完整行数组（不含换行符，含空串——空行语义由调用方决定）；
 *          rest：剩余半行（下次调用时拼在 chunk 前面）
 */
export function consumeLines(buf: string): { lines: string[]; rest: string } {
  let rest = buf
  const lines: string[] = []
  let idx: number
  while ((idx = rest.indexOf('\n')) >= 0) {
    lines.push(rest.slice(0, idx))
    rest = rest.slice(idx + 1)
  }
  if (rest.length > MAX_BUF) {
    const lastNl = rest.lastIndexOf('\n')
    rest = lastNl >= 0 ? rest.slice(lastNl + 1) : rest.slice(-MAX_BUF)
  }
  return { lines, rest }
}
