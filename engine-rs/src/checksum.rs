//! 完成后校验和：解析、流式哈希、后台校验任务。
//!
//! 这些被拆出来是因为校验涉及三套互不相同的正确性约束，集中在一起便于核对：
//! 1. 解析（`parse_checksum`）必须当场拒绝格式错，不能等到几十 GB 下完才发现校不了；
//! 2. 哈希（`hash_file`）必须逐字节 `{b:02x}` 出串，任何前导零都不能丢；
//! 3. 后台校验（`run_verify`）必须带任务代号/代际回来，主循环只接受「本任务、本代」的结果。

use serde_json::{json, Value};
use sha2::Digest;
use tokio::io::AsyncReadExt;
use tokio::sync::mpsc;

/// 校验和时一次读多少字节。只走一遍顺序读，靠系统页缓存，代价很小。
const HASH_BUF: usize = 128 * 1024;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Alg {
    Sha256,
    Sha1,
    Md5,
}

impl Alg {
    pub fn label(self) -> &'static str {
        match self {
            Alg::Sha256 => "sha256",
            Alg::Sha1 => "sha1",
            Alg::Md5 => "md5",
        }
    }
    pub fn hex_len(self) -> usize {
        match self {
            Alg::Sha256 => 64,
            Alg::Sha1 => 40,
            Alg::Md5 => 32,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Checksum {
    pub alg: Alg,
    /// 小写十六进制。
    pub hex: String,
}

impl Checksum {
    pub fn display(&self) -> String {
        format!("{}:{}", self.alg.label(), self.hex)
    }
}

/// 解析 `"sha256:<hex>"` / `"sha1:<hex>"` / `"md5:<hex>"`（前缀大小写不敏感，
/// 也接受 `sha-256`/`sha-1` 写法），裸 64 位十六进制按 sha256 处理。
/// 空串 → `Ok(None)`（不校验，不做任何额外磁盘读）。
/// 纯函数，便于单元测试。
pub fn parse_checksum(raw: &str) -> Result<Option<Checksum>, String> {
    let s = raw.trim();
    if s.is_empty() {
        return Ok(None);
    }
    let (alg, hex) = match s.split_once(':') {
        Some((name, hex)) => {
            let a = match name.trim().to_ascii_lowercase().as_str() {
                "sha256" | "sha-256" => Alg::Sha256,
                "sha1" | "sha-1" => Alg::Sha1,
                "md5" => Alg::Md5,
                other => return Err(format!("unsupported checksum algorithm: {other}")),
            };
            (a, hex.trim())
        }
        // 裸十六进制只认 sha256 的长度；其余一律要求写前缀，免得把 32 位 md5
        // 猜成 sha1 之类，校验个寂寞。
        None => {
            if s.len() == Alg::Sha256.hex_len() {
                (Alg::Sha256, s)
            } else {
                return Err(format!(
                    "checksum needs an algorithm prefix (sha256:/sha1:/md5:), got {} hex digits",
                    s.len()
                ));
            }
        }
    };
    if !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!("{} checksum is not hexadecimal: {hex}", alg.label()));
    }
    if hex.len() != alg.hex_len() {
        return Err(format!(
            "{} checksum must be {} hex digits, got {}",
            alg.label(),
            alg.hex_len(),
            hex.len()
        ));
    }
    Ok(Some(Checksum { alg, hex: hex.to_ascii_lowercase() }))
}

/// 一遍顺序读把文件哈希出来。
///
/// 逐字节 `format!("{b:02x}")` 而不是 `{:x}` 打 `Output`：后者要求
/// `GenericArray` 实现 `LowerHex`，而那需要给 `D::OutputSize` 加一堆关联类型约束，
/// 换算法时每次都要重写。这里一次哈希一个文件，性能差异可以忽略。
pub async fn hash_file<D: Digest + Send>(path: &str) -> Result<String, String> {
    let mut f = tokio::fs::File::open(path).await.map_err(|e| format!("{path}: {e}"))?;
    let mut hasher = D::new();
    let mut buf = vec![0u8; HASH_BUF];
    loop {
        let n = f.read(&mut buf).await.map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

/// 后台校验的产物：`error` 为 None 表示通过，否则是给用户看的整句错误 + 稳定码。
pub struct VerifyResult {
    pub task_id: u64,
    pub gen: usize,
    pub error: Option<String>,
    pub code: &'static str,
    pub params: Value,
}

async fn digest_file(cs: &Checksum, path: &str) -> Result<String, String> {
    match cs.alg {
        Alg::Sha256 => hash_file::<sha2::Sha256>(path).await,
        Alg::Sha1 => hash_file::<sha1::Sha1>(path).await,
        Alg::Md5 => hash_file::<md5::Md5>(path).await,
    }
}

/// 起一次校验。三种结果都要变成可读文案：通过 / 不一致（保留文件不删）/ 读盘失败。
pub async fn run_verify(cs: Checksum, path: String, task_id: u64, gen: usize, tx: mpsc::UnboundedSender<VerifyResult>) {
    let (error, code, params) = match digest_file(&cs, &path).await {
        Ok(actual) => {
            if actual == cs.hex {
                (None, "", Value::Null)
            } else {
                (
                    Some(format!(
                        "checksum mismatch: expected {}, got {}:{}",
                        cs.display(),
                        cs.alg.label(),
                        actual
                    )),
                    "checksum_mismatch",
                    json!({"alg": cs.alg.label(), "expected": cs.hex, "actual": actual}),
                )
            }
        }
        Err(e) => (
            Some(format!("checksum verify failed: {e}")),
            "checksum_verify_failed",
            Value::Null,
        ),
    };
    let _ = tx.send(VerifyResult { task_id, gen, error, code, params });
}