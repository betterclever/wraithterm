//! Standalone research kernel. Timings include copies into/out of this Wasm
//! memory. It is not linked into the shipped engine. Unsupported rows use JS.
#![no_std]
use core::arch::wasm32::*;

const COLS: usize = 320;
const SCALARS: usize = 0x3000 * 4;
static mut INPUT: [u32; COLS * 3] = [0; COLS * 3];
static mut OUTPUT: [u32; COLS * 5] = [0; COLS * 5];
static mut GLYPHS: [u32; SCALARS] = [0; SCALARS];
static mut PALETTE: [u32; 256] = [0; 256];

#[panic_handler]
fn panic(_: &core::panic::PanicInfo<'_>) -> ! {
    unreachable()
}

#[no_mangle]
pub extern "C" fn input_ptr() -> *mut u32 {
    core::ptr::addr_of_mut!(INPUT).cast()
}
#[no_mangle]
pub extern "C" fn output_ptr() -> *mut u32 {
    core::ptr::addr_of_mut!(OUTPUT).cast()
}
#[no_mangle]
pub extern "C" fn glyph_ptr() -> *mut u32 {
    core::ptr::addr_of_mut!(GLYPHS).cast()
}
#[no_mangle]
pub extern "C" fn palette_ptr() -> *mut u32 {
    core::ptr::addr_of_mut!(PALETTE).cast()
}

fn rgb(w: u32) -> u32 {
    ((w & 255) << 16) | (w & 0xff00) | ((w >> 16) & 255)
}
unsafe fn color(w: u32, default: u32, brighten: bool) -> u32 {
    match w & 0x3000000 {
        0x3000000 => rgb(w),
        0 => default,
        _ => {
            let index = (w & 255) as usize;
            *palette_ptr().add(index + if brighten && index < 8 { 8 } else { 0 })
        }
    }
}
fn flags(fg: u32, bg: u32) -> u32 {
    ((fg >> 27) & 1)
        | (((bg >> 26) & 1) << 1)
        | (((bg >> 27) & 1) << 2)
        | (((fg >> 30) & 1) << 4)
        | ((fg >> 31) << 5)
        | (((bg >> 30) & 1) << 6)
        | (((fg >> 28) & 1) << 8)
}
unsafe fn valid(cols: usize) -> bool {
    if cols > COLS {
        return false;
    }
    for x in 0..cols {
        let p = input_ptr().add(x * 3);
        let content = *p;
        let f = *p.add(1);
        let b = *p.add(2);
        let cp = content & 0x1fffff;
        if b & 0x10000000 != 0 || content & 0x200000 != 0 || content >> 22 > 2 || cp >= 0x3000 {
            return false;
        }
        if content >> 22 != 0
            && cp != 0
            && cp != 32
            && *glyph_ptr().add(cp as usize * 4 + (flags(f, b) & 3) as usize) == 0
        {
            return false;
        }
    }
    true
}
unsafe fn finish_cell(x: usize, fg: u32, bg: u32, underline: u32) {
    let input = input_ptr().add(x * 3);
    let output = output_ptr().add(x * 5);
    let content = *input;
    let cp = content & 0x1fffff;
    let style = flags(*input.add(1), *input.add(2));
    *output = fg;
    *output.add(1) = bg;
    *output.add(2) = underline;
    *output.add(3) = style | if content >> 22 == 2 { 65536 } else { 0 };
    *output.add(4) = if content >> 22 == 0 || cp == 0 || cp == 32 {
        0
    } else {
        *glyph_ptr().add(cp as usize * 4 + (style & 3) as usize)
    };
}
unsafe fn scalar_cell(x: usize, fg_default: u32, bg_default: u32, brighten: bool) {
    let p = input_ptr().add(x * 3);
    let f = *p.add(1);
    let b = *p.add(2);
    let inverse = f & 0x4000000 != 0;
    let fg = color(
        if inverse { b } else { f },
        if inverse { bg_default } else { fg_default },
        brighten && f & 0x8000000 != 0,
    );
    let bg = color(
        if inverse { f } else { b },
        if inverse { fg_default } else { bg_default },
        false,
    );
    let ul = if f & 0x3000000 != 0 {
        color(f, fg_default, false)
    } else {
        fg
    };
    finish_cell(x, fg, bg, ul);
}
#[no_mangle]
pub unsafe extern "C" fn pack_scalar(cols: usize, fg: u32, bg: u32, brighten: bool) -> u32 {
    if !valid(cols) {
        return 0;
    }
    for x in 0..cols {
        scalar_cell(x, fg, bg, brighten);
    }
    1
}
unsafe fn rgb4(v: v128) -> v128 {
    v128_or(
        v128_or(
            u32x4_shl(v128_and(v, u32x4_splat(255)), 16),
            v128_and(v, u32x4_splat(0xff00)),
        ),
        v128_and(u32x4_shr(v, 16), u32x4_splat(255)),
    )
}
#[no_mangle]
pub unsafe extern "C" fn pack_simd(cols: usize, fg: u32, bg: u32, brighten: bool) -> u32 {
    if !valid(cols) {
        return 0;
    }
    let mut x = 0;
    while x + 4 <= cols {
        let p = input_ptr().add(x * 3);
        let a = v128_load(p.cast());
        let b = v128_load(p.add(4).cast());
        let c = v128_load(p.add(8).cast());
        let f = i32x4_shuffle::<0, 1, 2, 6>(i32x4_shuffle::<1, 4, 7, 7>(a, b), c);
        let back = i32x4_shuffle::<0, 1, 4, 7>(i32x4_shuffle::<2, 5, 5, 5>(a, b), c);
        // SIMD shortcut only for ordinary non-inverse truecolor groups.
        if u32x4_all_true(u32x4_eq(
            v128_and(f, u32x4_splat(0x7000000)),
            u32x4_splat(0x3000000),
        )) && u32x4_all_true(u32x4_eq(
            v128_and(back, u32x4_splat(0x3000000)),
            u32x4_splat(0x3000000),
        )) {
            let front_rgb = rgb4(f);
            let back_rgb = rgb4(back);
            finish_cell(
                x,
                u32x4_extract_lane::<0>(front_rgb),
                u32x4_extract_lane::<0>(back_rgb),
                u32x4_extract_lane::<0>(front_rgb),
            );
            finish_cell(
                x + 1,
                u32x4_extract_lane::<1>(front_rgb),
                u32x4_extract_lane::<1>(back_rgb),
                u32x4_extract_lane::<1>(front_rgb),
            );
            finish_cell(
                x + 2,
                u32x4_extract_lane::<2>(front_rgb),
                u32x4_extract_lane::<2>(back_rgb),
                u32x4_extract_lane::<2>(front_rgb),
            );
            finish_cell(
                x + 3,
                u32x4_extract_lane::<3>(front_rgb),
                u32x4_extract_lane::<3>(back_rgb),
                u32x4_extract_lane::<3>(front_rgb),
            );
        } else {
            for j in 0..4 {
                scalar_cell(x + j, fg, bg, brighten);
            }
        }
        x += 4;
    }
    while x < cols {
        scalar_cell(x, fg, bg, brighten);
        x += 1;
    }
    1
}
