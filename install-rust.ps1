# install-rust.ps1 — 一键重装 Rust
# 在 PowerShell 中运行： .\install-rust.ps1

Write-Host "1/3 清理旧安装..." -ForegroundColor Yellow
Remove-Item -Recurse -Force "$env:USERPROFILE\.rustup" -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "$env:USERPROFILE\.cargo" -ErrorAction SilentlyContinue

Write-Host "2/3 下载 rustup-init..." -ForegroundColor Yellow
$url = "https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe"
$out = "$env:TEMP\rustup-init.exe"
Invoke-WebRequest -Uri $url -OutFile $out -UseBasicParsing

Write-Host "3/3 安装 Rust (需要几分钟)..." -ForegroundColor Yellow
& $out -y --default-toolchain stable --profile minimal

Write-Host ""
Write-Host "完成！运行以下命令验证：" -ForegroundColor Green
Write-Host "  $env:USERPROFILE\.cargo\bin\rustc.exe --version"
Write-Host "  $env:USERPROFILE\.cargo\bin\cargo.exe --version"
Write-Host ""
Write-Host "然后回到项目："
Write-Host "  cd D:\13243546\my-chat\src-tauri"
Write-Host "  cargo build"
