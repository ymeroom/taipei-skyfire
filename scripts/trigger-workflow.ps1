<#
.SYNOPSIS
  觸發一個 GitHub Actions workflow —— 用來取代不準時的 GitHub Actions
  schedule（實測延遲可達 4-7 小時，見 .github/workflows 內註解）。

.DESCRIPTION
  由本機 Windows 工作排程器（見 install-local-scheduler.ps1）在準時的
  本機時鐘上呼叫，等同手動在 GitHub 網頁上按下 workflow_dispatch 的
  「執行」。實際的擷取/評分/鎖定邏輯完全跑在 GitHub Actions 裡，本腳本
  只是負責「準時按下那顆按鈕」。

  記錄與憑證都刻意放在 C:\ProgramData\SkyFireScheduler，不放使用者
  個人設定檔底下、也不放 repo 內：
    - 不放 repo 內：這個 checkout 目錄會被 self-hosted runner 的 workflow
      檢出流程動到，之前縮時擷取的本機產出就是因為放在 repo 內被 git
      clean 清掉過 (見 .remember 記錄)。
    - 不放使用者設定檔 (%LOCALAPPDATA% 等)：本排程工作用 S4U 登入
      (見 install-local-scheduler.ps1 的說明)，S4U 工作階段是否完整載入
      使用者設定檔不保證一致，設定檔路徑可能因執行環境而變動；
      C:\ProgramData 是機器層級路徑，不受設定檔載入狀態影響。

.PARAMETER WorkflowFile
  .github/workflows/ 底下的檔名，例如 lock_forecast.yml

.PARAMETER Session
  sunrise 或 sunset
#>
param(
    [Parameter(Mandatory = $true)][string]$WorkflowFile,
    [Parameter(Mandatory = $true)][ValidateSet('sunrise', 'sunset')][string]$Session
)

# 探針：不管後面任何一步是否失敗，先留下「這個行程真的被啟動了」的
# 證據。C:\ProgramData 不需要載入使用者設定檔就能寫入，所以就算 S4U
# 工作階段的環境變數/設定檔有問題，這一行也不該失敗。
"$(Get-Date -Format o) START user=$env:USERNAME pid=$PID localappdata=[$env:LOCALAPPDATA] cwd=[$PWD]" |
    Out-File -Append -Encoding utf8 'C:\ProgramData\SkyFireScheduler\probe.log'

$repoRoot = Split-Path -Parent $PSScriptRoot
$stateDir = 'C:\ProgramData\SkyFireScheduler'
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
$logFile = Join-Path $stateDir 'trigger.log'
$tokenFile = Join-Path $stateDir 'gh-token.txt'

function Write-Log {
    param([string]$Message)
    $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz'), $Message
    Add-Content -Path $logFile -Value $line
}

# 整支腳本包在 try/catch 裡：任何一步炸掉都要把真正的錯誤訊息寫進
# trigger.log，不能讓 Task Scheduler 只留一個看不出原因的非 0 結果碼。
# (2026-09-11 實測教訓：$ErrorActionPreference='Stop' 搭配沒包 try 的
# token 讀取，炸掉後 Task Scheduler 只回報 LastTaskResult=1，記錄檔
# 連「開始執行」都沒寫到，完全看不出是哪裡壞的。)
try {
    $ErrorActionPreference = 'Stop'
    Write-Log "觸發 $WorkflowFile (session=$Session) ..."

    # gh CLI 預設把登入 token 存在 Windows 認證保存庫 (keyring)，那是用
    # DPAPI 加密、綁定「使用者互動登入工作階段」的 —— S4U 這種無人值守
    # 登入通常拿不到那把主控金鑰的解密權，會導致 gh 認證失敗。
    # 繞過方式：gh 會優先吃 GH_TOKEN 環境變數，優先權高於 keyring。
    # gh-token.txt 由人工用 `gh auth token > ...` 產生一次，不進 git、
    # 不在使用者設定檔底下 (同樣是 S4U 設定檔載入不保證的理由)。
    # 讀取失敗只記錄、不中止 —— 退回 keyring，manual/互動測試時仍可用。
    if (Test-Path $tokenFile) {
        try {
            $env:GH_TOKEN = (Get-Content -Raw -ErrorAction Stop $tokenFile).Trim()
            Write-Log '已載入本機 gh-token.txt'
        } catch {
            Write-Log "讀取 gh-token.txt 失敗，退回 keyring: $($_.Exception.Message)"
        }
    } else {
        Write-Log 'gh-token.txt 不存在，使用 keyring 認證'
    }

    Push-Location $repoRoot
    try {
        $output = & gh workflow run $WorkflowFile -f "session=$Session" 2>&1 | Out-String
        $exitCode = $LASTEXITCODE
        if ($exitCode -eq 0) {
            Write-Log "成功: $($output.Trim())"
        } else {
            Write-Log "失敗 (exit $exitCode): $($output.Trim())"
        }
        exit $exitCode
    } finally {
        Pop-Location
    }
} catch {
    Write-Log "腳本中止於未預期的錯誤: $($_.Exception.Message) | $($_.ScriptStackTrace)"
    exit 1
}
