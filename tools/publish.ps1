# Publish this folder to GitHub (one step).
# Usage:  powershell -NoProfile -ExecutionPolicy Bypass -File tools\publish.ps1
#         ... -Repo cstudio -Token <PAT>
# The token is never written to disk and never printed.
# NOTE: keep this file ASCII-only (Windows PowerShell 5.1 misreads BOM-less UTF-8).

param(
  [string]$Repo = 'cstudio',
  [string]$Description = 'Palm C - a C language IDE for phones: editor + built-in C interpreter + breakpoint debugging, works fully offline as one HTML file.',
  [string]$Token = '',
  [switch]$NoPages
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Fail($msg) { Write-Host ""; Write-Host "[FAIL] $msg" -ForegroundColor Red; exit 1 }
function Step($msg) { Write-Host ""; Write-Host "==> $msg" -ForegroundColor Cyan }

# ---- 0. locate repo root (this file lives in tools/) ----
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root
if (-not (Test-Path (Join-Path $root '.git'))) { Fail "not a git repo: $root" }

# ---- 1. token ----
if (-not $Token) {
  $secure = Read-Host -AsSecureString 'Paste GitHub token (input hidden, right-click to paste)'
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { $Token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}
$Token = $Token.Trim()
if ($Token.Length -lt 20) { Fail 'token looks too short' }
$masked = '***'

$headers = @{
  Authorization          = "Bearer $Token"
  Accept                 = 'application/vnd.github+json'
  'X-GitHub-Api-Version' = '2022-11-28'
  'User-Agent'           = 'palm-c-publisher'
}

# ---- 2. who am I ----
Step 'checking token'
try {
  $me = Invoke-RestMethod -Uri 'https://api.github.com/user' -Headers $headers -Method Get
} catch {
  Fail "token rejected or network blocked: $($_.Exception.Message)"
}
$owner = $me.login
Write-Host "    logged in as: $owner"

# ---- 3. create repo (idempotent) ----
Step "creating/verifying repository $owner/$Repo"
$body = @{
  name           = $Repo
  description    = $Description
  private        = $false
  has_issues     = $true
  has_discussions = $true
  has_wiki       = $false
  auto_init      = $false
} | ConvertTo-Json
$repoUrl = $null
try {
  $r = Invoke-RestMethod -Uri 'https://api.github.com/user/repos' -Headers $headers -Method Post -Body $body -ContentType 'application/json'
  $repoUrl = $r.clone_url
  Write-Host "    created: $($r.html_url)"
} catch {
  $resp = $_.Exception.Response
  $code = if ($resp) { [int]$resp.StatusCode } else { 0 }
  if ($code -eq 422) {
    Write-Host '    repository already exists, reusing it'
    $repoUrl = "https://github.com/$owner/$Repo.git"
  } else {
    Fail "cannot create repository (HTTP $code): $($_.Exception.Message)"
  }
}

# ---- 4. commit anything pending, then push ----
Step 'preparing local commit'
git add -A 2>&1 | Out-Null
$dirty = (git status --porcelain).Length -gt 0
if ($dirty) { git -c user.name="$owner" -c user.email="$owner@users.noreply.github.com" commit -q -m 'update' }

Step "pushing main to $owner/$Repo"
$hasBranch = (git rev-parse --verify --quiet main)
if (-not $hasBranch) { git branch -M main }
$pushUrl = "https://x-access-token:$Token@github.com/$owner/$Repo.git"
$log = & git push --porcelain $pushUrl 'main:main' 2>&1
$code = $LASTEXITCODE
$logText = ($log | Out-String) -replace [regex]::Escape($Token), $masked
if ($code -ne 0) {
  Write-Host $logText
  Fail 'git push failed (see message above)'
}
Write-Host '    pushed'

# ---- 5. keep origin clean (no token inside .git/config) ----
git remote remove origin 2>&1 | Out-Null
git remote add origin "https://github.com/$owner/$Repo.git" 2>&1 | Out-Null

# ---- 6. GitHub Pages ----
$pagesUrl = $null
if (-not $NoPages) {
  Step 'enabling GitHub Pages (branch: main, root)'
  $pbody = @{ source = @{ branch = 'main'; path = '/' } } | ConvertTo-Json
  try {
    $p = Invoke-RestMethod -Uri "https://api.github.com/repos/$owner/$Repo/pages" -Headers $headers -Method Post -Body $pbody -ContentType 'application/json'
    $pagesUrl = $p.html_url
    Write-Host "    pages: $pagesUrl"
  } catch {
    $code = 0
    if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
    if ($code -eq 409 -or $code -eq 422) {
      Write-Host '    pages already enabled (or needs manual click once)'
      $pagesUrl = "https://$owner.github.io/$Repo/"
    } else {
      Write-Host "    [warn] pages not enabled automatically (HTTP $code). Enable it in Settings > Pages."
    }
  }
}

# ---- 7. summary ----
Write-Host ''
Write-Host '------------------------------------------------------------' -ForegroundColor Green
Write-Host "repo   : https://github.com/$owner/$Repo" -ForegroundColor Green
Write-Host "push   : done (branch main)" -ForegroundColor Green
if ($pagesUrl) {
  Write-Host "online : $pagesUrl" -ForegroundColor Green
  Write-Host "offline: ${pagesUrl}%E6%8E%8C%E5%BF%83C-%E7%A6%BB%E7%BA%BF%E7%89%88.html" -ForegroundColor Green
}
Write-Host '------------------------------------------------------------' -ForegroundColor Green
Write-Host 'Done.'
