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
    /// 自定义请求头（扩展投递的 Referer/Cookie 等）。只在 `probe` / `run` 上有意义：
    /// 这两个命令才真的发 HTTP 请求；其余命令共用这个结构体，serde 默认即可忽略。
    /// 头名大小写不敏感；用 BTreeMap 只是为了让顺序确定（同名大小写变体谁覆盖谁是确定的）。
    /// 缺省 = 空 = 不带任何自定义头。
    #[serde(default)] pub headers: std::collections::BTreeMap<String, String>,
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
/// 单行上限：调用方（主进程）只会发几十到几百字节的命令行。不设限的话，
/// 一个永不换行的畸形字节流会把 `buf` 喂到爆内存（OOM 是整个引擎一起死）。
const MAX_LINE: usize = 1024 * 1024;

pub async fn read_stdin_line(
    reader: &mut BufReader<tokio::io::Stdin>,
    buf: &mut Vec<u8>,
) -> Result<Option<String>, std::io::Error> {
    buf.clear();
    let n = reader.read_until(b'\n', buf).await?;
    if n == 0 {
        return Ok(None);
    }
    if buf.last() != Some(&b'\n') && buf.len() > MAX_LINE {
        // 超限且还没到行尾：截到上限（这一行必然解析失败 → bad json），
        // 残余字节继续读到行尾为止全部丢弃——不然残余会拼成下一行，
        // 把一条命令切成两条。
        buf.truncate(MAX_LINE);
        loop {
            let mut sink = Vec::new();
            let m = reader.read_until(b'\n', &mut sink).await?;
            if m == 0 {
                return Ok(None);
            }
            if sink.last() == Some(&b'\n') {
                break;
            }
        }
    }
    let s = String::from_utf8_lossy(buf);
    Ok(Some(s.trim().to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cmd_headers_default_to_empty() {
        // 老主进程一条头都不给：解析必须照样成功，headers 为空表示「不带自定义头」。
        let c: Cmd = serde_json::from_str(r#"{"cmd":"probe","url":"https://x/y"}"#).unwrap();
        assert_eq!(c.cmd, "probe");
        assert!(c.headers.is_empty());
    }

    #[test]
    fn cmd_parses_headers_map() {
        // 扩展投递的直链：Cookie/Referer 随命令一起过来，字符串→字符串一一对应。
        let c: Cmd = serde_json::from_str(
            r#"{"cmd":"probe","url":"https://x/y","headers":{"Cookie":"a=1; b=2","Referer":"https://site/page"}}"#,
        )
        .unwrap();
        assert_eq!(
            c.headers.get("Cookie").map(String::as_str),
            Some("a=1; b=2")
        );
        assert_eq!(
            c.headers.get("Referer").map(String::as_str),
            Some("https://site/page")
        );
    }

    #[test]
    fn cmd_ignores_headers_on_non_http_commands() {
        // pause/stop 这些命令共用同一个结构体：带了 headers 也只是被忽略，不能报错。
        let c: Cmd = serde_json::from_str(r#"{"cmd":"pause","headers":{"X-Foo":"bar"}}"#).unwrap();
        assert_eq!(c.cmd, "pause");
        assert_eq!(c.headers.get("X-Foo").map(String::as_str), Some("bar"));
    }
}
