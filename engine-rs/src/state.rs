//! 限速令牌桶：一个任务内所有分段共享的速率控制（aria2 `--max-download-limit` 语义）。
//!
//! 拆出来是因为「限速」有三层容易互相搞混的量：用户填的 KiB/s（`rate_limit_kbps`）、
//! 桶里的字节/秒（`limit_bps`）、以及每轮能拿到的配额（`throttle` 的返回值）。
//! 换算（`rate_bps`/`bucket_capacity`/`refill_tokens`）都是纯函数，便于单元测试。

use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::Mutex;

/// 单次 `throttle()` 最多睡这么久就重新看一次桶。限速值随时可被 `set_rate` 改，
/// 一口气睡「补齐整段所需的时间」会把调高/取消限速拖成没反应；极低限速下
/// （比如 1 KiB/s）这也能让写盘保持小步推进，而不是一停几十秒。
const THROTTLE_WAIT_CAP: Duration = Duration::from_millis(50);

/// KiB/s → 字节/秒。字段名叫 `rate_limit_kbps`，单位按 1024 算（和 UI 上的 KB/s 一致）。
fn rate_bps(kbps: u64) -> u64 {
    kbps.saturating_mul(1024)
}

/// 桶容量（= 允许的突发量），单位字节。取 ~100ms 的配额：
/// 再大限速就形同虚设（起手能突发好几秒的量），再小则唤醒过密、写盘碎片化。
/// 纯函数，便于单元测试。
pub fn bucket_capacity(limit_bps: u64) -> u64 {
    if limit_bps == 0 { 0 } else { (limit_bps / 10).max(1) }
}

/// `elapsed` 时间内按 `limit_bps` 能补多少令牌（字节）。纯函数，便于单元测试。
/// 用微秒做中间单位：1 KiB/s 下 1ms 只值 1 字节，用毫秒会把低速档整体算成 0。
pub fn refill_tokens(limit_bps: u64, elapsed: Duration) -> u64 {
    (elapsed.as_micros() as u64).saturating_mul(limit_bps) / 1_000_000
}

/// 一个任务内所有分段共享的令牌桶。**不是**每段各限一份：
/// 8 段并发时总速度仍受同一个上限约束（aria2 `--max-download-limit` 的语义）。
#[derive(Debug)]
pub struct Bucket {
    /// 字节/秒。0 = 不限速（此时 `tokens` 恒 0，`throttle` 直接放行）。
    pub limit_bps: u64,
    /// 当前可用令牌（字节），上限见 `bucket_capacity`。
    pub tokens: u64,
    /// 上次补令牌的时刻。
    pub last: Instant,
}

impl Bucket {
    pub fn new(limit_kbps: u64) -> Self {
        Self { limit_bps: rate_bps(limit_kbps), tokens: 0, last: Instant::now() }
    }

    /// 按流逝时间补令牌，钳在容量以内。
    fn refill(&mut self) {
        let now = Instant::now();
        let elapsed = now.saturating_duration_since(self.last);
        self.last = now;
        if self.limit_bps == 0 {
            self.tokens = 0;
            return;
        }
        let cap = bucket_capacity(self.limit_bps);
        self.tokens = self.tokens.saturating_add(refill_tokens(self.limit_bps, elapsed)).min(cap);
    }

    /// 运行中改限速（含调回 0 取消）。先结算旧速率攒下的令牌，再重置计时起点，
    /// 否则「刚调高」要等到下一次长时间流逝才见效。
    pub fn set_limit(&mut self, limit_kbps: u64) {
        self.refill();
        self.limit_bps = rate_bps(limit_kbps);
        self.last = Instant::now();
        self.tokens = self.tokens.min(bucket_capacity(self.limit_bps));
    }
}

/// 想写 `want` 字节，问桶要配额。返回**本次可以立即写入**的字节数（<= `want`，
/// 不限速时就是 `want`），不足的部分调用方下一轮再要——所以调用方必须按返回值写，
/// 别把自己算的 `want` 全写下去。
///
/// 锁只在算令牌的那一小段持有，`sleep` 期间不放着锁，所以多个 worker 是真并发地
/// 从同一个桶里扣配额。
pub async fn throttle(bucket: &Arc<Mutex<Bucket>>, want: u64) -> u64 {
    if want == 0 {
        return 0;
    }
    loop {
        let (grant, wait) = {
            let mut b = bucket.lock().await;
            if b.limit_bps == 0 {
                return want;
            }
            b.refill();
            if b.tokens > 0 {
                let g = b.tokens.min(want);
                b.tokens -= g;
                (g, None)
            } else {
                // 一个令牌都没有：等出至少 1 字节配额，最长 `THROTTLE_WAIT_CAP`。
                let cap_us = THROTTLE_WAIT_CAP.as_micros() as u64;
                let micros = (1_000_000u64 / b.limit_bps.max(1)).clamp(1, cap_us);
                (0, Some(Duration::from_micros(micros)))
            }
        };
        if grant > 0 {
            return grant;
        }
        tokio::time::sleep(wait.unwrap_or(THROTTLE_WAIT_CAP)).await;
    }
}
