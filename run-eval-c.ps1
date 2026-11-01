# Eval C pada split DEV saja (set test TIDAK disentuh). Versi Windows dari run-eval-c.sh.
# Jalankan (PowerShell 5.1 atau 7), tanpa mengubah kebijakan eksekusi sistem:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\run-eval-c.ps1 -CheckOnly   (pemeriksaan awal saja)
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\run-eval-c.ps1               (jalankan Eval C)
# Letakkan tree-hash.py di folder yang sama dengan skrip ini (verifikasi isi ky\source).
# Boleh dihentikan (Ctrl+C) dan dijalankan ulang: pertanyaan yang sudah selesai dilewati.
# Bila skrip ini diletakkan di akar repo (folder yang berisi packages\core), -Repo terdeteksi otomatis.
# Parameter: -Repo <folder repomind-scaffold-iter4> -Ky <folder ky> -Model qwen25c3b-8k
param(
  [string]$Repo = $(if (Test-Path (Join-Path $PSScriptRoot 'packages\core')) { $PSScriptRoot } else { Join-Path $env:USERPROFILE 'Downloads\REPO\RepoMind_Paket_Sesi\kode\repomind-scaffold-iter4' }),
  [string]$Ky = (Join-Path $env:USERPROFILE 'Downloads\ky'),
  [string]$Model = 'qwen25c3b-8k',
  [string]$Api = 'http://localhost:11434',
  [int]$K = 8,
  [int]$Budget = 3000,
  [int]$Mcpf = 3,
  [int]$MaxTokens = 200,
  [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'
$KySha = '3541888878c4d303a8bc2ad61815f4e048f55a5d'
$Data = Join-Path $Repo 'eval\data\ky.dataset.jsonl'
$OutDir = Join-Path $Repo 'hasil'

function Die([string]$m) { Write-Host "GAGAL: $m" -ForegroundColor Red; exit 1 }
function Warn([string]$m) { Write-Host "PERINGATAN: $m" -ForegroundColor Yellow }
function Log([string]$path, [string]$line) { Add-Content -Path $path -Value $line -Encoding UTF8 }
function GitOut([string]$dir, [string[]]$gitArgs) {
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { return $null }
  $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try {
    $o = & git -C $dir @gitArgs 2>$null
    if ($LASTEXITCODE -ne 0) { return $null }
    return (($o | ForEach-Object { $_.ToString() }) -join "`n")
  } finally { $ErrorActionPreference = $old }
}

# ---------- pemeriksaan awal ----------
if (-not (Test-Path (Join-Path $Repo 'packages\core'))) { Die "Folder repo salah atau tidak ada: $Repo (harus berisi packages\core; pakai -Repo <folder repomind-scaffold-iter4>)" }
if (-not (Test-Path (Join-Path $Ky 'source'))) { Die "Folder ky tidak ada: $Ky (pakai -Ky ...)" }
if (-not (Test-Path $Data)) { Die "Dataset tidak ada: $Data (salin ky.dataset.jsonl ke eval\data\)" }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Die 'node tidak ditemukan di PATH' }
if (-not (Test-Path (Join-Path $Repo 'node_modules\tsx'))) { Die "dependensi belum terpasang: jalankan 'npm install' di $Repo" }
$common = Join-Path $Repo 'packages\core\scripts\lib\eval-common.ts'
if (-not (Select-String -Path $common -Pattern 'incomplete_refs' -Quiet)) { Die 'patch A-15 belum terpasang (d05 akan ikut terhitung)' }

# sidik jari isi ky\source (tahan zip lintas OS; mendeteksi CRLF/commit lain). tree-hash.py harus satu folder dengan skrip ini.
$KyTree = 'b30fda531dd3ea59ae23c0f20e62456ac41f93f474f4c00a99411636a49d8838'
$kyTreeNow = ''; $kyTreeOk = $false
$treeScript = Join-Path $PSScriptRoot 'tree-hash.py'
$py = Get-Command python -ErrorAction SilentlyContinue; if (-not $py) { $py = Get-Command py -ErrorAction SilentlyContinue }
if ($py -and (Test-Path $treeScript)) {
  $o = & $py.Source $treeScript $Ky
  if ($LASTEXITCODE -eq 0 -and $o) {
    $kyTreeNow = ($o | Select-Object -First 1).ToString().Split(' ')[0]
    if ($kyTreeNow -ne $KyTree) { Die "isi ky\source berbeda dari commit terkunci (sidik jari $kyTreeNow, seharusnya $KyTree). Penyebab umum: CRLF, commit lain, atau berkas berubah." }
    $kyTreeOk = $true
  } else { Warn 'python tidak berjalan (mungkin stub Microsoft Store); isi ky\source tidak diverifikasi' }
} else { Warn 'python atau tree-hash.py tidak ada di folder skrip; isi ky\source tidak diverifikasi' }

$kyHead = GitOut $Ky @('rev-parse', 'HEAD')
if ($kyHead) {
  if ($kyHead.Trim() -ne $KySha) { Die "ky bukan di commit $KySha (sekarang: $($kyHead.Trim()))" }
  $dirty = GitOut $Ky @('status', '--porcelain')
  if ($dirty) { Warn 'ky punya perubahan lokal; nomor baris acuan bisa meleset' }
} elseif (-not $kyTreeOk) { Warn "$Ky bukan repo git dan isinya tidak terverifikasi; tidak bisa memastikan commit $KySha" }

try { $tags = Invoke-RestMethod -Uri "$Api/api/tags" -TimeoutSec 5 } catch { Die "Ollama tidak berjalan di $Api (jalankan aplikasi Ollama)" }
if (-not ($tags.models | Where-Object { $_.name -like "$Model*" })) { Die "model $Model tidak ada di Ollama (cek: ollama list)" }

$os = Get-CimInstance Win32_OperatingSystem
$availMb = [int]($os.FreePhysicalMemory / 1024)
if ($availMb -lt 3500) { Warn "RAM tersedia $availMb MB (<3500); tutup aplikasi berat agar swap tidak mengacaukan latensi" }

if ($CheckOnly) { Write-Host "Pemeriksaan awal LULUS (RAM tersedia $availMb MB). Jalankan tanpa -CheckOnly untuk memulai Eval C." -ForegroundColor Green; exit 0 }

# ---------- catatan lingkungan (E-01) ----------
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$envFile = Join-Path $OutDir 'eval-c-dev-env.txt'
$cpu = (Get-CimInstance Win32_Processor | Select-Object -First 1).Name
$gpu = (Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name }) -join '; '
$repoCommit = GitOut $Repo @('rev-parse', 'HEAD'); if (-not $repoCommit) { $repoCommit = 'bukan-git' }
if (-not $kyHead) { $kyHead = 'tidak-diketahui' }
$ollamaVer = ''; if (Get-Command ollama -ErrorAction SilentlyContinue) { $ollamaVer = ((& ollama --version 2>&1) | ForEach-Object { $_.ToString() }) -join ' ' }
$sha = (Get-FileHash $Data -Algorithm SHA256).Hash.ToLower()
$mdlList = ''; if (Get-Command ollama -ErrorAction SilentlyContinue) { $mdlList = ((& ollama list 2>&1) | ForEach-Object { $_.ToString() } | Where-Object { $_ -match 'qwen' }) -join ' | ' }
$lines = @(
  "== $(Get-Date -Format o) Eval C dev (Windows)",
  "model=$Model k=$K budget=$Budget mcpf=$Mcpf max_tokens=$MaxTokens timeout_ms=400000",
  "ky_sha=$($kyHead.Trim())",
  "ky_source_tree_sha256=$kyTreeNow",
  "repo_commit=$($repoCommit.Trim())",
  "dataset_sha256=$sha",
  "node=$((& node -v)) ollama=$ollamaVer",
  "ollama_list=$mdlList",
  "cpu=$cpu gpu=$gpu ram_tersedia_mb=$availMb"
)
foreach ($l in $lines) { Write-Host $l; Log $envFile $l }

# ---------- cegah tidur selama skrip berjalan (tidak mengubah pengaturan daya sistem) ----------
try {
  Add-Type -Namespace RM -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'
  [void][RM.Power]::SetThreadExecutionState([uint32]2147483649)
} catch { Warn 'tidak bisa mencegah tidur otomatis; atur Sleep ke Never selama Eval C' }

# ---------- pemanasan model ----------
Write-Host 'Memanaskan model...'
try {
  $body = @{ model = $Model; prompt = 'ok'; stream = $false; options = @{ num_predict = 1 } } | ConvertTo-Json -Compress
  [void](Invoke-RestMethod -Method Post -Uri "$Api/api/generate" -ContentType 'application/json' -Body $body -TimeoutSec 900)
} catch { Warn 'pemanasan gagal; baris pertama mungkin lebih lambat' }
if (Get-Command ollama -ErrorAction SilentlyContinue) {
  $ps = ((& ollama ps 2>&1) | ForEach-Object { $_.ToString() }) -join ' | '
  Write-Host "ollama ps: $ps"; Log $envFile "ollama_ps=$ps"
}

# ---------- dua varian ----------
$env:LLM_PROVIDER = 'ollama'; $env:LLM_BASE_URL = "$Api/v1"; $env:LLM_MODEL = $Model; $env:LLM_TIMEOUT_MS = '400000'
$env:K = "$K"; $env:TOKEN_BUDGET = "$Budget"; $env:MCPF = "$Mcpf"; $env:MAX_TOKENS = "$MaxTokens"
Push-Location (Join-Path $Repo 'packages\core')
try {
  foreach ($v in @('compact', 'default')) {
    Write-Host ''; Write-Host "=== varian $v mulai $(Get-Date -Format HH:mm) ==="
    $env:PROMPT_VARIANT = $v
    $log = Join-Path $OutDir "eval-c-dev-$v.log"
    $jsonl = Join-Path $OutDir "llm-dev-$v.jsonl"
    $ErrorActionPreference = 'Continue'
    & node --import tsx scripts/eval-llm.ts $Ky $Data --split dev --out $jsonl 2>&1 | ForEach-Object { $s = $_.ToString(); Write-Host $s; Log $log $s }
    $code = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($code -ne 0) { throw "eval-llm gagal (kode $code) pada varian $v; jalankan ulang skrip untuk melanjutkan" }
  }
} finally {
  Pop-Location
  try { [void][RM.Power]::SetThreadExecutionState([uint32]2147483648) } catch { }
}

if (Get-Command ollama -ErrorAction SilentlyContinue) { & ollama stop $Model 2>&1 | Out-Null }
Write-Host ''
Write-Host "Selesai $(Get-Date -Format HH:mm). Berikutnya: isi nilai_manual di $OutDir\llm-dev-compact.csv dan llm-dev-default.csv, lalu:"
Write-Host "  python summarize-eval-c.py $OutDir"
