//! HTTP 层：错误归码、探测（HEAD→带 Range 的 GET 兜底）、分段/单流拉取。
//!
//! 所有「服务器回答了什么」的解读都在这一个文件里：请求构造（`make_client`）、
//! 响应头超时（`send_headers`）、长度/区间解析（`total_from_headers`、
//! `parse_content_range`、`expected_len`）、206 判据（`check_ranges`）、以及两种
//! 下载驱动（分段 `fetch_and_write` / 未知长度单流 `fetch_unbounded`）。
//! 归类用的 `FetchErr` 也在这里，因为它的字段是给 UI 的稳定契约。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::TryStreamExt;
use reqwest::header::HeaderValue;
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

use crate::state::Bucket;

/// TCP + TLS + 发请求的耗时上限。**不能**用 reqwest 的 `.timeout()`——那个覆盖
/// 的是整个请求含读完响应体的总时长，任何超过 45s 的健康慢速下载都会被准时
/// 掐断（实测：数据稳定流入中报 error decoding response body）。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// 从发请求到拿到响应头的上限。`.connect_timeout()` 只管 TCP/TLS 握手，
/// 不管服务端处理时长，所以还得单独兜这一层。
const HEADERS_TIMEOUT: Duration = Duration::from_secs(30);
/// 整个探测（HEAD，失败则退回一次带 Range 的 GET）的总预算。必须比 `HEADERS_TIMEOUT`
/// 宽一些，因为 `.send()` 的耗时包含 TCP/TLS 握手（`CONNECT_TIMEOUT` 15s），那段是从
/// 30s 里扣的；留 10s 余量才不会让外层先超时、把内层的原因信息吞掉。
const PROBE_TIMEOUT: Duration = Duration::from_secs(40);
/// 相邻两段数据之间的空闲上限。真正判定「服务端死了」的开关，取代旧的整请求
/// 超时——慢但健康的传输可以一直跑，只有真的卡住才断。
const CHUNK_IDLE: Duration = Duration::from_secs(60);
/// 攒够这么多新写入就 `sync_data` 一次，并把该段的「已落盘水位」推到这里。
/// 边车只记已落盘的水位：不 fsync 的话，断电/强制结束进程后边车会说「这段下过了」，
/// 而盘上其实还是 `set_len` 撑出来的空洞——续传跳过这段，成品就是一堆零字节。
/// 64 MiB 是吞吐与「崩溃最多重下多少」的折中（1 GiB/s 下约 15 秒一次）。
const FLUSH_BYTES: u64 = 64 * 1024 * 1024;
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                          (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
/// 分段写入时的单次写盘封顶（字节）。
const CHUNK: u64 = 64 * 1024;

pub struct FetchErr {
    pub msg: String,
    /// 稳定错误码（snake_case），随 `error` 事件和快照一起上报。
    /// 界面按码查文案，`msg` 只作为原文留档：以前界面靠正则去认英文原话，
    /// 引擎改一个词用户就看到「下载中断」，两边谁也不敢动字符串。
    pub code: &'static str,
    /// 码的参数（状态码、字节数、期望/实际摘要…），没有就是 `Null`。
    pub params: Value,
    pub fatal: bool,
    /// 服务器无视了 Range 请求（本次 from>0）。这类错误「原地重试」毫无意义——
    /// 每次都会拿到整份文件。worker 收到它要把该段 `done` 归零、重新 seek 到段首，
    /// 从段首（对单段任务即偏移 0）重下才能自愈，而不是空转。
    pub restart_from_zero: bool,
}

impl FetchErr {
    pub fn new(code: &'static str, msg: impl Into<String>) -> Self {
        Self { msg: msg.into(), code, params: Value::Null, fatal: false, restart_from_zero: false }
    }
    pub fn fatal(code: &'static str, msg: impl Into<String>) -> Self {
        Self { fatal: true, ..Self::new(code, msg) }
    }
    pub fn with_params(mut self, params: Value) -> Self {
        self.params = params;
        self
    }
    pub fn restarting(mut self) -> Self {
        self.restart_from_zero = true;
        self
    }
}

/// 把 reqwest 的错误链归到一个稳定码上。分类顺序即优先级，和界面文案表一致：
/// 代理填错必须报「代理没生效」，不能被笼统的「连不上服务器」盖掉。
pub fn req_code(e: &reqwest::Error) -> &'static str {
    let s = req_err(e).to_lowercase();
    if s.contains("proxy") {
        "proxy_invalid"
    } else if s.contains("dns") || s.contains("lookup") || s.contains("name resolution") || s.contains("name does not resolve") {
        "dns"
    } else if s.contains("certificate") || s.contains("tls") || s.contains("ssl") || s.contains("invalid peer") {
        "tls"
    } else if s.contains("refused") || s.contains("tcp connect error") || s.contains("connect") {
        "connect_refused"
    } else if s.contains("redirect") {
        "redirect_loop"
    } else {
        "request_failed"
    }
}

/// 把磁盘错误归到稳定码。Windows 的 `raw_os_error` 才是真凭据：
/// 112 磁盘满、36 路径太长、123 文件名非法、5 无权限/被占用。
pub fn io_code(e: &std::io::Error) -> &'static str {
    if e.kind() == std::io::ErrorKind::PermissionDenied {
        return "permission_denied";
    }
    match e.raw_os_error().unwrap_or(0) {
        112 => "no_space",
        36 => "name_too_long",
        5 | 32 => "permission_denied",
        123 | 124 => "invalid_filename",
        _ => "part_io",
    }
}

/// 统一的 `error` 事件形状。`error` 仍是原文（老主进程/日志都靠它），
/// `code`/`params` 是新增字段：只加不改，旧读端照旧能跑。
pub fn error_event(code: &str, msg: &str, params: &Value) -> Value {
    json!({"event": "error", "error": msg, "code": code, "params": params})
}

/// 磁盘类错误一律 fatal：重试不会让磁盘腾出空间、也不会让只读目录变得可写。
pub fn part_io_err(e: std::io::Error) -> FetchErr {
    let code = io_code(&e);
    let os = e.raw_os_error();
    FetchErr::fatal(code, e.to_string()).with_params(json!({"os_error": os}))
}

/// 「服务器少发了字节」的错误。两条路径（干净 EOF / 流中途报错）共用同一形状，
/// 免得同一个病因在界面上出现两种文案。
pub fn truncated_err(written: u64, expect: u64) -> FetchErr {
    FetchErr::new("truncated", format!("truncated: got {written} of {expect} bytes"))
        .with_params(json!({"got": written, "expect": expect}))
}

pub fn make_client(proxy: &str, user_agent: &str) -> Result<reqwest::Client, String> {
    let mut b = reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .http2_adaptive_window(true)
        // 强制 https：下载源（含代理入口）都应是 https，放开明文会把
        // Range 请求原样暴露在网络上，也防服务端用重定向把请求降级到 http。
        .https_only(true)
        // 默认重定向策略是「放行到任意主机」——一个 https 下载源可以把我们
        // 重定向到内网/本地地址并带上 Range 头（SSRF 面）。限制为最多 10 跳、
        // 且只允许同样的 https 协议（reqwest 对跨协议跳转默认已拒绝，这里显式化）。
        .redirect(reqwest::redirect::Policy::limited(10));
    // 代理串解析不了必须当场报错，不能 `if let Ok(..)` 静默跳过：跳过等于用户填了
    // 代理却一路直连，失败时他会去怀疑站点，而真正的原因是那行配置根本没生效。
    if !proxy.is_empty() {
        // 代理串可能带凭据（user:pass@host:port），报错时只回显去掉了凭据的部分，
        // 免得密码跟着错误事件进界面和日志。
        let readable = proxy.split('@').last().unwrap_or(&proxy);
        let p =
            reqwest::Proxy::all(proxy).map_err(|e| format!("invalid proxy url: {readable} ({e})"))?;
        b = b.proxy(p);
    }
    let mut h = reqwest::header::HeaderMap::new();
    let ua = if user_agent.is_empty() { USER_AGENT } else { user_agent };
    if let Ok(ua) = HeaderValue::from_str(ua) {
        h.insert("User-Agent", ua);
    }
    b.default_headers(h)
        .build()
        .map_err(|e| format!("http client build failed: {e}"))
}

/// reqwest 错误的 `to_string()` 只有最外层那句 `error sending request for url (...)`，
/// 真正的病因（`tcp connect error` / `Connection refused`）藏在 source 链里。
/// 界面是按这些关键词决定「连不上服务器」还是「网络传输中断，会自动重连」的：
/// 代理地址填错时若只给外层，用户会以为站点在抽风，等一台根本没挂的站自愈。
///
/// reqwest 的 message 会带上完整 URL——下载源常带签名令牌（`?token=...`、
/// `&sig=...`），直接透传会把临时凭据写进错误事件、日志和界面。这里在拼接
/// 前先把 URL 里的 query 剥掉，`error sending request for url (https://…/file.zip)`
/// 变成 `…/file.zip)`，令牌不落地。
fn req_err(e: &reqwest::Error) -> String {
    let mut msg = redact_url(&e.to_string());
    let mut src = std::error::Error::source(e);
    while let Some(s) = src {
        msg.push_str(": ");
        msg.push_str(&redact_url(&s.to_string()));
        src = s.source();
    }
    msg
}

/// 把字符串里形如 `https?://host/path?query` 的 URL 的 query 段去掉。
/// source 链里的 `url: https://host/file?token=abc` 也要脱敏，所以按
/// `://` 之后第一个 `?` 切掉 query 即可（端口、路径里的 ? 少见且无害）。
fn redact_url(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(pos) = rest.find("://") {
        // 协议前的内容照抄
        let head = &rest[..pos];
        out.push_str(head);
        let after = &rest[pos + 3..];
        // 找主机/路径段的结尾（空格或结尾）
        let end = after.find(|c: char| c.is_whitespace() || c == '(' || c == ')').unwrap_or(after.len());
        let addr = &after[..end];
        // 只剥 query：第一个 ? 之后到段尾
        let addr_clean = match addr.find('?') {
            Some(q) => &addr[..q],
            None => addr,
        };
        out.push_str("://");
        out.push_str(addr_clean);
        rest = &after[end..];
    }
    out.push_str(rest);
    out
}

/// 发请求并等响应头，单独封顶 `HEADERS_TIMEOUT`。
///
/// 不能用 reqwest 的 `.timeout()`：它把「读完整个响应体」也算进去，会掐断健康的
/// 慢速下载。拆成「连接」「响应头」两段各自的短截止 + 正文靠 `CHUNK_IDLE` 空闲
/// 检测，才既不误杀慢传输，也不会在永远不吐头的服务器上卡死。
pub async fn send_headers(
    req: reqwest::RequestBuilder,
    deadline: Duration,
) -> Result<reqwest::Response, FetchErr> {
    match tokio::time::timeout(deadline, req.send()).await {
        Ok(r) => r.map_err(|e| {
            // 网络级错误（连不上/DNS/TLS/代理/超时）一律可重试：瞬时抖动会自愈，
            // 标 fatal 会让 worker 一次尝试就永久终止下载，与 main.rs 的
            // 「网络抖动无限重试自愈」注释直接矛盾。真正不可重试的是 HTTP 4xx
            // 等确定性应答（由 is_fatal_status 判定），发送失败本身永远不在此列。
            let code = req_code(&e);
            FetchErr::new(code, req_err(&e))
        }),
        Err(_) => Err(FetchErr::new(
            "no_reply",
            format!("server did not reply within {}s", deadline.as_secs()),
        )
        .with_params(json!({"secs": deadline.as_secs()}))),
    }
}

/// `Accept-Ranges` is a *response* header, so echoing it in the request proves
/// nothing. Issue one 1-byte range request and require a real `206`.
///
/// 只看 `Accept-Ranges` 会放走一类真实存在的坏服务器：它挂着这个头却无视 Range，
/// 每次都回 200 整份文件。被判「可分段」之后，每个 from>0 的段都会撞上 `fetch_and_write`
/// 的错位保护，归零重下三次仍拿到 200，最终升级成 "server ignored Range request on
/// every attempt" —— 用户端表现就是一个干脆的下载失败，而这本可以单线程正常下完。
/// 所以这里只认真正的 206；判 false 退回单线程是安全的（首段 from==0，200 可接受）。
pub async fn check_ranges(client: &reqwest::Client, url: &str) -> bool {
    match send_headers(client.get(url).header("Range", "bytes=0-0"), HEADERS_TIMEOUT).await {
        Ok(resp) => {
            let st = resp.status().as_u16();
            drop(resp);
            st == 206
        }
        Err(_) => false,
    }
}

/// 从响应头里问出总长度：优先 `Content-Range: bytes a-b/<total>` 的总长，退回
/// `Content-Length`。缺头、非数字、或算出来是 0 都返回 `None` = **长度未知**
/// （0 不能当已知长度用：拿它去分段会得到 `[0, u64::MAX]` 这种荒谬区间）。
/// 纯函数，便于单元测试。
pub fn total_from_headers(content_range: Option<&str>, content_length: Option<&str>) -> Option<u64> {
    content_range
        .and_then(|s| s.rsplit_once('/'))
        .and_then(|(_, t)| t.trim().parse::<u64>().ok())
        .or_else(|| content_length.and_then(|s| s.trim().parse::<u64>().ok()))
        .filter(|&t| t > 0)
}

/// `Accept-Ranges: bytes` 只说明「这台服务器*可能*答得出区间」。探测阶段用它做的
/// 判断仅限于「要不要再发一次带 Range 的 GET 去问长度」；真正能不能分段仍然只认
/// `check_ranges` 拿到的 206（坑 2）。
pub fn accepts_ranges_header(v: Option<&HeaderValue>) -> bool {
    v.and_then(|s| s.to_str().ok())
        .map(|s| s.to_ascii_lowercase().contains("bytes"))
        .unwrap_or(false)
}

/// Total size via HEAD, falling back to a ranged GET when HEAD is unusable.
/// Both legs share ONE `PROBE_TIMEOUT` budget: the fallback gets whatever the first
/// leg left, so the total can't stack past the deadline. The fallback is skipped
/// entirely when HEAD just timed out — a host that never answers HEAD won't answer
/// GET either, so the second leg would only burn the remaining budget for nothing.
///
/// 返回 `Ok(None)` 表示「连上了、也正常应答了，但就是问不出长度」（chunked 流式接口）。
/// 这和 `Err`（连不上/超时/服务端拒绝）必须严格区分：前者要退化成单流顺序下载，
/// 后者才是真的失败。`Ok(None)` 的判定路径**不会**发出任何 `Range` 请求：
/// HEAD 说得出话却没给长度时，只有它自己声称 `Accept-Ranges: bytes` 才值得再补一次
/// 带区间的 GET（206 的 `Content-Range` 能报总长）；否则发 Range 只会白白拉回一整份
/// 正文再丢掉——未知长度下载从探测阶段起就不该请求区间。
pub async fn probe_total(client: &reqwest::Client, url: &str) -> Result<Option<u64>, FetchErr> {
    fn total_from(resp: &reqwest::Response) -> Option<u64> {
        total_from_headers(
            resp.headers().get("Content-Range").and_then(|v| v.to_str().ok()).as_deref(),
            resp.headers().get("Content-Length").and_then(|v| v.to_str().ok()).as_deref(),
        )
    }

    let started = Instant::now();
    match send_headers(client.head(url), PROBE_TIMEOUT).await {
        // HEAD answered successfully: use it directly.
        Ok(r) if r.status().is_success() => match total_from(&r) {
            Some(t) => return Ok(Some(t)),
            // 不支持区间的服务器不值得再发一次 Range 请求，直接判「长度未知」。
            None if !accepts_ranges_header(r.headers().get("Accept-Ranges")) => return Ok(None),
            None => {}
        },
        // HEAD timed out: the host isn't going to answer a ranged GET either.
        Err(FetchErr { fatal: false, code, .. }) => {
            return Err(FetchErr::new(code, "server did not reply"))
        }
        // HEAD 被拒（403/405）或发送失败：给带区间的 GET 剩下的预算。
        _ => {}
    }
    let remaining = PROBE_TIMEOUT.saturating_sub(started.elapsed());
    if remaining.is_zero() {
        return Err(
            FetchErr::new("no_reply", format!("server did not reply within {}s", PROBE_TIMEOUT.as_secs()))
                .with_params(json!({"secs": PROBE_TIMEOUT.as_secs()})),
        );
    }
    match send_headers(client.get(url).header("Range", "bytes=0-0"), remaining).await {
        // 兜底这一次也问不出长度 → 同样是「未知长度」，不是失败。
        Ok(r) => Ok(total_from(&r)),
        Err(e) => Err(e),
    }
}

/// Fetch one contiguous range and stream it straight into `file`.
/// Returns how many bytes were written; 0 means "no progress".
/// Reports the segment-relative offset as bytes arrive. The counter starts at
/// `base` so the worker can read it directly instead of adding deltas.
type OnProgress = Option<(Arc<AtomicU64>, u64)>;

/// 已落盘水位的回报通道：每 `FLUSH_BYTES` 次 `sync_data` 成功后写一次，
/// 值与 `OnProgress` 同口径（段内相对偏移）。worker 把它抄进 `Segment::flushed`，
/// 边车只记这个值，于是「边车说下过了」永远等于「盘上真有这些字节」。
type OnFlushed = Option<Arc<AtomicU64>>;

/// 状态码里哪些重试也没意义。416 意味着请求的区间已经越界（客户端算错了偏移
/// 或文件被改了），再重试只是把同一请求重放 N 次，必须停下来。
fn is_fatal_status(st: u16) -> bool {
    matches!(st, 401 | 403 | 404 | 410 | 416)
}

/// 解析 `Content-Range: bytes {first}-{last}/{total}` 头，返回 (first, last, total)。
/// 无法解析（缺 total、单位不是 bytes、区间反了、或 `*` 通配）返回 None。
/// 注意旧实现用 `split('=')` 找值，但这个头里根本没有 `=`，所以那条路永远走不通。
pub fn parse_content_range(v: &str) -> Option<(u64, u64, u64)> {
    let v = v.trim();
    let (unit, rest) = v.split_once(char::is_whitespace)?;
    if !unit.eq_ignore_ascii_case("bytes") {
        return None;
    }
    let (range, total) = rest.trim().split_once('/')?;
    let total = total.trim();
    let total: u64 = if total == "*" { u64::MAX } else { total.parse().ok()? };
    let (fs, ls) = range.split_once('-')?;
    let first: u64 = fs.trim().parse().ok()?;
    let last: u64 = ls.trim().parse().ok()?;
    if last < first {
        return None;
    }
    Some((first, last, total))
}

/// 本次响应「应当写入的字节数」。优先用 `Content-Range` 的区间长度（`last-first+1`），
/// 并校验区间起点等于我们请求的 `from`——服务器返回别的区间意味着它没照我们的 Range 发，
/// 写下去必坏，故用 Err(()) 让调用方判失败。`Content-Range` 缺失或解析不了才退回
/// `Content-Length`（200 整份文件响应就走这条）。两者都没有时返回 Ok(None)。
/// 纯函数，便于单元测试。
pub fn expected_len(
    content_range: Option<&str>,
    content_length: Option<u64>,
    from: u64,
) -> Result<Option<u64>, ()> {
    if let Some(cr) = content_range {
        if let Some((first, last, _total)) = parse_content_range(cr) {
            if first != from {
                return Err(());
            }
            // checked 运算：恶意/损坏的 Content-Range（如 first=u64::MAX, last=0）
            // 会让 `last - first + 1` 在 debug 构建里直接 panic——worker 静默死亡、
            // 任务卡死；release 里回绕成巨大的长度，截断检测跟着失效。
            let n = last.checked_sub(first).and_then(|d| d.checked_add(1));
            return Ok(n);
        }
    }
    Ok(content_length)
}

pub async fn fetch_and_write(
    client: &reqwest::Client,
    url: &str,
    from: u64,
    end: u64,
    size: u64,
    file: &mut tokio::fs::File,
    on_progress: OnProgress,
    on_flushed: OnFlushed,
    rate: &Arc<Mutex<Bucket>>,
) -> Result<u64, FetchErr> {
    let resp = send_headers(
        client.get(url).header("Range", format!("bytes={from}-{end}")),
        HEADERS_TIMEOUT,
    )
    .await?;
    let st = resp.status().as_u16();
    if !(resp.status().is_success() || st == 206) {
        let e = FetchErr::new("http_status", format!("http {st}")).with_params(json!({"status": st}));
        return Err(if is_fatal_status(st) { FetchErr { fatal: true, ..e } } else { e });
    }
    // 我们请求了 Range，服务器却没回 206 而是 200 —— 它无视了 Range，正文是整份文件。
    // 真正危险的判据不是 ranges_ok，而是本次请求的起始偏移 from 是否为 0：
    //   - from == 0：正文头一段恰好就是本段内容（写盘受 remaining 封顶），可安全接受；
    //   - from  > 0：把「从 0 开始」的正文写到 from 偏移会整体错位 → 数据损坏。
    // 后者必须失败，并让 worker 把该段 done 归零从段首重下（自愈），而不是原地空转。
    if st != 206 && from != 0 {
        return Err(FetchErr::new("range_ignored", "server ignored Range request")
            .with_params(json!({"from": from}))
            .restarting());
    }
    // 期望长度：优先 Content-Range（并校验区间起点），退回 Content-Length，再退回 size。
    let cr = resp.headers().get("Content-Range").and_then(|v| v.to_str().ok());
    let expect = match expected_len(cr, resp.content_length(), from) {
        Ok(Some(n)) => n.min(end - from + 1),
        Ok(None) => size,
        Err(()) => {
            return Err(FetchErr::fatal(
                "range_mismatch",
                format!("server returned a range not starting at {from}"),
            )
            .with_params(json!({"from": from})));
        }
    };
    let mut stream = resp.bytes_stream();
    let mut written = 0u64;
    let mut remaining = end - from + 1;
    // 本次尝试开始前已完成的量（与进度计数器同口径），落盘水位要用它换算成段内偏移。
    let base = on_progress.as_ref().map(|(_, b)| *b).unwrap_or(0);
    let mut unsynced = 0u64;
    loop {
        if remaining == 0 {
            break;
        }
        // `timeout` wraps the stream item in `Ok`, so the match is on that outer layer.
        match tokio::time::timeout(CHUNK_IDLE, stream.try_next()).await {
            Ok(Ok(Some(bytes))) => {
                if bytes.is_empty() {
                    continue;
                }
                // Cap each write so long segments still report progress in small steps,
                // and never write past the end of this segment.
                let mut pos = 0usize;
                while pos < bytes.len() {
                    let room = remaining as usize;
                    if room == 0 {
                        break;
                    }
                    let want = ((pos + CHUNK as usize).min(bytes.len()) - pos).min(room);
                    // 令牌桶在这里放行：桶空了就把写盘 await 住（本任务所有分段共用同一个
                    // 桶，所以是总速度受限，不是每段各限一份）。只写真正拿到配额的那几个
                    // 字节，剩下的下一轮再来。
                    let chunk = crate::state::throttle(rate, want as u64).await.min(want as u64) as usize;
                    file.write_all(&bytes[pos..pos + chunk]).await.map_err(|e| {
                        FetchErr::fatal(io_code(&e), e.to_string())
                            .with_params(json!({"os_error": e.raw_os_error()}))
                    })?;
                    written += chunk as u64;
                    remaining -= chunk as u64;
                    pos += chunk;
                    unsynced += chunk as u64;
                    if unsynced >= FLUSH_BYTES {
                        // fsync 失败就不推进水位，下载照常继续：数据还在页缓存里，
                        // 下一次 sync 会一起带上，最坏情况只是崩溃后多重下一截。
                        if file.sync_data().await.is_ok() {
                            unsynced = 0;
                            if let Some(f) = &on_flushed {
                                f.store(base + written, Ordering::Relaxed);
                            }
                        }
                    }
                    if let Some((p, _)) = &on_progress {
                        // 段内累计偏移，worker 直接读。`base` 是本次尝试前
                        // 已完成的量，fetch 任务里不改 `done`，避免两处竞争。
                        p.store(base + written, Ordering::Relaxed);
                    }
                }
            }
            Ok(Ok(None)) => {
                // 流正常结束。字节数对不上就是服务器提前断链，必须重试：
                // 否则 worker 会以为这一段完了，把残缺的 `.part` rename 成成品。
                if written < expect {
                    return Err(truncated_err(written, expect));
                }
                break;
            }
            Ok(Err(e)) => {
                // 流中途炸了。能走到这里说明响应头已经拿到、body 已经开始传，所以
                // 「声明的字节数没给够」就是截断——reqwest 对这种情况报的是
                // `error decoding response body` 而不是干净 EOF，两种都得算。
                // 少一个字节和整个 body 都没送来对重试策略没有区别：都是服务端
                // 没兑现它自己声明的长度。真正连不上会走 `send_headers` 的分支。
                if written < expect {
                    return Err(truncated_err(written, expect));
                }
                return Err(FetchErr::new(req_code(&e), req_err(&e)));
            }
            Err(_) => {
                return Err(FetchErr::new("read_timeout", "read timeout"));
            }
        }
    }
    // 段写完再落一次盘，把水位推到 written：否则最后这不足 FLUSH_BYTES 的一截
    // 要等下一次 sync 才算数，崩溃后会白重下。
    if file.sync_data().await.is_ok() {
        if let Some(f) = &on_flushed {
            f.store(base + written, Ordering::Relaxed);
        }
    }
    Ok(written)
}

/// 长度未知时的单流下载：**不发 `Range`**，一直读到流自然结束。
///
/// 和 `fetch_and_write` 的关键区别：
///  - 没有区间可对账，所以「读完」的唯一信号是 stream 给出 `None`（EOF）。中途报错
///    或空闲超时一律算失败，由调用方从 0 重下（不允许请求区间，就没法要求服务端从
///    偏移 X 续传）。
///  - 收到 200 是完全正常的（我们根本没请求区间）；反过来，万一服务器对无 Range 的
///    请求回了 206，说明正文只是文件的一段，拼起来必然缺字节 → 判失败。
/// 返回值为实际写入的字节数，调用方据此回填 `total`。
pub async fn fetch_unbounded(
    client: &reqwest::Client,
    url: &str,
    file: &mut tokio::fs::File,
    on_progress: OnProgress,
    rate: &Arc<Mutex<Bucket>>,
) -> Result<u64, FetchErr> {
    let resp = send_headers(client.get(url), HEADERS_TIMEOUT).await?;
    let st = resp.status().as_u16();
    if !resp.status().is_success() {
        let e = FetchErr::new("http_status", format!("http {st}")).with_params(json!({"status": st}));
        return Err(if is_fatal_status(st) { FetchErr { fatal: true, ..e } } else { e });
    }
    if st == 206 {
        return Err(FetchErr::fatal("unexpected_206", "server answered 206 to a request without Range"));
    }
    let mut stream = resp.bytes_stream();
    let mut written = 0u64;
    loop {
        match tokio::time::timeout(CHUNK_IDLE, stream.try_next()).await {
            Ok(Ok(Some(bytes))) => {
                let mut pos = 0usize;
                while pos < bytes.len() {
                    let want = (bytes.len() - pos).min(CHUNK as usize);
                    let chunk = crate::state::throttle(rate, want as u64).await.min(want as u64) as usize;
                    file.write_all(&bytes[pos..pos + chunk]).await.map_err(|e| {
                        FetchErr::fatal(io_code(&e), e.to_string())
                            .with_params(json!({"os_error": e.raw_os_error()}))
                    })?;
                    written += chunk as u64;
                    pos += chunk;
                    if let Some((p, base)) = &on_progress {
                        p.store(base + written, Ordering::Relaxed);
                    }
                }
            }
            Ok(Ok(None)) => break, // EOF：长度未知的响应里，这就是「发完了」的唯一凭据。
            Ok(Err(e)) => {
                // 这里分不清「服务端提前断链」和「本来就只剩这点内容」，
                // 只能按失败重下——重下的代价远比交付一个残缺文件小。
                return Err(FetchErr::new(req_code(&e), req_err(&e)));
            }
            Err(_) => {
                return Err(FetchErr::new("read_timeout", "read timeout"));
            }
        }
    }
    Ok(written)
}
