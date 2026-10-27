use wraith_engine::commands::{BlockState, COMMAND_EVENT, MAX_BLOCKS};
use wraith_engine::core::Core;

const SESSION: &str = concat!(
    "\x1b]133;A\x07$ \x1b]133;B\x07echo hi\r\n\x1b]133;C;cmdline_url=echo%20hi\x07",
    "hi\r\nthere\r\n\x1b]133;D;0\x07",
    "\x1b]133;A\x07$ \x1b]133;B\x07false\r\n\x1b]133;C\x1b\\\x1b]133;D;1\x1b\\",
    "\x1b]133;A\x07$ "
);

fn term(cols: u16, rows: u16, history: usize) -> Core {
    Core::new(cols, rows, history).unwrap()
}

#[test]
fn session_produces_blocks_with_commands_exit_codes_and_output() {
    let mut c = term(40, 10, 100);
    assert!(!c.has_commands());
    c.write(SESSION.as_bytes());
    let blocks = c.commands();
    assert_eq!(blocks.len(), 3);
    assert_eq!(blocks[0].command, "echo hi");
    assert_eq!(blocks[0].exit, Some(0));
    assert_eq!(blocks[0].state, BlockState::Done);
    assert_eq!(blocks[0].prompt_row, Some(0));
    assert_eq!(blocks[0].output_row, Some(1));
    assert_eq!(blocks[0].end_row, Some(3));
    assert_eq!(blocks[1].command, "");
    assert_eq!(blocks[1].exit, Some(1));
    assert_eq!(blocks[2].state, BlockState::Prompt);
    let output = c.command_text(blocks[0].id, false).unwrap().unwrap();
    assert_eq!(output, ("hi\nthere".to_string(), false));
    let input = c.command_text(blocks[1].id, true).unwrap().unwrap();
    assert_eq!(input.0, "false");
    assert_eq!(c.command_text(blocks[1].id, false).unwrap().unwrap().0, "");
    assert!(c.command_text(999, false).unwrap().is_none());
    let events: Vec<_> = c
        .take_events()
        .into_iter()
        .filter(|(kind, _)| *kind == COMMAND_EVENT)
        .map(|(_, bytes)| bytes[0])
        .collect();
    // prompt, running, done for two commands, then the last prompt.
    assert_eq!(events, vec![0, 2, 3, 0, 2, 3, 0]);
}

#[test]
fn every_chunk_boundary_parses_the_same_blocks() {
    let bytes = SESSION.as_bytes();
    let mut whole = term(40, 10, 100);
    whole.write(bytes);
    let expected = whole.commands();
    let output = whole.command_text(expected[0].id, false).unwrap();
    for split in 0..=bytes.len() {
        let mut c = term(40, 10, 100);
        c.write(&bytes[..split]);
        c.write(&bytes[split..]);
        assert_eq!(c.commands(), expected, "split at {split}");
        assert_eq!(c.command_text(expected[0].id, false).unwrap(), output);
    }
    // Byte at a time.
    let mut c = term(40, 10, 100);
    for b in bytes {
        c.write(std::slice::from_ref(b));
    }
    assert_eq!(c.commands(), expected);
}

#[test]
fn running_block_ends_at_the_cursor_and_next_prompt_finishes_it() {
    let mut c = term(40, 10, 100);
    c.write(b"\x1b]133;A\x07$ \x1b]133;B\x07make\r\n\x1b]133;C\x07compiling\r\nlinking");
    let blocks = c.commands();
    assert_eq!(blocks[0].state, BlockState::Running);
    assert_eq!(blocks[0].command, "");
    assert_eq!(
        c.command_text(blocks[0].id, true).unwrap().unwrap().0,
        "make"
    );
    assert_eq!(
        c.command_text(blocks[0].id, false).unwrap().unwrap().0,
        "compiling\nlinking"
    );
    let marks = c.command_marks();
    assert_eq!(marks, vec![blocks[0].id as i32, 2, 0, 0, 2]);
    // No OSC 133;D: the next prompt finishes the block without an exit code.
    c.write(b"\r\n\x1b]133;A\x07$ ");
    let blocks = c.commands();
    assert_eq!(blocks[0].state, BlockState::Done);
    assert_eq!(blocks[0].exit, None);
    assert_eq!(
        c.command_text(blocks[0].id, false).unwrap().unwrap().0,
        "compiling\nlinking"
    );
}

#[test]
fn redrawn_prompts_and_secondary_prompts_do_not_create_blocks() {
    let mut c = term(40, 10, 100);
    c.write(b"\x1b]133;A\x07$ \x1b]133;B\x07\r\x1b]133;A\x07$ \x1b]133;B\x07");
    c.write(b"\x1b]133;A;k=s\x07> \x1b]133;D;0\x07");
    let blocks = c.commands();
    assert_eq!(blocks.len(), 1);
    assert_eq!(blocks[0].state, BlockState::Input);
}

#[test]
fn alternate_screen_marks_are_ignored() {
    let mut c = term(40, 10, 100);
    c.write(b"\x1b[?1049h\x1b]133;A\x07$ \x1b]133;C\x07x\x1b]133;D;0\x07\x1b[?1049l");
    assert!(!c.has_commands());
}

#[test]
fn trimmed_blocks_report_truncated_output() {
    let mut c = term(20, 4, 30);
    c.write(b"\x1b]133;A\x07$ \x1b]133;B\x07seq\r\n\x1b]133;C\x07");
    // Ghostty prunes scrollback a page at a time; write until the prompt goes.
    let mut lines = 0;
    while c.commands()[0].output_row.is_some() {
        assert!(lines < 200_000, "scrollback never pruned");
        for _ in 0..100 {
            c.write(format!("line {lines}\r\n").as_bytes());
            lines += 1;
        }
    }
    c.write(b"\x1b]133;D;0\x07\x1b]133;A\x07$ ");
    let blocks = c.commands();
    assert_eq!(blocks[0].exit, Some(0));
    assert!(blocks[0].truncated);
    assert_eq!(blocks[0].prompt_row, None);
    assert_eq!(blocks[0].output_row, None);
    assert!(blocks[0].end_row.is_some());
    let (text, truncated) = c.command_text(blocks[0].id, false).unwrap().unwrap();
    assert!(truncated);
    let last = format!("line {}\nline {}", lines - 2, lines - 1);
    assert!(text.ends_with(&last), "{text}");
    assert!(!text.starts_with("line 0\n"));
    let mut more = 0;
    while c.commands()[0].end_row.is_some() {
        assert!(more < 400_000, "scrollback never pruned");
        for _ in 0..100 {
            c.write(format!("more {more}\r\n").as_bytes());
            more += 1;
        }
    }
    let blocks = c.commands();
    assert!(blocks[0].truncated);
    assert_eq!(
        c.command_text(blocks[0].id, false).unwrap().unwrap(),
        (String::new(), true)
    );
    assert!(blocks[1].prompt_row.is_none());
}

#[test]
fn blocks_follow_reflow_on_resize() {
    let mut c = term(20, 6, 100);
    c.write(b"\x1b]133;A\x07$ \x1b]133;B\x07cat\r\n\x1b]133;C\x07");
    c.write(b"abcdefghijklmnopqrstuvwxyz0123\r\n\x1b]133;D;0\x07\x1b]133;A\x07$ ");
    let before = c.command_text(1, false).unwrap().unwrap().0;
    assert_eq!(before, "abcdefghijklmnopqrstuvwxyz0123");
    c.resize(10, 6, 9, 18).unwrap();
    let blocks = c.commands();
    assert_eq!(blocks[0].output_row, Some(1));
    // 30 characters reflow to three rows at 10 columns.
    assert_eq!(blocks[0].end_row, Some(4));
    assert_eq!(blocks[1].prompt_row, Some(4));
    assert_eq!(c.command_text(1, false).unwrap().unwrap().0, before);
    c.resize(40, 6, 9, 18).unwrap();
    assert_eq!(c.commands()[0].end_row, Some(2));
    assert_eq!(c.command_text(1, false).unwrap().unwrap().0, before);
}

#[test]
fn jump_to_prompt_scrolls_between_prompts() {
    let mut c = term(20, 4, 100);
    for i in 0..3 {
        c.write(format!("\x1b]133;A\x07$ \x1b]133;B\x07cmd{i}\r\n\x1b]133;C\x07").as_bytes());
        for j in 0..5 {
            c.write(format!("out {i}.{j}\r\n").as_bytes());
        }
        c.write(b"\x1b]133;D;0\x07");
    }
    c.write(b"\x1b]133;A\x07$ ");
    let prompts: Vec<_> = c.commands().iter().map(|b| b.prompt_row.unwrap()).collect();
    assert_eq!(prompts, vec![0, 6, 12, 18]);
    let bottom = c.screen().offset;
    assert_eq!(bottom, 15);
    assert_eq!(c.jump_to_prompt(-1), Some(12));
    assert_eq!(c.jump_to_prompt(-1), Some(6));
    assert_eq!(c.jump_to_prompt(-1), Some(0));
    assert_eq!(c.jump_to_prompt(-1), None);
    assert_eq!(c.jump_to_prompt(1), Some(6));
    let marks = c.command_marks();
    // Viewport rows 0..3 show block 2 (prompt at row 0 of the viewport).
    assert_eq!(&marks[..5], &[2, 3, 1, 0, 3]);
    assert_eq!(c.jump_to_prompt(1), Some(12));
    // The newest prompt is inside the active area: the viewport clamps to the bottom.
    assert_eq!(c.jump_to_prompt(1), Some(bottom));
    assert_eq!(c.jump_to_prompt(1), None);
}

#[test]
fn block_count_is_bounded() {
    let mut c = term(20, 4, 10);
    for _ in 0..MAX_BLOCKS + 10 {
        c.write(b"\x1b]133;A\x07\x1b]133;C\x07\x1b]133;D;0\x07");
    }
    let blocks = c.commands();
    assert_eq!(blocks.len(), MAX_BLOCKS);
    assert_eq!(blocks[0].id, 11);
}

#[test]
fn repeated_output_start_belongs_to_the_running_command() {
    // fish 4 emits its own marks; a second integration repeats them.
    let mut c = term(40, 10, 100);
    c.write(b"\x1b]133;A\x07> \x1b]133;B\x07\x1b]133;B\x1b\\ls\r\n");
    c.write(b"\x1b]133;C;cmdline_url=ls\x1b\\\x1b]133;C;cmdline_url=ls\x07a\r\n");
    c.write(b"\x1b]133;D;0\x1b\\\x1b]133;D;0\x07\x1b]133;A\x07> ");
    let blocks = c.commands();
    assert_eq!(blocks.len(), 2);
    assert_eq!(blocks[0].command, "ls");
    assert_eq!(blocks[0].exit, Some(0));
    assert_eq!(c.command_text(blocks[0].id, false).unwrap().unwrap().0, "a");
}

#[test]
fn clearing_scrollback_reports_erased_blocks_as_truncated() {
    let mut c = term(20, 5, 100);
    c.write(SESSION.as_bytes());
    // What `clear` sends: home, erase the screen into scrollback, erase that.
    c.write(b"\x1b[H\x1b[2J\x1b[3J");
    c.write(b"\x1b]133;A\x07$ \x1b]133;B\x07ls\r\n\x1b]133;C\x07a\r\n\x1b]133;D;0\x07");
    c.write(b"\x1b]133;A\x07$ ");
    // Ghostty moves references on erased rows to the origin; the single-block
    // lookup used for completions must see them as gone too.
    let first = c.command(1).unwrap();
    assert!(first.truncated, "{first:?}");
    assert_eq!(first.prompt_row, None);
    let blocks = c.commands();
    // The prompt pending during the clear was redrawn and became `ls`.
    assert_eq!(blocks.len(), 4);
    for block in &blocks[..2] {
        assert!(block.truncated, "{block:?}");
        assert_eq!(
            (block.prompt_row, block.output_row, block.end_row),
            (None, None, None)
        );
    }
    assert_eq!(blocks[2].command, "");
    assert!(!blocks[2].truncated, "{:?}", blocks[2]);
    assert_eq!(blocks[2].prompt_row, Some(0));
    assert_eq!(
        c.command_text(blocks[2].id, false).unwrap().unwrap(),
        ("a".to_string(), false)
    );
    assert_eq!(
        c.command_text(blocks[0].id, false).unwrap().unwrap(),
        (String::new(), true)
    );
    // No erased prompt is left to jump back to.
    assert_eq!(c.jump_to_prompt(-1), None);
}

#[test]
fn a_reset_does_not_truncate_the_next_command() {
    let mut c = term(20, 5, 100);
    c.write(SESSION.as_bytes());
    c.write(b"\x1bc");
    c.write(b"\x1b]133;A\x07$ \x1b]133;B\x07ls\r\n\x1b]133;C\x07a\r\n\x1b]133;D;0\x07");
    let blocks = c.commands();
    assert!(blocks[..2].iter().all(|b| b.truncated), "{blocks:?}");
    let last = blocks.last().unwrap();
    assert_eq!(last.exit, Some(0));
    assert!(!last.truncated, "{last:?}");
}
