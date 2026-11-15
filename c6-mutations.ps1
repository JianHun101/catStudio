$ErrorActionPreference = 'Continue'
$w = (Get-ChildItem 'D:\Game\ai\catStudy-sessions' -Directory | Where-Object { $_.Name -like '17d152b0-flash*' }).FullName
$srv = Join-Path $w 'packages\server\src\routes\sessions.ts'
$vue = Join-Path $w 'packages\web\src\components\SessionHistoryPanel.vue'

function Run-Test([string]$file, [string]$label) {
  Push-Location $w
  $out = & node node_modules/vitest/vitest.mjs run $file 2>&1
  $code = $LASTEXITCODE
  Pop-Location
  Write-Host "=== $label (exit $code) ==="
  $out | Select-String -Pattern 'Tests\s+\d+|Test Files\s+\d+|FAIL|AssertionError|expected' | Select-Object -Last 6 | ForEach-Object { $_.Line }
}

function Mutate-Browse([string]$path, [string]$pattern, [string]$replacement, [string]$label, [string]$testFile) {
  $enc = [System.Text.UTF8Encoding]::new($false)
  $orig = [IO.File]::ReadAllText($path)
  $start = $orig.IndexOf("app.get('/api/sessions/:id/messages/browse'")
  $end = $orig.IndexOf("app.get('/api/sessions/:id/messages/facets'")
  if ($start -lt 0 -or $end -lt 0) { throw 'browse block not found' }
  $head = $orig.Substring(0, $start)
  $block = $orig.Substring($start, $end - $start)
  $tail = $orig.Substring($end)
  $newBlock = [regex]::Replace($block, $pattern, $replacement)
  if ($newBlock -eq $block) { throw "mutation pattern not applied: $label" }
  [IO.File]::WriteAllText($path, $head + $newBlock + $tail, $enc)
  try {
    Run-Test $testFile $label
  } finally {
    [IO.File]::WriteAllText($path, $orig, $enc)
  }
}

try {
  Mutate-Browse $srv "if \(from !== undefined && \(typeof from !== 'string' \|\| !from\.trim\(\)\)\) \{\s*return reply\.status\(400\)\.send\(\{ error: 'from[^']*' \}\)\s*\}" "if (false) { /* mutated */ }" 'M1 browse from-validation removed' 'packages/server/src/routes/sessions.test.ts'
  Mutate-Browse $srv "if \(to !== undefined && \(typeof to !== 'string' \|\| !to\.trim\(\)\)\) \{\s*return reply\.status\(400\)\.send\(\{ error: 'to[^']*' \}\)\s*\}" "if (false) { /* mutated */ }" 'M1b browse to-validation removed' 'packages/server/src/routes/sessions.test.ts'
  Mutate-Browse $srv 'Math\.min\(Math\.max\(parsedLimit, 1\), 100\)' 'Math.min(Math.max(parsedLimit, 1), 1000)' 'M2 browse limit upper bound 100 -> 1000' 'packages/server/src/routes/sessions.test.ts'
  Mutate-Browse $srv 'Math\.min\(Math\.max\(parsedLimit, 1\), 100\)' 'Math.min(parsedLimit, 100)' 'M3 browse lower clamp removed (probe for discrimination gap)' 'packages/server/src/routes/sessions.test.ts'

  $enc2 = [System.Text.UTF8Encoding]::new($false)
  $origVue = [IO.File]::ReadAllText($vue)
  $mut = $origVue.Replace('<div v-if="revealNote" class="hist-reveal-note">', '<div v-if="revealNote" class="hist-reveal-err">')
  if ($mut -eq $origVue) { throw 'M4 pattern not applied' }
  [IO.File]::WriteAllText($vue, $mut, $enc2)
  try {
    Run-Test 'packages/web/src/components/SessionHistoryPanel.test.ts' 'M4 system note class -> err'
  } finally {
    [IO.File]::WriteAllText($vue, $origVue, $enc2)
  }
} finally {
  Write-Host '=== git status after restore ==='
  git -C $w status --short
}
