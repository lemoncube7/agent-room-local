param(
    [string]$DbName = 'agent-room-db',
    [switch]$SkipMigrate
)
$ErrorActionPreference = 'Stop'
$dir = $PSScriptRoot
$toml = Join-Path $dir 'wrangler.toml'
$example = Join-Path $dir 'wrangler.toml.example'
$parent = Split-Path -Parent $dir

Push-Location -LiteralPath $dir
try {
    if (-not (Test-Path -LiteralPath $toml -PathType Leaf)) {
        Write-Output '=== Agent Room Cloudflare Workers 초기 설정 ==='
        $whoami = & npx wrangler whoami 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Output 'Cloudflare 로그인이 필요합니다. 브라우저에서 로그인을 완료해 주세요...'
            npx wrangler login
            if ($LASTEXITCODE -ne 0) { throw "wrangler login failed: $LASTEXITCODE" }
        }

        Write-Output "D1 데이터베이스($DbName)를 준비합니다..."
        $d1Out = (& npx wrangler d1 create $DbName 2>&1 | Out-String)
        $dbId = $null
        if ($d1Out -match 'database_id\s*=\s*"([0-9a-fA-F-]+)"') {
            $dbId = $Matches[1]
        } else {
            $listJson = (& npx wrangler d1 list --json 2>&1 | Out-String)
            try {
                $existing = ($listJson | ConvertFrom-Json) | Where-Object { $_.name -eq $DbName } | Select-Object -First 1
                if ($existing -and $existing.uuid) { $dbId = $existing.uuid }
            } catch {}
        }
        if (-not $dbId) {
            throw "D1 database_id를 자동으로 찾지 못했습니다. wrangler.toml.example을 wrangler.toml로 복사해 database_id를 직접 입력해 주세요.`n$d1Out"
        }

        $tpl = Get-Content -LiteralPath $example -Raw -Encoding UTF8
        $cfg = $tpl -replace 'database_id\s*=\s*"[^"]*"', ('database_id = "' + $dbId + '"')
        $cfg = $cfg -replace 'database_name\s*=\s*"[^"]*"', ('database_name = "' + $DbName + '"')
        Set-Content -LiteralPath $toml -Value $cfg -Encoding UTF8
        Write-Output "wrangler.toml 생성 완료 (database_id: $dbId)"

        # Generate random 32-byte hex REMOTE_DEVICE_KEY
        $bytes = New-Object byte[] 32
        [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
        $deviceKey = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
        Write-Output 'REMOTE_DEVICE_KEY 시크릿을 등록합니다...'
        $deviceKey | npx wrangler secret put REMOTE_DEVICE_KEY | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "REMOTE_DEVICE_KEY 등록 실패" }

        $pwSecure = Read-Host '원격 접속용 비밀번호(REMOTE_ACCESS_PASSWORD, 12자 이상 권장)를 입력하세요' -AsSecureString
        $pwPlain = [pscredential]::new('agent-room', $pwSecure).GetNetworkCredential().Password
        if (-not $pwPlain) { throw 'REMOTE_ACCESS_PASSWORD는 비어 있을 수 없습니다.' }
        $pwPlain | npx wrangler secret put REMOTE_ACCESS_PASSWORD | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "REMOTE_ACCESS_PASSWORD 등록 실패" }

        Write-Output ''
        Write-Output '============================================================'
        Write-Output 'PC 앱 [⚙ 설정 -> 원격 연결]에 아래 값을 붙여 넣어 주세요:'
        Write-Output "REMOTE_DEVICE_KEY: $deviceKey"
        Write-Output '============================================================'
        Write-Output ''
    }

    if (-not $SkipMigrate) {
        $sqls = @(
            'schema.sql',
            '0001_multiple_rooms.sql',
            '0002_remote_state.sql',
            '0003_remote_command_id.sql'
        )
        foreach ($sql in $sqls) {
            $path = Join-Path $parent $sql
            if (Test-Path -LiteralPath $path -PathType Leaf) {
                Write-Output "Applying D1 migration: $sql"
                try {
                    npx wrangler d1 execute $DbName --remote --file $path | Out-Host
                } catch {
                    Write-Output "Migration $sql skipped or already applied: $($_.Exception.Message)"
                }
            }
        }
    }
    Write-Output 'Deploying Cloudflare Worker...'
    npx wrangler deploy
    if ($LASTEXITCODE -ne 0) { throw "wrangler deploy failed: $LASTEXITCODE" }
    Write-Output 'Cloudflare Worker deployed successfully.'
} finally {
    Pop-Location
}
