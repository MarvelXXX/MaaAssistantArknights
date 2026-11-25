$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
    $job = [Console]::ReadLine() | ConvertFrom-Json
    Add-Type -Path (Join-Path $PSScriptRoot 'MaaBridge.cs')
    [MaaBridge]::Run($job.home, $job.work, $job.client, $job.adb, $job.serial,
        $job.type, $job.params, [string]$job.stageTask, [bool]$job.prepare)
} catch {
    [Console]::Error.WriteLine($_.Exception.GetBaseException().Message)
    exit 1
}
