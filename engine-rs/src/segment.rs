//! 分段布局与「换线程数后按真实下载区间重摊进度」。
//!
//! `Segment` 是任务的最小工作单元：每个 worker 独占一段，只写自己的字节区间。
//! `recompute_segment` 是 `set_threads` 时把老段进度折算进新段的纯函数——旧算法
//! 累加 `min(odone, overlap)`，把整段重叠区都当成已下载，曾导致中途改线程数损坏文件。

use serde::Deserialize;

#[derive(Deserialize)]
pub struct Segment {
    pub index: usize,
    pub start: u64,
    pub end: u64,
    pub downloaded: u64,
    /// 已经 `sync_data` 确认落盘的字节数（相对段首），恒 ≤ `downloaded`。
    /// 写进边车的是它，不是 `downloaded`：崩溃后只有这部分是真的在盘上。
    pub flushed: u64,
    pub status: String,
    pub speed: f64,
}

impl Segment {
    pub fn new(index: usize, start: u64, end: u64) -> Self {
        Self { index, start, end, downloaded: 0, flushed: 0, status: "waiting".into(), speed: 0.0 }
    }
    pub fn size(&self) -> u64 {
        self.end - self.start + 1
    }
    pub fn done(&self) -> bool {
        self.downloaded >= self.size()
    }
}

/// 线程数变了、段重新切分后，新段 `[ns, ne]` 里到底有多少字节是「真的已经下过了」。
/// 关键：老段真正下载的字节区间是 `[ostart, ostart+odone)`，把它和新段求交集长度才是
/// 真实已有的量。老段之间的下载区间互不相交，所以逐段相加不会重复计数。
/// 旧算法累加 `min(odone, overlap)`，隐含假设老段已下载的字节都落在重叠区间的开头，
/// 会把整段重叠区都当成已下载，凭空多出进度——这正是「中途改线程数导致文件损坏」的根因。
/// 纯函数，便于单元测试。
pub fn recompute_segment(ns: u64, ne: u64, old: &[(u64, u64, u64)]) -> u64 {
    let new_excl = ne.saturating_add(1);
    let mut got = 0u64;
    for &(ostart, oend, odone) in old {
        // 老段真实已下载区间 [ostart, oexcl)，钳到本老段末尾以内。
        let oexcl = ostart.saturating_add(odone).min(oend.saturating_add(1));
        let lo = ns.max(ostart);
        let hi = new_excl.min(oexcl);
        if hi > lo {
            got += hi - lo;
        }
    }
    got.min(ne - ns + 1)
}
