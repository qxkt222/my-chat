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

pub fn encrypt(plaintext: &str) -> String {
    if plaintext.is_empty() {
        return String::new();
    }
    match win::protect(plaintext.as_bytes()) {
        Ok(enc) => STANDARD.encode(&enc),
        Err(_) => String::new(),
    }
}

pub fn decrypt(encoded: &str) -> String {
    if encoded.is_empty() {
        return String::new();
    }
    let Ok(bytes) = STANDARD.decode(encoded) else {
        return String::new();
    };
    match win::unprotect(&bytes) {
        Ok(dec) => String::from_utf8(dec).unwrap_or_default(),
        Err(_) => String::new(),
    }
}
