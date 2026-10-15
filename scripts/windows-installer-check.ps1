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

# The one-click setup's window, read through Win32 rather than UI Automation: electron-builder's one-click
# template (SpiderBanner /MODERN) hides the NSIS page, shrinks the setup window and draws its own child dialog
# with a msctls_progress32 on a second thread. Every window the setup process owns is recorded, so a failure
# prints what the setup did show.
$setupWindowsSource = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class SetupWindows {
	delegate bool EnumProc(IntPtr hwnd, IntPtr data);
	[StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
	[DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr data);
	[DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc proc, IntPtr data);
	[DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
	[DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
	[DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
	[DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr hwnd);
	[DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int max);
	// No WM_GETTEXT round trip into the busy setup.
	[DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int InternalGetWindowText(IntPtr hwnd, StringBuilder text, int max);
	[DllImport("user32.dll")] static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam, uint flags, uint timeoutMs, out IntPtr result);
	const uint PBM_GETPOS = 0x0408;
	const uint SMTO_ABORTIFHUNG = 0x0002;

	public static bool SawProgress;
	public static int MaxProgress = -1;
	public static readonly HashSet<string> Buttons = new HashSet<string>();
	public static readonly List<string> Seen = new List<string>();
	static readonly HashSet<string> seenKeys = new HashSet<string>();

	static string ClassOf(IntPtr hwnd) { var text = new StringBuilder(256); GetClassName(hwnd, text, text.Capacity); return text.ToString(); }
	static string TextOf(IntPtr hwnd) { var text = new StringBuilder(512); InternalGetWindowText(hwnd, text, text.Capacity); return text.ToString(); }
	static bool Overlaps(Rect a, Rect b) { return a.Left < b.Right && b.Left < a.Right && a.Top < b.Bottom && b.Top < a.Bottom; }

	static void Note(string line) {
		if (Seen.Count < 300 && seenKeys.Add(line)) Seen.Add(line);
	}

	static string Describe(IntPtr hwnd, Rect rect, bool visible) {
		return string.Format("{0} id={1} '{2}' {3} {4}x{5} at {6},{7}", ClassOf(hwnd), GetDlgCtrlID(hwnd), TextOf(hwnd),
			visible ? "visible" : "hidden", rect.Right - rect.Left, rect.Bottom - rect.Top, rect.Left, rect.Top);
	}

	// Returns how many top-level windows of the process are visible now. A progress bar or button counts only
	// while it and its window are visible and it lies inside that window (the shrunken setup window leaves the
	// NSIS buttons outside it).
	public static int Poll(int pid) {
		int visibleWindows = 0;
		EnumWindows((top, unusedTop) => {
			uint owner;
			GetWindowThreadProcessId(top, out owner);
			if (owner != (uint)pid) return true;
			Rect topRect;
			GetWindowRect(top, out topRect);
			bool topVisible = IsWindowVisible(top) && topRect.Right > topRect.Left && topRect.Bottom > topRect.Top;
			if (topVisible) visibleWindows++;
			Note("window " + Describe(top, topRect, topVisible));
			EnumChildWindows(top, (child, unusedChild) => {
				Rect rect;
				GetWindowRect(child, out rect);
				bool visible = topVisible && IsWindowVisible(child) && rect.Right > rect.Left && rect.Bottom > rect.Top && Overlaps(rect, topRect);
				string cls = ClassOf(child);
				// Static/edit text changes with every file; the class, id and state are what matter.
				Note("  " + (cls == "msctls_progress32" || cls == "Button" ? Describe(child, rect, visible) : string.Format("{0} id={1} {2}", cls, GetDlgCtrlID(child), visible ? "visible" : "hidden")));
				if (!visible) return true;
				if (cls == "msctls_progress32") {
					SawProgress = true;
					IntPtr pos;
					if (SendMessageTimeout(child, PBM_GETPOS, IntPtr.Zero, IntPtr.Zero, SMTO_ABORTIFHUNG, 200, out pos) != IntPtr.Zero)
						MaxProgress = Math.Max(MaxProgress, pos.ToInt32());
				} else if (cls == "Button") {
					Buttons.Add(TextOf(child).Replace("&", ""));
				}
				return true;
			}, IntPtr.Zero);
			return true;
		}, IntPtr.Zero);
		return visibleWindows;
	}
}
'@

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
		Add-Type -TypeDefinition $setupWindowsSource
		$started = Get-Date
		# Exactly what a double-click runs.
		$setupProcess = Start-Process -FilePath $Setup -PassThru
		$shownAt = $null
		$progressAt = $null
		while (-not $setupProcess.HasExited) {
			$elapsed = ((Get-Date) - $started).TotalSeconds
			if ($elapsed -gt 180) {
				Save-Screen 'installer-stuck'
				Stop-Process -Id $setupProcess.Id -Force
				Fail 'the setup did not finish on its own within 3 minutes (a page or question waiting for input?)'
			}
			$visibleWindows = [SetupWindows]::Poll($setupProcess.Id)
			if ($visibleWindows -gt 0 -and $null -eq $shownAt) {
				$shownAt = $elapsed
				Save-Screen 'installer-window'
			}
			if ([SetupWindows]::SawProgress -and $null -eq $progressAt) {
				$progressAt = $elapsed
				Save-Screen 'installer-progress'
			}
			Start-Sleep -Milliseconds 50
		}
		$setupProcess.WaitForExit()
		Write-Host 'windows the setup showed (class, control id, text, state, size):'
		foreach ($line in [SetupWindows]::Seen) { Write-Host "     $line" }
		if ($setupProcess.ExitCode -ne 0) { Fail "the setup exited with $($setupProcess.ExitCode)" }
		Ok "the setup finished on its own in $([int]((Get-Date) - $started).TotalSeconds) s"
		if ($null -eq $shownAt) { Fail 'the setup never showed a window' }
		if (-not [SetupWindows]::SawProgress) { Fail "the setup window (shown at $([int]$shownAt) s) never showed a progress bar" }
		Ok "the setup window showed a progress bar from $([math]::Round($progressAt, 1)) s (highest position read: $([SetupWindows]::MaxProgress))"
		$buttons = @([SetupWindows]::Buttons)
		$asked = @($buttons | Where-Object { $_ -match '^(Next|Install|I Agree|Browse|Back|Yes|No)\b' })
		if ($asked.Count -ne 0) { Fail "the setup showed buttons that ask for input: $($asked -join ', ')" }
		Ok "no Next/Install/Browse button (buttons seen: $(if ($buttons.Count) { $buttons -join ', ' } else { 'none' }))"
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
