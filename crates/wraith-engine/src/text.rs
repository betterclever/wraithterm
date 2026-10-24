//! Rasterization happens on cache misses. Warm frames never shape or rasterize.
use crate::core::Cell;
use harfrust::{Direction, FontRef as ShapeFont, ShapeOptions, ShaperData, UnicodeBuffer};
use std::{
    collections::HashMap,
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
/// Synthetic bold for mask glyphs: widen coverage to the right by `strength`
/// pixels. Outline emboldening (swash `embolden`) can collapse glyphs whose
/// contours overlap after offsetting, such as JetBrains Mono's `i`, which
/// rendered as a lone speck; dilating the rasterized coverage cannot.
fn embolden(pixels: &mut [u8], width: u32, strength: u32) {
    for row in pixels.chunks_exact_mut(width as usize * 4) {
        for x in (0..width as usize).rev() {
            let mut a = row[x * 4 + 3];
            for k in 1..=strength as usize {
                if x >= k {
                    a = a.max(row[(x - k) * 4 + 3]);
                }
            }
            if a != 0 {
                row[x * 4..x * 4 + 3].fill(255);
                row[x * 4 + 3] = a;
            }
        }
    }
}
/// Composite a rendered glyph over RGBA `pixels` with its origin at (x, y).
fn blit(
    pixels: &mut [u8],
    width: u32,
    height: u32,
    image: &swash::scale::image::Image,
    x: i32,
    y: i32,
) {
    let origin_x = x + image.placement.left;
    let origin_y = y - image.placement.top;
    for gy in 0..image.placement.height as i32 {
        for gx in 0..image.placement.width as i32 {
            let tx = origin_x + gx;
            let ty = origin_y + gy;
            if tx < 0 || ty < 0 || tx >= width as i32 || ty >= height as i32 {
                continue;
            }
            let src = (gy as u32 * image.placement.width + gx as u32) as usize;
            let dst = ((ty as u32 * width + tx as u32) * 4) as usize;
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
                        .round() as u8;
                }
                pixels[dst + 3] = (alpha * 255.).round() as u8;
            }
        }
    }
}
/// Scripts whose letters change form with their neighbours (Arabic, Hebrew
/// marks, Indic, Thai, Myanmar, Khmer and their presentation forms).
fn complex(c: char) -> bool {
    matches!(c as u32, 0x0590..=0x08ff | 0x0900..=0x0dff | 0x0e00..=0x0eff | 0x1000..=0x109f
        | 0x1780..=0x17ff | 0xa8e0..=0xa8ff | 0xfb1d..=0xfdff | 0xfe70..=0xfeff)
}
/// ASCII punctuation that programming-font ligatures are built from.
fn operator(c: char) -> bool {
    matches!(
        c,
        '!' | '#'
            | '$'
            | '%'
            | '&'
            | '*'
            | '+'
            | '-'
            | '.'
            | '/'
            | ':'
            | ';'
            | '<'
            | '='
            | '>'
            | '?'
            | '@'
            | '\\'
            | '^'
            | '_'
            | '|'
            | '~'
    )
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

pub struct Upload {
    pub x: u32,
    pub y: u32,
    pub pixels: Vec<u8>,
}
pub struct Atlas {
    fonts: Vec<Font>,
    context: ScaleContext,
    cache: FxMap<String, [u32; 4]>,
    /// Shaped runs (text and bold/italic style) to one glyph word per cell.
    runs: FxMap<(String, u8), Vec<u32>>,
    /// Shape runs of operator symbols together, forming programming ligatures.
    /// Complex scripts are shaped as runs regardless.
    pub ligatures: bool,
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
    /// Set when a miss found no free slot. The renderer then resets the atlas
    /// and repacks every visible row before any stale reference is drawn.
    pub overflow: bool,
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
            runs: FxMap::default(),
            ligatures: false,
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
            overflow: false,
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
            runs: FxMap::default(),
            ligatures: false,
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
            overflow: false,
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
    pub fn reset(&mut self) {
        self.cache.clear();
        self.runs.clear();
        self.scalars.fill(0);
        self.next = 0;
        self.uploads.clear();
        self.overflow = false;
        self.resets += 1;
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
        if self.next >= self.capacity {
            self.overflow = true;
            return 0;
        }
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
        if cell.flags & 2 != 0 {
            render.transform(Some(Transform::new(1., 0., 0.2, 1., 0., 0.)));
        }
        let mut pixels = vec![0u8; (self.tile_width * self.tile_height * 4) as usize];
        let mut pen = 0f32;
        let mut colored = false;
        let (width, height, baseline) = (self.tile_width, self.tile_height, self.baseline);
        for (info, pos) in glyphs.glyph_infos().iter().zip(glyphs.glyph_positions()) {
            if let Some(image) = render.render(&mut scaler, info.glyph_id as u16) {
                colored |= image.content == Content::Color;
                let x = (pen + pos.x_offset as f32 * factor).round() as i32;
                let y = (baseline - pos.y_offset as f32 * factor).round() as i32;
                blit(&mut pixels, width, height, &image, x, y);
            }
            pen += pos.x_advance as f32 * factor;
        }
        if cell.flags & 1 != 0 && !colored {
            embolden(
                &mut pixels,
                self.tile_width,
                (self.font_size / 24.0).round().max(1.0) as u32,
            );
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
    /// Glyph words for one row of cells. Runs of complex-script letters, and of
    /// operator symbols with `ligatures` on, are shaped together; other cells,
    /// and the run under `cursor`, take the per-cell path.
    pub fn row(&mut self, cells: &[Cell], out: &mut [u32], cursor: Option<usize>) {
        // The per-cell path, noting whether any cell could need run shaping.
        let mut candidates = false;
        for (cell, word) in cells.iter().zip(out.iter_mut()) {
            *word = self.tile(cell);
            candidates |= self.candidate(cell);
        }
        if !candidates {
            return;
        }
        // Shape only maximal runs of candidate cells in one style: operator
        // sequences (`=>`, `!==`) and complex-script letters. Runs stay short
        // and repeat, so they cache well; other cells keep their glyphs.
        let wide = |c: &Cell| c.flags & (1 << 16 | 1 << 20) != 0;
        let mut i = 0;
        while i < cells.len() {
            if wide(&cells[i]) || !self.candidate(&cells[i]) {
                i += 1;
                continue;
            }
            let style = cells[i].flags & 3;
            let mut j = i + 1;
            while j < cells.len()
                && !wide(&cells[j])
                && cells[j].flags & 3 == style
                && self.candidate(&cells[j])
            {
                j += 1;
            }
            if j - i > 1 && !cursor.is_some_and(|c| (i..j).contains(&c)) {
                if let Some(words) = self.run(&cells[i..j]) {
                    out[i..j].copy_from_slice(&words);
                }
            }
            i = j;
        }
    }
    /// Whether a cell's text joins, or ligates with, its neighbours.
    fn candidate(&self, cell: &Cell) -> bool {
        match char::from_u32(cell.scalar).filter(|_| cell.scalar != 0) {
            Some(c) if (c as u32) < 0x0590 => self.ligatures && operator(c),
            Some(c) => complex(c),
            None => cell
                .text
                .chars()
                .any(|c| complex(c) || (self.ligatures && operator(c))),
        }
    }
    /// Shape a word as one run and slice its raster into one tile per cell.
    /// Each glyph is placed at its own cell, so the grid stays exact; ligatures
    /// that reach into neighbouring cells land in those cells' slices. None
    /// when no single font covers the run.
    fn run(&mut self, cells: &[Cell]) -> Option<Vec<u32>> {
        let style = (cells[0].flags & 3) as u8;
        let mut text = String::new();
        let mut starts = Vec::with_capacity(cells.len());
        for cell in cells {
            starts.push(text.len() as u32);
            text.push_str(&cell.text);
        }
        if let Some(words) = self.runs.get(&(text.clone(), style)) {
            self.hits += 1;
            return Some(words.clone());
        }
        self.misses += 1;
        let font_index = self.fonts.iter().position(|f| {
            let cmap = f.raster().charmap();
            text.chars().all(|c| {
                c == '\u{200d}' || ('\u{fe00}'..='\u{fe0f}').contains(&c) || cmap.map(c) != 0
            })
        })?;
        let n = cells.len() as u32;
        if self.next + n > self.capacity {
            self.overflow = true;
            return Some(vec![0; cells.len()]);
        }
        let font = &self.fonts[font_index];
        let shape_font = ShapeFont::new(&font.data).unwrap();
        let shaper = font.shape.shaper(&shape_font).build();
        let factor = self.font_size / shaper.units_per_em() as f32;
        let mut buffer = UnicodeBuffer::new();
        buffer.push_str(&text);
        buffer.guess_segment_properties();
        // Terminal cells hold text in logical order; keep it left to right.
        buffer.set_direction(Direction::LeftToRight);
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
        if style & 2 != 0 {
            render.transform(Some(Transform::new(1., 0., 0.2, 1., 0., 0.)));
        }
        // One cell of margin on each side for glyphs that overhang the run.
        let (cw, tw, th) = (self.cell_width, self.tile_width, self.tile_height);
        let width = (n + 1) * cw + tw;
        let mut canvas = vec![0u8; (width * th * 4) as usize];
        let mut colored = false;
        // Glyphs start at their cluster's cell and advance within it, so a
        // syllable of several glyphs (an Indic conjunct and its vowel sign)
        // keeps its shape while the grid stays exact.
        let (mut current, mut pen) = (u32::MAX, 0f32);
        for (info, pos) in glyphs.glyph_infos().iter().zip(glyphs.glyph_positions()) {
            let cell = starts
                .partition_point(|&s| s <= info.cluster)
                .saturating_sub(1) as u32;
            if cell != current {
                (current, pen) = (cell, 0.);
            }
            if let Some(image) = render.render(&mut scaler, info.glyph_id as u16) {
                colored |= image.content == Content::Color;
                let x =
                    ((cw + cell * cw) as f32 + pen + pos.x_offset as f32 * factor).round() as i32;
                let y = (self.baseline - pos.y_offset as f32 * factor).round() as i32;
                blit(&mut canvas, width, th, &image, x, y);
            }
            pen += pos.x_advance as f32 * factor;
        }
        if style & 1 != 0 && !colored {
            embolden(
                &mut canvas,
                width,
                (self.font_size / 24.0).round().max(1.0) as u32,
            );
        }
        let mut words = Vec::with_capacity(cells.len());
        for k in 0..n {
            // Cells own exactly their column; the last also keeps any overhang.
            let x0 = cw + k * cw;
            let x1 = if k + 1 == n {
                (x0 + tw).min(width)
            } else {
                x0 + cw
            };
            let mut tile = vec![0u8; (tw * th * 4) as usize];
            let mut ink = false;
            for y in 0..th {
                let src = ((y * width + x0) * 4) as usize;
                let dst = (y * tw * 4) as usize;
                let len = ((x1 - x0) * 4) as usize;
                tile[dst..dst + len].copy_from_slice(&canvas[src..src + len]);
                ink |= tile[dst..dst + len].chunks_exact(4).any(|p| p[3] != 0);
            }
            if !ink {
                words.push(0);
                continue;
            }
            let x = (self.next % (ATLAS_SIZE / tw)) * tw;
            let y = (self.next / (ATLAS_SIZE / tw)) * th;
            words.push(glyph_word(self.next, ink_width(&tile, tw), colored));
            self.next += 1;
            self.uploads.push(Upload { x, y, pixels: tile });
        }
        self.runs.insert((text, style), words.clone());
        Some(words)
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
    fn cached_glyphs_and_spaces_never_overflow_a_full_atlas() {
        let mut atlas = small_atlas(1);
        let tile = atlas.tile(&cell("A"));
        assert_eq!(atlas.tile(&cell(" ")), 0);
        assert_eq!(atlas.tile(&cell("")), 0);
        assert_eq!(atlas.tile(&cell("A")), tile);
        assert!(!atlas.overflow);
        assert_eq!(atlas.count(), 1);
    }

    #[test]
    fn a_miss_without_a_free_slot_flags_overflow_and_places_nothing() {
        let mut atlas = small_atlas(1);
        atlas.tile(&cell("A"));
        assert_eq!(atlas.tile(&cell("B")), 0);
        assert!(atlas.overflow);
        assert_eq!(atlas.count(), 1);
        assert_eq!(atlas.uploads.len(), 1);
        atlas.reset();
        assert!(!atlas.overflow);
        assert!(atlas.uploads.is_empty());
        assert_ne!(atlas.tile(&cell("B")), 0);
        assert_eq!(atlas.count(), 1);
    }
}

#[cfg(test)]
mod shaping {
    use super::*;
    const MONO: &[u8] = include_bytes!("../../../demo/fonts/JetBrainsMono-Regular.ttf");
    const ARABIC: &[u8] = include_bytes!("../tests/fonts/NotoNaskhArabic.ttf");

    fn cells(text: &str) -> Vec<Cell> {
        text.chars()
            .map(|c| Cell::with_text(&c.to_string()))
            .collect()
    }
    fn words(atlas: &mut Atlas, text: &str, cursor: Option<usize>) -> Vec<u32> {
        let row = cells(text);
        let mut out = vec![0; row.len()];
        atlas.row(&row, &mut out, cursor);
        out
    }
    fn per_cell(atlas: &mut Atlas, text: &str) -> Vec<u32> {
        cells(text).iter().map(|c| atlas.tile(c)).collect()
    }

    #[test]
    fn plain_text_and_disabled_ligatures_use_per_cell_glyphs() {
        let mut atlas = Atlas::new(MONO.to_vec(), 16., 1.3).unwrap();
        assert_eq!(
            words(&mut atlas, "hello world", None),
            per_cell(&mut atlas, "hello world")
        );
        assert_eq!(
            words(&mut atlas, "a => b", None),
            per_cell(&mut atlas, "a => b")
        );
    }

    #[test]
    fn ligatures_span_their_cells_and_split_under_the_cursor() {
        let mut atlas = Atlas::new(MONO.to_vec(), 16., 1.3).unwrap();
        atlas.ligatures = true;
        let plain = per_cell(&mut atlas, "x => y");
        let shaped = words(&mut atlas, "x => y", None);
        // The word "=>" became one ligature sliced over two cells; "x" and "y" did not change.
        assert_eq!((shaped[0], shaped[1], shaped[5]), (plain[0], 0, plain[5]));
        assert!(shaped[2] != 0 && shaped[3] != 0);
        assert!(shaped[2] != plain[2] && shaped[3] != plain[3]);
        // The word under the cursor shows its separate characters.
        assert_eq!(words(&mut atlas, "x => y", Some(3)), plain);
        // Warm: the shaped run is reused.
        let before = atlas.count();
        assert_eq!(words(&mut atlas, "x => y", None), shaped);
        assert_eq!(atlas.count(), before);
    }

    #[test]
    fn a_syllable_of_several_glyphs_advances_within_its_cell() {
        const DEVANAGARI: &[u8] = include_bytes!("../tests/fonts/NotoSansDevanagari.ttf");
        let mut atlas = Atlas::new(MONO.to_vec(), 16., 1.3).unwrap();
        atlas.add_font(DEVANAGARI.to_vec()).unwrap();
        // "त्रि" is one cell holding a vowel sign and a conjunct; next to another
        // syllable it is shaped as a run, and must match the cell shaped alone.
        let syllable = Cell::with_text("त्रि");
        let alone = atlas.tile(&syllable);
        let row = vec![syllable, Cell::with_text("य")];
        let mut out = vec![0; 2];
        atlas.row(&row, &mut out, None);
        let pixels = |atlas: &Atlas, word: u32| {
            let slot = (word & GLYPH_SLOT) - 1;
            let index = atlas.uploads.iter().position(|u| {
                u.x == (slot % (ATLAS_SIZE / atlas.tile_width)) * atlas.tile_width
                    && u.y == (slot / (ATLAS_SIZE / atlas.tile_width)) * atlas.tile_height
            });
            atlas.uploads[index.unwrap()].pixels.clone()
        };
        let cw = atlas.cell_width as usize;
        let within = |p: &[u8]| -> Vec<u8> {
            p.chunks_exact(atlas.tile_width as usize * 4)
                .flat_map(|row| row[..cw * 4].iter().copied())
                .collect()
        };
        assert_eq!(
            within(&pixels(&atlas, out[0])),
            within(&pixels(&atlas, alone))
        );
    }

    #[test]
    fn arabic_letters_join_within_a_run() {
        let mut atlas = Atlas::new(MONO.to_vec(), 16., 1.3).unwrap();
        atlas.add_font(ARABIC.to_vec()).unwrap();
        let isolated = per_cell(&mut atlas, "سلام");
        let joined = words(&mut atlas, "سلام", None);
        assert!(joined.iter().all(|&w| w != 0));
        // Contextual forms differ from the isolated letters.
        assert!(joined.iter().zip(&isolated).filter(|(a, b)| a != b).count() >= 3);
    }
}
