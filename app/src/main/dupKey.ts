/**
 * 重复游戏判重键（纯函数，无 electron/IO 依赖——因此可被 node:test 直接测）。
 *
 * 由来（实测 2026-10-16 用户截图）：同一款游戏装在两个目录
 * （F:\gg 与 G:\ggame 各一份），exePath 不同，原有"按 exePath 去重"挡不住，
 * 结果封面墙上同一个游戏出现 N 份（4 个妹相随、2 个 Yog-Sothoth）。
 *
 * 解法：cleanTitle 归一化后小写作键。妹相随彩色版 / 黑白版 / 1.4.5+DLC+… 尾巴
 * 都会被 cleanTitle 削成同一个「妹相随」，两道判重合一。
 *
 * 为什么不做内容哈希：galgame 动辄几十 GB，扫一次全算哈希会卡死界面。
 * 归一化标题在真实案例上已足够，且「同款不同版本想都留着」的用户可以走
 * 手动添加（handleAddOne 不过这道闸）。
 */

/**
 * 同一款游戏的判重键：归一化标题小写、空白压一。
 * @param rawTitle 目录名原文
 * @param title 已 cleanTitle 过的标题（可空，空则自行归一）
 * @param clean 标题归一函数（由调用方注入，避免本模块反向依赖 games.ts）
 */
export function dupKeyOf(rawTitle: string, title: string, clean: (s: string) => string): string {
  const base = title && title.trim() ? title : rawTitle
  return clean(base).toLowerCase().replace(/\s+/g, ' ').trim()
}
