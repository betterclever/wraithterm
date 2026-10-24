//! Kitty graphics support: PNG decoding for Ghostty and pixel expansion for upload.
use std::io::Cursor;

/// Ghostty's stored pixel formats (`GhosttyKittyImageFormat`).
pub const RGB: u32 = 0;
pub const RGBA: u32 = 1;
pub const GRAY_ALPHA: u32 = 3;
pub const GRAY: u32 = 4;

fn decoder(bytes: &[u8]) -> png::Decoder<Cursor<&[u8]>> {
    let mut decoder = png::Decoder::new(Cursor::new(bytes));
    // Palette, low bit depth and tRNS become 8-bit channels; 16-bit is stripped.
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    decoder
}

/// Width and height from a PNG header, without decoding pixels.
pub fn png_size(bytes: &[u8]) -> Option<(u32, u32)> {
    let reader = decoder(bytes).read_info().ok()?;
    let info = reader.info();
    Some((info.width, info.height))
}

/// Decode the first frame as RGBA8 into `out`, which must hold exactly
/// width × height × 4 bytes. RGBA output decodes in place; other layouts
/// decode once into scratch and expand.
pub fn decode_png(bytes: &[u8], out: &mut [u8]) -> bool {
    let Ok(mut reader) = decoder(bytes).read_info() else {
        return false;
    };
    let (color, depth) = reader.output_color_type();
    if depth != png::BitDepth::Eight {
        return false;
    }
    let format = match color {
        png::ColorType::Rgba => RGBA,
        png::ColorType::Rgb => RGB,
        png::ColorType::GrayscaleAlpha => GRAY_ALPHA,
        png::ColorType::Grayscale => GRAY,
        png::ColorType::Indexed => return false,
    };
    let Some(size) = reader.output_buffer_size() else {
        return false;
    };
    if format == RGBA {
        return size == out.len() && reader.next_frame(out).is_ok();
    }
    let mut scratch = vec![0; size];
    reader.next_frame(&mut scratch).is_ok() && expand(format, &scratch, out)
}

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

#[no_mangle]
/// Read a PNG's dimensions for Ghostty's decode callback.
///
/// # Safety
/// `data` must be readable for `len` bytes; `width` and `height` must be writable.
pub unsafe extern "C" fn wraith_png_size(
    data: *const u8,
    len: usize,
    width: *mut u32,
    height: *mut u32,
) -> bool {
    if data.is_null() || width.is_null() || height.is_null() {
        return false;
    }
    let bytes = unsafe { std::slice::from_raw_parts(data, len) };
    let Some((w, h)) = png_size(bytes) else {
        return false;
    };
    unsafe {
        *width = w;
        *height = h;
    }
    true
}

#[no_mangle]
/// Decode a PNG as RGBA8 into a Ghostty-allocated buffer.
///
/// # Safety
/// `data` must be readable for `len` bytes and `out` writable for `out_len`
/// bytes; the two must not overlap.
pub unsafe extern "C" fn wraith_png_decode(
    data: *const u8,
    len: usize,
    out: *mut u8,
    out_len: usize,
) -> bool {
    if data.is_null() || out.is_null() {
        return false;
    }
    let bytes = unsafe { std::slice::from_raw_parts(data, len) };
    let out = unsafe { std::slice::from_raw_parts_mut(out, out_len) };
    decode_png(bytes, out)
}
