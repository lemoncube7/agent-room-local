param(
    [string]$DbName = 'agent-room-db',
    [switch]$SkipMigrate
)
$ErrorActionPreference = 'Stop'
$dir = $PSScriptRoot
$toml = Join-Path $dir 'wrangler.toml'
if (-not (Test-Path -LiteralPath $toml -PathType Leaf)) {
    throw "Missing wrangler.toml. Copy wrangler.toml.example to wrangler.toml and set your D1 database_id."
}
$parent = Split-Path -Parent $dir
Push-Location -LiteralPath $dir
try {
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
