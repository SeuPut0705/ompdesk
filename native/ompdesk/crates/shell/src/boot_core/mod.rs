//! `boot.*`'s pure rules (PROTOCOL.md §15.9, batch SX5): the lid policy that keeps a charging laptop awake while work
//! runs, the Windows lid backend over `powercfg`, and the `omp-media://` answers. `captured.json` holds what the
//! TypeScript did before it was deleted; the tests replay it.

pub mod lid;
pub mod lid_runtime;
pub mod media;
pub mod powercfg;
pub mod text;

/// JavaScript's `\s` (and what `String.prototype.trim` removes): the rules here were written against it.
pub(crate) fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}
