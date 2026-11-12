//! The renderer's built files a browser may be handed (`server.ts` `#static`, `#resolveFile`, `#brotliOf`): the
//! allowlist, the MIME table, a file resolved inside its root (a symlink pointing out is refused), and the brotli copy:
//! the build's own `.br` beside the file (quality 11, `scripts/precompress-plugin.ts`) when it is not older than the
//! file, else compressed here once at quality 9 (11 is too slow for a request) and kept in memory.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use hyper::body::Bytes;

/// Compressed copies of static files kept in memory, in bytes.
const COMPRESSED_CACHE_MAX_BYTES: usize = 64 * 1024 * 1024;
/// A file at most this long is sent as it is: brotli would cost more than it saves.
pub const BROTLI_MIN_BYTES: u64 = 1024;
const BROTLI_QUALITY: i32 = 9;
const BROTLI_LGWIN: i32 = 22;

const STATIC_DIRS: [&str; 6] = [
    "/assets/",
    "/cmaps/",
    "/standard_fonts/",
    "/wasm/",
    "/icons/",
    "/screenshots/",
];
const STATIC_FILES: [&str; 5] = [
    "/manifest.webmanifest",
    "/sw.js",
    "/pre-paint.js",
    "/favicon.ico",
    "/apple-touch-icon.png",
];
/// Pages of the single-page app: both are `web.html`.
pub const PAGE_ROUTES: [&str; 2] = ["/", "/pair"];
pub const PAGE_FILE: &str = "web.html";

/// Where the built renderer is, as main knows it (`staticRoot`, `previousBuilds`).
pub trait Assets: Send + Sync {
    /// The folder holding `web.html` and the assets; `None` while there is none.
    fn root(&self) -> Option<PathBuf>;
    /// Replaced builds' folders, newest first: a hashed `/assets/` file the current build lacks is served from them.
    fn previous_builds(&self) -> Vec<PathBuf>;
}

pub fn is_page(pathname: &str) -> bool {
    PAGE_ROUTES.contains(&pathname)
}

pub fn is_allowed(pathname: &str) -> bool {
    is_page(pathname)
        || STATIC_FILES.contains(&pathname)
        || STATIC_DIRS.iter().any(|dir| pathname.starts_with(dir))
}

/// `/\\|\0|%00|%2e|%2f|%5c/i`, a `//`, or a `..` segment: never a built file.
pub fn is_bad_path(pathname: &str) -> bool {
    let lower = pathname.to_ascii_lowercase();
    pathname.contains(['\\', '\0'])
        || ["%00", "%2e", "%2f", "%5c"]
            .iter()
            .any(|bad| lower.contains(bad))
        || pathname.contains("//")
        || pathname.split('/').any(|segment| segment == "..")
}

pub fn mime(extension: &str) -> &'static str {
    match extension {
        ".html" => "text/html; charset=utf-8",
        ".js" | ".mjs" => "text/javascript; charset=utf-8",
        ".css" => "text/css; charset=utf-8",
        ".json" | ".map" => "application/json; charset=utf-8",
        ".webmanifest" => "application/manifest+json; charset=utf-8",
        ".svg" => "image/svg+xml",
        ".png" => "image/png",
        ".ico" => "image/x-icon",
        ".jpg" => "image/jpeg",
        ".woff" => "font/woff",
        ".woff2" => "font/woff2",
        ".ttf" => "font/ttf",
        ".wasm" => "application/wasm",
        ".bcmap" | ".pfb" => "application/octet-stream",
        _ => "application/octet-stream",
    }
}

/// `/^(text\/|application\/(json|manifest\+json|wasm)|image\/svg\+xml)/`.
pub fn compressible(content_type: &str) -> bool {
    content_type.starts_with("text/")
        || [
            "application/json",
            "application/manifest+json",
            "application/wasm",
            "image/svg+xml",
        ]
        .iter()
        .any(|prefix| content_type.starts_with(prefix))
}

/// `/\bbr\b/` over the `Accept-Encoding` value: `br` as a whole word.
pub fn accepts_brotli(accept_encoding: &str) -> bool {
    let bytes = accept_encoding.as_bytes();
    let word = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    accept_encoding.match_indices("br").any(|(at, _)| {
        (at == 0 || !word(bytes[at - 1])) && (at + 2 >= bytes.len() || !word(bytes[at + 2]))
    })
}

pub struct File {
    pub path: PathBuf,
    pub size: u64,
    pub modified: SystemTime,
    /// From the last `.` of the resolved path, as the TypeScript read it (a dot in a folder's name counts).
    pub extension: String,
}

/// A regular file inside `root` (symlinks resolved: one pointing out is refused), or `None`.
pub fn resolve_file(root: &Path, relative: &str) -> Option<File> {
    let real_root = std::fs::canonicalize(root).ok()?;
    let real = std::fs::canonicalize(root.join(relative)).ok()?;
    let prefix = format!(
        "{}{}",
        real_root.to_string_lossy(),
        std::path::MAIN_SEPARATOR
    );
    if !real.to_string_lossy().starts_with(&prefix) {
        return None;
    }
    let info = std::fs::metadata(&real).ok()?;
    if !info.is_file() {
        return None;
    }
    let text = real.to_string_lossy();
    let extension = text
        .rfind('.')
        .map_or_else(String::new, |at| text[at..].to_owned());
    Some(File {
        size: info.len(),
        modified: info.modified().ok()?,
        extension,
        path: real,
    })
}

/// Brotli copies kept in memory, keyed by file, size and modification time.
#[derive(Default)]
pub struct CompressedCache {
    state: Mutex<(HashMap<String, Bytes>, usize)>,
}

impl CompressedCache {
    /// The file brotli-compressed: its build's `.br` beside it, else made here at quality 9.
    pub fn brotli_of(&self, file: &File, base: &Path, relative: &str) -> std::io::Result<Bytes> {
        let since_epoch = file
            .modified
            .duration_since(SystemTime::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        let key = format!("{}:{}:{since_epoch}", file.path.display(), file.size);
        if let Some(hit) = self
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .0
            .get(&key)
        {
            return Ok(hit.clone());
        }
        let built = resolve_file(base, &format!("{relative}.br"))
            .filter(|built| built.modified >= file.modified);
        let packed = match built {
            Some(built) => std::fs::read(&built.path)?,
            None => {
                let input = std::fs::read(&file.path)?;
                let params = brotli::enc::BrotliEncoderParams {
                    quality: BROTLI_QUALITY,
                    lgwin: BROTLI_LGWIN,
                    size_hint: usize::try_from(file.size).unwrap_or(usize::MAX),
                    ..Default::default()
                };
                let mut out = Vec::new();
                brotli::BrotliCompress(&mut input.as_slice(), &mut out, &params)?;
                out
            }
        };
        let packed = Bytes::from(packed);
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.1 + packed.len() <= COMPRESSED_CACHE_MAX_BYTES {
            state.1 += packed.len();
            state.0.insert(key, packed.clone());
        }
        Ok(packed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowlist_and_bad_paths() {
        for ok in [
            "/",
            "/pair",
            "/sw.js",
            "/assets/a.js",
            "/icons/x.png",
            "/favicon.ico",
        ] {
            assert!(is_allowed(ok), "{ok}");
        }
        for no in ["/secret.txt", "/assets", "/api/x", "/Sw.js", "/pair/"] {
            assert!(!is_allowed(no), "{no}");
        }
        for bad in [
            "/assets/../x",
            "/assets/%2E%2e/x",
            "/assets//x",
            "/assets/a\\b",
            "/assets/a%00",
            "/assets/%2F",
            "/assets/%5C",
        ] {
            assert!(is_bad_path(bad), "{bad}");
        }
        assert!(!is_bad_path("/assets/a..b.js") && !is_bad_path("/assets/a%20b.js"));
    }

    #[test]
    fn brotli_is_a_whole_word() {
        for yes in ["br", "gzip, deflate, br", "br;q=0", "gzip,br,zstd", "br,"] {
            assert!(accepts_brotli(yes), "{yes}");
        }
        for no in ["gzip", "brotli", "abr", "", "identity"] {
            assert!(!accepts_brotli(no), "{no}");
        }
    }

    #[test]
    fn compressible_types() {
        assert!(
            compressible("text/html; charset=utf-8")
                && compressible("application/wasm")
                && compressible("image/svg+xml")
        );
        assert!(
            !compressible("image/png")
                && !compressible("application/octet-stream")
                && !compressible("font/woff2")
        );
        assert_eq!(mime(".map"), "application/json; charset=utf-8");
        assert_eq!(mime(".nope"), "application/octet-stream");
    }

    #[test]
    fn a_file_is_resolved_only_inside_its_root() {
        let dir = std::env::temp_dir().join(format!("web-assets-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("assets")).unwrap();
        std::fs::write(dir.join("assets/a.js"), "x").unwrap();
        std::fs::write(dir.join("outside.js"), "y").unwrap();
        assert_eq!(
            resolve_file(&dir, "assets/a.js").map(|f| f.extension),
            Some(".js".to_owned())
        );
        assert!(
            resolve_file(&dir, "assets").is_none(),
            "a directory is not a file"
        );
        assert!(
            resolve_file(&dir.join("assets"), "../outside.js").is_none(),
            "outside the root"
        );
        assert!(
            resolve_file(&dir, "assets/../outside.js").is_some(),
            "inside this root"
        );
        assert!(resolve_file(&dir, "assets/missing.js").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
