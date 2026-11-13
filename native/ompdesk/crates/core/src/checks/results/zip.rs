//! Reads the files of a zip archive as GitHub serves a workflow artifact (`actions/artifacts/<id>/zip`): the central
//! directory, then each entry stored or deflated. Bounded, because the archive is a job's upload: at most
//! `MAX_ENTRIES` files of at most `MAX_ENTRY` bytes each are read, and what is past that is left out. No zip64 (a
//! test report is megabytes) and no encryption; such an archive is refused.

use std::io::Read;

use flate2::read::DeflateDecoder;

const MAX_ENTRIES: usize = 64;
pub const MAX_ENTRY: u64 = 64 * 1024 * 1024;
const EOCD: [u8; 4] = [b'P', b'K', 5, 6];
const CENTRAL: [u8; 4] = [b'P', b'K', 1, 2];
const LOCAL: [u8; 4] = [b'P', b'K', 3, 4];
/// The end record is 22 bytes plus a comment of at most 65 535.
const EOCD_SEARCH: usize = 22 + 65_535;

fn u16_at(bytes: &[u8], at: usize) -> Option<usize> {
    Some(usize::from(u16::from_le_bytes(
        bytes.get(at..at + 2)?.try_into().ok()?,
    )))
}

fn u32_at(bytes: &[u8], at: usize) -> Option<usize> {
    usize::try_from(u32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?)).ok()
}

/// Every file of the archive that `wanted` names, with its bytes, in the archive's order.
pub fn files(zip: &[u8], wanted: &dyn Fn(&str) -> bool) -> Result<Vec<(String, Vec<u8>)>, String> {
    let from = zip.len().saturating_sub(EOCD_SEARCH);
    let end = zip[from..]
        .windows(4)
        .rposition(|w| w == EOCD)
        .map(|at| from + at)
        .ok_or("not a zip archive (no end record)")?;
    let broken = || "a broken zip archive".to_string();
    let count = u16_at(zip, end + 10).ok_or_else(broken)?;
    let mut at = u32_at(zip, end + 16).ok_or_else(broken)?;
    if count == 0xffff || at == 0xffff_ffff {
        return Err("a zip64 archive is not read".into());
    }
    let mut out = Vec::new();
    for _ in 0..count {
        if zip.get(at..at + 4) != Some(&CENTRAL[..]) {
            return Err(broken());
        }
        let flags = u16_at(zip, at + 8).ok_or_else(broken)?;
        let method = u16_at(zip, at + 10).ok_or_else(broken)?;
        let packed = u32_at(zip, at + 20).ok_or_else(broken)?;
        let size = u32_at(zip, at + 24).ok_or_else(broken)?;
        let (name_len, extra_len, comment_len) = (
            u16_at(zip, at + 28).ok_or_else(broken)?,
            u16_at(zip, at + 30).ok_or_else(broken)?,
            u16_at(zip, at + 32).ok_or_else(broken)?,
        );
        let local = u32_at(zip, at + 42).ok_or_else(broken)?;
        let name = zip.get(at + 46..at + 46 + name_len).ok_or_else(broken)?;
        let name = String::from_utf8_lossy(name).replace('\\', "/");
        at += 46 + name_len + extra_len + comment_len;
        if name.ends_with('/') || !wanted(&name) || out.len() >= MAX_ENTRIES {
            continue;
        }
        if flags & 1 != 0 {
            return Err(format!("{name} is encrypted"));
        }
        if size as u64 > MAX_ENTRY {
            continue;
        }
        if zip.get(local..local + 4) != Some(&LOCAL[..]) {
            return Err(broken());
        }
        let data = local
            + 30
            + u16_at(zip, local + 26).ok_or_else(broken)?
            + u16_at(zip, local + 28).ok_or_else(broken)?;
        let body = zip.get(data..data + packed).ok_or_else(broken)?;
        let bytes = match method {
            0 => body.to_vec(),
            8 => {
                // The directory's size is the writer's word: read no more than the bound whatever it says.
                let mut bytes = Vec::with_capacity(size.min(1 << 20));
                DeflateDecoder::new(body)
                    .take(MAX_ENTRY + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|e| format!("{name}: {e}"))?;
                if bytes.len() as u64 > MAX_ENTRY {
                    continue;
                }
                bytes
            }
            other => return Err(format!("{name}: compression method {other} is not read")),
        };
        out.push((name, bytes));
    }
    Ok(out)
}

#[cfg(test)]
pub(crate) mod tests {
    use std::io::Write;

    use flate2::Compression;
    use flate2::write::DeflateEncoder;

    use super::*;

    /// A zip as a streaming writer makes it: sizes in the directory, deflated unless `stored`.
    pub(crate) fn archive(files: &[(&str, &[u8], bool)]) -> Vec<u8> {
        let (mut out, mut directory) = (Vec::new(), Vec::new());
        for (name, bytes, stored) in files {
            let body = if *stored {
                bytes.to_vec()
            } else {
                let mut encoder = DeflateEncoder::new(Vec::new(), Compression::default());
                encoder.write_all(bytes).unwrap();
                encoder.finish().unwrap()
            };
            let method: u16 = if *stored { 0 } else { 8 };
            let offset = out.len() as u32;
            let sizes = |v: &mut Vec<u8>| {
                v.extend(0u32.to_le_bytes());
                v.extend((body.len() as u32).to_le_bytes());
                v.extend((bytes.len() as u32).to_le_bytes());
                v.extend((name.len() as u16).to_le_bytes());
            };
            out.extend(LOCAL);
            out.extend([20, 0, 0, 0]);
            out.extend(method.to_le_bytes());
            out.extend([0; 4]);
            sizes(&mut out);
            out.extend(4u16.to_le_bytes());
            out.extend(name.as_bytes());
            out.extend([0xca, 0xfe, 0, 0]);
            out.extend(&body);
            directory.extend(CENTRAL);
            directory.extend([20, 0, 20, 0, 0, 0]);
            directory.extend(method.to_le_bytes());
            directory.extend([0; 4]);
            sizes(&mut directory);
            directory.extend([0; 12]);
            directory.extend(offset.to_le_bytes());
            directory.extend(name.as_bytes());
        }
        let start = out.len() as u32;
        let count = files.len() as u16;
        out.extend(&directory);
        out.extend(EOCD);
        out.extend([0; 4]);
        out.extend(count.to_le_bytes());
        out.extend(count.to_le_bytes());
        out.extend((directory.len() as u32).to_le_bytes());
        out.extend(start.to_le_bytes());
        out.extend(7u16.to_le_bytes());
        out.extend(b"comment");
        out
    }

    #[test]
    fn it_reads_stored_and_deflated_files_and_only_those_wanted() {
        let long = "x".repeat(100_000);
        let zip = archive(&[
            ("vitest.json", b"{\"a\":1}", false),
            ("notes.txt", b"skip me", true),
            ("nested\\junit.xml", long.as_bytes(), false),
            ("plain.json", b"[]", true),
        ]);
        let wanted = |name: &str| name.ends_with(".json") || name.ends_with(".xml");
        let files = files(&zip, &wanted).unwrap();
        let names: Vec<&str> = files.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(names, ["vitest.json", "nested/junit.xml", "plain.json"]);
        assert_eq!(files[0].1, b"{\"a\":1}");
        assert_eq!(files[1].1.len(), 100_000);
    }

    #[test]
    fn what_is_no_archive_or_is_cut_short_is_an_error_never_a_panic() {
        assert!(files(b"", &|_| true).is_err());
        assert!(files(b"<html>Not Found</html>", &|_| true).is_err());
        let zip = archive(&[("a.json", b"{}", false), ("b.json", b"{}", true)]);
        for cut in 0..zip.len() {
            let _ = files(&zip[..cut], &|_| true);
            let mut damaged = zip.clone();
            damaged[cut] ^= 0xff;
            let _ = files(&damaged, &|_| true);
        }
    }
}
