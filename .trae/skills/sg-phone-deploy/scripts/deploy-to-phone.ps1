# 一键部署手机 sing-box 配置：本地 JSON 校验 → 服务器 sing-box check → MTP 写入手机 → 回读校验。
# 用法：.\deploy-to-phone.ps1 [-ConfigPath ...] [-Server 20.89.88.138] [-Key ...] [-SkipServerCheck]
param(
  [string]$ConfigPath = 'C:\Users\66386\AppData\Local\Temp\sg-phone\sg-phone.json',
  [string]$Server = '20.89.88.138',
  [string]$Key = 'C:\Projects\keys\sg-gateway_key.pem',
  [switch]$SkipServerCheck
)
$ErrorActionPreference = 'Stop'
$DevicePath = '::{20D04FE0-3AEA-1069-A2D8-08002B30309D}\\\?\usb#vid_2d95&pid_6012&mi_00#6&24c61fae&0&0000#{6ac27878-a6fa-4155-ba85-f98f491d4f33}'
$srcDir = Split-Path -Parent $ConfigPath
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "==> 1/4 本地 JSON 解析" -ForegroundColor Cyan
try { Get-Content $ConfigPath -Raw | ConvertFrom-Json | Out-Null } catch { throw "config JSON invalid: $_" }
$localSize = (Get-Item $ConfigPath).Length
Write-Host "    OK ($localSize bytes)"

if (-not $SkipServerCheck) {
  Write-Host "==> 2/4 服务器 sing-box check" -ForegroundColor Cyan
  scp -i $Key -o StrictHostKeyChecking=no $ConfigPath "azureuser@${Server}:/tmp/sg-phone.json" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "scp failed" }
  ssh -i $Key -o StrictHostKeyChecking=no "azureuser@${Server}" "sing-box check -c /tmp/sg-phone.json"
  if ($LASTEXITCODE -ne 0) { throw "server sing-box check failed (exit $LASTEXITCODE)" }
  Write-Host "    OK"
} else {
  Write-Host "==> 2/4 跳过服务器校验 (-SkipServerCheck)" -ForegroundColor DarkYellow
}

Write-Host "==> 3/4 写入手机 Download" -ForegroundColor Cyan
& "$scriptDir\copy-phone.ps1" -SrcDir $srcDir
if ($LASTEXITCODE -ne 0) { throw "MTP copy failed" }

Write-Host "==> 4/4 回读校验" -ForegroundColor Cyan
$verifyDir = Join-Path $env:TEMP "sg-phone-readback-$(Get-Random)"
New-Item -ItemType Directory -Force -Path $verifyDir | Out-Null
$shell = New-Object -ComObject Shell.Application
$dev = $shell.Namespace($DevicePath)
if (-not $dev) { throw 'device not found (readback)' }
$storage = ($dev.Items() | Where-Object { $_.IsFolder } | Select-Object -First 1).GetFolder()
$download = ($storage.Items() | Where-Object { $_.Name -eq 'Download' } | Select-Object -First 1).GetFolder()
$dest = $shell.Namespace($verifyDir)
foreach ($n in @('sg-phone.json', 'sg-phone-README.txt')) {
  $download.ParseName($n) | ForEach-Object { $dest.CopyHere($_, 0x14) }
}
Start-Sleep -Seconds 4
$rb = Join-Path $verifyDir 'sg-phone.json'
if (-not (Test-Path $rb)) { throw "readback failed: sg-phone.json not pulled back" }
$rbSize = (Get-Item $rb).Length
if ($rbSize -lt 1000) { throw "readback failed: file too small ($rbSize bytes)" }
try { Get-Content $rb -Raw | ConvertFrom-Json | Out-Null } catch { throw "readback failed: JSON invalid on phone" }
Write-Host "    OK ($rbSize bytes, JSON valid)"

Write-Host ""
Write-Host "部署完成：手机 Download/sg-phone.json ($rbSize B) 已更新。" -ForegroundColor Green
Write-Host "请在手机 SFA 中重新导入该配置（覆盖旧的）再启用 VPN。"
