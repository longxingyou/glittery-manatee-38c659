# Neon 数据库每日逻辑备份（所有 public 表 → gzip JSON → OSCA，保留 7 天）
# 由 Windows 任务计划每天北京时间 04:20 触发，避免与文渊 04:00 备份重叠
$ErrorActionPreference = "Continue"
$date = Get-Date -Format "yyyy-MM-dd"
$localDir = "$env:TEMP\neon-backup"
$jcli = "C:\Users\66386\Downloads\jcli.exe"
$bucket = "22058-ccpy-232011"
$projectRoot = "C:\Projects\my-website\glittery-manatee-38c659"
$node = "C:\Program Files\nodejs\node.exe"
$log = "$localDir\backup-$date.log"

New-Item -ItemType Directory -Force $localDir | Out-Null
"=== $date backup start $(Get-Date -Format 'HH:mm:ss') ===" | Out-File $log

# 1. 逻辑导出（gzip JSON）
$dump = "$localDir\neondb.json.gz"
Push-Location $projectRoot
& $node scripts\dump-db.mjs current $dump neondb 2>&1 | Out-File $log -Append
Pop-Location
if (-not (Test-Path $dump)) { "DUMP FAILED" | Out-File $log -Append; exit 1 }

# 2. 上传不可变日期快照 + latest 指针
& $jcli put -f $dump -r "neondb/snapshots/$date/neondb.json.gz" -bucket $bucket -quiet -retry 10 -multipart-md5 2>> $log
& $jcli put -f $dump -r "neondb/latest/neondb.json.gz" -bucket $bucket -quiet -retry 10 -multipart-md5 2>> $log

# 3. 清理 7 天前的快照目录
$cutoff = (Get-Date).AddDays(-7).ToString("yyyy-MM-dd")
$listOut = & $jcli list -bucket $bucket -prefix "neondb/snapshots/" 2>&1
foreach ($line in $listOut) {
  if ($line -match "neondb/snapshots/(\d{4}-\d{2}-\d{2})") {
    $snapDate = $Matches[1]
    if ($snapDate -lt $cutoff) {
      & $jcli delete -r "neondb/snapshots/$snapDate" -b $bucket -f -nocheck 2>> $log
      "deleted old: neondb/snapshots/$snapDate" | Out-File $log -Append
    }
  }
}

"=== $date backup done $(Get-Date -Format 'HH:mm:ss') ===" | Out-File $log -Append
# 保留最近 10 个日志
Get-ChildItem "$localDir\backup-*.log" | Sort-Object LastWriteTime -Descending | Select-Object -Skip 10 | Remove-Item -Force
