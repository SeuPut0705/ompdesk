use super::archives::{ArchiveRelease, TailscaleRelease};
use super::types::PlanDownload;

pub fn sh(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
pub fn ps(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}
fn line(d: &PlanDownload) -> String {
    format!(
        "# OMPdesk downloaded {} (SHA-256 {}) to {}\n",
        d.url, d.sha256, d.file
    )
}
fn checksum(d: &PlanDownload) -> String {
    format!(
        "echo {} | shasum -a 256 -c -\n",
        sh(&format!("{}  {}", d.sha256, d.file))
    )
}
fn ps_download(d: &PlanDownload) -> String {
    format!(
        "{}$ErrorActionPreference = 'Stop'\n$file = {}\n$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLowerInvariant()\nif ($hash -ne {}) {{ throw ('SHA-256 mismatch: expected {}, got ' + $hash) }}\nWrite-Output 'SHA-256 verified'\n",
        line(d),
        ps(&d.file),
        ps(&d.sha256),
        d.sha256
    )
}

pub fn bun(install: &str) -> String {
    format!(
        "$ErrorActionPreference = 'Stop'\n$exe = Join-Path {} 'bin\\bun.exe'\n",
        ps(install)
    ) + r#"Get-ChildItem -Path ($exe + '.ompdesk-*') -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
$aside = $null
if (Test-Path -LiteralPath $exe) {
    $aside = $exe + '.ompdesk-' + [DateTime]::UtcNow.Ticks
    try { Move-Item -LiteralPath $exe -Destination $aside } catch { $aside = $null; Write-Output ('Could not move the old bun.exe aside: ' + $_) }
}
$failure = $null
try { Invoke-RestMethod -Uri 'https://bun.sh/install.ps1' | Invoke-Expression } catch { $failure = $_ }
$version = $null
if (Test-Path -LiteralPath $exe) { $version = & $exe --version; if ($LASTEXITCODE -ne 0) { $version = $null } }
if (-not $version) {
    if ($aside -and -not (Test-Path -LiteralPath $exe)) { Move-Item -LiteralPath $aside -Destination $exe }
    if ($failure) { Write-Output $failure }
    throw 'Bun was not installed: bun.exe does not answer --version'
}
if ($aside) { Remove-Item -LiteralPath $aside -Force -ErrorAction SilentlyContinue }
Write-Output ('Bun ' + $version + ' is in ' + $exe)"#
}

pub fn portable_git(dest: &str, d: &PlanDownload) -> String {
    ps_download(d)
        + &format!("$dest = {}\n", ps(dest))
        + r#"$part = $dest + '.partial'
if (Test-Path -LiteralPath $part) { Remove-Item -Recurse -Force -LiteralPath $part }
$proc = Start-Process -FilePath $file -ArgumentList @('-y', ('-o"' + $part + '"')) -Wait -PassThru -WindowStyle Hidden
if ($proc.ExitCode -ne 0) { throw ('PortableGit extraction exited with ' + $proc.ExitCode) }
if (-not (Test-Path -LiteralPath (Join-Path $part 'bin\bash.exe'))) { throw 'bash.exe is missing after extraction' }
if (Test-Path -LiteralPath $dest) { Remove-Item -Recurse -Force -LiteralPath $dest }
Move-Item -LiteralPath $part -Destination $dest
Write-Output ('Git for Windows 2.56.0.2 is in ' + $dest)"#
}

pub fn archive(release: &ArchiveRelease, tools: &str, dest: &str, d: &PlanDownload) -> String {
    let unpack = if release.item == "node" {
        format!(
            "tar -xzf {} -C \"$tmp/x\" --strip-components 1",
            sh(&d.file)
        )
    } else {
        format!(
            "ditto -x -k {} \"$tmp/zip\" && mv \"$tmp\"/zip/*/* \"$tmp/x/\"",
            sh(&d.file)
        )
    };
    format!(
        "{}set -euo pipefail\n{}tmp=\"$(mktemp -d)\"\ntrap 'rm -rf \"$tmp\"' EXIT\nmkdir -p \"$tmp/x\" \"$tmp/zip\"\n{}\nmkdir -p {}\nrm -rf {}\nmv \"$tmp/x\" {}\necho {}",
        line(d),
        checksum(d),
        unpack,
        sh(tools),
        sh(dest),
        sh(dest),
        sh(&format!(
            "{} {} is in {dest}",
            release.item, release.version
        ))
    )
}

pub fn agent_desktop(
    release: &ArchiveRelease,
    tools: &str,
    dest: &str,
    temp: &str,
    d: &PlanDownload,
) -> String {
    format!(
        "{}set -euo pipefail\n{}listing=\"$(tar -tzf {} | LC_ALL=C sort | paste -sd' ' -)\"\n[ \"$listing\" = 'agent-desktop agent-desktop-macos-helper' ] || {{ echo \"Unexpected archive contents: $listing\"; exit 1; }}\nmkdir -p {}\ntmp=\"$(mktemp -d {}XXXXXX)\"\ntrap 'rm -rf \"$tmp\"' EXIT\nmkdir \"$tmp/new\"\ntar -xzf {} -C \"$tmp/new\"\n",
        line(d),
        checksum(d),
        sh(&d.file),
        sh(tools),
        sh(temp),
        sh(&d.file)
    ) + r#"for name in agent-desktop agent-desktop-macos-helper; do
    if [ ! -f "$tmp/new/$name" ] || [ -L "$tmp/new/$name" ]; then echo "$name is not a regular file"; exit 1; fi
    chmod 755 "$tmp/new/$name"
done
chmod 755 "$tmp/new"
"# + &format!(
        "want={}\n",
        sh(&format!("agent-desktop {}", release.version))
    ) + r#"[ "$("$tmp/new/agent-desktop" --version)" = "$want" ] || { echo "The downloaded agent-desktop does not print $want"; exit 1; }
"# + &format!("dest={}\n", sh(dest))
        + r#"if [ -e "$dest" ]; then mv "$dest" "$tmp/old"; fi
mv "$tmp/new" "$dest" || { [ ! -e "$tmp/old" ] || mv "$tmp/old" "$dest"; exit 1; }
if [ "$("$dest/agent-desktop" --version)" != "$want" ]; then
    rm -rf "$dest"
    [ ! -e "$tmp/old" ] || mv "$tmp/old" "$dest"
    echo "agent-desktop in $dest does not print $want"
    exit 1
fi
echo "$want is in $dest""#
}

pub fn agent_desktop_windows(release: &ArchiveRelease, dest: &str, d: &PlanDownload) -> String {
    ps_download(d)
        + &format!("$dest = {}\n", ps(dest))
        + r#"$exe = Join-Path $dest 'agent-desktop.exe'
$part = $dest + '.partial'
$tar = Join-Path $env:SystemRoot 'System32\tar.exe'
$listing = (& $tar -tzf $file | Sort-Object) -join ' '
if ($LASTEXITCODE -ne 0) { throw ('tar.exe could not list the archive (exit ' + $LASTEXITCODE + ')') }
if ($listing -ne 'agent-desktop.exe') { throw ('Unexpected archive contents: ' + $listing) }
if (Test-Path -LiteralPath $part) { Remove-Item -Recurse -Force -LiteralPath $part }
New-Item -ItemType Directory -Force -Path $part | Out-Null
& $tar -xzf $file -C $part
if ($LASTEXITCODE -ne 0) { throw ('tar.exe could not extract the archive (exit ' + $LASTEXITCODE + ')') }
$new = Join-Path $part 'agent-desktop.exe'
if (-not (Test-Path -LiteralPath $new -PathType Leaf)) { throw 'agent-desktop.exe is missing after extraction' }
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Get-ChildItem -Path ($exe + '.ompdesk-*') -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
$aside = $null
if (Test-Path -LiteralPath $exe) {
    $aside = $exe + '.ompdesk-' + [DateTime]::UtcNow.Ticks
    Move-Item -LiteralPath $exe -Destination $aside
}
try { Move-Item -LiteralPath $new -Destination $exe } catch {
    if ($aside -and -not (Test-Path -LiteralPath $exe)) { Move-Item -LiteralPath $aside -Destination $exe }
    throw
}
"# + &format!(
        "$want = {}\n",
        ps(&format!("agent-desktop {}", release.version))
    ) + r#"$version = (& $exe --version | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $version -ne $want) {
    Remove-Item -LiteralPath $exe -Force -ErrorAction SilentlyContinue
    if ($aside) { Move-Item -LiteralPath $aside -Destination $exe }
    throw ('The downloaded agent-desktop.exe does not print ' + $want)
}
if ($aside) { Remove-Item -LiteralPath $aside -Force -ErrorAction SilentlyContinue }
Remove-Item -Recurse -Force -LiteralPath $part -ErrorAction SilentlyContinue
Write-Output ($want + ' is in ' + $exe)"#
}

pub fn tailscale_zip(release: &TailscaleRelease, d: &PlanDownload) -> String {
    format!(
        "{}set -euo pipefail\n{}tmp=\"$(mktemp -d)\"\ntrap 'rm -rf \"$tmp\"' EXIT\nditto -x -k {} \"$tmp\"\n",
        line(d),
        checksum(d),
        sh(&d.file)
    ) + r#"app="$tmp/Tailscale.app"
test -d "$app" || { echo "Tailscale.app is missing from the download"; exit 1; }
codesign --verify --deep --strict "$app"
id="$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$app/Contents/Info.plist")"
case "$id" in io.tailscale.ipn.macsys|io.tailscale.ipn.macos) ;; *) echo "Unexpected bundle id $id"; exit 1;; esac
team="$(codesign -dv "$app" 2>&1 | sed -n 's/^TeamIdentifier=//p')"
[ "$team" = W5364U7YZB ] || { echo "Unexpected signing team $team"; exit 1; }
rm -rf '/Applications/Tailscale.app'
ditto "$app" '/Applications/Tailscale.app'
"# + &format!(
        "echo {}",
        sh(&format!(
            "Tailscale {} is in /Applications/Tailscale.app",
            release.version
        ))
    )
}

pub fn tailscale_msi(d: &PlanDownload) -> String {
    ps_download(d)
        + r#"$sig = Get-AuthenticodeSignature -LiteralPath $file
if ($sig.Status -ne 'Valid') { throw ('Signature is ' + $sig.Status) }
if ($sig.SignerCertificate.Subject -notlike '*CN=Tailscale Inc.*') { throw ('Signed by ' + $sig.SignerCertificate.Subject) }
Write-Output 'Signature verified'
$proc = Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/i', ('"' + $file + '"'), '/qn') -Verb RunAs -Wait -PassThru
if ($proc.ExitCode -ne 0 -and $proc.ExitCode -ne 3010) { throw ('msiexec exited with ' + $proc.ExitCode) }
Write-Output 'Tailscale is installed'"#
}
