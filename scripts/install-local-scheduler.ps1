<#
.SYNOPSIS
  在本機（Windows 工作排程器）註冊排程工作，取代不準時的 GitHub Actions
  schedule 觸發。涵蓋全部 4 個原本用 schedule 觸發的 workflow。

.DESCRIPTION
  可重複執行 —— 每次都會先移除舊的同名工作再重建，方便以後調整時間。
  每個工作都是呼叫 trigger-workflow.ps1，用 `gh workflow run` 觸發對應
  的 workflow_dispatch。

  「鎖定」類工作（Lock-*）錯過就跳過，不補跑 —— 一個事後才鎖定的預測
  等於造假，不如不做。「擷取/日報」類工作（Capture-*/Briefing-*）錯過
  會在電腦醒來後自動補跑一次 —— DVR 回溯本來就設計成可以事後補抓，
  日報也本來就是回顧性質，補跑不會損及誠實性。

.NOTES
  執行前需求：
    - 已安裝並登入 gh CLI (`gh auth status`)
    - 建議以目前這個互動登入的使用者執行本腳本。排程工作會設定成
      LogonType=Interactive（等同工作排程器 GUI 的「只在使用者登入時
      執行」），不需要另外輸入或儲存密碼。
    - 這台電腦需保持台北時區 (已確認: Taipei Standard Time)，工作排程
      器直接用本機時間，不需要額外轉換。
#>
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$triggerScript = Join-Path $PSScriptRoot 'trigger-workflow.ps1'
$taskFolder = '\SkyFire\'

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    throw '找不到 gh CLI，請先安裝並執行 gh auth login'
}

# LogonType=S4U 需要「以這個帳號身分登入批次工作」的權限，Windows 只在
# 註冊時才授予，這一步需要系統管理員權限。用「以系統管理員身分執行
# PowerShell」再跑本腳本一次即可，之後排程本身平常執行不需要系統管理員。
$isElevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isElevated) {
    throw '需要系統管理員權限才能註冊 S4U 排程工作。請以「系統管理員身分執行」開一個新的 PowerShell 視窗，重新執行本腳本。'
}

# LogonType=S4U：不需要密碼，但不像 Interactive 需要「使用者正處於互動
# 桌面工作階段」—— 這台機器常態以 RDP 連線、斷線後仍要能準時觸發，
# 用 Interactive 實測會「回報成功但其實完全沒執行」(Register 沒問題，
# 但排定時刻到了時若當下沒有真正互動的桌面工作階段，Windows 靜默跳過
# 動作，LastTaskResult 仍顯示 0)。S4U 才是本機無人值守自動化的正確選擇。
$principal = New-ScheduledTaskPrincipal -UserId $env:UserName -LogonType S4U -RunLevel Limited

# Name / 觸發時間 (台北=本機時間) / workflow 檔 / session (空字串 = 不帶
# session 參數，給沒有那個輸入欄位的 workflow 用) / 錯過是否補跑 /
# Weekly+DayOfWeek (省略 = 每天)
$tasks = @(
    @{ Name = 'Lock-Sunset';        Time = '15:30'; File = 'lock_forecast.yml';                Session = 'sunset';  CatchUp = $false }
    @{ Name = 'Lock-Sunrise';       Time = '23:45'; File = 'lock_forecast.yml';                Session = 'sunrise'; CatchUp = $false }
    @{ Name = 'Capture-Sunrise';    Time = '05:30'; File = 'auto_validate_capture.yml';         Session = 'sunrise'; CatchUp = $true }
    @{ Name = 'Briefing-Sunrise';   Time = '09:00'; File = 'auto_validate_capture.yml';         Session = 'sunrise'; CatchUp = $true }
    @{ Name = 'Capture-Sunset';     Time = '18:45'; File = 'auto_validate_capture.yml';         Session = 'sunset';  CatchUp = $true }
    @{ Name = 'Briefing-Sunset';    Time = '21:00'; File = 'auto_validate_capture.yml';         Session = 'sunset';  CatchUp = $true }
    # 縮時視窗前後 40 分鐘，過了就沒意義了，但錯過一次不算誠實性問題
    # (跟主要驗證管線無關，純留存素材)，還是設成補跑，總比完全沒有好。
    @{ Name = 'Timelapse-Sunrise';  Time = '06:30'; File = 'auto_timelapse_multi_station.yml'; Session = 'sunrise'; CatchUp = $true }
    @{ Name = 'Timelapse-Sunset';   Time = '19:00'; File = 'auto_timelapse_multi_station.yml'; Session = 'sunset';  CatchUp = $true }
    # 這個 workflow 沒有 session 輸入欄位，Session 留空；每週一次，非每天。
    @{ Name = 'Weekly-Calibration'; Time = '00:00'; File = 'weekly_auto_calibration.yml';      Session = '';        CatchUp = $true; Weekly = $true; DayOfWeek = 'Monday' }
)

foreach ($t in $tasks) {
    $taskName = $t.Name

    $existing = Get-ScheduledTask -TaskName $taskName -TaskPath $taskFolder -ErrorAction SilentlyContinue
    if ($existing) {
        Unregister-ScheduledTask -TaskName $taskName -TaskPath $taskFolder -Confirm:$false
    }

    $sessionArg = if ($t.Session) { " -Session $($t.Session)" } else { '' }
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
        -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$triggerScript`" -WorkflowFile $($t.File)$sessionArg" `
        -WorkingDirectory $repoRoot

    if ($t.Weekly) {
        $trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek $t.DayOfWeek -At $t.Time
    } else {
        $trigger = New-ScheduledTaskTrigger -Daily -At $t.Time
    }

    $settings = New-ScheduledTaskSettingsSet `
        -WakeToRun `
        -StartWhenAvailable:$t.CatchUp `
        -DontStopOnIdleEnd `
        -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
    # New-ScheduledTaskSettingsSet 沒有「允許在電池模式執行」的開關參數，
    # 兩個電池相關屬性預設一律為 $true (連桌機也一樣)。這台機器多半是
    # 桌機、常態不會真的跑在電池上，但寫死比較保險 —— 以防哪天真的斷電
    # 切到 UPS/筆電，任務不該無聲被跳過。
    $settings.DisallowStartIfOnBatteries = $false
    $settings.StopIfGoingOnBatteries = $false

    $sessionDesc = if ($t.Session) { "session=$($t.Session)" } else { '無 session 參數' }
    Register-ScheduledTask -TaskName $taskName -TaskPath $taskFolder `
        -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
        -Description "SkyFire: 準時觸發 $($t.File) ($sessionDesc)，取代不準時的 GitHub Actions schedule" `
        | Out-Null

    $freqDesc = if ($t.Weekly) { "每週$($t.DayOfWeek)" } else { '每天' }
    Write-Host "已註冊 $taskFolder$taskName -> $freqDesc $($t.Time)，錯過補跑=$($t.CatchUp)"
}

Write-Host ''
Write-Host "全部 $($tasks.Count) 個排程工作已註冊在工作排程器的 \SkyFire\ 資料夾底下。"
Write-Host '記錄檔位置: C:\ProgramData\SkyFireScheduler\trigger.log (探針: probe.log)'
Write-Host ''
Write-Host '已實測驗證: S4U 登入下 gh CLI 直接讀 Windows 憑證保存庫即可成功'
Write-Host '認證，不需要額外的權杖檔案。若未來哪天 gh 認證突然失效，trigger-'
Write-Host 'workflow.ps1 仍支援放一份 C:\ProgramData\SkyFireScheduler\gh-token.txt'
Write-Host '(內容為 `gh auth token` 的輸出) 當備援，優先於 keyring 使用。'
