Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root
$LogDir = Join-Path $Root 'logs'
$LogFile = Join-Path $LogDir 'opencord.log'
$PidFile = Join-Path $Root '.opencord.pid'
$EnvFile = Join-Path $Root '.env'
$EnvExample = Join-Path $Root '.env.example'
$DataDir = Join-Path $Root 'data'
$BackupDir = Join-Path $Root 'backups'

New-Item -ItemType Directory -Force -Path $LogDir, $BackupDir | Out-Null
if (-not (Test-Path $EnvFile) -and (Test-Path $EnvExample)) { Copy-Item $EnvExample $EnvFile }

function Get-EnvValue([string]$Name, [string]$Default) {
    if (-not (Test-Path $EnvFile)) { return $Default }
    $match = Get-Content $EnvFile | Where-Object { $_ -match "^$([regex]::Escape($Name))=" } | Select-Object -Last 1
    if (-not $match) { return $Default }
    return ($match -split '=', 2)[1].Trim()
}

function Set-EnvValue([string]$Name, [string]$Value) {
    $lines = if (Test-Path $EnvFile) { [System.Collections.Generic.List[string]](Get-Content $EnvFile) } else { [System.Collections.Generic.List[string]]::new() }
    $index = -1
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match "^$([regex]::Escape($Name))=") { $index = $i }
    }
    if ($index -ge 0) { $lines[$index] = "$Name=$Value" } else { $lines.Add("$Name=$Value") }
    Set-Content -Path $EnvFile -Value $lines -Encoding UTF8
}

function Get-LocalIPv4 {
    try {
        $ip = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
            Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.PrefixOrigin -ne 'WellKnown' } |
            Sort-Object InterfaceMetric |
            Select-Object -First 1 -ExpandProperty IPAddress
        if ($ip) { return $ip }
    } catch {}
    try {
        return ([System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName()) |
            Where-Object { $_.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork -and $_.IPAddressToString -notlike '127.*' } |
            Select-Object -First 1).IPAddressToString
    } catch { return '127.0.0.1' }
}

function Get-ServerProcess {
    if (-not (Test-Path $PidFile)) { return $null }
    $storedPid = (Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    if (-not $storedPid) { return $null }
    try { return Get-Process -Id ([int]$storedPid) -ErrorAction Stop } catch {
        Remove-Item $PidFile -ErrorAction SilentlyContinue
        return $null
    }
}

function Invoke-Npm([string[]]$Arguments) {
    $npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue)
    if (-not $npm) { throw 'Node.js/npm was not found. Install Node.js 24 LTS.' }
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $npm.Source
    $psi.WorkingDirectory = $Root
    $psi.Arguments = ($Arguments -join ' ')
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $psi
    [void]$process.Start()
    while (-not $process.HasExited) {
        $line = $process.StandardOutput.ReadLine()
        if ($line) { Add-Content $LogFile $line; $script:LogBox.AppendText("$line`r`n"); $script:LogBox.SelectionStart = $script:LogBox.Text.Length; $script:LogBox.ScrollToCaret(); [System.Windows.Forms.Application]::DoEvents() }
    }
    $out = $process.StandardOutput.ReadToEnd(); $err = $process.StandardError.ReadToEnd()
    if ($out) { Add-Content $LogFile $out }
    if ($err) { Add-Content $LogFile $err }
    if ($process.ExitCode -ne 0) { throw "npm $($Arguments -join ' ') failed. Check the log." }
}

function Ensure-Installed {
    if (-not (Test-Path (Join-Path $Root 'node_modules'))) {
        Invoke-Npm @('install','--no-audit','--no-fund')
    }
}

function Start-OpenCord {
    if (Get-ServerProcess) { return }
    Ensure-Installed
    $npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue)
    if (-not $npm) { throw 'Node.js/npm was not found. Install Node.js 24 LTS.' }
    Add-Content $LogFile "`r`n===== START $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ====="
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'cmd.exe'
    $psi.Arguments = "/d /s /c `"npm start >> `"$LogFile`" 2>&1`""
    $psi.WorkingDirectory = $Root
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $process = [System.Diagnostics.Process]::Start($psi)
    Set-Content -Path $PidFile -Value $process.Id -Encoding ASCII
    Start-Sleep -Milliseconds 700
}

function Stop-OpenCord {
    $process = Get-ServerProcess
    if (-not $process) { return }
    & taskkill.exe /PID $process.Id /T /F | Out-Null
    Remove-Item $PidFile -ErrorAction SilentlyContinue
}

function New-OfflineBackup {
    if (Get-ServerProcess) { throw 'Stop the server before creating a manual backup from the launcher.' }
    $db = Join-Path $DataDir 'opencord.db'
    if (-not (Test-Path $db)) { throw 'The opencord.db database does not exist yet.' }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $dest = Join-Path $BackupDir "opencord-manual-$stamp.db"
    Copy-Item $db $dest
    return $dest
}

function Restore-Backup([string]$Source) {
    if (Get-ServerProcess) { throw 'Stop the server before restoring a backup.' }
    $db = Join-Path $DataDir 'opencord.db'
    if (Test-Path $db) {
        $safety = Join-Path $BackupDir ("opencord-pre-restore-{0}.db" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
        Copy-Item $db $safety
    }
    Remove-Item "$db-wal", "$db-shm" -ErrorAction SilentlyContinue
    Copy-Item $Source $db -Force
}

$form = New-Object System.Windows.Forms.Form
$form.Text = 'OpenCord Self-Host Launcher 0.6.0'
$form.Size = New-Object System.Drawing.Size(940, 650)
$form.MinimumSize = New-Object System.Drawing.Size(820, 560)
$form.StartPosition = 'CenterScreen'
$form.BackColor = [System.Drawing.Color]::FromArgb(40,43,48)
$form.ForeColor = [System.Drawing.Color]::White
$form.Font = New-Object System.Drawing.Font('Segoe UI', 9)

$title = New-Object System.Windows.Forms.Label
$title.Text = 'OpenCord'
$title.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 20)
$title.Location = New-Object System.Drawing.Point(18, 14)
$title.AutoSize = $true
$form.Controls.Add($title)

$status = New-Object System.Windows.Forms.Label
$status.Location = New-Object System.Drawing.Point(20, 58)
$status.Size = New-Object System.Drawing.Size(880, 22)
$form.Controls.Add($status)

$portLabel = New-Object System.Windows.Forms.Label
$portLabel.Text = 'Port:'
$portLabel.Location = New-Object System.Drawing.Point(20, 91)
$portLabel.AutoSize = $true
$form.Controls.Add($portLabel)

$portBox = New-Object System.Windows.Forms.NumericUpDown
$portBox.Location = New-Object System.Drawing.Point(68, 88)
$portBox.Minimum = 1; $portBox.Maximum = 65535
$portBox.Value = [int](Get-EnvValue 'PORT' '4000')
$portBox.Width = 90
$form.Controls.Add($portBox)

function New-Button([string]$Text, [int]$X, [int]$Y, [int]$Width = 120) {
    $b = New-Object System.Windows.Forms.Button
    $b.Text = $Text; $b.Location = New-Object System.Drawing.Point($X,$Y); $b.Size = New-Object System.Drawing.Size($Width,34)
    $b.FlatStyle = 'Flat'; $b.BackColor = [System.Drawing.Color]::FromArgb(66,69,74); $b.ForeColor = [System.Drawing.Color]::White
    return $b
}

$startButton = New-Button 'Start' 180 84 105
$stopButton = New-Button 'Stop' 292 84 105
$openButton = New-Button 'Open browser' 404 84 135
$installButton = New-Button 'Install / Update' 546 84 145
$backupButton = New-Button 'Backup' 698 84 95
$restoreButton = New-Button 'Restore' 800 84 95
$form.Controls.AddRange(@($startButton,$stopButton,$openButton,$installButton,$backupButton,$restoreButton))

$info = New-Object System.Windows.Forms.TextBox
$info.Location = New-Object System.Drawing.Point(20, 132)
$info.Size = New-Object System.Drawing.Size(875, 48)
$info.Multiline = $true; $info.ReadOnly = $true
$info.BackColor = [System.Drawing.Color]::FromArgb(47,49,54); $info.ForeColor = [System.Drawing.Color]::Gainsboro; $info.BorderStyle = 'FixedSingle'
$form.Controls.Add($info)

$logLabel = New-Object System.Windows.Forms.Label
$logLabel.Text = 'Logs'; $logLabel.Location = New-Object System.Drawing.Point(20, 194); $logLabel.AutoSize = $true
$form.Controls.Add($logLabel)

$script:LogBox = New-Object System.Windows.Forms.TextBox
$script:LogBox.Location = New-Object System.Drawing.Point(20, 218)
$script:LogBox.Size = New-Object System.Drawing.Size(875, 355)
$script:LogBox.Anchor = 'Top,Bottom,Left,Right'
$script:LogBox.Multiline = $true; $script:LogBox.ReadOnly = $true; $script:LogBox.ScrollBars = 'Vertical'
$script:LogBox.Font = New-Object System.Drawing.Font('Consolas', 9)
$script:LogBox.BackColor = [System.Drawing.Color]::FromArgb(32,34,37); $script:LogBox.ForeColor = [System.Drawing.Color]::Gainsboro
$form.Controls.Add($script:LogBox)

$footer = New-Object System.Windows.Forms.Label
$footer.Text = 'No Docker • Local SQLite • Node.js 24+'
$footer.Location = New-Object System.Drawing.Point(20, 585); $footer.Anchor = 'Bottom,Left'; $footer.AutoSize = $true
$form.Controls.Add($footer)

$lastLogLength = 0
function Refresh-Ui {
    $running = [bool](Get-ServerProcess)
    $port = [int]$portBox.Value
    $ip = Get-LocalIPv4
    $status.Text = if ($running) { 'Status: ONLINE' } else { 'Status: STOPPED' }
    $status.ForeColor = if ($running) { [System.Drawing.Color]::LightGreen } else { [System.Drawing.Color]::Silver }
    $info.Text = "This PC: http://localhost:$port`r`nLocal network: http://${ip}:$port"
    $startButton.Enabled = -not $running; $stopButton.Enabled = $running; $portBox.Enabled = -not $running

    if (Test-Path $LogFile) {
        $file = Get-Item $LogFile
        if ($file.Length -ne $script:lastLogLength) {
            $content = Get-Content $LogFile -Tail 250 -ErrorAction SilentlyContinue | Out-String
            $script:LogBox.Text = $content
            $script:LogBox.SelectionStart = $script:LogBox.Text.Length
            $script:LogBox.ScrollToCaret()
            $script:lastLogLength = $file.Length
        }
    }
}

$startButton.Add_Click({
    try {
        Set-EnvValue 'PORT' ([string][int]$portBox.Value)
        Start-OpenCord
        Refresh-Ui
    } catch { [System.Windows.Forms.MessageBox]::Show($_.Exception.Message,'OpenCord','OK','Error') | Out-Null }
})
$stopButton.Add_Click({ try { Stop-OpenCord; Refresh-Ui } catch { [System.Windows.Forms.MessageBox]::Show($_.Exception.Message,'OpenCord','OK','Error') | Out-Null } })
$openButton.Add_Click({
    $port = [int]$portBox.Value
    Start-Process "http://localhost:$port"
})
$installButton.Add_Click({
    try {
        $installButton.Enabled = $false
        Invoke-Npm @('install','--no-audit','--no-fund')
        Invoke-Npm @('run','build')
        [System.Windows.Forms.MessageBox]::Show('Dependencies and build updated.','OpenCord') | Out-Null
    } catch { [System.Windows.Forms.MessageBox]::Show($_.Exception.Message,'OpenCord','OK','Error') | Out-Null }
    finally { $installButton.Enabled = $true; Refresh-Ui }
})
$backupButton.Add_Click({
    try { $path = New-OfflineBackup; [System.Windows.Forms.MessageBox]::Show("Backup created at:`r`n$path",'OpenCord') | Out-Null }
    catch { [System.Windows.Forms.MessageBox]::Show($_.Exception.Message,'OpenCord','OK','Error') | Out-Null }
})
$restoreButton.Add_Click({
    try {
        if (Get-ServerProcess) { throw 'Stop the server before restoring a backup.' }
        $dialog = New-Object System.Windows.Forms.OpenFileDialog
        $dialog.Filter = 'SQLite database (*.db)|*.db|All files (*.*)|*.*'
        $dialog.InitialDirectory = $BackupDir
        if ($dialog.ShowDialog() -eq 'OK') {
            $confirm = [System.Windows.Forms.MessageBox]::Show('Restore this backup? The current database will be backed up before restoration.','OpenCord','YesNo','Warning')
            if ($confirm -eq 'Yes') { Restore-Backup $dialog.FileName; [System.Windows.Forms.MessageBox]::Show('Backup restored.','OpenCord') | Out-Null }
        }
    } catch { [System.Windows.Forms.MessageBox]::Show($_.Exception.Message,'OpenCord','OK','Error') | Out-Null }
})
$form.Add_FormClosing({ if (Get-ServerProcess) { } })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1200
$timer.Add_Tick({ Refresh-Ui })
$timer.Start()
Refresh-Ui
[void]$form.ShowDialog()
