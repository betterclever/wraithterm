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
    let module = naga::front::wgsl::parse_str(include_str!("../src/terminal.wgsl")).unwrap();
    naga::valid::Validator::new(
        naga::valid::ValidationFlags::all(),
        naga::valid::Capabilities::empty(),
    )
    .validate(&module)
    .unwrap();
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
