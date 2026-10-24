//! Kitty graphics pixel formats and their expansion to RGBA8 for upload. PNG
//! payloads are decoded in the bridge with Wuffs before they are stored.

/// Ghostty's stored pixel formats (`GhosttyKittyImageFormat`).
pub const RGB: u32 = 0;
pub const RGBA: u32 = 1;
pub const GRAY_ALPHA: u32 = 3;
pub const GRAY: u32 = 4;

/// Expand a stored image to RGBA8. Returns false on a length mismatch.
pub fn expand(format: u32, src: &[u8], out: &mut [u8]) -> bool {
    let pixels = out.len() / 4;
    match format {
        RGBA if src.len() == out.len() => out.copy_from_slice(src),
        RGB if src.len() == pixels * 3 => {
            for (o, s) in out.chunks_exact_mut(4).zip(src.chunks_exact(3)) {
                o.copy_from_slice(&[s[0], s[1], s[2], 255]);
            }
        }
        GRAY_ALPHA if src.len() == pixels * 2 => {
            for (o, s) in out.chunks_exact_mut(4).zip(src.chunks_exact(2)) {
                o.copy_from_slice(&[s[0], s[0], s[0], s[1]]);
            }
        }
        GRAY if src.len() == pixels => {
            for (o, &g) in out.chunks_exact_mut(4).zip(src) {
                o.copy_from_slice(&[g, g, g, 255]);
            }
        }
        _ => return false,
    }
    true
}
