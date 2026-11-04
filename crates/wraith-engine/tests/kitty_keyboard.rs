//! The kitty keyboard protocol through libghostty-vt: the progressive
//! enhancement stack (push, pop, set, query) and each flag's encoding.
//! Keys use Ghostty's key codes (packages/wraith/src/keycodes.ts); mods are
//! shift 1, ctrl 2, alt 4, super 8; actions release 0, press 1, repeat 2.
use wraith_engine::core::Core;

const KEY_A: u32 = 20;
const ENTER: u32 = 58;
const ESCAPE: u32 = 120;
const ARROW_UP: u32 = 78;

fn term() -> Core {
    let mut c = Core::new(20, 3, 100).unwrap();
    c.theme(0xffffff, 0, 0xffffff);
    c
}
/// Bytes the terminal sent back (replies and encoded keys), as one string.
fn sent(c: &mut Core) -> String {
    c.take_events()
        .into_iter()
        .filter(|(kind, _)| *kind == 0)
        .map(|(_, b)| String::from_utf8_lossy(&b).into_owned())
        .collect()
}
fn press(c: &mut Core, key: u32, mods: u32, text: &str, unshifted: u32) -> String {
    c.key(key, mods, 1, text, unshifted).unwrap();
    sent(c)
}
fn release(c: &mut Core, key: u32, mods: u32, unshifted: u32) -> String {
    c.key(key, mods, 0, "", unshifted).unwrap();
    sent(c)
}
fn flags(c: &mut Core) -> String {
    c.write(b"\x1b[?u");
    sent(c)
}

#[test]
fn flags_push_pop_set_and_query() {
    let mut c = term();
    assert_eq!(flags(&mut c), "\x1b[?0u", "legacy until a program asks");
    c.write(b"\x1b[>1u");
    assert_eq!(flags(&mut c), "\x1b[?1u");
    c.write(b"\x1b[>11u");
    assert_eq!(flags(&mut c), "\x1b[?11u", "a push replaces the flags");
    c.write(b"\x1b[<u");
    assert_eq!(
        flags(&mut c),
        "\x1b[?1u",
        "a pop restores the previous entry"
    );
    c.write(b"\x1b[=4;2u");
    assert_eq!(flags(&mut c), "\x1b[?5u", "mode 2 sets bits");
    c.write(b"\x1b[=1;3u");
    assert_eq!(flags(&mut c), "\x1b[?4u", "mode 3 clears bits");
    c.write(b"\x1b[=2;1u");
    assert_eq!(flags(&mut c), "\x1b[?2u", "mode 1 replaces");
    c.write(b"\x1b[<5u");
    assert_eq!(
        flags(&mut c),
        "\x1b[?0u",
        "popping past the bottom empties the stack"
    );
}

#[test]
fn legacy_encoding_without_flags() {
    let mut c = term();
    assert_eq!(press(&mut c, KEY_A, 0, "a", 'a' as u32), "a");
    assert_eq!(press(&mut c, ESCAPE, 0, "", 0), "\x1b");
    assert_eq!(press(&mut c, KEY_A, 2, "", 'a' as u32), "\x01");
    assert_eq!(press(&mut c, ENTER, 0, "\r", 0), "\r");
    assert_eq!(
        release(&mut c, KEY_A, 0, 'a' as u32),
        "",
        "no release events"
    );
}

#[test]
fn disambiguate_escape_and_modified_keys() {
    let mut c = term();
    c.write(b"\x1b[>1u");
    sent(&mut c);
    assert_eq!(
        press(&mut c, KEY_A, 0, "a", 'a' as u32),
        "a",
        "plain text stays text"
    );
    assert_eq!(press(&mut c, ESCAPE, 0, "", 0), "\x1b[27u");
    assert_eq!(press(&mut c, KEY_A, 2, "", 'a' as u32), "\x1b[97;5u");
    assert_eq!(press(&mut c, KEY_A, 4, "a", 'a' as u32), "\x1b[97;3u");
    assert_eq!(
        press(&mut c, ENTER, 0, "\r", 0),
        "\r",
        "Enter keeps its legacy byte"
    );
    assert_eq!(press(&mut c, ARROW_UP, 0, "", 0), "\x1b[A");
    assert_eq!(press(&mut c, ARROW_UP, 2, "", 0), "\x1b[1;5A");
}

#[test]
fn event_types_report_repeats_and_releases() {
    let mut c = term();
    c.write(b"\x1b[>3u");
    sent(&mut c);
    assert_eq!(press(&mut c, ESCAPE, 0, "", 0), "\x1b[27u");
    c.key(ESCAPE, 0, 2, "", 0).unwrap();
    assert_eq!(sent(&mut c), "\x1b[27;1:2u");
    assert_eq!(release(&mut c, ESCAPE, 0, 0), "\x1b[27;1:3u");
    // A text key's press stays text; its release has no text form, so it is
    // an escape code (as kitty sends it).
    assert_eq!(press(&mut c, KEY_A, 0, "a", 'a' as u32), "a");
    assert_eq!(release(&mut c, KEY_A, 0, 'a' as u32), "\x1b[97;1:3u");
}

#[test]
fn all_keys_as_escape_codes_with_associated_text() {
    let mut c = term();
    c.write(b"\x1b[>8u");
    sent(&mut c);
    assert_eq!(press(&mut c, KEY_A, 0, "a", 'a' as u32), "\x1b[97u");
    assert_eq!(press(&mut c, ENTER, 0, "\r", 0), "\x1b[13u");
    c.write(b"\x1b[=24;1u");
    sent(&mut c);
    assert_eq!(press(&mut c, KEY_A, 1, "A", 'a' as u32), "\x1b[97;2;65u");
}

#[test]
fn each_screen_keeps_its_own_flags() {
    let mut c = term();
    c.write(b"\x1b[>1u\x1b[?1049h");
    assert_eq!(
        flags(&mut c),
        "\x1b[?0u",
        "the alternate screen starts in legacy"
    );
    c.write(b"\x1b[>8u\x1b[?1049l");
    assert_eq!(
        flags(&mut c),
        "\x1b[?1u",
        "the primary screen's flags come back"
    );
    c.write(b"\x1bc");
    assert_eq!(flags(&mut c), "\x1b[?0u", "a full reset clears them");
}
