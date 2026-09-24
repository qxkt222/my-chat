// db/encryption.rs - Windows DPAPI encryption for API keys

use base64::{engine::general_purpose::STANDARD, Engine};

#[cfg(windows)]
mod win {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB,
    };

    pub fn protect(data: &[u8]) -> Result<Vec<u8>, String> {
        let blob_in = CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr().cast_mut(),
        };
        let mut blob_out = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        // SAFETY: blob_in 是栈上有效 CRYPT_INTEGER_BLOB(pbData 指向 data,
        // 调用期间 data 存活);blob_out 由 DPAPI 分配,pbData 非空时才解引用;
        // 返回后立即用 LocalFree 释放 blob_out.pbData(见下方同样 unsafe 的调用)。
        let result = unsafe {
            CryptProtectData(
                &raw const blob_in,
                windows_sys::w!(""),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                1, // CRYPTPROTECT_UI_FORBIDDEN
                &raw mut blob_out,
            )
        };
        if result == 0 {
            return Err("DPAPI protect failed".to_string());
        }
        // SAFETY: result == 0 表示成功,DPAPI 保证 blob_out.pbData 非空且
        // cbData 字节有效(指向 DPAPI 分配的缓冲区,本进程可读)。
        let out = unsafe {
            std::slice::from_raw_parts(blob_out.pbData, blob_out.cbData as usize).to_vec()
        };
        // SAFETY: blob_out.pbData 由 DPAPI(LocalAlloc)分配,必须用
        // LocalFree 释放;ptr::cast 是纯类型转换,无额外越界。
        unsafe { LocalFree(blob_out.pbData.cast::<std::ffi::c_void>()) };
        Ok(out)
    }

    pub fn unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
        let blob_in = CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr().cast_mut(),
        };
        let mut blob_out = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        // SAFETY: blob_in 是栈上有效 CRYPT_INTEGER_BLOB(pbData 指向 data,
        // 调用期间 data 存活);blob_out 由 DPAPI 分配,非空时才解引用;
        // 返回后立即用 LocalFree 释放(见下方同样 unsafe 的调用)。
        let result = unsafe {
            CryptUnprotectData(
                &raw const blob_in,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                0,
                &raw mut blob_out,
            )
        };
        if result == 0 {
            return Err("DPAPI unprotect failed".to_string());
        }
        // SAFETY: result == 0 表示成功,DPAPI 保证 blob_out.pbData 非空且
        // cbData 字节有效(指向 DPAPI 分配的缓冲区,本进程可读)。
        let out = unsafe {
            std::slice::from_raw_parts(blob_out.pbData, blob_out.cbData as usize).to_vec()
        };
        // SAFETY: blob_out.pbData 由 DPAPI(LocalAlloc)分配,必须用
        // LocalFree 释放;ptr::cast 是纯类型转换,无额外越界。
        unsafe { LocalFree(blob_out.pbData.cast::<std::ffi::c_void>()) };
        Ok(out)
    }
}

#[cfg(not(windows))]
mod win {
    pub fn protect(data: &[u8]) -> Result<Vec<u8>, String> {
        Ok(data.to_vec())
    }
    pub fn unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
        Ok(data.to_vec())
    }
}

/// 加密。失败返回 `Err` —— **绝不返回空串**。
///
/// 旧实现失败时返回 `String::new()`，调用方把空串当密文存下去，
/// 用户的 API key 就这样无声消失了：界面上只表现成「认证失败」，
/// 而真正的原因（DPAPI 失败）没有任何痕迹。换 Windows 账户或重装系统
/// 后 DPAPI 解不开旧密文，正是最常见的触发场景。
pub fn encrypt(plaintext: &str) -> Result<String, String> {
    if plaintext.is_empty() {
        return Ok(String::new());
    }
    win::protect(plaintext.as_bytes())
        .map(|enc| STANDARD.encode(enc))
        .map_err(|e| fail(&format!("DPAPI 加密失败（API key 未能保存）: {e}")))
}

/// 解密。失败返回 `Err` 并落盘日志；调用方决定怎么降级（当前降级为空 key）。
pub fn decrypt(encoded: &str) -> Result<String, String> {
    if encoded.is_empty() {
        return Ok(String::new());
    }
    let bytes = STANDARD.decode(encoded).map_err(|e| {
        fail(&format!(
            "API key 密文不是合法 base64（该 key 需重新输入）: {e}"
        ))
    })?;
    let dec = win::unprotect(&bytes).map_err(|e| {
        fail(&format!(
            "DPAPI 解密失败（换 Windows 账户或重装系统后旧密文解不开，该 key 需重新输入）: {e}"
        ))
    })?;
    String::from_utf8(dec).map_err(|e| {
        fail(&format!(
            "API key 明文不是合法 UTF-8（该 key 需重新输入）: {e}"
        ))
    })
}

/// 失败统一落盘到 `chat_errors.log` —— 否则「key 没了」这件事查无可查。
fn fail(msg: &str) -> String {
    crate::commands::chat::log_chat_error(&format!("ENCRYPTION: {msg}"));
    msg.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 空串直通 + 正常值 roundtrip（Windows 走真 DPAPI，其它平台走直通实现）。
    #[test]
    fn encrypt_decrypt_roundtrip() {
        assert_eq!(encrypt("").expect("空串应直通"), "");
        assert_eq!(decrypt("").expect("空串应直通"), "");

        let secret = "sk-test-1234567890";
        let enc = encrypt(secret).expect("加密应成功");
        assert!(!enc.starts_with("sk-"), "密文不应等于明文");
        assert_eq!(decrypt(&enc).expect("解密应成功"), secret);
    }

    /// 坏密文必须返回 `Err`。
    ///
    /// 旧实现返回空串，让「解不开」与「本来就没有 key」在调用方看来一模一样——
    /// 这正是本轮要修的那个「无声」。
    #[test]
    fn decrypt_rejects_bad_base64() {
        let r = decrypt("!!!!not-base64!!!!");
        assert!(r.is_err(), "坏 base64 应返回 Err，而不是静默空串");
    }
}
