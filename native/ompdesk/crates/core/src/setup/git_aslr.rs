use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::plans;
use super::scripts::ps;
use super::types::{Platform, SpawnSpec};

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    Fix,
    Undo,
}

pub struct Log {
    pub root: String,
    pub action: Action,
    pub outcome: super::types::RunOutcome,
    pub images: Vec<String>,
    pub output: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Prior {
    Notset,
    On,
    OnRequireRelocs,
}
impl Prior {
    fn nibble(self) -> u8 {
        match self {
            Self::Notset => 0,
            Self::On => 1,
            Self::OnRequireRelocs => 3,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Image {
    pub path: String,
    pub prior: Prior,
}

#[derive(Serialize, Deserialize)]
pub struct Record {
    version: u8,
    roots: BTreeMap<String, Vec<Image>>,
}

fn root_key(root: &str) -> String {
    let root = root.replace('/', "\\");
    let mut parts = Vec::new();
    for part in root.split('\\') {
        match part {
            "." => {}
            ".." if parts
                .last()
                .is_some_and(|part: &&str| !part.ends_with(':') && !part.is_empty()) =>
            {
                parts.pop();
            }
            "" if parts.last() == Some(&"") => {}
            part => parts.push(part),
        }
    }
    parts.join("\\").trim_end_matches('\\').to_lowercase()
}

pub fn own_image(root: &str, image: &str) -> bool {
    let image = root_key(image);
    image.starts_with(&format!("{}\\usr\\", root_key(root))) && image.ends_with(".exe")
}

impl Record {
    pub fn read(file: &Path) -> Self {
        let bytes = std::fs::read_to_string(file).unwrap_or_default();
        Self::parse(&bytes)
    }
    pub fn parse(text: &str) -> Self {
        let record = serde_json::from_str::<Self>(text.trim_start_matches('\u{feff}').trim())
            .ok()
            .filter(|record| record.version == 1);
        let roots = record.map_or_else(BTreeMap::new, |record| {
            record
                .roots
                .into_iter()
                .filter(|(_, images)| !images.is_empty())
                .map(|(root, images)| (root_key(&root), images))
                .collect()
        });
        Self { version: 1, roots }
    }
    pub fn images(&self, root: &str) -> &[Image] {
        self.roots.get(&root_key(root)).map_or(&[], Vec::as_slice)
    }
    pub fn fixed(&mut self, root: &str, changed: Vec<Image>) {
        let images = self.roots.entry(root_key(root)).or_default();
        let mut known: BTreeSet<_> = images
            .iter()
            .map(|image| image.path.to_lowercase())
            .collect();
        for image in changed {
            if known.insert(image.path.to_lowercase()) {
                images.push(image);
            }
        }
    }
    pub fn restored(&mut self, root: &str, restored: &[String]) {
        let key = root_key(root);
        let done: BTreeSet<_> = restored.iter().map(|path| path.to_lowercase()).collect();
        if let Some(images) = self.roots.get_mut(&key) {
            images.retain(|image| !done.contains(&image.path.to_lowercase()));
            if images.is_empty() {
                self.roots.remove(&key);
            }
        }
    }
    pub fn save(&self, file: &Path) -> Result<(), String> {
        // An empty durable record supersedes any earlier retry waiting on a full disk.
        let mut bytes = serde_json::to_vec_pretty(self).map_err(|error| error.to_string())?;
        bytes.push(b'\n');
        crate::disk::saves::write_kept(file, &bytes, Some(0o600), 0o700)
            .map_err(|fault| fault.message)?;
        if self.roots.is_empty() {
            let _ = std::fs::remove_file(file);
        }
        Ok(())
    }
}

fn parse_value(text: &str) -> Option<Value> {
    serde_json::from_str(text.trim_start_matches('\u{feff}').trim()).ok()
}
fn rows(value: Value) -> Vec<Value> {
    match value {
        Value::Array(rows) => rows,
        value => vec![value],
    }
}

pub fn parse_fix(text: &str) -> Vec<Image> {
    let rows = rows(parse_value(text).unwrap_or_else(|| json!([])));
    if rows.iter().any(|row| {
        row.get("path").and_then(Value::as_str).is_none()
            || !row.get("prior").is_some_and(Value::is_number)
    }) {
        return Vec::new();
    }
    rows.into_iter()
        .filter_map(|row| {
            let prior = match row["prior"].as_u64()? {
                0 => Prior::Notset,
                1 => Prior::On,
                3 => Prior::OnRequireRelocs,
                _ => return None,
            };
            Some(Image {
                path: row["path"].as_str()?.to_owned(),
                prior,
            })
        })
        .collect()
}

pub fn parse_undo(text: &str) -> Vec<String> {
    let rows = rows(parse_value(text).unwrap_or_else(|| json!([])));
    rows.into_iter()
        .map(|row| row.as_str().map(str::to_owned))
        .collect::<Option<Vec<_>>>()
        .unwrap_or_default()
}

pub fn undo_input(images: &[Image]) -> String {
    Value::Array(
        images
            .iter()
            .map(|image| json!({"path":image.path,"prior":image.prior.nibble()}))
            .collect(),
    )
    .to_string()
}

pub fn git_aslr_overridden(query: &str, root: &str) -> bool {
    let target = plans::join(Platform::Win32, root, &["usr", "bin", "sh.exe"]).to_lowercase();
    let mut path = None;
    let mut options = None;
    let check = |path: &Option<String>, options: &Option<String>| -> Option<bool> {
        if path.as_deref() != Some(&target) {
            return None;
        }
        let options = options.as_deref()?;
        Some(
            options
                .get(2..4)
                .and_then(|hex| u8::from_str_radix(hex, 16).ok())
                .is_some_and(|byte| byte & 0xf == 2),
        )
    };
    for line in query.lines().chain(std::iter::once("")) {
        if line.trim().is_empty() {
            if let Some(found) = check(&path, &options) {
                return found;
            }
            path = None;
            options = None;
        } else if let Some((_, after)) = line.split_once("FilterFullPath") {
            if let Some((_, value)) = after.split_once("REG_SZ") {
                path = Some(value.trim().to_lowercase());
            }
        } else if let Some((_, after)) = line.split_once("MitigationOptions") {
            if let Some((_, value)) = after.split_once("REG_BINARY") {
                options = Some(
                    value
                        .trim()
                        .chars()
                        .take_while(char::is_ascii_hexdigit)
                        .collect(),
                );
            }
        }
    }
    false
}

const HELPERS: &str = r#"$ifeo = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options'
function Find-Entry([string]$image) {
    $key = Join-Path $ifeo ([System.IO.Path]::GetFileName($image))
    if (-not (Test-Path -LiteralPath $key)) { return $null }
    foreach ($sub in @(Get-ChildItem -LiteralPath $key)) { if ([string]$sub.GetValue('FilterFullPath') -ieq $image) { return $sub } }
    return $null
}
function Get-Options($entry) { if (-not $entry) { return $null }; $o = $entry.GetValue('MitigationOptions'); if ($o -is [byte[]] -and $o.Length -ge 2) { return $o }; return $null }
function Set-Relocate($entry, [byte[]]$options, [int]$value) {
    $options[1] = [byte](($options[1] -band 0xF0) -bor ($value -band 0x0F))
    [Microsoft.Win32.Registry]::SetValue($entry.Name, 'MitigationOptions', $options, [Microsoft.Win32.RegistryValueKind]::Binary)
}"#;

pub fn elevated_script(root: &str, action: Action, input: &Path, output: &Path) -> String {
    let write = format!(
        "ConvertTo-Json -InputObject @($done) -Compress | Set-Content -LiteralPath {} -Encoding UTF8",
        ps(&output.to_string_lossy())
    );
    let body = match action {
        Action::Fix => {
            format!(
                "$images = @(Get-ChildItem -LiteralPath {} -Recurse -File -Filter *.exe | ForEach-Object {{ $_.FullName }})\n",
                ps(&plans::join(Platform::Win32, root, &["usr"]))
            ) + r#"foreach ($image in $images) {
    $entry = Find-Entry $image
    $options = Get-Options $entry
    $prior = if ($options) { $options[1] -band 0x0F } else { 0 }
    if ($prior -eq 2) { continue }
    if (-not $entry) {
        $parent = Join-Path $ifeo ([System.IO.Path]::GetFileName($image))
        if (-not (Test-Path -LiteralPath $parent)) { $null = New-Item -Path $parent -Force }
        Set-ItemProperty -LiteralPath $parent -Name UseFilter -Value 1 -Type DWord
        $entry = New-Item -Path (Join-Path $parent ('{' + [guid]::NewGuid() + '}'))
        Set-ItemProperty -LiteralPath $entry.PSPath -Name FilterFullPath -Value $image
    }
    if (-not $options) { $options = New-Object byte[] 24 }
    Set-Relocate $entry $options 2
    $done += [pscustomobject]@{ path = $image; prior = $prior }
"# + &write + "\n}"
        }
        Action::Undo => {
            format!(
                "foreach ($e in (Get-Content -LiteralPath {} -Raw -Encoding UTF8 | ConvertFrom-Json)) {{\n",
                ps(&input.to_string_lossy())
            ) + r#"    $entry = Find-Entry ([string]$e.path)
    $options = Get-Options $entry
    if ($options -and ($options[1] -band 0x0F) -eq 2) { Set-Relocate $entry $options ([int]$e.prior) }
    $done += [string]$e.path
"# + &write + "\n}"
        }
    };
    format!("$ErrorActionPreference = 'Stop'\n{HELPERS}\n$done = @()\n{write}\n{body}")
}

pub fn spawn(
    system_root: &str,
    root: &str,
    action: Action,
    input: &Path,
    output: &Path,
) -> SpawnSpec {
    let script = elevated_script(root, action, input, output);
    let bytes: Vec<_> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let encoded = base64::prelude::BASE64_STANDARD.encode(bytes);
    let outer = format!(
        "$ErrorActionPreference = 'Stop'\n$proc = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', '{encoded}') -Verb RunAs -Wait -PassThru -WindowStyle Hidden\nif ($proc.ExitCode -ne 0) {{ throw ('The elevated step exited with ' + $proc.ExitCode) }}"
    );
    plans::powershell(system_root, &outer)
}
