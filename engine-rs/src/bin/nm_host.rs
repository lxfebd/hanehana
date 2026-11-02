//! Chrome native messaging 宿主中继：把桌面端的私有帧转成 Chrome 认的原生消息帧。
//!
//! 为什么需要它：Chrome 按「stdout 首 4 字节 = 小端长度」切帧，一个字节都不能多。
//! 桌面端是 Electron 应用，Windows 上启动时原生代码会往 stdout 写 "\r\n"（JS 拦不掉），
//! 这 2 个字节会让 Chrome 把首 4 字节当成长度头，整条链路直接错位。
//! 所以让一个**不依赖 Electron 的小 exe**当中继：Chrome 启动它，它的 stdout 天然干净，
//! 再由它扫描桌面端的 stdout、滤掉杂字节后按 Chrome 协议重写帧。
//!
//! 两条协议：
//!   桌面端 → 中继（桌面端 stdout）：b"HHNM" + 4 字节小端长度 + UTF-8 JSON
//!   中继 → Chrome（中继 stdout）：  4 字节小端长度 + UTF-8 JSON
//!
//! 规矩：中继的 stdout 是协议车道，**只能有协议帧**；所有日志/警告一律走 stderr。

use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};

/// 桌面端私有帧的魔数。扫描时靠它对齐：桌面端 stdout 上的其它字节
/// （Electron 写的 "\r\n" 等）一律跳过，只认带魔数的帧。
const MAGIC: &[u8; 4] = b"HHNM";
/// Chrome 原生消息单条上限 1 MiB。超长的帧当无效帧丢掉——不能为了"等它读完"
/// 把桌面端可能吐出的巨量数据整个收进内存。
const MAX_FRAME: usize = 1024 * 1024;
/// 桌面端约定的环境变量名：桌面端读它来判断"这次调用来自哪个扩展 origin"。
const ORIGIN_ENV: &str = "HANEHANA_NM_ORIGIN";
/// 桌面端 exe 的文件名（打包后与中继同属一个 resources 目录）。
const DESKTOP_EXE: &str = "hanehana.exe";

/// 帧扫描器：喂进任意分片的字节流，吐出其中凑齐的、JSON 合法的帧（payload 是原始 JSON 字节）。
///
/// 为什么做成纯逻辑：桌面端 stdout 上既有 Electron 的杂字节、又会分片到达，
/// 这些边界靠真实进程复现很麻烦，纯函数测起来最快也最稳。
struct FrameScanner {
    buf: Vec<u8>,
}

impl FrameScanner {
    fn new() -> Self {
        Self { buf: Vec::new() }
    }

    /// 喂一段字节，返回这一段里凑齐的完整帧。
    fn push(&mut self, chunk: &[u8]) -> Vec<Vec<u8>> {
        self.buf.extend_from_slice(chunk);
        let mut frames = Vec::new();
        loop {
            let Some(pos) = find(&self.buf, MAGIC) else {
                // 没找到魔数：只留末尾 3 字节（可能是魔数的前半截，等下一段凑齐），其余丢掉。
                let keep = self.buf.len().saturating_sub(MAGIC.len() - 1);
                self.buf.drain(..keep);
                break;
            };
            if pos > 0 {
                // 魔数之前都是杂字节（Electron 的 "\r\n" 等），丢掉。
                self.buf.drain(..pos);
            }
            if self.buf.len() < MAGIC.len() + 4 {
                // 长度头还没到齐，等下一段。
                break;
            }
            let len =
                u32::from_le_bytes([self.buf[4], self.buf[5], self.buf[6], self.buf[7]]) as usize;
            if len == 0 || len > MAX_FRAME {
                // 无效帧：丢掉魔数+长度头继续扫。超长时我们不知道正文到哪结束，
                // 只能让正文里的字节被当成杂字节跳过——这正是"无效帧"的含义。
                self.buf.drain(..MAGIC.len() + 4);
                continue;
            }
            if self.buf.len() < MAGIC.len() + 4 + len {
                // 正文还没到齐，等下一段。
                break;
            }
            let payload = self.buf[MAGIC.len() + 4..MAGIC.len() + 4 + len].to_vec();
            self.buf.drain(..MAGIC.len() + 4 + len);
            // JSON 解析不过的帧不能转给 Chrome：Chrome 收到坏 JSON 会直接断链。
            if serde_json::from_slice::<serde_json::Value>(&payload).is_ok() {
                frames.push(payload);
            }
            // JSON 非法 → 丢掉这一帧，继续扫后面的。
        }
        frames
    }
}

/// 在字节流里找子串，返回第一个出现的位置。
fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// 按 Chrome 原生消息协议写一帧：4 字节小端长度 + UTF-8 JSON，**不多写一个字节**。
fn write_chrome_frame(out: &mut impl Write, payload: &[u8]) -> std::io::Result<()> {
    let len = u32::try_from(payload.len()).map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "frame too large for chrome",
        )
    })?;
    out.write_all(&len.to_le_bytes())?;
    out.write_all(payload)?;
    out.flush()
}

/// 往 stdout 写一个错误帧。stdout 是协议车道，所以错误也得是"帧"，不能是裸文本。
fn emit_error_frame(msg: &str) {
    let payload = serde_json::json!({ "ok": false, "error": msg }).to_string();
    let mut out = std::io::stdout();
    if let Err(e) = write_chrome_frame(&mut out, payload.as_bytes()) {
        eprintln!("[nm-host] 写错误帧失败: {e}");
    }
}

/// 定位桌面端 exe，返回第一个真实存在的候选。
///
/// 候选顺序覆盖三种布局：
///   - 环境变量（开发/测试时显式指定）
///   - 打包布局：resources/xxx/fastdrop-nm-host.exe → ../hanehana.exe
///   - 同目录
///   - 开发布局：engine-rs/target/release/ 上溯三级到仓库根 → app/release/win-unpacked/hanehana.exe
///
/// 不做信任判断：origin 由桌面端自己校验，这里只负责把字节搬过去。
fn locate_desktop() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(p) = std::env::var("HANEHANA_APP_EXE") {
        if !p.is_empty() {
            candidates.push(PathBuf::from(p));
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("..").join(DESKTOP_EXE));
            candidates.push(dir.join(DESKTOP_EXE));
            candidates.push(
                dir.join("..")
                    .join("..")
                    .join("..")
                    .join("app")
                    .join("release")
                    .join("win-unpacked")
                    .join(DESKTOP_EXE),
            );
        }
    }
    for c in candidates {
        if c.exists() {
            return Some(c);
        }
        eprintln!("[nm-host] 桌面端候选不存在: {}", c.display());
    }
    None
}

fn main() {
    std::process::exit(run());
}

fn run() -> i32 {
    // Chrome 启动原生宿主时，argv[1] 就是扩展的 origin。
    let origin = match std::env::args().nth(1) {
        Some(o) if !o.is_empty() => o,
        _ => {
            eprintln!("[nm-host] 缺少 origin 参数");
            emit_error_frame("缺少 origin 参数");
            return 1;
        }
    };

    let desktop = match locate_desktop() {
        Some(p) => p,
        None => {
            eprintln!("[nm-host] 找不到桌面端程序");
            emit_error_frame("找不到桌面端程序");
            return 1;
        }
    };
    eprintln!("[nm-host] origin={origin} desktop={}", desktop.display());

    let mut cmd = Command::new(&desktop);
    cmd.env(ORIGIN_ENV, &origin);
    // 必须删掉 ELECTRON_RUN_AS_NODE：带着它 Electron 会退化成纯 Node 模式，
    // 直接崩在启动阶段，桌面端根本起不来。
    cmd.env_remove("ELECTRON_RUN_AS_NODE");
    // stdin 直接给桌面端：Chrome 的输入管道由桌面端自己读（native messaging 的请求方向）。
    cmd.stdin(Stdio::inherit());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::inherit());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[nm-host] 启动桌面端失败: {e}");
            emit_error_frame("启动桌面端失败");
            return 1;
        }
    };
    let mut child_out = match child.stdout.take() {
        Some(s) => s,
        None => {
            eprintln!("[nm-host] 拿不到桌面端 stdout");
            let _ = child.kill();
            emit_error_frame("启动桌面端失败");
            return 1;
        }
    };

    let mut scanner = FrameScanner::new();
    let mut sent = 0usize;
    let mut buf = [0u8; 64 * 1024];
    let mut out = std::io::stdout();
    loop {
        match child_out.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                for payload in scanner.push(&buf[..n]) {
                    if let Err(e) = write_chrome_frame(&mut out, &payload) {
                        // Chrome 那边断链了：桌面端再写也没用，直接收摊。
                        eprintln!("[nm-host] 写 Chrome 帧失败: {e}");
                        let _ = child.kill();
                        let _ = child.wait();
                        return 1;
                    }
                    sent += 1;
                }
            }
            Err(e) => {
                eprintln!("[nm-host] 读桌面端 stdout 失败: {e}");
                break;
            }
        }
    }

    // 桌面端退出后中继退出，退出码跟随桌面端。
    let code = match child.wait() {
        Ok(s) => s.code().unwrap_or(1),
        Err(e) => {
            eprintln!("[nm-host] 等桌面端退出失败: {e}");
            1
        }
    };
    if sent == 0 {
        // 一个帧都没产出：桌面端多半是启动就崩了。给 Chrome 一个说得清的答复，
        // 而不是让它对着空 stdout 干等。
        emit_error_frame("桌面端未返回应答");
    }
    code
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 造一个私有帧：魔数 + 小端长度 + JSON。
    fn frame(json: &str) -> Vec<u8> {
        let mut v = MAGIC.to_vec();
        v.extend_from_slice(&(json.len() as u32).to_le_bytes());
        v.extend_from_slice(json.as_bytes());
        v
    }

    #[test]
    fn scanner_reads_a_normal_frame() {
        let mut s = FrameScanner::new();
        let frames = s.push(&frame(r#"{"ok":true}"#));
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0], br#"{"ok":true}"#.to_vec());
    }

    #[test]
    fn scanner_skips_junk_before_frame() {
        // Electron 在 Windows 启动时写的就是 "\r\n"——不过滤会让 Chrome 错位。
        let mut s = FrameScanner::new();
        let mut data = b"\r\n".to_vec();
        data.extend_from_slice(&frame(r#"{"ok":true}"#));
        let frames = s.push(&data);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0], br#"{"ok":true}"#.to_vec());
    }

    #[test]
    fn scanner_waits_for_fragmented_frame() {
        let mut s = FrameScanner::new();
        let data = frame(r#"{"ok":true}"#);
        let cut = data.len() / 2;
        assert!(s.push(&data[..cut]).is_empty());
        let frames = s.push(&data[cut..]);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0], br#"{"ok":true}"#.to_vec());
    }

    #[test]
    fn scanner_keeps_magic_split_across_chunks() {
        // 魔数本身也可能被切在两段里，不能把前半截当杂字节丢掉。
        let mut s = FrameScanner::new();
        assert!(s.push(b"xxHH").is_empty());
        let mut rest = b"NM".to_vec();
        rest.extend_from_slice(&frame(r#"{"ok":true}"#)[4..]);
        let frames = s.push(&rest);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0], br#"{"ok":true}"#.to_vec());
    }

    #[test]
    fn scanner_drops_oversized_frame_and_keeps_scanning() {
        let mut s = FrameScanner::new();
        let mut data = MAGIC.to_vec();
        data.extend_from_slice(&((MAX_FRAME + 1) as u32).to_le_bytes());
        data.extend_from_slice(b"way too long payload");
        assert!(s.push(&data).is_empty());
        // 超长帧被丢掉后，后面的正常帧仍要能扫出来。
        let frames = s.push(&frame(r#"{"ok":true}"#));
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0], br#"{"ok":true}"#.to_vec());
    }

    #[test]
    fn scanner_drops_frame_with_invalid_json() {
        // 坏 JSON 不能转给 Chrome：它收到就会断链。
        let mut s = FrameScanner::new();
        assert!(s.push(&frame("not json")).is_empty());
        let frames = s.push(&frame(r#"{"ok":true}"#));
        assert_eq!(frames.len(), 1);
    }

    #[test]
    fn chrome_frame_is_length_prefixed_utf8() {
        let payload = br#"{"ok":true}"#;
        let mut out = Vec::new();
        write_chrome_frame(&mut out, payload).unwrap();
        assert_eq!(out.len(), 4 + payload.len());
        assert_eq!(&out[..4], &(payload.len() as u32).to_le_bytes());
        assert_eq!(&out[4..], payload);
    }
}
