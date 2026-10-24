//! Kitty graphics through libghostty-vt: transmission formats, placement
//! geometry, layering, deletion and replies. Cells default to 9×18 pixels.
use std::io::Write;
use wraith_engine::{core::Core, image};

fn term(cols: u16, rows: u16) -> Core {
    let mut c = Core::new(cols, rows, 100).unwrap();
    c.theme(0xffffff, 0, 0xffffff);
    c
}
fn base64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |n, (i, &b)| n | (b as u32) << (16 - 8 * i));
        for i in 0..=chunk.len() {
            out.push(T[(n >> (18 - 6 * i) & 63) as usize] as char);
        }
        out.extend(std::iter::repeat_n('=', 3 - chunk.len()));
    }
    out
}
fn apc(control: &str, payload: &[u8]) -> Vec<u8> {
    format!("\x1b_G{control};{}\x1b\\", base64(payload)).into_bytes()
}
fn replies(c: &mut Core) -> String {
    c.take_events()
        .into_iter()
        .filter(|(kind, _)| *kind == 0)
        .map(|(_, b)| String::from_utf8_lossy(&b).into_owned())
        .collect()
}
fn rgba(w: u32, h: u32) -> Vec<u8> {
    (0..w * h)
        .flat_map(|i| [i as u8, (2 * i) as u8, 255 - i as u8, 200])
        .collect()
}
fn png(w: u32, h: u32, color: png::ColorType, data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut encoder = png::Encoder::new(&mut out, w, h);
    encoder.set_color(color);
    encoder.set_depth(png::BitDepth::Eight);
    encoder
        .write_header()
        .unwrap()
        .write_image_data(data)
        .unwrap();
    out
}

#[test]
fn rgba_image_is_stored_placed_at_the_cursor_and_acknowledged() {
    let mut c = term(20, 6);
    c.write(b"ab\r\ncd");
    let pixels = rgba(3, 2);
    c.write(&apc("a=T,f=32,s=3,v=2,i=7", &pixels));
    assert!(c.update().unwrap());
    let p = c.placements()[0];
    assert_eq!(c.placements().len(), 1);
    assert_eq!(
        (p.image_id, p.x, p.y, p.width, p.height),
        (7, 2 * 9, 18, 3, 2)
    );
    assert_eq!((p.source_width, p.source_height, p.layer), (3, 2, 3));
    let image = c.image(7).unwrap();
    assert_eq!(
        (image.width, image.height, image.format),
        (3, 2, image::RGBA)
    );
    assert_eq!(image.pixels, &pixels[..]);
    assert!(replies(&mut c).contains("\x1b_Gi=7;OK\x1b\\"));
}

#[test]
fn chunked_zlib_rgb_and_png_payloads_decode() {
    let mut c = term(20, 6);
    let rgb: Vec<u8> = (0..4 * 4 * 3).map(|i| i as u8).collect();
    let mut z = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    z.write_all(&rgb).unwrap();
    let encoded = base64(&z.finish().unwrap());
    let (head, tail) = encoded.split_at(encoded.len() / 2 / 4 * 4);
    c.write(format!("\x1b_Ga=t,f=24,o=z,s=4,v=4,i=1,m=1;{head}\x1b\\").as_bytes());
    c.write(format!("\x1b_Gm=0;{tail}\x1b\\").as_bytes());
    let image = c.image(1).unwrap();
    assert_eq!((image.format, image.pixels), (image::RGB, &rgb[..]));

    let gray: Vec<u8> = (0..6u8).collect();
    c.write(&apc(
        "a=t,f=100,i=2",
        &png(3, 2, png::ColorType::Grayscale, &gray),
    ));
    let image = c.image(2).unwrap();
    assert_eq!(
        (image.width, image.height, image.format),
        (3, 2, image::RGBA)
    );
    let expected: Vec<u8> = gray.iter().flat_map(|&g| [g, g, g, 255]).collect();
    assert_eq!(image.pixels, &expected[..]);

    let rgba = rgba(5, 3);
    c.write(&apc(
        "a=t,f=100,i=3",
        &png(5, 3, png::ColorType::Rgba, &rgba),
    ));
    assert_eq!(c.image(3).unwrap().pixels, &rgba[..]);
}

#[test]
fn scaling_cropping_offsets_and_layers_follow_the_protocol() {
    let mut c = term(20, 8);
    c.write(&apc("a=t,f=32,s=8,v=8,i=1,q=2", &rgba(8, 8)));
    c.write(b"\x1b[3;5H");
    c.write(b"\x1b_Ga=p,i=1,p=1,c=4,r=2,X=3,Y=5,z=-1,q=2\x1b\\");
    c.write(b"\x1b[1;1H\x1b_Ga=p,i=1,p=2,x=2,y=1,w=4,h=6,z=5,q=2\x1b\\");
    c.write(b"\x1b[6;1H\x1b_Ga=p,i=1,p=3,z=-1073741825,C=1,q=2\x1b\\");
    c.update().unwrap();
    let placements = c.placements();
    let layers: Vec<_> = placements
        .iter()
        .map(|p| (p.placement_id, p.layer))
        .collect();
    assert_eq!(layers, [(3, 1), (1, 2), (2, 3)]);
    let scaled = placements[1];
    assert_eq!((scaled.x, scaled.y), (4 * 9 + 3, 2 * 18 + 5));
    // Ghostty fits c×r cells minus the in-cell pixel offset.
    assert_eq!((scaled.width, scaled.height), (4 * 9 - 3, 2 * 18 - 5));
    let cropped = placements[2];
    let source = (
        cropped.source_x,
        cropped.source_y,
        cropped.source_width,
        cropped.source_height,
    );
    assert_eq!(source, (2, 1, 4, 6));
    assert_eq!((cropped.width, cropped.height), (4, 6));
    assert!(replies(&mut c).is_empty(), "q=2 suppresses every reply");
}

#[test]
fn deletion_replacement_and_scrolling_update_placements() {
    let mut c = term(10, 4);
    c.write(&apc("a=T,f=32,s=2,v=2,i=1,q=2", &rgba(2, 2)));
    c.update().unwrap();
    let first = c.placements()[0].generation;
    assert!(!c.update().unwrap(), "unchanged storage needs no redraw");

    // Retransmitting an ID drops its placements (as in kitty); streaming
    // programs transmit and display again, which yields a new generation.
    c.write(&apc("a=t,f=32,s=2,v=2,i=1,q=2", &rgba(2, 2)));
    assert!(c.update().unwrap());
    assert!(c.placements().is_empty());
    c.write(b"\x1b[H");
    c.write(&apc("a=T,f=32,s=2,v=2,i=1,q=2", &rgba(2, 2)));
    assert!(c.update().unwrap());
    assert!(
        c.placements()[0].generation > first,
        "retransmission is a new generation"
    );

    c.write(b"\r\n\r\n\r\n\r\n");
    c.update().unwrap();
    assert!(c.placements().is_empty(), "scrolled out of the viewport");
    c.scroll(-2);
    c.update().unwrap();
    assert_eq!(c.placements().len(), 1, "visible again in scrollback");
    c.scroll(2);

    c.write(b"\x1b_Ga=p,i=1,q=2\x1b\\");
    c.update().unwrap();
    assert_eq!(c.placements().len(), 1);
    c.write(b"\x1b_Ga=d,d=A,q=2\x1b\\");
    assert!(c.update().unwrap());
    assert!(c.placements().is_empty());
}

#[test]
fn errors_are_reported_and_a_zero_limit_disables_images() {
    let mut c = term(10, 4);
    c.write(b"\x1b_Ga=p,i=99\x1b\\");
    assert!(replies(&mut c).contains("ENOENT"));
    c.set_image_limit(0).unwrap();
    c.write(&apc("a=T,f=32,s=1,v=1,i=1,q=2", &rgba(1, 1)));
    c.update().unwrap();
    assert!(c.placements().is_empty());
}

#[test]
fn placements_on_the_first_and_last_rows_and_sub_cell_images_are_visible() {
    let mut c = term(20, 4);
    c.write(&apc("a=T,f=32,s=2,v=2,i=1,q=2", &rgba(2, 2)));
    c.write(b"\x1b[4;19H");
    c.write(&apc("a=T,f=32,s=9,v=18,i=2,q=2,C=1", &rgba(9, 18)));
    c.update().unwrap();
    let at: Vec<_> = c
        .placements()
        .iter()
        .map(|p| (p.image_id, p.x, p.y))
        .collect();
    assert_eq!(at, [(1, 0, 0), (2, 18 * 9, 3 * 18)]);
}
