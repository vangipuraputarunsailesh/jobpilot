# =============================================================================
# sync-secrets.ps1 — JobPilot one-shot deploy helper
# -----------------------------------------------------------------------------
# What it does (in order):
#   1. Reads secret values from a local .env.deploy file (gitignored).
#   2. Pushes them to GitHub Actions secrets via `gh secret set`.
#   3. Pushes them to the linked Railway service via `railway variables --set`.
#   4. Optionally commits any working-tree changes and pushes to origin,
#      which triggers the Railway auto-deploy webhook.
#
# Prerequisites (one-time):
#   - GitHub CLI:  winget install GitHub.cli   (then `gh auth login`)
#   - Railway CLI: npm i -g @railway/cli       (then `railway login`
#                                               and `railway link` in this repo)
#   - Create scripts\.env.deploy from scripts\.env.deploy.example and fill it.
#
# Usage:
#   pwsh scripts/sync-secrets.ps1                       # sync + (no commit)
#   pwsh scripts/sync-secrets.ps1 -Commit               # sync + commit + push
#   pwsh scripts/sync-secrets.ps1 -Commit -Message "x"  # custom commit message
#   pwsh scripts/sync-secrets.ps1 -SkipGitHub           # only Railway
#   pwsh scripts/sync-secrets.ps1 -SkipRailway          # only GitHub
#   pwsh scripts/sync-secrets.ps1 -DryRun               # show what would happen
#
# SECURITY:
#   - scripts\.env.deploy MUST stay gitignored. The script will refuse to run
#     if it is tracked by git.
#   - Secret values are passed to gh/railway over their stdin/argv only; this
#     script never prints them.
# =============================================================================

[CmdletBinding()]
param(
    [switch] $Commit,
    [string] $Message = "chore: sync deploy config",
    [switch] $SkipGitHub,
    [switch] $SkipRailway,
    [switch] $DryRun,
    [string] $EnvFile = "$PSScriptRoot\.env.deploy"
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path "$PSScriptRoot\..").Path
Set-Location $repoRoot

function Write-Info($msg) { Write-Host "[sync] $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "[ ok ] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "[warn] $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "[err ] $msg" -ForegroundColor Red }

# ── 1. Sanity checks ─────────────────────────────────────────────────────────
if (-not (Test-Path $EnvFile)) {
    Write-Err "Missing $EnvFile. Copy scripts\.env.deploy.example and fill it in."
    exit 1
}

# Refuse to run if .env.deploy is tracked by git (would leak on next commit).
$tracked = git ls-files --error-unmatch "scripts/.env.deploy" 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Err "scripts/.env.deploy is tracked by git. Run: git rm --cached scripts/.env.deploy"
    exit 1
}

# Verify CLIs are present (only those we'll actually use).
if (-not $SkipGitHub) {
    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
        Write-Err "GitHub CLI 'gh' not found. Install: winget install GitHub.cli"; exit 1
    }
    & gh auth status 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Err "Run 'gh auth login' first."; exit 1 }
}
if (-not $SkipRailway) {
    if (-not (Get-Command railway -ErrorAction SilentlyContinue)) {
        Write-Err "Railway CLI not found. Install: npm i -g @railway/cli"; exit 1
    }
    & railway whoami 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Err "Run 'railway login' first."; exit 1 }
}

# ── 2. Parse .env.deploy ─────────────────────────────────────────────────────
# Accepts KEY=value lines, ignores blanks and # comments. Quoted values are
# unquoted. Values are NEVER echoed.
$secrets = [ordered]@{}
foreach ($line in Get-Content $EnvFile) {
    $t = $line.Trim()
    if (-not $t -or $t.StartsWith("#")) { continue }
    $eq = $t.IndexOf("=")
    if ($eq -lt 1) { continue }
    $k = $t.Substring(0, $eq).Trim()
    $v = $t.Substring($eq + 1).Trim()
    if (($v.StartsWith('"') -and $v.EndsWith('"')) -or
        ($v.StartsWith("'") -and $v.EndsWith("'"))) {
        $v = $v.Substring(1, $v.Length - 2)
    }
    $secrets[$k] = $v
}
if ($secrets.Count -eq 0) { Write-Err "$EnvFile has no KEY=value entries."; exit 1 }
Write-Info "Loaded $($secrets.Count) secret(s) from $EnvFile"
Write-Info "Keys: $($secrets.Keys -join ', ')"

# ── 3. Push to GitHub Actions secrets ────────────────────────────────────────
if (-not $SkipGitHub) {
    Write-Info "Pushing GitHub Actions secrets..."
    foreach ($k in $secrets.Keys) {
        if ($DryRun) { Write-Host "  DRY: gh secret set $k --body <hidden>"; continue }
        # --body avoids exposing the value via process listing on most platforms;
        # for max safety we pipe via stdin with --body-file -.
        $secrets[$k] | & gh secret set $k --body-file - 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { Write-Err "Failed: gh secret set $k"; exit 1 }
        Write-Ok "  GitHub: $k"
    }
}

# ── 4. Push to Railway variables ─────────────────────────────────────────────
if (-not $SkipRailway) {
    Write-Info "Pushing Railway service variables..."
    # Build a single `railway variables --set "K=V" --set "K=V" ...` call so
    # the service restarts at most once.
    $setArgs = @()
    foreach ($k in $secrets.Keys) {
        $setArgs += "--set"
        $setArgs += "$k=$($secrets[$k])"
    }
    if ($DryRun) {
        Write-Host "  DRY: railway variables $((@($setArgs | ForEach-Object { if ($_ -like '--set') { $_ } else { ($_ -split '=',2)[0] + '=<hidden>' } })) -join ' ')"
    } else {
        & railway variables @setArgs 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { Write-Err "Failed: railway variables ..."; exit 1 }
        Write-Ok "  Railway: $($secrets.Count) variable(s) updated"
    }
}

# ── 5. Optional: commit + push (triggers Railway auto-deploy) ────────────────
if ($Commit) {
    $changed = git status --porcelain
    if (-not $changed) {
        Write-Info "Nothing to commit; working tree clean."
    } else {
        if ($DryRun) {
            Write-Host "  DRY: git add -A; git commit -m `"$Message`"; git push"
        } else {
            Write-Info "Committing & pushing..."
            git add -A
            # Safety: refuse to push if .env.deploy somehow got staged.
            $staged = git diff --cached --name-only
            if ($staged -contains "scripts/.env.deploy") {
                Write-Err "scripts/.env.deploy is staged. Aborting."; git reset HEAD scripts/.env.deploy; exit 1
            }
            git commit -m $Message
            if ($LASTEXITCODE -ne 0) { Write-Err "git commit failed"; exit 1 }
            git push
            if ($LASTEXITCODE -ne 0) { Write-Err "git push failed"; exit 1 }
            Write-Ok "Pushed. Railway will auto-deploy if the GitHub integration is enabled."
        }
    }
}

Write-Ok "Done."
