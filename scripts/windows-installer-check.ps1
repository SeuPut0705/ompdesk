<#
Checks the packaged Windows setup (electron-builder.win.yml: one click, per
user) on a real Windows. ci.yml's manual `installer-check` job runs every mode
on windows-latest (`gh workflow run ci.yml -f installer_check=true`).

  -Mode silent  `setup /S`: per-user install in %LOCALAPPDATA%\Programs\ompdesk,
                Start-menu and desktop shortcuts to it, one HKCU uninstall
                entry and none in HKLM; the installed app opens its window
                (renderer page over CDP); the uninstaller removes all of it.
  -Mode ui      What a double-click runs (no arguments): it must finish on its
                own with no page or question (a one-click window with a
                progress bar, no Next/Install/Browse button), install the same
                way, and start OMPdesk with a window by itself.
  -Mode legacy  -LegacySetup (an assisted-installer release) installed for all
                users first; `setup /S` must remove that copy (HKLM entry,
                Program Files folder, all-users shortcuts) and install per user.

Each mode uninstalls what it installed, so they run one after another.
#>
param(
	[Parameter(Mandatory)] [string] $Setup,
	[Parameter(Mandatory)] [ValidateSet('silent', 'ui', 'legacy')] [string] $Mode,
	[string] $LegacySetup = '',
	[string] $Captures = ''
)
$ErrorActionPreference = 'Stop'
$Setup = (Resolve-Path -LiteralPath $Setup).Path
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\ompdesk'
$exe = Join-Path $installDir 'OMPdesk.exe'
$startMenuLink = Join-Path ([Environment]::GetFolderPath('Programs')) 'OMPdesk.lnk'
$desktopLink = Join-Path ([Environment]::GetFolderPath('Desktop')) 'OMPdesk.lnk'
$uninstallKeys = @{
	HKCU = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
	HKLM = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
}

function Fail([string] $Message) { throw "FAIL ($Mode): $Message" }
function Ok([string] $Message) { Write-Host "ok   $Message" }

function Get-UninstallEntries([string] $Hive) {
	@(Get-ChildItem $uninstallKeys[$Hive] -ErrorAction SilentlyContinue |
			ForEach-Object { Get-ItemProperty $_.PSPath } |
			Where-Object { $_.DisplayName -like 'OMPdesk*' })
}

function Wait-Until([scriptblock] $Condition, [int] $Seconds, [string] $What) {
	$deadline = (Get-Date).AddSeconds($Seconds)
	while ((Get-Date) -lt $deadline) {
		if (& $Condition) { return }
		Start-Sleep -Milliseconds 250
	}
	Fail "timed out after $Seconds s waiting for $What"
}

function Get-ShortcutTarget([string] $Link) {
	(New-Object -ComObject WScript.Shell).CreateShortcut($Link).TargetPath
}

function Save-Screen([string] $Name) {
	if (-not $Captures) { return }
	try {
		Add-Type -AssemblyName System.Windows.Forms, System.Drawing
		New-Item -ItemType Directory -Force -Path $Captures | Out-Null
		$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
		$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
		$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
		$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
		$bitmap.Save((Join-Path $Captures "$Name.png"), [System.Drawing.Imaging.ImageFormat]::Png)
		$graphics.Dispose()
		$bitmap.Dispose()
	} catch {
		Write-Host "note: no screen capture ($($_.Exception.Message))"
	}
}

function Assert-PerUserInstall {
	if (-not (Test-Path -LiteralPath $exe)) { Fail "$exe is missing" }
	Ok "installed in $installDir"
	$entries = Get-UninstallEntries HKCU
	if ($entries.Count -ne 1) { Fail "expected one per-user uninstall entry, found $($entries.Count)" }
	$entry = $entries[0]
	if ($entry.QuietUninstallString -notlike "*$installDir*") { Fail "the uninstall entry points elsewhere: $($entry.QuietUninstallString)" }
	Ok "uninstall entry '$($entry.DisplayName)' $($entry.DisplayVersion): $($entry.QuietUninstallString)"
	if ((Get-UninstallEntries HKLM).Count -ne 0) { Fail 'an all-users uninstall entry exists' }
	Ok 'no all-users uninstall entry'
	foreach ($link in @($startMenuLink, $desktopLink)) {
		if (-not (Test-Path -LiteralPath $link)) { Fail "$link is missing" }
		$target = Get-ShortcutTarget $link
		if ($target -ne $exe) { Fail "$link points to $target" }
		Ok "$link -> $target"
	}
	$entry
}

function Stop-App {
	Get-Process OMPdesk -ErrorAction SilentlyContinue | Stop-Process -Force
	Wait-Until { -not (Get-Process OMPdesk -ErrorAction SilentlyContinue) } 30 'OMPdesk to exit'
}

# Headless (no tray, no automatic machine setup); the CDP page list proves the window loaded its renderer.
function Assert-Launches {
	$env:OMP_GUI_HEADLESS = '1'
	Start-Process -FilePath $exe -ArgumentList '--remote-debugging-port=9333' | Out-Null
	Remove-Item Env:OMP_GUI_HEADLESS
	$script:page = $null
	Wait-Until {
		try {
			$script:page = Invoke-RestMethod -Uri 'http://127.0.0.1:9333/json/list' -TimeoutSec 2 |
				Where-Object { $_.type -eq 'page' -and $_.url -like '*index.html*' } |
				Select-Object -First 1
		} catch { $script:page = $null }
		$null -ne $script:page
	} 120 'the installed app to load its window'
	Ok "the installed app opened its window: '$($script:page.title)' $($script:page.url)"
	Stop-App
}

function Uninstall-PerUser($Entry) {
	$parts = $Entry.QuietUninstallString -split '"', 3
	Start-Process -FilePath $parts[1] -ArgumentList $parts[2].Trim() | Out-Null
	# The uninstaller restarts itself from a temp copy, so wait for its effects, not its process.
	Wait-Until {
		-not (Test-Path -LiteralPath $exe) -and (Get-UninstallEntries HKCU).Count -eq 0 -and
		-not (Test-Path -LiteralPath $startMenuLink) -and -not (Test-Path -LiteralPath $desktopLink)
	} 120 'the uninstaller to remove the app, its entry and its shortcuts'
	Ok 'uninstalled: app, uninstall entry and shortcuts are gone'
}

function Invoke-SilentSetup([string] $File, [string[]] $Arguments) {
	$process = Start-Process -FilePath $File -ArgumentList $Arguments -Wait -PassThru
	if ($process.ExitCode -ne 0) { Fail "$File $Arguments exited with $($process.ExitCode)" }
	Ok "$([IO.Path]::GetFileName($File)) $Arguments exited 0"
}

if ((Get-UninstallEntries HKCU).Count + (Get-UninstallEntries HKLM).Count -ne 0) { Fail 'OMPdesk is already installed' }

switch ($Mode) {
	'silent' {
		Invoke-SilentSetup $Setup @('/S')
		$entry = Assert-PerUserInstall
		Assert-Launches
		Uninstall-PerUser $entry
	}
	'ui' {
		Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
		$ae = [System.Windows.Automation.AutomationElement]
		$started = Get-Date
		# Exactly what a double-click runs.
		$setupProcess = Start-Process -FilePath $Setup -PassThru
		$sawProgress = $false
		$buttons = @{}
		while (-not $setupProcess.HasExited) {
			if (((Get-Date) - $started).TotalSeconds -gt 180) {
				Save-Screen 'installer-stuck'
				Stop-Process -Id $setupProcess.Id -Force
				Fail 'the setup did not finish on its own within 3 minutes (a page or question waiting for input?)'
			}
			try {
				$byProcess = New-Object System.Windows.Automation.PropertyCondition($ae::ProcessIdProperty, $setupProcess.Id)
				foreach ($window in $ae::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $byProcess)) {
					$progressBars = New-Object System.Windows.Automation.PropertyCondition($ae::ControlTypeProperty, [System.Windows.Automation.ControlType]::ProgressBar)
					if (-not $sawProgress -and $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $progressBars).Count -gt 0) {
						$sawProgress = $true
						Ok "the setup window '$($window.Current.Name)' shows a progress bar"
						Save-Screen 'installer-progress'
					}
					$buttonType = New-Object System.Windows.Automation.PropertyCondition($ae::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
					foreach ($button in $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $buttonType)) {
						if ($button.Current.IsOffscreen -eq $false) { $buttons[$button.Current.Name] = $true }
					}
				}
			} catch {
				# The window can close between the lookup and the read.
			}
			Start-Sleep -Milliseconds 100
		}
		if ($setupProcess.ExitCode -ne 0) { Fail "the setup exited with $($setupProcess.ExitCode)" }
		Ok "the setup finished on its own in $([int]((Get-Date) - $started).TotalSeconds) s"
		if (-not $sawProgress) { Fail 'never saw a progress bar in the setup window' }
		$asked = @($buttons.Keys | Where-Object { $_ -match '^(Next|Install|I Agree|Browse|Back|Yes|No)\b' })
		if ($asked.Count -ne 0) { Fail "the setup showed buttons that ask for input: $($asked -join ', ')" }
		Ok "no Next/Install/Browse button (buttons seen: $(if ($buttons.Count) { $buttons.Keys -join ', ' } else { 'none' }))"
		$entry = Assert-PerUserInstall
		Wait-Until {
			@(Get-Process OMPdesk -ErrorAction SilentlyContinue |
					Where-Object { $_.Path -eq $exe -and $_.MainWindowHandle -ne 0 }).Count -gt 0
		} 120 'OMPdesk to start on its own with a window'
		Ok 'OMPdesk started on its own after the install'
		Save-Screen 'app-started'
		Stop-App
		Uninstall-PerUser $entry
	}
	'legacy' {
		if (-not $LegacySetup) { Fail '-LegacySetup is required' }
		$LegacySetup = (Resolve-Path -LiteralPath $LegacySetup).Path
		Invoke-SilentSetup $LegacySetup @('/S', '/allusers')
		$legacy = Get-UninstallEntries HKLM
		if ($legacy.Count -ne 1) { Fail "the assisted installer did not register an all-users install ($($legacy.Count) entries)" }
		$legacyDir = Split-Path -Parent ($legacy[0].UninstallString -split '"', 3)[1]
		$allUsersLinks = @(
			(Join-Path ([Environment]::GetFolderPath('CommonPrograms')) 'OMPdesk.lnk'),
			(Join-Path ([Environment]::GetFolderPath('CommonDesktopDirectory')) 'OMPdesk.lnk')
		)
		Ok "all-users install $($legacy[0].DisplayVersion) in $legacyDir"
		Invoke-SilentSetup $Setup @('/S')
		if ((Get-UninstallEntries HKLM).Count -ne 0) { Fail 'the all-users uninstall entry is still there' }
		if (Test-Path -LiteralPath (Join-Path $legacyDir 'OMPdesk.exe')) { Fail "$legacyDir\OMPdesk.exe is still there" }
		foreach ($link in $allUsersLinks) {
			if (Test-Path -LiteralPath $link) { Fail "$link is still there" }
		}
		Ok 'the all-users copy, its entry and its shortcuts are gone'
		$entry = Assert-PerUserInstall
		Uninstall-PerUser $entry
	}
}
Write-Host "PASS ($Mode)"
