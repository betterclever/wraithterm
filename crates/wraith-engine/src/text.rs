//! Rasterization happens on cache misses. Warm frames never shape or rasterize.
use crate::core::Cell;
use harfrust::{FontRef as ShapeFont, ShapeOptions, ShaperData, UnicodeBuffer};
use std::{
    collections::{HashMap, HashSet},
    hash::{BuildHasherDefault, Hasher},
};
use swash::{
    scale::{image::Content, Render, ScaleContext, Source, StrikeWith},
    zeno::{Format, Transform},
    CacheKey, FontRef,
};

pub const ATLAS_SIZE: u32 = 2048;
/// Scalars below this bound (ASCII through braille) resolve through a flat
/// table indexed by `scalar * 4 + style`, with no hashing on warm frames.
const SCALAR_TABLE: u32 = 0x3000;
/// A glyph word: atlas slot + 1 in bits 0..20, horizontal ink extent in pixels
/// in bits 20..31 and the color-glyph bit in bit 31. Zero means no glyph.
pub const GLYPH_SLOT: u32 = 0xf_ffff;
const MAX_SLOTS: u32 = GLYPH_SLOT - 1;
pub fn glyph_word(slot: u32, ink: u32, colored: bool) -> u32 {
    (slot + 1) | (ink.min(2047) << 20) | ((colored as u32) << 31)
}
/// Rightmost covered column + 1 of a tile's RGBA pixels.
pub fn ink_width(pixels: &[u8], width: u32) -> u32 {
    let mut ink = 0;
    for row in pixels.chunks_exact(width as usize * 4) {
        for x in (ink..width).rev() {
            if row[x as usize * 4 + 3] != 0 {
                ink = x + 1;
                break;
            }
        }
    }
    ink
}
/// FNV-style multiply hasher: warm lookups hash short grapheme strings, where
/// SipHash's DoS resistance buys nothing and costs most of the lookup.
#[derive(Default)]
struct Fx(u64);
impl Hasher for Fx {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, bytes: &[u8]) {
        for chunk in bytes.chunks(8) {
            let mut word = [0; 8];
            word[..chunk.len()].copy_from_slice(chunk);
            self.0 = (self.0.rotate_left(5) ^ u64::from_le_bytes(word))
                .wrapping_mul(0x51_7c_c1_b7_27_22_0a_95);
        }
    }
    fn write_u8(&mut self, i: u8) {
        self.write(&[i]);
    }
}
type FxMap<K, V> = HashMap<K, V, BuildHasherDefault<Fx>>;
pub struct Font {
    data: Vec<u8>,
    key: CacheKey,
    shape: ShaperData,
}
impl Font {
    fn new(data: Vec<u8>) -> Result<Self, String> {
        let font = ShapeFont::new(&data).map_err(|_| "invalid OpenType font")?;
        let shape = ShaperData::new(&font);
        if shape.shaper(&font).build().units_per_em() <= 0 {
            return Err("font has an invalid units-per-em value".into());
        }
        if FontRef::from_index(&data, 0).is_none() {
            return Err("invalid rasterization font".into());
        }
        Ok(Self {
            data,
            key: CacheKey::new(),
            shape,
        })
    }
    fn raster(&self) -> FontRef<'_> {
        let mut font = FontRef::from_index(&self.data, 0).unwrap();
        font.key = self.key;
        font
    }
}

#[derive(Hash, Eq, PartialEq)]
struct Key<'a> {
    text: &'a str,
    style: u32,
}
impl<'a> Key<'a> {
    fn cell(cell: &'a Cell) -> Self {
        Self {
            text: &cell.text,
            style: cell.flags & 3,
        }
    }
}

pub struct Upload {
    pub x: u32,
    pub y: u32,
    pub pixels: Vec<u8>,
}
pub struct Atlas {
    fonts: Vec<Font>,
    context: ScaleContext,
    cache: FxMap<String, [u32; 4]>,
    scalars: Vec<u32>,
    pub uploads: Vec<Upload>,
    pub cell_width: u32,
    pub cell_height: u32,
    pub tile_width: u32,
    pub tile_height: u32,
    pub font_size: f32,
    baseline: f32,
    next: u32,
    capacity: u32,
    pub hits: u64,
    pub misses: u64,
    pub resets: u64,
}
impl Atlas {
    /// The compatibility compositor receives already-rasterized browser glyphs.
    /// It needs no font allocation, shaping data or font download.
    #[cfg(target_arch = "wasm32")]
    pub(crate) fn external() -> Self {
        Self {
            fonts: Vec::new(),
            context: ScaleContext::new(),
            cache: FxMap::default(),
            scalars: vec![0; SCALAR_TABLE as usize * 4],
            uploads: Vec::new(),
            cell_width: 1,
            cell_height: 1,
            tile_width: 1,
            tile_height: 1,
            font_size: 14.,
            baseline: 0.,
            next: 0,
            capacity: MAX_SLOTS,
            hits: 0,
            misses: 0,
            resets: 0,
        }
    }
    pub fn new(data: Vec<u8>, size: f32, line_height: f32) -> Result<Self, String> {
        if !size.is_finite()
            || !(6.0..=96.0).contains(&size)
            || !line_height.is_finite()
            || !(1.0..=2.0).contains(&line_height)
        {
            return Err("font size must be 6..96 physical pixels; line height must be 1..2".into());
        }
        let font = Font::new(data)?;
        let raster = font.raster();
        let metrics = raster.metrics(&[]).scale(size);
        let cw = raster
            .glyph_metrics(&[])
            .scale(size)
            .advance_width(raster.charmap().map('M'))
            .round()
            .max(1.0) as u32;
        let ch = (size * line_height).ceil() as u32;
        // centre the font's line (ascent above the baseline, descent below: swash reports both as positive distances) in the cell;
        // subtracting the descent here put the baseline too low and clipped descenders (g, p, y) at the bottom of the tile
        let baseline =
            ((ch as f32 - (metrics.ascent + metrics.descent)) * 0.5 + metrics.ascent).round();
        let tw = cw * 2 + 4;
        let th = ch;
        let capacity = ((ATLAS_SIZE / tw) * (ATLAS_SIZE / th)).min(MAX_SLOTS);
        Ok(Self {
            fonts: vec![font],
            context: ScaleContext::new(),
            cache: FxMap::default(),
            scalars: vec![0; SCALAR_TABLE as usize * 4],
            uploads: Vec::new(),
            cell_width: cw,
            cell_height: ch,
            tile_width: tw,
            tile_height: th,
            font_size: size,
            baseline,
            next: 0,
            capacity,
            hits: 0,
            misses: 0,
            resets: 0,
        })
    }
    #[cfg(target_arch = "wasm32")]
    pub(crate) fn is_external(&self) -> bool {
        self.fonts.is_empty()
    }
    pub fn add_font(&mut self, bytes: Vec<u8>) -> Result<(), String> {
        self.fonts.push(Font::new(bytes)?);
        self.reset();
        Ok(())
    }
    fn reset(&mut self) {
        self.cache.clear();
        self.scalars.fill(0);
        self.next = 0;
        self.uploads.clear();
        self.resets += 1;
    }
    /// Clear the atlas before references become stale. Rebuild all visible rows
    /// in the same frame. Scrollback remains in Ghostty, independent of the atlas.
    pub fn begin(&mut self, cells: &[Cell], dirty: &mut [bool], cols: usize) -> Result<(), String> {
        let drawable = |c: &&Cell| !c.text.is_empty() && c.text != " ";
        let dirty_cells = || {
            cells
                .chunks(cols)
                .zip(dirty.iter())
                .filter(|(_, d)| **d)
                .flat_map(|(row, _)| row)
        };
        let dirty_count = dirty_cells().filter(drawable).count();
        if self.next as usize + dirty_count <= self.capacity as usize {
            return Ok(());
        }
        let missing: HashSet<_> = dirty_cells()
            .filter(drawable)
            .filter(|c| self.cached(c) == 0)
            // Cells remain borrowed for this preflight; a warm full viewport
            // allocates neither glyph strings nor a missing-glyph hash table.
            .map(Key::cell)
            .collect();
        if self.next as usize + missing.len() > self.capacity as usize {
            let visible: HashSet<_> = cells.iter().filter(drawable).map(Key::cell).collect();
            if visible.len() > self.capacity as usize {
                return Err(
                    "visible glyph set exceeds atlas capacity; reduce font size or grid size"
                        .into(),
                );
            }
            self.reset();
            dirty.fill(true);
        }
        Ok(())
    }
    fn cached(&self, cell: &Cell) -> u32 {
        let style = (cell.flags & 3) as usize;
        if cell.scalar != 0 && cell.scalar < SCALAR_TABLE {
            return self.scalars[cell.scalar as usize * 4 + style];
        }
        self.cache
            .get(cell.text.as_str())
            .map_or(0, |variants| variants[style])
    }
    /// The cell's glyph word, rasterizing and scheduling an upload on a miss.
    pub fn tile(&mut self, cell: &Cell) -> u32 {
        if cell.scalar == 32 || cell.text.is_empty() || cell.text == " " {
            return 0;
        }
        let style = (cell.flags & 3) as usize;
        let glyph = self.cached(cell);
        if glyph != 0 {
            self.hits += 1;
            return glyph;
        }
        self.misses += 1;
        // Block elements and braille are geometry, not type: drawn to fill the cell exactly, so neighbours tile with no seam at any
        // font or line height (a font's block glyph fills only the font's own line). Terminals do the same (xterm customGlyphs, Ghostty sprites).
        if let Some(pixels) = self.procedural(&cell.text) {
            return self.place(cell, style, pixels, false);
        }
        let font_index = self
            .fonts
            .iter()
            .position(|f| {
                let cmap = f.raster().charmap();
                cell.text.chars().all(|c| {
                    c == '\u{200d}' || ('\u{fe00}'..='\u{fe0f}').contains(&c) || cmap.map(c) != 0
                })
            })
            .unwrap_or(0);
        let font = &self.fonts[font_index];
        let shape_font = ShapeFont::new(&font.data).unwrap();
        let shaper = font.shape.shaper(&shape_font).build();
        let factor = self.font_size / shaper.units_per_em() as f32;
        let mut buffer = UnicodeBuffer::new();
        buffer.push_str(&cell.text);
        buffer.guess_segment_properties();
        let glyphs = shaper.shape(buffer, ShapeOptions::default());
        let mut scaler = self
            .context
            .builder(font.raster())
            .size(self.font_size)
            .hint(true)
            .build();
        let mut render = Render::new(&[
            Source::ColorOutline(0),
            Source::ColorBitmap(StrikeWith::BestFit),
            Source::Outline,
        ]);
        render.format(Format::Alpha);
        if cell.flags & 1 != 0 {
            render.embolden(self.font_size / 24.0);
        }
        if cell.flags & 2 != 0 {
            render.transform(Some(Transform::new(1., 0., 0.2, 1., 0., 0.)));
        }
        let mut pixels = vec![0u8; (self.tile_width * self.tile_height * 4) as usize];
        let mut pen = 0f32;
        let mut colored = false;
        for (info, pos) in glyphs.glyph_infos().iter().zip(glyphs.glyph_positions()) {
            if let Some(image) = render.render(&mut scaler, info.glyph_id as u16) {
                colored |= image.content == Content::Color;
                let origin_x =
                    (pen + pos.x_offset as f32 * factor).round() as i32 + image.placement.left;
                let origin_y = (self.baseline - pos.y_offset as f32 * factor).round() as i32
                    - image.placement.top;
                for y in 0..image.placement.height as i32 {
                    for x in 0..image.placement.width as i32 {
                        let tx = origin_x + x;
                        let ty = origin_y + y;
                        if tx < 0
                            || ty < 0
                            || tx >= self.tile_width as i32
                            || ty >= self.tile_height as i32
                        {
                            continue;
                        }
                        let src = (y as u32 * image.placement.width + x as u32) as usize;
                        let dst = ((ty as u32 * self.tile_width + tx as u32) * 4) as usize;
                        let rgba = if image.content == Content::Color {
                            [
                                image.data[src * 4],
                                image.data[src * 4 + 1],
                                image.data[src * 4 + 2],
                                image.data[src * 4 + 3],
                            ]
                        } else {
                            [255, 255, 255, image.data[src]]
                        };
                        let a = rgba[3] as f32 / 255.;
                        let old = pixels[dst + 3] as f32 / 255.;
                        let alpha = a + old * (1. - a);
                        if alpha > 0. {
                            for channel in 0..3 {
                                pixels[dst + channel] = ((rgba[channel] as f32 * a
                                    + pixels[dst + channel] as f32 * old * (1. - a))
                                    / alpha)
                                    .round()
                                    as u8;
                            }
                            pixels[dst + 3] = (alpha * 255.).round() as u8;
                        }
                    }
                }
            }
            pen += pos.x_advance as f32 * factor;
        }
        self.place(cell, style, pixels, colored)
    }
    fn place(&mut self, cell: &Cell, style: usize, pixels: Vec<u8>, colored: bool) -> u32 {
        let x = (self.next % (ATLAS_SIZE / self.tile_width)) * self.tile_width;
        let y = (self.next / (ATLAS_SIZE / self.tile_width)) * self.tile_height;
        let glyph = glyph_word(self.next, ink_width(&pixels, self.tile_width), colored);
        self.next += 1;
        self.uploads.push(Upload { x, y, pixels });
        if cell.scalar != 0 && cell.scalar < SCALAR_TABLE {
            self.scalars[cell.scalar as usize * 4 + style] = glyph;
        } else {
            self.cache.entry(cell.text.clone()).or_insert([0; 4])[style] = glyph;
        }
        glyph
    }
    /// Coverage for U+2580..U+259F (block elements) and U+2800..U+28FF (braille), filling exactly one cell; None for anything else.
    fn procedural(&self, text: &str) -> Option<Vec<u8>> {
        let mut chars = text.chars();
        let c = chars.next()? as u32;
        if chars.next().is_some()
            || !((0x2580..=0x259f).contains(&c) || (0x2800..=0x28ff).contains(&c))
        {
            return None;
        }
        let (w, h, tw) = (self.cell_width, self.cell_height, self.tile_width);
        let mut pixels = vec![0u8; (tw * self.tile_height * 4) as usize];
        // fill [x0, x1) x [y0, y1) of the cell, in eighths of its size (split points rounded once, so adjacent cells meet exactly)
        let mut fill = |x0: u32, y0: u32, x1: u32, y1: u32, a: u8| {
            let (px0, px1) = ((x0 * w + 4) / 8, (x1 * w + 4) / 8);
            let (py0, py1) = ((y0 * h + 4) / 8, (y1 * h + 4) / 8);
            for y in py0..py1.min(h) {
                for x in px0..px1.min(w) {
                    let i = ((y * tw + x) * 4) as usize;
                    pixels[i..i + 4].copy_from_slice(&[255, 255, 255, a]);
                }
            }
        };
        match c {
            0x2580 => fill(0, 0, 8, 4, 255), // ▀ upper half
            0x2581..=0x2587 => fill(0, 8 - (c - 0x2580), 8, 8, 255), // ▁..▇ lower eighths
            0x2588 => fill(0, 0, 8, 8, 255), // █
            0x2589..=0x258f => fill(0, 0, 8 - (c - 0x2588), 8, 255), // ▉..▏ left eighths
            0x2590 => fill(4, 0, 8, 8, 255), // ▐ right half
            0x2591 => fill(0, 0, 8, 8, 64),  // ░ shades: flat coverage
            0x2592 => fill(0, 0, 8, 8, 128), // ▒
            0x2593 => fill(0, 0, 8, 8, 191), // ▓
            0x2594 => fill(0, 0, 8, 1, 255), // ▔ upper eighth
            0x2595 => fill(7, 0, 8, 8, 255), // ▕ right eighth
            0x2596..=0x259f => {
                // quadrants as bits: 1 upper-left, 2 upper-right, 4 lower-left, 8 lower-right
                let q = [4u8, 8, 1, 13, 9, 7, 11, 2, 6, 14][(c - 0x2596) as usize];
                if q & 1 != 0 {
                    fill(0, 0, 4, 4, 255);
                }
                if q & 2 != 0 {
                    fill(4, 0, 8, 4, 255);
                }
                if q & 4 != 0 {
                    fill(0, 4, 4, 8, 255);
                }
                if q & 8 != 0 {
                    fill(4, 4, 8, 8, 255);
                }
            }
            _ => {
                // braille: dots 1-3 and 7 down the left column, 4-6 and 8 down the right; each a square in its 2x4 sub-cell
                let bits = c - 0x2800;
                let dots = [
                    (0, 0),
                    (0, 1),
                    (0, 2),
                    (1, 0),
                    (1, 1),
                    (1, 2),
                    (0, 3),
                    (1, 3),
                ];
                let (sw, sh) = (w as f32 / 2.0, h as f32 / 4.0);
                let r = (sw.min(sh) * 0.34).max(1.0);
                for (k, (dx, dy)) in dots.iter().enumerate() {
                    if bits & (1 << k) == 0 {
                        continue;
                    }
                    let (cx, cy) = ((*dx as f32 + 0.5) * sw, (*dy as f32 + 0.5) * sh);
                    let (x0, x1) = (
                        (cx - r).round().max(0.0) as u32,
                        (cx + r).round().min(w as f32) as u32,
                    );
                    let (y0, y1) = (
                        (cy - r).round().max(0.0) as u32,
                        (cy + r).round().min(h as f32) as u32,
                    );
                    for y in y0..y1 {
                        for x in x0..x1 {
                            let i = ((y * tw + x) * 4) as usize;
                            pixels[i..i + 4].copy_from_slice(&[255, 255, 255, 255]);
                        }
                    }
                }
            }
        }
        Some(pixels)
    }
    pub fn count(&self) -> usize {
        self.next as usize
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn small_atlas(capacity: u32) -> Atlas {
        let data = include_bytes!("../../../demo/fonts/JetBrainsMono-Regular.ttf").to_vec();
        let mut atlas = Atlas::new(data, 16., 1.3).unwrap();
        atlas.capacity = capacity;
        atlas
    }
    fn cell(text: &str) -> Cell {
        Cell::with_text(text)
    }

    #[test]
    fn cached_viewport_and_spaces_do_not_evict_a_full_atlas() {
        let mut atlas = small_atlas(1);
        let a = cell("A");
        let tile = atlas.tile(&a);
        let cells = [a, cell(" "), cell("A"), cell("")];
        let mut dirty = [true];
        atlas.begin(&cells, &mut dirty, 4).unwrap();
        assert_eq!(atlas.resets, 0);
        assert_eq!(atlas.count(), 1);
        assert_eq!(atlas.tile(&cells[2]), tile);
    }

    #[test]
    fn eviction_invalidates_every_visible_row_before_reusing_slots() {
        let mut atlas = small_atlas(2);
        atlas.tile(&cell("A"));
        atlas.tile(&cell("B"));
        let cells = [cell("B"), cell("C")];
        let mut dirty = [false, true];
        atlas.begin(&cells, &mut dirty, 1).unwrap();
        assert_eq!(dirty, [true, true]);
        assert_eq!(atlas.resets, 1);
        assert!(atlas.uploads.is_empty());
        atlas.tile(&cells[0]);
        atlas.tile(&cells[1]);
        assert_eq!(atlas.count(), 2);
    }

    #[test]
    fn visible_overflow_preserves_existing_tiles_and_damage() {
        let mut atlas = small_atlas(1);
        atlas.tile(&cell("A"));
        let mut dirty = [true];
        assert!(atlas.begin(&[cell("A"), cell("B")], &mut dirty, 2).is_err());
        assert_eq!(atlas.resets, 0);
        assert_eq!(atlas.count(), 1);
        assert_eq!(dirty, [true]);
    }
}
