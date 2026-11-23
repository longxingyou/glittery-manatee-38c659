# 把 sg-phone.json + README 写入手机 Download 目录（MTP）。
# 参数 -SrcDir 默认指向工作目录；换手机/换路径时改 $DevicePath。
param(
  [string]$SrcDir = 'C:\Users\66386\AppData\Local\Temp\sg-phone'
)
$ErrorActionPreference = 'Stop'

# 手机 MTP 设备路径（USB 直连时固定；换手机或换 USB 口后需重新获取）
$DevicePath = '::{20D04FE0-3AEA-1069-A2D8-08002B30309D}\\\?\usb#vid_2d95&pid_6012&mi_00#6&24c61fae&0&0000#{6ac27878-a6fa-4155-ba85-f98f491d4f33}'

$shell = New-Object -ComObject Shell.Application
$dev = $shell.Namespace($DevicePath)
if (-not $dev) { throw 'device not found: phone not connected or DevicePath changed' }

$storage = ($dev.Items() | Where-Object { $_.IsFolder } | Select-Object -First 1).GetFolder()
$downloadItem = $storage.Items() | Where-Object { $_.Name -eq 'Download' } | Select-Object -First 1
if (-not $downloadItem) { throw 'Download folder not found on phone' }
$download = $downloadItem.GetFolder()

# 先删旧文件，避免残留
foreach ($n in @('sg-phone.json', 'sg-phone-README.txt')) {
  $old = $download.ParseName($n)
  if ($old) { $old.InvokeVerb('delete') }
}
Start-Sleep -Seconds 2

# README.txt 复制为 sg-phone-README.txt（手机上更易辨认）
Copy-Item -LiteralPath (Join-Path $SrcDir 'README.txt') -Destination (Join-Path $SrcDir 'sg-phone-README.txt') -Force

$local = $shell.Namespace($SrcDir)
foreach ($name in @('sg-phone.json', 'sg-phone-README.txt')) {
  $file = $local.ParseName($name)
  if (-not $file) { throw "missing local file: $name" }
  $download.CopyHere($file, 0x14)
}

# 等待写入完成（MTP 的 Size 元数据可能恒为 0，不能据此判断；只能等文件出现）
$deadline = (Get-Date).AddSeconds(45)
do {
  Start-Sleep -Milliseconds 800
  $ok = ($download.ParseName('sg-phone.json')) -and ($download.ParseName('sg-phone-README.txt'))
} while ((-not $ok) -and ((Get-Date) -lt $deadline))

foreach ($name in @('sg-phone.json', 'sg-phone-README.txt')) {
  $it = $download.ParseName($name)
  if ($it) { "OK $name" } else { "MISSING $name" }
}
if (-not $ok) { throw 'MTP copy did not finish in time' }
