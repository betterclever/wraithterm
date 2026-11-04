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
fn query_checks_support_without_storing() {
    let mut c = term(10, 4);
    c.write(&apc("a=q,i=31,f=24,s=1,v=1", &[255, 0, 0]));
    assert!(replies(&mut c).contains("\x1b_Gi=31;OK\x1b\\"));
    assert!(c.image(31).is_none(), "a query stores nothing");
    c.update().unwrap();
    assert!(c.placements().is_empty());
}

#[test]
fn image_numbers_get_ids_and_replies_name_both() {
    let mut c = term(10, 4);
    c.write(&apc("a=t,f=24,s=1,v=1,I=13", &[0, 255, 0]));
    let reply = replies(&mut c);
    assert!(reply.contains("I=13") && reply.contains(";OK"), "{reply:?}");
    let id: u32 = reply
        .split("i=")
        .nth(1)
        .and_then(|s| s.split([',', ';']).next())
        .and_then(|s| s.parse().ok())
        .expect("the reply names the assigned id");
    assert!(id > 0 && c.image(id).is_some());
}

#[test]
fn palette_transparency_and_16_bit_pngs_decode_to_rgba() {
    let mut c = term(10, 4);
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, 2, 1);
        encoder.set_color(png::ColorType::Indexed);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_palette(vec![255, 0, 0, 0, 0, 255]);
        encoder.set_trns(vec![255, 64]);
        let mut w = encoder.write_header().unwrap();
        w.write_image_data(&[0, 1]).unwrap();
    }
    c.write(&apc("a=t,f=100,i=1,q=2", &out));
    let image = c.image(1).unwrap();
    assert_eq!(
        (image.width, image.height, image.format),
        (2, 1, image::RGBA)
    );
    assert_eq!(image.pixels, &[255, 0, 0, 255, 0, 0, 255, 64]);

    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, 1, 1);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Sixteen);
        let mut w = encoder.write_header().unwrap();
        w.write_image_data(&[0x12, 0x34, 0x80, 0x00, 0xff, 0xff])
            .unwrap();
    }
    c.write(&apc("a=t,f=100,i=2,q=2", &out));
    let image = c.image(2).unwrap();
    assert_eq!((image.width, image.height), (1, 1));
    for (got, high) in image.pixels[..3].iter().zip([0x12u8, 0x80, 0xff]) {
        assert!(
            got.abs_diff(high) <= 1,
            "16-bit samples narrow to their high byte"
        );
    }
    assert_eq!(image.pixels[3], 255);
}

#[test]
fn corrupt_payloads_and_oversized_images_are_errors() {
    let mut c = term(10, 4);
    c.write(&apc("a=T,f=100,i=1", b"\x89PNG\r\n\x1a\nnot really"));
    let reply = replies(&mut c);
    assert!(
        reply.contains("i=1;E") && !reply.contains("OK"),
        "{reply:?}"
    );
    assert!(c.image(1).is_none());

    c.write(&apc("a=t,f=24,s=4,v=4,i=2", &[1, 2, 3]));
    assert!(
        replies(&mut c).contains("i=2;E"),
        "short raw data is an error"
    );
    assert!(c.image(2).is_none());

    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, 16_385, 1);
        encoder.set_color(png::ColorType::Grayscale);
        encoder.set_depth(png::BitDepth::Eight);
        let mut w = encoder.write_header().unwrap();
        w.write_image_data(&vec![0; 16_385]).unwrap();
    }
    c.write(&apc("a=t,f=100,i=3", &out));
    assert!(replies(&mut c).contains("i=3;E"), "wider than 16,384 px");
    assert!(c.image(3).is_none());
    // The terminal keeps working after errors.
    c.write(&apc("a=T,f=24,s=1,v=1,i=4,q=2", &[9, 9, 9]));
    c.update().unwrap();
    assert_eq!(c.placements().len(), 1);
}

#[test]
fn several_placements_of_one_image_and_deleting_by_placement() {
    let mut c = term(20, 8);
    c.write(&apc("a=t,f=32,s=4,v=4,i=5,q=2", &rgba(4, 4)));
    c.write(b"\x1b[1;1H\x1b_Ga=p,i=5,p=1,C=1,q=2\x1b\\");
    c.write(b"\x1b[3;6H\x1b_Ga=p,i=5,p=2,C=1,q=2\x1b\\");
    c.write(b"\x1b[6;11H\x1b_Ga=p,i=5,p=3,C=1,q=2\x1b\\");
    c.update().unwrap();
    let mut ids: Vec<_> = c.placements().iter().map(|p| p.placement_id).collect();
    ids.sort();
    assert_eq!(ids, [1, 2, 3]);
    let second = c
        .placements()
        .iter()
        .find(|p| p.placement_id == 2)
        .copied()
        .unwrap();
    assert_eq!((second.x, second.y), (5 * 9, 2 * 18));

    c.write(b"\x1b_Ga=d,d=i,i=5,p=2,q=2\x1b\\");
    c.update().unwrap();
    let mut ids: Vec<_> = c.placements().iter().map(|p| p.placement_id).collect();
    ids.sort();
    assert_eq!(ids, [1, 3]);

    // Lowercase deletes placements and keeps the image for later.
    c.write(b"\x1b_Ga=d,d=i,i=5,q=2\x1b\\");
    c.update().unwrap();
    assert!(c.placements().is_empty());
    assert!(c.image(5).is_some());
    c.write(b"\x1b_Ga=p,i=5,q=2\x1b\\");
    c.update().unwrap();
    assert_eq!(c.placements().len(), 1);
    // Uppercase frees the image too.
    c.write(b"\x1b_Ga=d,d=I,i=5,q=2\x1b\\");
    c.update().unwrap();
    assert!(c.placements().is_empty());
    assert!(c.image(5).is_none());
}

#[test]
fn the_cursor_moves_past_an_image_unless_told_not_to() {
    let mut c = term(20, 6);
    // 18×36 px: two cells wide, two rows tall.
    c.write(&apc("a=T,f=32,s=18,v=36,i=1,q=2", &rgba(18, 36)));
    c.write(b"Z");
    c.update().unwrap();
    let rows: Vec<String> = c.text(false).lines().map(str::to_owned).collect();
    assert_eq!(rows.get(1).map(|r| r.trim_end()), Some("  Z"), "{rows:?}");

    let mut c = term(20, 6);
    c.write(&apc("a=T,f=32,s=18,v=36,i=1,C=1,q=2", &rgba(18, 36)));
    c.write(b"Z");
    c.update().unwrap();
    assert!(c.text(false).starts_with('Z'));
}

#[test]
fn many_chunks_in_quiet_mode_reassemble_exactly() {
    let mut c = term(20, 6);
    let pixels = rgba(64, 64);
    let encoded = base64(&pixels);
    let chunks: Vec<&str> = encoded
        .as_bytes()
        .chunks(4096)
        .map(|b| std::str::from_utf8(b).unwrap())
        .collect();
    assert!(chunks.len() > 3);
    for (i, chunk) in chunks.iter().enumerate() {
        let more = (i + 1 < chunks.len()) as u8;
        let control = if i == 0 {
            format!("a=t,f=32,s=64,v=64,i=9,q=1,m={more}")
        } else {
            format!("m={more},q=1")
        };
        c.write(format!("\x1b_G{control};{chunk}\x1b\\").as_bytes());
    }
    assert!(replies(&mut c).is_empty(), "q=1 suppresses OK");
    assert_eq!(c.image(9).unwrap().pixels, &pixels[..]);
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

#[test]
fn clearing_the_screen_and_scrollback_takes_its_images_along() {
    // `clear`: home, erase the display, erase the scrollback.
    for clear in [
        &b"\x1b[H\x1b[2J\x1b[3J"[..],
        b"\x1b[H\x1b[2J",
        b"\x1b[3J\x1b[H\x1b[2J",
    ] {
        let mut c = term(20, 8);
        c.write(b"line one\r\n");
        c.write(&apc("a=T,f=32,s=9,v=18,i=1,q=2", &rgba(9, 18)));
        c.write(b"\r\nmore\r\n\r\n");
        c.update().unwrap();
        assert_eq!(c.placements().len(), 1);
        c.write(clear);
        c.update().unwrap();
        let at: Vec<_> = c.placements().iter().map(|p| (p.x, p.y)).collect();
        assert!(
            at.is_empty(),
            "{:?}: placements still drawn at {at:?}",
            String::from_utf8_lossy(clear)
        );
    }
}

#[test]
fn clearing_removes_placements_made_by_id_and_scrolled_ones_too() {
    let mut c = term(20, 8);
    c.write(&apc("a=T,f=32,s=9,v=18,i=101,q=2", &rgba(9, 18)));
    c.write(b"\r\n\r\n");
    c.write(&apc("a=t,f=32,s=4,v=4,i=102,q=2", &rgba(4, 4)));
    c.write(b"  \x1b_Ga=p,i=102,p=1,c=2,r=2,q=2\x1b\\  \x1b_Ga=p,i=102,p=2,c=1,r=1,q=2\x1b\\\r\n\r\n\r\n");
    c.write(&apc("a=t,f=32,s=4,v=4,i=103,q=2", &rgba(4, 4)));
    c.write(b"  \x1b_Ga=p,i=103,p=1,c=2,r=2,z=1,C=1,q=2\x1b\\TEXT\r\n");
    c.write(b"  \x1b_Ga=p,i=103,p=2,c=2,r=2,z=-1,C=1,q=2\x1b\\TEXT\r\n\r\n\r\nprompt$ ");
    c.update().unwrap();
    assert!(!c.placements().is_empty());
    c.write(b"\x1b[H\x1b[2J\x1b[3J");
    c.update().unwrap();
    let left: Vec<_> = c
        .placements()
        .iter()
        .map(|p| (p.image_id, p.placement_id, p.x, p.y))
        .collect();
    assert!(left.is_empty(), "still drawn after clear: {left:?}");
}

#[test]
fn erasing_scrollback_keeps_unplaced_images_and_visible_placements() {
    let mut c = term(20, 4);
    c.write(&apc("a=t,f=32,s=2,v=2,i=200,q=2", &rgba(2, 2)));
    c.write(&apc("a=T,f=32,s=2,v=2,i=201,q=2", &rgba(2, 2)));
    c.write(b"\r\n\r\n\r\n\r\n\r\n\r\n");
    c.write(&apc("a=T,f=32,s=2,v=2,i=202,q=2", &rgba(2, 2)));
    c.update().unwrap();
    c.write(b"\x1b[3J");
    c.update().unwrap();
    let ids: Vec<_> = c.placements().iter().map(|p| p.image_id).collect();
    assert_eq!(
        ids,
        [202],
        "the visible placement stays, the scrolled-out one goes"
    );
    assert!(
        c.image(200).is_some(),
        "transmitted, never placed: kept for later"
    );
    assert!(c.image(201).is_none(), "only its erased placement used it");
    c.write(b"\x1b[H\x1b_Ga=p,i=200,q=2\x1b\\");
    c.update().unwrap();
    assert_eq!(c.placements().len(), 2);
}

#[test]
fn clear_at_a_shell_prompt_keeps_images_off_the_new_screen() {
    // ncurses `clear`: E3 first, then home and ED2; at an OSC 133 prompt
    // Ghostty scrolls the screen into history before clearing it.
    let mut c = term(20, 8);
    c.write(b"\x1b]133;A\x07$ \x1b]133;B\x07spec\r\n\x1b]133;C\x07");
    c.write(&apc("a=t,f=32,s=4,v=4,i=103,q=2", &rgba(4, 4)));
    c.write(b"  \x1b_Ga=p,i=103,p=1,c=2,r=2,z=1,C=1,q=2\x1b\\TEXT\r\n");
    c.write(b"  \x1b_Ga=p,i=103,p=2,c=2,r=2,z=-1,C=1,q=2\x1b\\TEXT\r\n\r\n");
    c.write(b"\x1b]133;D;0\x07\x1b]133;A\x07$ \x1b]133;B\x07");
    c.update().unwrap();
    assert_eq!(c.placements().len(), 2);
    // Scrolled back a little (reading earlier output), then typing returns.
    c.scroll(-2);
    c.update().unwrap();
    c.scroll(2);
    c.write(b"clear\r\n\x1b]133;C\x07\x1b[3J\x1b[H\x1b[2J");
    c.write(b"\x1b]133;D;0\x07\x1b]133;A\x07$ \x1b]133;B\x07");
    c.update().unwrap();
    let left: Vec<_> = c
        .placements()
        .iter()
        .map(|p| (p.placement_id, p.x, p.y))
        .collect();
    assert!(left.is_empty(), "after clear: {left:?}");
    for i in 0..30 {
        c.write(format!("out {i}\r\n").as_bytes());
    }
    c.update().unwrap();
    let left: Vec<_> = c
        .placements()
        .iter()
        .map(|p| (p.placement_id, p.x, p.y))
        .collect();
    assert!(left.is_empty(), "after more output: {left:?}");
}

#[test]
fn clear_while_scrolled_back_keeps_images_off_the_new_screen() {
    let mut c = term(20, 8);
    c.write(b"\x1b]133;A\x07$ \x1b]133;B\x07spec\r\n\x1b]133;C\x07");
    for i in 0..10 {
        c.write(format!("pre {i}\r\n").as_bytes());
    }
    c.write(&apc("a=t,f=32,s=4,v=4,i=103,q=2", &rgba(4, 4)));
    c.write(b"  \x1b_Ga=p,i=103,p=1,c=2,r=2,z=1,C=1,q=2\x1b\\TEXT\r\n");
    c.write(b"  \x1b_Ga=p,i=103,p=2,c=2,r=2,z=-1,C=1,q=2\x1b\\TEXT\r\n\r\n");
    c.write(b"\x1b]133;D;0\x07\x1b]133;A\x07$ \x1b]133;B\x07");
    c.scroll(-3);
    c.update().unwrap();
    // The viewport stays scrolled back while the command runs.
    c.write(b"clear\r\n\x1b]133;C\x07\x1b[3J\x1b[H\x1b[2J");
    c.write(b"\x1b]133;D;0\x07\x1b]133;A\x07$ \x1b]133;B\x07");
    c.update().unwrap();
    c.scroll(10_000);
    for i in 0..30 {
        c.write(format!("out {i}\r\n").as_bytes());
    }
    c.update().unwrap();
    let left: Vec<_> = c
        .placements()
        .iter()
        .map(|p| (p.placement_id, p.x, p.y))
        .collect();
    assert!(left.is_empty(), "after clear while scrolled back: {left:?}");
}

#[test]
fn erasing_below_from_home_keeps_images_never_placed() {
    // A program can upload once and repaint with CSI H CSI J between frames.
    let mut c = term(20, 8);
    c.write(&apc("a=t,f=32,s=2,v=2,i=7,q=2", &rgba(2, 2)));
    c.write(&apc("a=T,f=32,s=2,v=2,i=8,q=2", &rgba(2, 2)));
    c.update().unwrap();
    c.write(b"\x1b[H\x1b[J");
    c.update().unwrap();
    assert!(c.placements().is_empty());
    assert!(c.image(7).is_some(), "transmitted, never placed: kept");
    assert!(c.image(8).is_none(), "only its erased placement used it");
    c.write(b"\x1b_Ga=p,i=7,q=2\x1b\\");
    c.update().unwrap();
    assert_eq!(c.placements().len(), 1);
}

#[test]
fn erasing_scrollback_keeps_a_placement_still_partly_on_screen() {
    let mut c = term(20, 4);
    c.write(&apc("a=T,f=32,s=2,v=2,i=9,r=4,c=2,q=2", &rgba(2, 2)));
    c.write(b"\r\n");
    c.update().unwrap();
    assert_eq!(c.placements().len(), 1, "its lower rows are on screen");
    c.write(b"\x1b[3J");
    c.update().unwrap();
    assert_eq!(c.placements().len(), 1, "so it stays");
    assert!(c.image(9).is_some());
}

#[test]
fn busybox_clear_erasing_below_from_home_takes_the_images() {
    // busybox `clear`: CSI H CSI J (erase below, from the home position).
    let mut c = term(20, 8);
    c.write(b"text\r\n");
    c.write(&apc("a=T,f=32,s=9,v=18,i=1,q=2", &rgba(9, 18)));
    c.write(b"\r\nmore\r\n");
    c.update().unwrap();
    assert_eq!(c.placements().len(), 1);
    c.write(b"\x1b[H\x1b[J");
    c.update().unwrap();
    assert!(c.placements().is_empty(), "busybox clear leaves no image");

    // Erasing below from elsewhere keeps what is above the cursor.
    let mut c = term(20, 8);
    c.write(&apc("a=T,f=32,s=9,v=18,i=1,q=2", &rgba(9, 18)));
    c.write(b"\r\n\r\n\r\nrest\r\n");
    c.write(b"\x1b[4;1H\x1b[J");
    c.update().unwrap();
    assert_eq!(
        c.placements().len(),
        1,
        "an image above the erased rows stays"
    );
}
