//! stdio 线协议：命令解析（`Cmd`）与一行 JSON 的读写。
//!
//! 协议形状是整个引擎对外最稳定的契约：命令字段名的增减、`event` 事件的形状
//! 都不能随实现随意改，所以把编解码集中在一个文件里，任何一侧变动都只看得到这里。

use serde::Deserialize;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Stdout};

#[derive(Deserialize, Default)]
pub struct Cmd {
    #[serde(default)] pub cmd: String,
    #[serde(default)] pub url: String,
    #[serde(default)] pub dest: String,
    #[serde(default)] pub threads: usize,
    #[serde(default)] pub proxy: String,
    #[serde(default)] pub user_agent: String,
    #[serde(default)] pub n: usize,
    /// 限速，单位 KiB/s，0 = 不限速。`probe` / `run` / `set_rate` 都接受。
    /// 用 `Option` 是为了区分「JSON 里没这个字段」和「显式给 0」：前者**不改**当前限速，
    /// 否则一条裸 `{"cmd":"run"}` 就会把 probe 设好的限速抹成不限速。
    /// 对调用方没有额外负担——写 `"rate_limit_kbps": 512` 即可，和普通数字完全一样。
    #[serde(default)] pub rate_limit_kbps: Option<u64>,
    /// 完成后校验和，空 = 不校验（不产生任何额外磁盘读）。
    /// 形如 `"sha256:<hex>"` / `"sha1:<hex>"` / `"md5:<hex>"`，裸 64 位十六进制按 sha256 处理。
    #[serde(default)] pub checksum: String,
}

pub async fn emit_line(out: &mut tokio::io::BufWriter<Stdout>, v: Value) {
    let _ = out.write_all((v.to_string() + "\n").as_bytes()).await;
    let _ = out.flush().await;
}

/// Read one line from stdin into `buf`.
///
/// 用 `read_until(b'\n')` 拿到原始字节再 `from_utf8_lossy`，而不是 `read_line`——后者遇到
/// 非 UTF-8 字节会返回 Err，旧代码把 Err 当成 EOF 处理（`Ok(_) => None`），于是 Electron 只要
/// 塞进一行坏字节，`main` 的 loop 就 `break`、进程安静 exit 0，协议里连一条 error 事件都没有。
/// 现在非法字节被替换成 U+FFFD，交给 `serde_json` 报 bad json，进程照常存活。
/// 返回：`Ok(Some(line))` 有内容 / `Ok(None)` 干净 EOF / `Err` 真的 IO 读取出错。
pub async fn read_stdin_line(
    reader: &mut BufReader<tokio::io::Stdin>,
    buf: &mut Vec<u8>,
) -> Result<Option<String>, std::io::Error> {
    buf.clear();
    let n = reader.read_until(b'\n', buf).await?;
    if n == 0 {
        return Ok(None);
    }
    let s = String::from_utf8_lossy(buf);
    Ok(Some(s.trim().to_string()))
}