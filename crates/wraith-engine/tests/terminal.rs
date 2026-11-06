use wraith_engine::{core::Core, text::Atlas};
fn term(cols: u16, rows: u16) -> Core {
    let mut c = Core::new(cols, rows, 100).unwrap();
    c.theme(0xffffff, 0, 0xffffff);
    c
}
fn text(c: &mut Core) -> String {
    c.update().unwrap();
    c.text(false)
}
#[test]
fn plain_text_and_cursor() {
    let mut c = term(80, 24);
    c.write(b"hello");
    assert_eq!(text(&mut c), "hello");
    assert_eq!(c.frame().cursor_x, 5);
}
#[test]
fn native_selection_supports_words_lines_blocks_and_all_history() {
    let mut c = term(12, 3);
    c.write("hello world\r\n界e\u{301} text\r\nlast".as_bytes());
    c.select_mode(1, 0, 1, 0, 2).unwrap();
    assert_eq!(c.selection_text().unwrap(), "hello");
    c.select_mode(0, 1, 0, 1, 3).unwrap();
    assert_eq!(c.selection_text().unwrap(), "界e\u{301} text");
    c.select_mode(0, 0, 1, 2, 1).unwrap();
    assert_eq!(c.selection_text().unwrap(), "he\n界\nla");
    c.select_mode(0, 0, 0, 0, 4).unwrap();
    assert_eq!(
        c.selection_text().unwrap(),
        "hello world\n界e\u{301} text\nlast"
    );
    c.select_mode(-1, 0, 0, 0, 0).unwrap();
    assert_eq!(c.selection_text().unwrap(), "");
    assert!(c.select_mode(12, 0, 12, 0, 0).is_err());
}
#[test]
fn native_search_covers_scrollback_unicode_reflow_and_wraparound() {
    let mut c = term(12, 3);
    c.write("old MATCH\r\n界 match\r\nthird MATCH\r\nlatest".as_bytes());
    c.search("match", 0).unwrap();
    for _ in 0..100 {
        if c.search("", 1).unwrap()[0] == 2 {
            break;
        }
    }
    let first = c.search("", 2).unwrap();
    assert_eq!(first[1], 3);
    assert_eq!(first[2], 0);
    assert_eq!(c.selection_text().unwrap(), "MATCH");
    assert_eq!(c.search("", 2).unwrap()[2], 1);
    assert_eq!(c.selection_text().unwrap(), "match");
    assert_eq!(c.search("", 2).unwrap()[2], 2);
    assert_eq!(c.search("", 2).unwrap()[2], 0);
    assert_eq!(c.search("", 3).unwrap()[2], 2);
    c.resize(8, 4, 9, 18).unwrap();
    c.search("界", 0).unwrap();
    while c.search("", 1).unwrap()[0] != 2 {}
    assert_eq!(c.search("", 2).unwrap()[1], 1);
    assert_eq!(c.selection_text().unwrap(), "界");
    c.search("missing", 0).unwrap();
    while c.search("", 1).unwrap()[0] != 2 {}
    assert_eq!(c.search("", 2).unwrap()[1], 0);
    assert_eq!(c.selection_text().unwrap(), "");
    assert_eq!(c.search("", 4).unwrap()[1], 0);
}
#[test]
fn utf8_and_escape_sequences_survive_every_chunk_boundary() {
    let input = "a\x1b[31m界e\u{301}\x1b[0m\r\nnext".as_bytes();
    let mut whole = term(20, 3);
    whole.write(input);
    let expected = text(&mut whole);
    for boundary in 0..=input.len() {
        let mut c = term(20, 3);
        c.write(&input[..boundary]);
        c.write(&input[boundary..]);
        assert_eq!(text(&mut c), expected, "split at {boundary}");
    }
    let mut bytes = term(20, 3);
    for b in input {
        bytes.write(&[*b]);
    }
    assert_eq!(text(&mut bytes), expected);
}
#[test]
fn truecolor_and_indexed_palette() {
    let mut c = term(20, 2);
    c.write(b"\x1b[38;2;12;34;56mA\x1b[38;5;196mB");
    c.update().unwrap();
    assert_eq!(c.cells()[0].foreground, 12 | 34 << 8 | 56 << 16);
    assert_eq!(c.cells()[1].foreground, 255);
}
#[test]
fn sgr_colon_rgb_and_decorations() {
    let mut c = term(10, 2);
    c.write(b"\x1b[38:2::10:20:30;1;3;4:3;9mA");
    c.update().unwrap();
    let a = &c.cells()[0];
    assert_eq!(a.foreground, 10 | 20 << 8 | 30 << 16);
    assert_eq!(a.flags & 3, 3);
    assert!(a.flags & 32 != 0);
    assert_eq!((a.flags >> 8) & 7, 3);
}
#[test]
fn inverse_and_background_erase() {
    let mut c = term(10, 2);
    c.write(b"\x1b[38;2;1;2;3;48;2;4;5;6;7mA\x1b[27m\x1b[K");
    c.update().unwrap();
    assert_eq!(c.cells()[0].foreground, 4 | 5 << 8 | 6 << 16);
    assert_eq!(c.cells()[1].background, 4 | 5 << 8 | 6 << 16);
}
#[test]
fn alternate_screen_restores_main_cursor_and_text() {
    let mut c = term(20, 3);
    c.write(b"main\x1b[?1049h\x1b[Halt");
    assert_eq!(text(&mut c), "alt");
    c.write(b"\x1b[?1049l!");
    assert_eq!(text(&mut c), "main!");
}
#[test]
fn wide_and_combining_cells() {
    let mut c = term(10, 2);
    c.write("界e\u{301}".as_bytes());
    c.update().unwrap();
    assert_eq!(c.cells()[0].text, "界");
    assert!(c.cells()[0].flags & (1 << 16) != 0);
    assert!(c.cells()[1].flags & (1 << 20) != 0);
    assert_eq!(c.cells()[2].text, "e\u{301}");
    assert_eq!(c.text(false), "界e\u{301}");
}
#[test]
fn emoji_sequences_and_flags_are_one_grapheme_even_after_a_reset() {
    for reset in [&b""[..], b"\x1bc"] {
        let mut c = term(20, 2);
        c.write(reset);
        assert!(c.mode(2027), "grapheme clustering is on by default");
        c.write("👍🏽|👨\u{200d}👩\u{200d}👧|🇯🇵|e\u{301}|".as_bytes());
        c.update().unwrap();
        let cells = c.cells();
        let texts: Vec<&str> = cells[..9].iter().map(|c| c.text.as_str()).collect();
        assert_eq!(texts[0], "👍🏽", "{texts:?}");
        assert_eq!(texts[2], "|");
        assert_eq!(texts[3], "👨\u{200d}👩\u{200d}👧", "{texts:?}");
        assert_eq!(texts[6], "🇯🇵", "{texts:?}");
        assert_eq!(texts[8], "|");
    }
}
/// A subset of Twemoji with one glyph, ▶, which JetBrains Mono also has.
const TWEMOJI_PLAY: &[u8] = include_bytes!("fonts/Twemoji-play.ttf");
fn colourful(pixels: &[u8]) -> usize {
    pixels
        .chunks_exact(4)
        .filter(|p| p[3] > 64 && p[..3].iter().max().unwrap() - p[..3].iter().min().unwrap() > 60)
        .count()
}
#[test]
fn a_variation_selector_asks_for_the_colour_font_over_a_text_glyph() {
    let mut atlas = regular_atlas();
    atlas.add_font(TWEMOJI_PLAY.to_vec()).unwrap();
    let text = styled_tile(&mut atlas, "▶", 0).1;
    assert_eq!(colourful(&text), 0, "plain, the regular font's glyph");
    let selected = styled_tile(&mut atlas, "▶\u{fe0e}", 0).1;
    assert_eq!(colourful(&selected), 0, "U+FE0E asks for the text glyph");
    let emoji = styled_tile(&mut atlas, "▶\u{fe0f}", 0).1;
    assert!(colourful(&emoji) > 20, "U+FE0F asks for the emoji");
    let mut plain = regular_atlas();
    let fallback = styled_tile(&mut plain, "▶\u{fe0f}", 0).1;
    assert!(
        fallback.chunks_exact(4).any(|p| p[3] > 64) && colourful(&fallback) == 0,
        "no colour font: still drawn, from the text font"
    );
}
#[test]
fn delayed_autowrap() {
    let mut c = term(4, 2);
    c.write(b"abcd");
    c.update().unwrap();
    assert_eq!(c.frame().cursor_y, 0);
    c.write(b"e");
    assert_eq!(text(&mut c), "abcd\ne");
}
#[test]
fn scrollback_and_viewport() {
    let mut c = term(10, 2);
    c.write(b"one\r\ntwo\r\nthree");
    assert_eq!(text(&mut c), "two\nthree");
    c.scroll(-1);
    assert_eq!(text(&mut c), "one\ntwo");
    c.scroll(100);
    assert_eq!(text(&mut c), "two\nthree");
}
#[test]
fn scroll_to_bottom_returns_from_history() {
    let mut c = term(10, 3);
    for i in 0..12 {
        c.write(format!("line {i}\r\n").as_bytes());
    }
    let bottom = text(&mut c);
    c.scroll(-5);
    assert_ne!(text(&mut c), bottom, "scrolled back");
    c.scroll_to_bottom();
    assert_eq!(text(&mut c), bottom);
}
#[test]
fn a_cursor_saved_by_a_full_screen_program_does_not_hold_blank_rows_on_shrinking() {
    // The patch for this needs batch-sgr's Screen.zig, so it goes with that switch.
    if std::env::var_os("WRAITH_GHOSTTY_PATCHES").is_some_and(|v| v == "0") {
        return;
    }
    // `less` saved the cursor low on the screen (1049 keeps it after leaving);
    // the shell then cleared and printed near the top. Showing the
    // keyboard shrinks the screen: the blank rows below go, not the output.
    let mut c = term(64, 34);
    for i in 0..300 {
        c.write(format!("{i}\r\n").as_bytes());
    }
    c.write(b"$ \x1b[?1049h\x1b[H\x1b[2Jpager\x1b[?1049l");
    c.write(b"\x1b[H\x1b[2J\x1b[3Joutput\r\n$ ");
    c.update().unwrap();
    assert_eq!(c.frame().cursor_y, 1);
    for rows in [30, 25, 20, 17, 8, 4] {
        c.resize(64, rows, 9, 18).unwrap();
        c.update().unwrap();
        assert_eq!(
            c.frame().cursor_y,
            1,
            "the prompt stays where it was at {rows} rows"
        );
        assert_eq!(
            text(&mut c).lines().next(),
            Some("output"),
            "at {rows} rows"
        );
    }
    // A shell's redraw on each of those keeps one prompt, in no scrollback.
    c.write(b"\r\x1b[K\r$ ");
    c.select_mode(0, 0, 0, 0, 4).unwrap();
    assert_eq!(c.selection_text().unwrap().matches('$').count(), 1);
}
#[test]
fn configured_history_retains_several_pages_and_zero_disables_it() {
    let mut c = Core::new(120, 40, 10_000).unwrap();
    let mut input = String::from("\x1bc");
    for n in 0..9000 {
        input.push_str(&format!("line {n:05} needle-{n} build output\r\n"));
    }
    c.write(input.as_bytes());
    c.search("needle-100 build", 0).unwrap();
    for _ in 0..1000 {
        if c.search("", 1).unwrap()[0] == 2 {
            break;
        }
    }
    assert_eq!(c.search("", 2).unwrap()[1], 1);
    assert_eq!(c.selection_text().unwrap(), "needle-100 build");
    c.select_mode(0, 0, 0, 0, 4).unwrap();
    let history = c.selection_text().unwrap();
    assert!(history.contains("line 00000 needle-0"));
    assert!(history.contains("line 08999 needle-8999"));

    let mut empty = Core::new(120, 3, 0).unwrap();
    empty.write(b"\x1bcgone\r\none\r\ntwo\r\nthree\r\nfour");
    empty.scroll(-10_000);
    assert_eq!(text(&mut empty), "two\nthree\nfour");
}
#[test]
fn scrolling_region_preserves_outside_rows() {
    let mut c = term(10, 4);
    c.write(b"top\r\na\r\nb\r\nbottom\x1b[2;3r\x1b[3;1H\nX");
    assert_eq!(text(&mut c), "top\nb\nX\nbottom");
}
#[test]
fn origin_mode_addresses_relative_to_margin() {
    let mut c = term(10, 5);
    c.write(b"\x1b[2;4r\x1b[?6h\x1b[1;1HX");
    c.update().unwrap();
    assert_eq!(c.cells()[10].text, "X");
}
#[test]
fn insert_delete_and_erase_chars() {
    let mut c = term(10, 2);
    c.write(b"abcd\x1b[1;2H\x1b[2@X");
    assert_eq!(text(&mut c), "aX bcd");
    c.write(b"\x1b[1;2H\x1b[2P");
    assert_eq!(text(&mut c), "abcd");
    c.write(b"\x1b[1;2H\x1b[2X");
    assert_eq!(text(&mut c), "a  d");
}
#[test]
fn save_restore_and_cursor_visibility() {
    let mut c = term(20, 3);
    c.write(b"abc\x1b7\x1b[3;3HX\x1b8!\x1b[?25l");
    c.update().unwrap();
    assert_eq!(c.frame().cursor_x, 4);
    assert_eq!(c.frame().cursor_y, 0);
    assert_eq!(c.frame().cursor_visible, 0);
}
#[test]
fn dec_line_drawing() {
    let mut c = term(20, 3);
    c.write(b"\x1b(0lqqk\x1b(B");
    assert_eq!(text(&mut c), "┌──┐");
}
#[test]
fn title_bell_and_cursor_report_effects() {
    let mut c = term(20, 3);
    c.write(b"\x1b]2;Wraith\x07\x07abc\x1b[6n");
    assert!(c.events().iter().any(|(k, d)| *k == 1 && d == b"Wraith"));
    assert!(c.events().iter().any(|(k, _)| *k == 2));
    assert!(c.events().iter().any(|(k, d)| *k == 0 && d == b"\x1b[1;4R"));
}
#[test]
fn synchronized_output_holds_the_previous_snapshot() {
    let mut c = term(10, 2);
    c.write(b"old");
    assert_eq!(text(&mut c), "old");
    c.write(b"\x1b[?2026h\rnew");
    c.update().unwrap();
    assert_eq!(c.frame().held, 1);
    assert_eq!(c.text(false), "old");
    c.write(b"\x1b[?2026l");
    assert_eq!(text(&mut c), "new");
}
#[test]
fn digests_read_content_inside_synchronized_output_without_releasing_it() {
    let mut a = term(10, 2);
    let mut b = term(10, 2);
    a.write(b"old");
    b.write(b"old");
    let before = a.digest().unwrap();
    a.write(b"\x1b[?2026h\rnew");
    b.write(b"\rnew");
    assert_ne!(a.digest().unwrap(), before);
    assert_eq!(a.digest().unwrap(), b.digest().unwrap());
    assert!(a.mode(2026));
    a.update().unwrap();
    assert_eq!(a.frame().held, 1);
}
#[test]
fn abandoned_synchronized_output_can_be_recovered() {
    let mut c = term(10, 2);
    c.write(b"\x1b[?2026hheld");
    c.release_hold();
    assert_eq!(text(&mut c), "held");
}
#[test]
fn hyperlinks_and_selection() {
    let mut c = term(20, 3);
    c.write(b"\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\ plain");
    assert_eq!(c.link(1, 0), "https://example.com");
    c.select(0, 0, 3, 0).unwrap();
    c.update().unwrap();
    assert_eq!(c.text(true), "link");
    c.select(-1, 0, 0, 0).unwrap();
    c.update().unwrap();
    assert_eq!(c.text(true), "");
}
#[test]
fn modes_and_kitty_input_encoding() {
    let mut c = term(20, 3);
    c.write(b"\x1b[?2004h\x1b[?1004h\x1b[>1u");
    assert!(c.mode(2004));
    assert!(c.mode(1004));
    c.key(0, 2, 1, "a", 97).unwrap();
    assert!(c.events().iter().any(|(k, d)| *k == 0 && !d.is_empty()));
}
#[test]
fn resize_preserves_and_reflows_content() {
    let mut c = term(10, 3);
    c.write(b"abcdefghijK");
    c.resize(5, 5, 9, 18).unwrap();
    assert_eq!(text(&mut c), "abcde\nfghij\nK");
}
#[test]
fn dirty_rows_are_incremental() {
    let mut c = term(20, 5);
    c.update().unwrap();
    c.acknowledge_damage();
    c.write(b"\x1b[3;1HX");
    c.update().unwrap();
    // Ghostty also damages the cursor's previous row, but its cells are
    // unchanged (the cursor is a uniform), so that row is reused in place.
    assert_eq!(c.dirty_rows(), vec![false, false, true, false, false]);
}
#[test]
fn shaders_validate_and_buffer_layout_matches() {
    for source in [
        include_str!("../src/terminal.wgsl"),
        include_str!("../src/image.wgsl"),
        include_str!("../src/effects.wgsl"),
    ] {
        let module = naga::front::wgsl::parse_str(source).unwrap();
        naga::valid::Validator::new(
            naga::valid::ValidationFlags::all(),
            naga::valid::Capabilities::empty(),
        )
        .validate(&module)
        .unwrap();
    }
}
#[test]
fn custom_shader_prelude_accepts_gallery_shaders() {
    // Custom shaders are the user's source followed by the prelude, exactly
    // as the renderer assembles them.
    let prelude = include_str!("../src/shader_prelude.wgsl");
    let identity = "fn mainImage(fragCoord: vec2<f32>) -> vec4<f32> {\n    return textureSample(iChannel0, iChannel0Sampler, fragCoord / iResolution.xy);\n}\n";
    for (name, source) in [
        ("identity", identity),
        ("amber", include_str!("../../../demo/effects/amber.wgsl")),
        ("ripple", include_str!("../../../demo/effects/ripple.wgsl")),
        (
            "spotlight",
            include_str!("../../../demo/effects/spotlight.wgsl"),
        ),
        ("glitch", include_str!("../../../demo/effects/glitch.wgsl")),
        (
            "synthwave",
            include_str!("../../../demo/effects/synthwave.wgsl"),
        ),
        ("rain", include_str!("../../../demo/effects/rain.wgsl")),
        (
            "shockwave",
            include_str!("../../../demo/effects/shockwave.wgsl"),
        ),
        (
            "hologram",
            include_str!("../../../demo/effects/hologram.wgsl"),
        ),
        ("warp", include_str!("../../../demo/effects/warp.wgsl")),
        ("matrix", include_str!("../../../demo/effects/matrix.wgsl")),
    ] {
        let code = format!("{source}\n{prelude}");
        let module = naga::front::wgsl::parse_str(&code)
            .unwrap_or_else(|e| panic!("{name}: {}", e.emit_to_string(&code)));
        naga::valid::Validator::new(
            naga::valid::ValidationFlags::all(),
            naga::valid::Capabilities::empty(),
        )
        .validate(&module)
        .unwrap_or_else(|e| panic!("{name}: {e:?}"));
    }
    // Without mainImage the module is rejected, which surfaces as an error.
    assert!(naga::front::wgsl::parse_str(prelude).is_err());
}
#[test]
fn font_rasterization_and_warm_cache() {
    let data = include_bytes!("../../../demo/fonts/JetBrainsMono-Regular.ttf").to_vec();
    let mut atlas = Atlas::new(data, 16., 1.3).unwrap();
    let cell = wraith_engine::core::Cell::with_text("e\u{301}");
    let first = atlas.tile(&cell);
    assert_ne!(first & wraith_engine::text::GLYPH_SLOT, 0);
    assert!(
        first >> 20 & 2047 > 0,
        "combining cluster records its ink extent"
    );
    assert!(atlas.uploads[0].pixels.iter().any(|p| *p != 0));
    let second = atlas.tile(&cell);
    assert_eq!(first, second);
    assert_eq!(atlas.uploads.len(), 1);
    assert_eq!(atlas.hits, 1);
}
#[test]
fn invalid_dimensions_are_rejected_without_ffi_calls() {
    assert!(Core::new(0, 24, 100).is_err());
    assert!(Core::new(512, 512, 100).is_err());
}
#[test]
fn selection_unwraps_soft_wrapped_lines() {
    let mut c = term(5, 3);
    c.write(b"abcdefgh");
    c.select(0, 0, 2, 1).unwrap();
    assert_eq!(c.selection_text().unwrap(), "abcdefgh");
}
#[test]
fn device_attributes_and_version_queries_have_responses() {
    let mut c = term(20, 3);
    c.write(b"\x1b[c\x1b[>c\x1b[>q");
    assert!(c
        .events()
        .iter()
        .any(|(k, d)| *k == 0 && d.starts_with(b"\x1b[?62;")));
    assert!(c
        .events()
        .iter()
        .any(|(k, d)| *k == 0 && d.starts_with(b"\x1b[>1;")));
    assert!(c
        .events()
        .iter()
        .any(|(k, d)| *k == 0 && d.windows(6).any(|w| w == b"Wraith")));
}
#[test]
fn configured_theme_colors_survive_unstyled_cells() {
    let mut c = term(20, 3);
    c.theme(0x443322, 0x776655, 0xccbbaa);
    c.write(b"X");
    c.update().unwrap();
    assert_eq!(c.cells()[0].foreground, 0x443322);
    assert_eq!(c.cells()[0].background, 0x776655);
}
#[test]
fn size_and_color_scheme_reports_follow_current_geometry_and_theme() {
    let mut c = term(20, 3);
    c.resize(40, 10, 8, 16).unwrap();
    c.write(b"\x1b[18t\x1b[16t\x1b[14t\x1b[?996n");
    for expected in [
        b"\x1b[8;10;40t".as_slice(),
        b"\x1b[6;16;8t",
        b"\x1b[4;160;320t",
        b"\x1b[?997;1n",
    ] {
        assert!(c.events().iter().any(|(k, d)| *k == 0 && d == expected));
    }
    c.theme(0, 0xffffff, 0);
    c.write(b"\x1b[?996n");
    assert!(c
        .events()
        .iter()
        .any(|(k, d)| *k == 0 && d == b"\x1b[?997;2n"));
}
#[test]
fn sgr_mouse_press_and_release_are_byte_exact() {
    let mut c = term(20, 3);
    c.resize(20, 3, 9, 18).unwrap();
    c.write(b"\x1b[?1000h\x1b[?1006h");
    c.mouse(0, 1, 0, 18., 18., 1).unwrap();
    c.mouse(1, 1, 0, 18., 18., 0).unwrap();
    assert!(c
        .events()
        .iter()
        .any(|(k, d)| *k == 0 && d == b"\x1b[<0;3;2M"));
    assert!(c
        .events()
        .iter()
        .any(|(k, d)| *k == 0 && d == b"\x1b[<0;3;2m"));
}
#[test]
fn scalar_table_and_cluster_cache_return_stable_glyph_words() {
    let data = include_bytes!("../../../demo/fonts/JetBrainsMono-Regular.ttf").to_vec();
    let mut atlas = Atlas::new(data, 16., 1.3).unwrap();
    let a = wraith_engine::core::Cell::with_text("A");
    let space = wraith_engine::core::Cell::with_text(" ");
    let crab = wraith_engine::core::Cell::with_text("\u{1f980}");
    assert_eq!(a.scalar, 'A' as u32);
    assert_eq!(atlas.tile(&space), 0);
    let first = atlas.tile(&a);
    let mut bold = a.clone();
    bold.flags = 1;
    let heavy = atlas.tile(&bold);
    assert_ne!(first, heavy, "styles occupy separate slots");
    assert_eq!(atlas.tile(&a), first);
    let emoji = atlas.tile(&crab);
    assert_eq!(atlas.tile(&crab), emoji);
    assert_eq!(atlas.hits, 2);
    assert_eq!(atlas.count(), 3);
    // Ink never exceeds the tile, which is two cells plus an italic margin.
    for glyph in [first, heavy, emoji] {
        assert!(glyph >> 20 & 2047 <= atlas.tile_width);
    }
}
fn box_atlas(font: &[u8]) -> Atlas {
    Atlas::new(font.to_vec(), 16., 1.3).unwrap()
}
const JETBRAINS: &[u8] = include_bytes!("../../../demo/fonts/JetBrainsMono-Regular.ttf");
/// The tile of a box drawing character.
fn box_pixels(atlas: &mut Atlas, cp: u32) -> Vec<u8> {
    let c = char::from_u32(cp).unwrap().to_string();
    atlas.tile(&wraith_engine::core::Cell::with_text(&c));
    atlas.uploads.last().unwrap().pixels.clone()
}
/// Alpha of the tile pixel (x, y), for a box drawing character.
fn box_tile(atlas: &mut Atlas, cp: u32) -> impl Fn(u32, u32) -> u8 {
    let pixels = box_pixels(atlas, cp);
    let tw = atlas.tile_width;
    move |x, y| pixels[((y * tw + x) * 4 + 3) as usize]
}
#[test]
fn box_drawing_is_geometry_whatever_the_font() {
    // This font has no box drawing glyphs at all.
    let no_box_glyphs = include_bytes!("fonts/NotoSansDevanagari.ttf");
    let (mut with, mut without) = (box_atlas(JETBRAINS), box_atlas(no_box_glyphs));
    for atlas in [&mut with, &mut without] {
        // Ink alone would also pass with a font's missing-glyph box: the line
        // has to be the drawn one, edge to edge.
        let (w, h) = (atlas.cell_width, atlas.cell_height);
        let across = box_tile(atlas, 0x2500);
        assert!(
            (0..h).any(|y| (0..w).all(|x| across(x, y) == 255)),
            "─ spans the whole width"
        );
        for cp in 0x2501..=0x257f {
            let pixels = box_pixels(atlas, cp);
            assert!(
                pixels.chunks_exact(4).any(|p| p[3] > 0),
                "U+{cp:04X} draws something"
            );
        }
    }
}
#[test]
fn double_line_joins_stay_open_where_an_arm_enters() {
    let mut atlas = box_atlas(JETBRAINS);
    let (w, h) = (atlas.tile_width, atlas.cell_height);
    let across = box_tile(&mut atlas, 0x2550);
    let rows: Vec<u32> = (0..h).filter(|&y| across(0, y) > 127).collect();
    let down = box_tile(&mut atlas, 0x2551);
    let columns: Vec<u32> = (0..w).filter(|&x| down(x, 0) > 127).collect();
    let (top, bottom) = (rows[0], *rows.last().unwrap());
    let (left, right) = (columns[0], *columns.last().unwrap());
    let (gap_x, gap_y) = ((left + right) / 2, (top + bottom) / 2);
    assert!(gap_x > left && gap_x < right && gap_y > top && gap_y < bottom);
    // Character, then which arms it has: up, right, down, left.
    for (c, arms) in [
        ('╔', [false, true, true, false]),
        ('╗', [false, false, true, true]),
        ('╚', [true, true, false, false]),
        ('╝', [true, false, false, true]),
        ('╠', [true, true, true, false]),
        ('╣', [true, false, true, true]),
        ('╦', [false, true, true, true]),
        ('╩', [true, true, false, true]),
        ('╬', [true, true, true, true]),
    ] {
        let tile = box_tile(&mut atlas, c as u32);
        let lit = [
            tile(gap_x, top),
            tile(right, gap_y),
            tile(gap_x, bottom),
            tile(left, gap_y),
        ]
        .map(|alpha| alpha > 127);
        assert_eq!(lit, arms.map(|arm| !arm), "{c}: up, right, down, left");
    }
}
#[test]
fn box_lines_reach_the_cell_edges_so_rows_and_columns_join() {
    let mut atlas = box_atlas(JETBRAINS);
    let (w, h) = (atlas.cell_width, atlas.cell_height);
    let across = box_tile(&mut atlas, 0x2500); // ─
    let row = (0..h)
        .find(|&y| across(0, y) == 255)
        .expect("a covered row");
    assert!(
        (0..w).all(|x| across(x, row) == 255),
        "─ spans the whole width"
    );
    assert_eq!(across(0, 0), 0);
    let down = box_tile(&mut atlas, 0x2502); // │
    let col = (0..w)
        .find(|&x| down(x, 0) == 255)
        .expect("a covered column");
    assert!(
        (0..h).all(|y| down(col, y) == 255),
        "│ spans the whole height"
    );
    let cross = box_tile(&mut atlas, 0x253c); // ┼
    assert!(cross(0, row) == 255 && cross(w - 1, row) == 255);
    assert!(cross(col, 0) == 255 && cross(col, h - 1) == 255);
    // ┌ joins only rightwards and downwards.
    let corner = box_tile(&mut atlas, 0x250c);
    assert!(corner(w - 1, row) == 255 && corner(col, h - 1) == 255);
    assert!(corner(0, row) == 0 && corner(col, 0) == 0);
}
#[test]
fn box_weights_doubles_and_dashes() {
    let mut atlas = box_atlas(JETBRAINS);
    let (w, h) = (atlas.cell_width, atlas.cell_height);
    let rows = |atlas: &mut Atlas, cp: u32| {
        let t = box_tile(atlas, cp);
        (0..h).filter(|&y| t(w / 2, y) == 255).collect::<Vec<_>>()
    };
    let light = rows(&mut atlas, 0x2500);
    let heavy = rows(&mut atlas, 0x2501);
    assert_eq!(heavy.len(), light.len() * 2, "heavy is twice light");
    let double = rows(&mut atlas, 0x2550); // ═
    assert_eq!(double.len(), light.len() * 2);
    assert!(
        double.windows(2).any(|p| p[1] > p[0] + 1),
        "═ is two lines with a gap: {double:?}"
    );
    let dashed = box_tile(&mut atlas, 0x2504); // ┄
    let row = light[0];
    let covered = (0..w).filter(|&x| dashed(x, row) == 255).count() as u32;
    assert!(covered > 0 && covered < w, "┄ has gaps");
}
#[test]
fn rounded_corners_and_diagonals_are_antialiased_strokes() {
    let mut atlas = box_atlas(JETBRAINS);
    let (w, h) = (atlas.cell_width, atlas.cell_height);
    let line = box_tile(&mut atlas, 0x2500);
    let row = (0..h).find(|&y| line(0, y) == 255).unwrap();
    let down = box_tile(&mut atlas, 0x2502);
    let col = (0..w).find(|&x| down(x, 0) == 255).unwrap();
    let arc = box_tile(&mut atlas, 0x256d); // ╭
    assert!(arc(w - 1, row) > 200, "╭ meets the next cell's line");
    assert!(arc(col, h - 1) > 200, "╭ meets the line below");
    assert_eq!(arc(0, 0), 0);
    assert_eq!(arc(col, 0), 0, "nothing above the turn");
    let partial = (0..h)
        .flat_map(|y| (0..w).map(move |x| (x, y)))
        .any(|(x, y)| (1..255).contains(&arc(x, y)));
    assert!(partial, "the curve is antialiased");
    let rising = box_tile(&mut atlas, 0x2571); // ╱
    assert!(rising(w - 1, 0) > 0 && rising(0, h - 1) > 0);
    assert_eq!(rising(0, 0), 0);
    let cross = box_tile(&mut atlas, 0x2573); // ╳
    assert!(cross(0, 0) > 0 && cross(w - 1, 0) > 0);
}
#[test]
fn a_theme_palette_colors_ansi_text_and_osc_4_still_overrides() {
    let mut c = term(20, 2);
    c.palette(&[0x000000, 0x0000aa, 0x00aa00]);
    c.write(b"\x1b[31mR\x1b[32mG\x1b[33mY\x1b[38;5;196mX");
    c.update().unwrap();
    assert_eq!(c.cells()[0].foreground, 0x0000aa, "red is the theme's");
    assert_eq!(c.cells()[1].foreground, 0x00aa00);
    let yellow = c.cells()[2].foreground;
    assert_ne!(yellow, 0, "entries not given keep the built-in palette");
    assert_eq!(c.cells()[3].foreground, 255, "256-colour entries too");
    // A program's own colour for an index survives a new theme palette.
    c.write(b"\x1b]4;1;rgb:12/34/56\x1b\\\r\x1b[31mR");
    c.palette(&[0x000000, 0x0000bb]);
    c.update().unwrap();
    assert_eq!(c.cells()[0].foreground, 0x12 | 0x34 << 8 | 0x56 << 16);
    c.palette(&[]);
    c.write(b"\x1b]104\x1b\\\r\x1b[31mR\x1b[33mY");
    c.update().unwrap();
    assert_eq!(
        c.cells()[1].foreground,
        yellow,
        "an empty palette restores the built-in"
    );
}
#[test]
fn blink_count_tracks_visible_cells() {
    let mut c = term(10, 2);
    c.write(b"\x1b[5mAB\x1b[0mC");
    c.update().unwrap();
    let blinking = c.cells().iter().filter(|cell| cell.flags & 8 != 0).count();
    assert_eq!(blinking, 2);
    assert_eq!(c.blinking(), 2);
    c.write(b"\x1b[H\x1b[2K");
    c.update().unwrap();
    assert_eq!(c.blinking(), 0);
}
#[test]
fn moved_rows_are_reused_and_match_a_fresh_snapshot() {
    fn cells(c: &Core) -> Vec<(String, u32, u32, u32, u32)> {
        c.cells()
            .iter()
            .map(|x| {
                (
                    x.text.clone(),
                    x.foreground,
                    x.background,
                    x.underline,
                    x.flags,
                )
            })
            .collect()
    }
    let line = |i: usize| {
        format!(
            "\x1b[3{};4{}m{i:05}\x1b[0m {} stream {}\r\n",
            i % 8,
            (i * 3) % 8,
            if i % 5 == 0 { "e\u{301}" } else { "plain" },
            if i % 7 == 0 {
                "\x1b[5mblink\x1b[0m"
            } else {
                ""
            },
        )
    };
    let mut incremental = term(40, 10);
    let mut input = Vec::new();
    let check = |incremental: &mut Core, input: &[u8], setup: &dyn Fn(&mut Core)| {
        let mut fresh = term(40, 10);
        fresh.write(input);
        setup(&mut fresh);
        fresh.update().unwrap();
        incremental.update().unwrap();
        assert_eq!(cells(incremental), cells(&fresh));
        assert_eq!(incremental.blinking(), fresh.blinking());
    };
    for i in 0..60 {
        let bytes = line(i);
        incremental.write(bytes.as_bytes());
        input.extend_from_slice(bytes.as_bytes());
        incremental.update().unwrap();
    }
    check(&mut incremental, &input, &|_| {});
    assert!(
        incremental.reused_rows() > 100,
        "{}",
        incremental.reused_rows()
    );
    incremental.scroll(-4);
    check(&mut incremental, &input, &|c| c.scroll(-4));
    incremental.scroll(2);
    check(&mut incremental, &input, &|c| c.scroll(-2));
    incremental.scroll(2);
    incremental.select(1, 2, 6, 3).unwrap();
    check(&mut incremental, &input, &|c| c.select(1, 2, 6, 3).unwrap());
    incremental.select(-1, 0, 0, 0).unwrap();
    // A palette change resolves cached colors differently.
    let palette = b"\x1b]4;1;rgb:12/34/56\x1b\\";
    incremental.write(palette);
    input.extend_from_slice(palette);
    check(&mut incremental, &input, &|_| {});
    let edit = b"\x1b[3;1H\x1b[2Kedited\x1b[6;1H\x1b[M";
    incremental.write(edit);
    input.extend_from_slice(edit);
    check(&mut incremental, &input, &|_| {});
    // The alternate screen has new rows and ids.
    for step in [&b"\x1b[?1049halt\r\nscreen\r\n"[..], b"\x1b[?1049l"] {
        incremental.write(step);
        input.extend_from_slice(step);
        check(&mut incremental, &input, &|_| {});
    }
}
#[test]
fn synthetic_bold_never_loses_coverage() {
    // Outline emboldening once collapsed JetBrains Mono's bold `i` to a speck.
    let data = include_bytes!("../../../demo/fonts/JetBrainsMono-Regular.ttf").to_vec();
    let mut atlas = Atlas::new(data, 15., 20. / 15.).unwrap();
    let coverage = |atlas: &mut Atlas, text: &str, flags: u32| {
        let mut cell = wraith_engine::core::Cell::with_text(text);
        cell.flags = flags;
        atlas.tile(&cell);
        let tile = atlas.uploads.last().unwrap();
        tile.pixels
            .chunks_exact(4)
            .map(|p| p[3] as u32)
            .sum::<u32>()
    };
    for c in '!'..='~' {
        let text = c.to_string();
        let regular = coverage(&mut atlas, &text, 0);
        let bold = coverage(&mut atlas, &text, 1);
        assert!(
            bold > regular,
            "bold {c:?} covers {bold}, regular {regular}"
        );
    }
}

/// Leftmost and rightmost inked columns of the last tile drawn.
fn ink_span(atlas: &Atlas) -> (u32, u32) {
    let pixels = &atlas.uploads.last().unwrap().pixels;
    let (mut left, mut right) = (u32::MAX, 0);
    for row in pixels.chunks_exact(atlas.tile_width as usize * 4) {
        for x in 0..atlas.tile_width {
            if row[x as usize * 4 + 3] > 64 {
                left = left.min(x);
                right = right.max(x);
            }
        }
    }
    (left, right)
}
#[test]
fn glyphs_narrower_than_their_cells_are_centred() {
    let atlas = || {
        let data = include_bytes!("../../../demo/fonts/JetBrainsMono-Regular.ttf").to_vec();
        Atlas::new(data, 16., 1.3).unwrap()
    };
    let with_fallback = || {
        let mut atlas = atlas();
        atlas
            .add_font(include_bytes!("fonts/NotoSansDevanagari.ttf").to_vec())
            .unwrap();
        atlas
    };
    const WIDE: u32 = 1 << 16;
    let span = |mut atlas: Atlas, text: &str, flags: u32| {
        let mut cell = wraith_engine::core::Cell::with_text(text);
        cell.flags |= flags;
        atlas.tile(&cell);
        (ink_span(&atlas), atlas.cell_width)
    };
    // A fallback glyph narrower than its slot moves right by half a cell when
    // the slot is a wide (two-cell) one.
    let (narrow, width) = span(with_fallback(), "क", 0);
    let (wide, _) = span(with_fallback(), "क", WIDE);
    let shift = wide.0 as i32 - narrow.0 as i32;
    assert!(
        (shift - width as i32 / 2).abs() <= 1,
        "centred in two cells: {narrow:?} -> {wide:?}"
    );
    // The regular font's glyphs fill their cell exactly and stay in it.
    let (m, width) = span(atlas(), "M", 0);
    assert!(m.1 < width + 2, "M stays in its own cell: {m:?}");
}
#[test]
fn native_search_cache_tracks_mutations_and_wrapped_page_overlap() {
    let mut c = Core::new(120, 40, 27000).unwrap();
    let input: String = (0..9000)
        .map(|n| {
            format!(
                "line {n:06} needle-{n} build output 界 e\u{301} {}\r\n",
                "wrapped contents ".repeat(8)
            )
        })
        .collect();
    c.write(input.as_bytes());
    for (needle, expected) in [
        ("needle-100", 11),
        ("needle-8700", 1),
        ("needle-8600 build", 1),
        ("absent", 0),
    ] {
        c.search(needle, 0).unwrap();
        while c.search("", 1).unwrap()[0] != 2 {}
        assert_eq!(c.search("", 2).unwrap()[1], expected, "{needle}");
    }
    // Changing content must invalidate text cached under earlier needles.
    c.write(b"\r\nneedle-8700 appended");
    c.search("needle-8700", 0).unwrap();
    while c.search("", 1).unwrap()[0] != 2 {}
    assert_eq!(c.search("", 2).unwrap()[1], 2);
    c.resize(73, 30, 9, 18).unwrap();
    c.search("needle-8700", 0).unwrap();
    while c.search("", 1).unwrap()[0] != 2 {}
    assert_eq!(c.search("", 2).unwrap()[1], 2);
    c.write(b"\x1bcFRESH ONLY");
    c.search("needle-8700", 0).unwrap();
    while c.search("", 1).unwrap()[0] != 2 {}
    assert_eq!(c.search("", 2).unwrap()[1], 0);
    c.search("fresh", 0).unwrap();
    while c.search("", 1).unwrap()[0] != 2 {}
    assert_eq!(c.search("", 2).unwrap()[1], 1);
    assert_eq!(c.selection_text().unwrap(), "FRESH");
}

#[test]
fn native_search_survives_page_cache_eviction() {
    let mut c = Core::new(120, 40, 100000).unwrap();
    // Encoded UTF-8 plus per-byte coordinates exceeds the 32 MiB cache cap.
    for n in 0..40000 {
        c.write(format!("record-{n} {}\r\n", "abcdef ".repeat(27)).as_bytes());
    }
    for needle in ["record-12 ", "record-39990 ", "absent"] {
        c.search(needle, 0).unwrap();
        while c.search("", 1).unwrap()[0] != 2 {}
        assert_eq!(
            c.search("", 2).unwrap()[1],
            if needle == "absent" { 0 } else { 1 }
        );
    }
}
#[test]
fn vt_snapshots_restore_screen_history_modes_and_cursor() {
    let cases: [&[u8]; 9] = [
        b"plain\r\nlines\r\n\x1b[1;31mred bold\x1b[0m tail",
        b"\x1b[?1049h\x1b[2;5Halt screen \x1b[7mreverse\x1b[0m",
        // Trailing blank rows, a scrolling region, origin and insert modes.
        b"\x1b[3;10r\x1b[?6h\x1b[2;3Hin region\x1b[4h\x1b[?25l",
        // Pending wrap at the right edge and a soft-wrapped line in history.
        b"0123456789012345678901234567890123456789\r\nabcdefghijklmnopqrst",
        "\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\ \u{754c} e\u{301}\x1b(0lqk\x1b(B"
            .as_bytes(),
        // Rows erased with a background colour but holding no text.
        b"\x1b[44m\x1b[2J\x1b[H\x1b[0mtop\x1b[4;1H\x1b[48;2;10;20;30m\x1b[K\x1b[0m",
        // Autowrap off with a long line.
        b"\x1b[?7lthis line is longer than twenty columns\r\nnext",
        // Cursor parked on a blank row after a clear with history.
        b"\x1b[2J\x1b[5;7H",
        // A custom palette entry and blank screen tail.
        b"\x1b]4;1;rgb:12/34/56\x1b\\\x1b[31mpalette\x1b[0m\r\n\r\n",
    ];
    for bytes in cases {
        let mut source = term(20, 6);
        for n in 0..12 {
            source.write(format!("history {n}\r\n").as_bytes());
        }
        source.write(bytes);
        let snapshot = source.snapshot().unwrap();
        assert!(!snapshot.is_empty());
        let mut restored = term(20, 6);
        restored.write(&snapshot);
        let label = String::from_utf8_lossy(bytes).into_owned();
        assert_eq!(text(&mut restored), text(&mut source), "{label:?}");
        assert_eq!(restored.snapshot().unwrap(), snapshot, "{label:?}");
        assert_eq!(
            restored.digest().unwrap(),
            source.digest().unwrap(),
            "{label:?}"
        );
        // Continuing both terminals with the same bytes keeps them identical.
        let more = b"next\r\n\x1b[Acont\x1b[Kz\r\n\r\n\r\n\r\n\r\n\r\n\r\nend";
        source.write(more);
        restored.write(more);
        assert_eq!(text(&mut restored), text(&mut source), "{label:?}");
        assert_eq!(
            restored.digest().unwrap(),
            source.digest().unwrap(),
            "{label:?}"
        );
        assert_eq!(
            restored.snapshot().unwrap(),
            source.snapshot().unwrap(),
            "{label:?}"
        );
        source.scroll(-6);
        restored.scroll(-6);
        assert_eq!(text(&mut restored), text(&mut source), "{label:?} history");
    }
}
/// A cell's glyph word and its uploaded pixels, rasterized fresh.
fn styled_tile(atlas: &mut Atlas, text: &str, style: u32) -> (u32, Vec<u8>) {
    let mut cell = wraith_engine::core::Cell::with_text(text);
    cell.flags |= style;
    let word = atlas.tile(&cell);
    assert_ne!(
        word & wraith_engine::text::GLYPH_SLOT,
        0,
        "{text:?} style {style}"
    );
    let pixels = atlas.uploads.last().unwrap().pixels.clone();
    (word, pixels)
}
fn ink(pixels: &[u8]) -> u32 {
    pixels.chunks_exact(4).map(|p| p[3] as u32).sum()
}
fn regular_atlas() -> Atlas {
    let data = include_bytes!("../../../demo/fonts/JetBrainsMono-Regular.ttf").to_vec();
    Atlas::new(data, 16., 1.3).unwrap()
}
const LILEX_ITALIC: &[u8] = include_bytes!("fonts/Lilex-MediumItalic.otf");
const LILEX_BOLD_ITALIC: &[u8] = include_bytes!("fonts/Lilex-BoldItalic.otf");
#[test]
fn style_faces_draw_their_own_glyphs() {
    let mut synthetic = regular_atlas();
    let mut faced = regular_atlas();
    faced.set_face(2, LILEX_ITALIC.to_vec()).unwrap();
    // Regular cells never touch a style face.
    assert_eq!(
        styled_tile(&mut synthetic, "a", 0).1,
        styled_tile(&mut faced, "a", 0).1
    );
    // An italic cell draws the italic face's own `a` (single-storey in
    // Lilex), not JetBrains Mono's slanted.
    assert_ne!(
        styled_tile(&mut synthetic, "a", 2).1,
        styled_tile(&mut faced, "a", 2).1
    );
    // Bold has no face here: still synthesized from the regular font.
    assert_eq!(
        styled_tile(&mut synthetic, "a", 1).1,
        styled_tile(&mut faced, "a", 1).1
    );
}
#[test]
fn bold_italic_falls_back_to_the_italic_face_emboldened() {
    let mut faced = regular_atlas();
    faced.set_face(2, LILEX_ITALIC.to_vec()).unwrap();
    let italic = styled_tile(&mut faced, "a", 2).1;
    let bold_italic = styled_tile(&mut faced, "a", 3).1;
    assert!(
        ink(&bold_italic) > ink(&italic),
        "synthetic bold on the italic face"
    );
    // A face of its own wins over the emboldened italic.
    let mut full = regular_atlas();
    full.set_face(2, LILEX_ITALIC.to_vec()).unwrap();
    full.set_face(3, LILEX_BOLD_ITALIC.to_vec()).unwrap();
    assert_ne!(styled_tile(&mut full, "a", 3).1, bold_italic);
}
#[test]
fn a_face_without_the_character_falls_back_to_synthetic_style() {
    let devanagari = include_bytes!("fonts/NotoSansDevanagari.ttf").to_vec();
    let mut synthetic = regular_atlas();
    synthetic.add_font(devanagari.clone()).unwrap();
    let mut faced = regular_atlas();
    faced.add_font(devanagari).unwrap();
    faced.set_face(2, LILEX_ITALIC.to_vec()).unwrap();
    // Lilex has no Devanagari: the fallback font, slanted, as without a face.
    assert_eq!(
        styled_tile(&mut synthetic, "क", 2).1,
        styled_tile(&mut faced, "क", 2).1
    );
}
#[test]
fn style_faces_keep_their_cache_slots_apart_and_reject_bad_input() {
    let mut faced = regular_atlas();
    faced.set_face(2, LILEX_ITALIC.to_vec()).unwrap();
    let regular = styled_tile(&mut faced, "x", 0).0;
    let italic = styled_tile(&mut faced, "x", 2).0;
    assert_ne!(regular, italic);
    assert_eq!(
        faced.tile(&wraith_engine::core::Cell::with_text("x")),
        regular
    );
    assert!(faced.set_face(0, LILEX_ITALIC.to_vec()).is_err());
    assert!(faced.set_face(4, LILEX_ITALIC.to_vec()).is_err());
    assert!(faced.set_face(2, b"not a font".to_vec()).is_err());
}
