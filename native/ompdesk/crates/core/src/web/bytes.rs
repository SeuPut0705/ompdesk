//! The web edge's byte stores (unit 8b): uploads, blobs and the previous builds' assets. Their methods, pushes and
//! events are listed in each module's header.

use crate::server::Registry;

pub fn register(registry: &mut Registry) {
    super::uploads::register(registry);
    super::blobs::register(registry);
    super::archive::register(registry);
}
