//! Box drawing (U+2500..U+257F) as geometry, not type. A font's box glyphs
//! stop short of the cell at most line heights, so borders (fastfetch's,
//! htop's, tmux's) break into dashes between rows; drawn here, every line
//! runs to the cell's edges, as Ghostty's sprites and restty draw them.
//! Light, heavy and double strokes meet at the centre, dashes split the
//! cell evenly, and rounded corners and diagonals are antialiased.
//!
//! The line table is restty's (src/renderer/box-drawing-map.ts, MIT, see
//! licenses/restty-MIT.txt): each character's [up, right, down, left] as
//! 0 none, 1 light, 2 heavy, 3 double.

#[rustfmt::skip]
const LINES: &[(u8, [u8; 4])] = &[
    (0x00, [0, 1, 0, 1]), (0x01, [0, 2, 0, 2]), (0x02, [1, 0, 1, 0]), (0x03, [2, 0, 2, 0]),
    (0x0c, [0, 1, 1, 0]), (0x0d, [0, 2, 1, 0]), (0x0e, [0, 1, 2, 0]), (0x0f, [0, 2, 2, 0]),
    (0x10, [0, 0, 1, 1]), (0x11, [0, 0, 1, 2]), (0x12, [0, 0, 2, 1]), (0x13, [0, 0, 2, 2]),
    (0x14, [1, 1, 0, 0]), (0x15, [1, 2, 0, 0]), (0x16, [2, 1, 0, 0]), (0x17, [2, 2, 0, 0]),
    (0x18, [1, 0, 0, 1]), (0x19, [1, 0, 0, 2]), (0x1a, [2, 0, 0, 1]), (0x1b, [2, 0, 0, 2]),
    (0x1c, [1, 1, 1, 0]), (0x1d, [1, 2, 1, 0]), (0x1e, [2, 1, 1, 0]), (0x1f, [1, 1, 2, 0]),
    (0x20, [2, 1, 2, 0]), (0x21, [2, 2, 1, 0]), (0x22, [1, 2, 2, 0]), (0x23, [2, 2, 2, 0]),
    (0x24, [1, 0, 1, 1]), (0x25, [1, 0, 1, 2]), (0x26, [2, 0, 1, 1]), (0x27, [1, 0, 2, 1]),
    (0x28, [2, 0, 2, 1]), (0x29, [2, 0, 1, 2]), (0x2a, [1, 0, 2, 2]), (0x2b, [2, 0, 2, 2]),
    (0x2c, [0, 1, 1, 1]), (0x2d, [0, 1, 1, 2]), (0x2e, [0, 2, 1, 1]), (0x2f, [0, 2, 1, 2]),
    (0x30, [0, 1, 2, 1]), (0x31, [0, 1, 2, 2]), (0x32, [0, 2, 2, 1]), (0x33, [0, 2, 2, 2]),
    (0x34, [1, 1, 0, 1]), (0x35, [1, 1, 0, 2]), (0x36, [1, 2, 0, 1]), (0x37, [1, 2, 0, 2]),
    (0x38, [2, 1, 0, 1]), (0x39, [2, 1, 0, 2]), (0x3a, [2, 2, 0, 1]), (0x3b, [2, 2, 0, 2]),
    (0x3c, [1, 1, 1, 1]), (0x3d, [1, 1, 1, 2]), (0x3e, [1, 2, 1, 1]), (0x3f, [1, 2, 1, 2]),
    (0x40, [2, 1, 1, 1]), (0x41, [1, 1, 2, 1]), (0x42, [2, 1, 2, 1]), (0x43, [2, 1, 1, 2]),
    (0x44, [2, 2, 1, 1]), (0x45, [1, 1, 2, 2]), (0x46, [1, 2, 2, 1]), (0x47, [2, 2, 1, 2]),
    (0x48, [1, 2, 2, 2]), (0x49, [2, 1, 2, 2]), (0x4a, [2, 2, 2, 1]), (0x4b, [2, 2, 2, 2]),
    (0x50, [0, 3, 0, 3]), (0x51, [3, 0, 3, 0]), (0x52, [0, 3, 1, 0]), (0x53, [0, 1, 3, 0]),
    (0x54, [0, 3, 3, 0]), (0x55, [0, 0, 1, 3]), (0x56, [0, 0, 3, 1]), (0x57, [0, 0, 3, 3]),
    (0x58, [1, 3, 0, 0]), (0x59, [3, 1, 0, 0]), (0x5a, [3, 3, 0, 0]), (0x5b, [1, 0, 0, 3]),
    (0x5c, [3, 0, 0, 1]), (0x5d, [3, 0, 0, 3]), (0x5e, [1, 3, 1, 0]), (0x5f, [3, 1, 3, 0]),
    (0x60, [3, 3, 3, 0]), (0x61, [1, 0, 1, 3]), (0x62, [3, 0, 3, 1]), (0x63, [3, 0, 3, 3]),
    (0x64, [0, 3, 1, 3]), (0x65, [0, 1, 3, 1]), (0x66, [0, 3, 3, 3]), (0x67, [1, 3, 0, 3]),
    (0x68, [3, 1, 0, 1]), (0x69, [3, 3, 0, 3]), (0x6a, [1, 3, 1, 3]), (0x6b, [3, 1, 3, 1]),
    (0x6c, [3, 3, 3, 3]), (0x74, [0, 0, 0, 1]), (0x75, [1, 0, 0, 0]), (0x76, [0, 1, 0, 0]),
    (0x77, [0, 0, 1, 0]), (0x78, [0, 0, 0, 2]), (0x79, [2, 0, 0, 0]), (0x7a, [0, 2, 0, 0]),
    (0x7b, [0, 0, 2, 0]), (0x7c, [0, 2, 0, 1]), (0x7d, [1, 0, 2, 0]), (0x7e, [0, 1, 0, 2]),
    (0x7f, [2, 0, 1, 0]),
];

/// Dashed lines: (codepoint, dashes, heavy, vertical).
const DASHES: &[(u32, u32, bool, bool)] = &[
    (0x2504, 3, false, false),
    (0x2505, 3, true, false),
    (0x2506, 3, false, true),
    (0x2507, 3, true, true),
    (0x2508, 4, false, false),
    (0x2509, 4, true, false),
    (0x250a, 4, false, true),
    (0x250b, 4, true, true),
    (0x254c, 2, false, false),
    (0x254d, 2, true, false),
    (0x254e, 2, false, true),
    (0x254f, 2, true, true),
];

/// White coverage for `cp` in a `w`×`h` cell at the origin of an RGBA tile
/// `tw` pixels wide (and at least `h` tall); None when `cp` is not box
/// drawing this draws.
pub fn draw(cp: u32, w: u32, h: u32, tw: u32, th: u32) -> Option<Vec<u8>> {
    if !(0x2500..=0x257f).contains(&cp) || w == 0 || h == 0 {
        return None;
    }
    let mut pixels = vec![0u8; (tw * th * 4) as usize];
    let light = (h as f32 / 16.).round().max(1.) as u32;
    let heavy = light * 2;
    let thick = |s: u8| if s == 2 { heavy } else { light };
    let cx = w.saturating_sub(light) / 2;
    let cy = h.saturating_sub(light) / 2;
    let rect = |pixels: &mut [u8], x0: u32, y0: u32, x1: u32, y1: u32| {
        for y in y0..y1.min(h) {
            for x in x0..x1.min(w) {
                let i = ((y * tw + x) * 4) as usize;
                pixels[i..i + 4].copy_from_slice(&[255; 4]);
            }
        }
    };

    if let Some(&(_, n, is_heavy, vertical)) = DASHES.iter().find(|d| d.0 == cp) {
        let t = if is_heavy { heavy } else { light };
        let len = if vertical { h } else { w };
        let gap = ((len as f32 / (n * 4) as f32).round() as u32).max(1);
        let seg = (len.saturating_sub(gap * n)) as f32 / n as f32;
        for i in 0..n {
            let at = (gap as f32 / 2. + i as f32 * (seg + gap as f32)).round() as u32;
            let size = seg.round() as u32;
            if vertical {
                let x = w.saturating_sub(t) / 2;
                rect(&mut pixels, x, at, x + t, at + size);
            } else {
                let y = h.saturating_sub(t) / 2;
                rect(&mut pixels, at, y, at + size, y + t);
            }
        }
        return Some(pixels);
    }

    // Rounded corners and diagonals: antialiased strokes, from 4×4 samples
    // of the distance to their path.
    let centre = (cx as f32 + light as f32 / 2., cy as f32 + light as f32 / 2.);
    let stroke: Option<Box<dyn Fn(f32, f32) -> f32>> = match cp {
        0x256d..=0x2570 => {
            // ╭ right+down, ╮ left+down, ╯ left+up, ╰ right+up.
            let (dx, dy) = match cp {
                0x256d => (1., 1.),
                0x256e => (-1., 1.),
                0x256f => (-1., -1.),
                _ => (1., -1.),
            };
            let (lx, ly) = centre;
            let r = (w.min(h) as f32 / 2.).min(if dx > 0. { w as f32 - lx } else { lx });
            let (ax, ay) = (lx + dx * r, ly + dy * r);
            let (edge_x, edge_y) = (
                if dx > 0. { w as f32 } else { 0. },
                if dy > 0. { h as f32 } else { 0. },
            );
            Some(Box::new(move |px: f32, py: f32| {
                let vertical = segment(px, py, (lx, ay), (lx, edge_y));
                let horizontal = segment(px, py, (ax, ly), (edge_x, ly));
                let arc = if (px - ax) * dx <= 0. && (py - ay) * dy <= 0. {
                    ((px - ax).hypot(py - ay) - r).abs()
                } else {
                    f32::MAX
                };
                vertical.min(horizontal).min(arc)
            }))
        }
        0x2571..=0x2573 => {
            let (wf, hf) = (w as f32, h as f32);
            Some(Box::new(move |px: f32, py: f32| {
                let rising = segment(px, py, (wf, 0.), (0., hf));
                let falling = segment(px, py, (0., 0.), (wf, hf));
                match cp {
                    0x2571 => rising,
                    0x2572 => falling,
                    _ => rising.min(falling),
                }
            }))
        }
        _ => None,
    };
    if let Some(distance) = stroke {
        let half = light as f32 / 2.;
        for y in 0..h {
            for x in 0..w {
                let mut hits = 0u32;
                for sy in 0..4 {
                    for sx in 0..4 {
                        let px = x as f32 + (sx as f32 + 0.5) / 4.;
                        let py = y as f32 + (sy as f32 + 0.5) / 4.;
                        hits += (distance(px, py) <= half) as u32;
                    }
                }
                if hits > 0 {
                    let i = ((y * tw + x) * 4) as usize;
                    pixels[i..i + 3].fill(255);
                    pixels[i + 3] = (hits * 255 / 16) as u8;
                }
            }
        }
        return Some(pixels);
    }

    let [up, right, down, left] = LINES.iter().find(|l| 0x2500 + l.0 as u32 == cp)?.1;
    // Each arm from the edge to the centre, through the widest crossing arm,
    // so joins close; a double line is two light ones a stroke apart.
    let width = |s: u8| match s {
        0 => light,
        3 => light * 3,
        s => thick(s),
    };
    let h_reach = width(up).max(width(down));
    let v_reach = width(left).max(width(right));
    // A double stroke stops at the near line of a double arm crossing it, and
    // otherwise runs on to the far line, so corners and tees stay open.
    let (near_x, far_x) = (cx.saturating_sub(light), cx + light);
    let (near_y, far_y) = (cy.saturating_sub(light), cy + light);
    let mut h_arm = |s: u8, to_right: bool| {
        if s == 0 {
            return;
        }
        let x0 = if to_right {
            w.saturating_sub(h_reach) / 2
        } else {
            0
        };
        let x1 = if to_right {
            w
        } else {
            (w + h_reach).div_ceil(2)
        };
        if s == 3 {
            for (y, crossed) in [(near_y, up == 3), (far_y, down == 3)] {
                let (x0, x1) = match (to_right, crossed, up == 3 || down == 3) {
                    (true, true, _) => (far_x, x1),
                    (true, false, true) => (near_x, x1),
                    (false, true, _) => (x0, near_x + light),
                    (false, false, true) => (x0, far_x + light),
                    _ => (x0, x1),
                };
                rect(&mut pixels, x0, y, x1, y + light);
            }
        } else {
            let y = h.saturating_sub(thick(s)) / 2;
            rect(&mut pixels, x0, y, x1, y + thick(s));
        }
    };
    h_arm(left, false);
    h_arm(right, true);
    let mut v_arm = |s: u8, to_bottom: bool| {
        if s == 0 {
            return;
        }
        let y0 = if to_bottom {
            h.saturating_sub(v_reach) / 2
        } else {
            0
        };
        let y1 = if to_bottom {
            h
        } else {
            (h + v_reach).div_ceil(2)
        };
        if s == 3 {
            for (x, crossed) in [(near_x, left == 3), (far_x, right == 3)] {
                let (y0, y1) = match (to_bottom, crossed, left == 3 || right == 3) {
                    (true, true, _) => (far_y, y1),
                    (true, false, true) => (near_y, y1),
                    (false, true, _) => (y0, near_y + light),
                    (false, false, true) => (y0, far_y + light),
                    _ => (y0, y1),
                };
                rect(&mut pixels, x, y0, x + light, y1);
            }
        } else {
            let x = w.saturating_sub(thick(s)) / 2;
            rect(&mut pixels, x, y0, x + thick(s), y1);
        }
    };
    v_arm(up, false);
    v_arm(down, true);
    Some(pixels)
}

/// Distance from (px, py) to the segment a–b.
fn segment(px: f32, py: f32, a: (f32, f32), b: (f32, f32)) -> f32 {
    let (vx, vy) = (b.0 - a.0, b.1 - a.1);
    let len = vx * vx + vy * vy;
    let t = if len == 0. {
        0.
    } else {
        (((px - a.0) * vx + (py - a.1) * vy) / len).clamp(0., 1.)
    };
    (px - (a.0 + t * vx)).hypot(py - (a.1 + t * vy))
}
