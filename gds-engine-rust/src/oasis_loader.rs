use std::io::{Read, Seek};

use anyhow::Result;

use crate::geometry::Library;

/// High-level OASIS loader (parallel to `gds_loader::load_gds`).
///
/// Parsing details live in `oasis_parser`; this module is the public, format-specific
/// entrypoint used by binaries/tests.
pub fn load_oasis<R: Read + Seek>(reader: R) -> Result<Library> {
    crate::oasis_parser::parse_oasis(reader)
}
