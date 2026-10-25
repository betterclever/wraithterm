//! OSC 133 command blocks. libghostty-vt parses the shell integration marks and
//! reports each step; the bridge pins the cursor cell of every step with a
//! tracked grid reference. Ghostty moves those references through scrolling,
//! scrollback pruning and resize/reflow, and reports no value once their rows
//! are trimmed, so blocks never hold stale coordinates.
//!
//! Terminals that never receive OSC 133 hold no blocks and no references:
//! nothing here runs per byte or per frame for them.
use crate::core::{Core, State};
use std::{collections::VecDeque, ffi::c_void, ptr::NonNull};

extern "C" {
    fn wraith_bridge_mark_point(mark: *mut c_void, tag: u32, x: *mut u32, y: *mut u32) -> i32;
    fn wraith_bridge_mark_free(mark: *mut c_void);
    fn wraith_bridge_screen(b: *mut c_void, out: *mut u64) -> i32;
    fn wraith_bridge_range_text(b: *mut c_void, x1: u32, y1: u32, x2: u32, y2: u32) -> i32;
    fn wraith_bridge_scroll_row(b: *mut c_void, row: u64);
}

/// Event kind in `State::events` carrying one encoded block transition.
pub const COMMAND_EVENT: u32 = 5;
/// Event kind the bridge uses for range text; drained synchronously.
const RANGE_TEXT: u32 = 6;
/// Retained blocks. Older blocks (and their tracked references) are dropped.
pub const MAX_BLOCKS: usize = 1000;

const VIEWPORT: u32 = 1;
const SCREEN: u32 = 2;

/// An owned Ghostty tracked grid reference.
pub(crate) struct Mark(NonNull<c_void>);
impl Mark {
    /// Column and row in a Ghostty point space, or None when the row was
    /// trimmed or lies outside that space (above the viewport, for viewport).
    fn point(&self, tag: u32) -> Option<(u32, u32)> {
        let (mut x, mut y) = (0, 0);
        // SAFETY: the reference is live until Drop; the call only reads it.
        (unsafe { wraith_bridge_mark_point(self.0.as_ptr(), tag, &mut x, &mut y) } == 0)
            .then_some((x, y))
    }
}
impl Drop for Mark {
    fn drop(&mut self) {
        // SAFETY: freed exactly once; valid even after the terminal is freed.
        unsafe { wraith_bridge_mark_free(self.0.as_ptr()) }
    }
}

#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BlockState {
    /// The prompt is drawn (OSC 133;A).
    Prompt = 0,
    /// The user is typing a command (OSC 133;B).
    Input = 1,
    /// The command is running (OSC 133;C).
    Running = 2,
    /// The command finished (OSC 133;D, or the next prompt started).
    Done = 3,
}

pub(crate) struct Block {
    id: u32,
    prompt: Option<Mark>,
    input: Option<Mark>,
    output: Option<Mark>,
    end: Option<Mark>,
    command: String,
    exit: Option<i32>,
    state: BlockState,
    /// Some of the block's rows have left the scrollback.
    trimmed: bool,
}
impl Block {
    fn new(id: u32, state: BlockState) -> Self {
        Self {
            id,
            prompt: None,
            input: None,
            output: None,
            end: None,
            command: String::new(),
            exit: None,
            state,
            trimmed: false,
        }
    }
    fn first(&self) -> Option<&Mark> {
        self.prompt
            .as_ref()
            .or(self.input.as_ref())
            .or(self.output.as_ref())
    }
}

#[derive(Default)]
pub(crate) struct Commands {
    blocks: VecDeque<Block>,
    next: u32,
}

/// One block as reported to hosts. Rows are screen rows (0 is the oldest
/// retained scrollback row); `None` means unknown or trimmed.
#[derive(Clone, Debug, PartialEq)]
pub struct BlockInfo {
    pub id: u32,
    pub state: BlockState,
    pub command: String,
    pub exit: Option<i32>,
    pub prompt_row: Option<u32>,
    pub input_row: Option<u32>,
    pub output_row: Option<u32>,
    pub end_row: Option<u32>,
    pub truncated: bool,
}

/// Screen geometry: total rows, viewport offset and length, cursor screen
/// row and column, and whether the primary screen is active.
#[derive(Clone, Copy, Debug, Default)]
pub struct Screen {
    pub total: u64,
    pub offset: u64,
    pub len: u64,
    pub cursor_row: u64,
    pub cursor_col: u64,
    pub primary: bool,
}

fn encode(block: &Block, phase: BlockState) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(10 + block.command.len());
    bytes.push(phase as u8);
    bytes.extend_from_slice(&block.id.to_le_bytes());
    bytes.push(block.exit.is_some() as u8);
    bytes.extend_from_slice(&block.exit.unwrap_or(0).to_le_bytes());
    if phase == BlockState::Running {
        bytes.extend_from_slice(block.command.as_bytes());
    }
    bytes
}

impl Commands {
    fn emit(events: &mut Vec<(u32, Vec<u8>)>, block: &Block) {
        events.push((COMMAND_EVENT, encode(block, block.state)));
    }
    fn push(&mut self, state: BlockState) -> &mut Block {
        self.next = self.next.wrapping_add(1).max(1);
        if self.blocks.len() >= MAX_BLOCKS {
            self.blocks.pop_front();
        }
        self.blocks.push_back(Block::new(self.next, state));
        self.blocks.back_mut().unwrap()
    }
    /// Apply one OSC 133 step. Shells differ in which steps they send, so each
    /// is handled on its own rather than as a strict sequence.
    fn step(
        &mut self,
        events: &mut Vec<(u32, Vec<u8>)>,
        kind: u32,
        prompt_kind: u32,
        exit: Option<i32>,
        command: &str,
        mark: Option<Mark>,
    ) {
        let last = self.blocks.back().map(|b| b.state);
        match kind {
            // Prompt start. Right, continuation and secondary prompts belong to
            // the current block.
            1 if prompt_kind == 0 => match last {
                // A redrawn or abandoned prompt replaces the pending one.
                Some(BlockState::Prompt | BlockState::Input) => {
                    let block = self.blocks.back_mut().unwrap();
                    block.prompt = mark;
                    block.input = None;
                    block.state = BlockState::Prompt;
                }
                _ => {
                    if last == Some(BlockState::Running) {
                        // No OSC 133;D: the next prompt ends the command.
                        let block = self.blocks.back_mut().unwrap();
                        block.state = BlockState::Done;
                        Self::emit(events, block);
                    }
                    let block = self.push(BlockState::Prompt);
                    block.prompt = mark;
                    Self::emit(events, block);
                }
            },
            2 => {
                if !matches!(last, Some(BlockState::Prompt | BlockState::Input)) {
                    self.push(BlockState::Input);
                }
                let block = self.blocks.back_mut().unwrap();
                block.input = mark;
                block.state = BlockState::Input;
            }
            // A repeated output start (two integrations, or a shell that sends
            // its own marks) belongs to the running command.
            3 if last == Some(BlockState::Running) => {
                let block = self.blocks.back_mut().unwrap();
                if block.command.is_empty() {
                    block.command = command.to_owned();
                }
            }
            3 => {
                if !matches!(last, Some(BlockState::Prompt | BlockState::Input)) {
                    self.push(BlockState::Input);
                }
                let block = self.blocks.back_mut().unwrap();
                block.output = mark;
                block.command = command.to_owned();
                block.state = BlockState::Running;
                Self::emit(events, block);
            }
            // A command end without a running command (an empty Enter in some
            // integrations) has nothing to finish.
            4 if last == Some(BlockState::Running) => {
                let block = self.blocks.back_mut().unwrap();
                block.end = mark;
                block.exit = exit;
                block.state = BlockState::Done;
                Self::emit(events, block);
            }
            _ => {}
        }
    }
}

#[no_mangle]
/// Record one OSC 133 step from the bridge, taking ownership of `mark`.
///
/// # Safety
/// `user` must point to the live, uniquely borrowed State during a synchronous
/// terminal write. For nonzero `len`, `command` must be readable for `len`
/// bytes during this call. `mark` must be null or a tracked grid reference
/// that no one else frees.
pub unsafe extern "C" fn wraith_semantic(
    user: *mut c_void,
    kind: u32,
    prompt_kind: u32,
    has_exit: bool,
    exit_code: i32,
    command: *const u8,
    len: usize,
    mark: *mut c_void,
) {
    let state = unsafe { &mut *user.cast::<State>() };
    let mark = NonNull::new(mark).map(Mark);
    let command = if len == 0 || command.is_null() {
        String::new()
    } else {
        String::from_utf8_lossy(unsafe { std::slice::from_raw_parts(command, len) }).into_owned()
    };
    let State {
        commands, events, ..
    } = state;
    commands.step(
        events,
        kind,
        prompt_kind,
        has_exit.then_some(exit_code),
        &command,
        mark,
    );
}

fn info(b: &Block) -> BlockInfo {
    let row = |m: &Option<Mark>| m.as_ref().and_then(|m| m.point(SCREEN)).map(|p| p.1);
    BlockInfo {
        id: b.id,
        state: b.state,
        command: b.command.clone(),
        exit: b.exit,
        prompt_row: row(&b.prompt),
        input_row: row(&b.input),
        output_row: row(&b.output),
        end_row: row(&b.end),
        truncated: b.trimmed,
    }
}

/// Exclusive end position → inclusive last cell, given the column count.
fn before(end: (u32, u32), cols: u32) -> Option<(u32, u32)> {
    match end {
        (0, 0) => None,
        (0, y) => Some((cols.saturating_sub(1), y - 1)),
        (x, y) => Some((x - 1, y)),
    }
}

impl Core {
    fn bridge_ptr(&self) -> *mut c_void {
        self.bridge.as_ptr()
    }
    /// Whether any OSC 133 block exists. Hosts skip all block work otherwise.
    pub fn has_commands(&self) -> bool {
        !self.state.commands.blocks.is_empty()
    }
    pub fn screen(&self) -> Screen {
        let mut out = [0u64; 6];
        if unsafe { wraith_bridge_screen(self.bridge_ptr(), out.as_mut_ptr()) } != 0 {
            return Screen::default();
        }
        Screen {
            total: out[0],
            offset: out[1],
            len: out[2],
            cursor_row: out[3],
            cursor_col: out[4],
            primary: out[5] != 0,
        }
    }
    /// Release references whose rows were all trimmed, keeping the metadata.
    fn release_trimmed(&mut self) {
        for block in self.state.commands.blocks.iter_mut() {
            let lost = |m: &mut Option<Mark>| {
                if m.as_ref().is_some_and(|m| m.point(SCREEN).is_none()) {
                    *m = None;
                    true
                } else {
                    false
                }
            };
            let mut trimmed = lost(&mut block.prompt);
            trimmed |= lost(&mut block.input);
            trimmed |= lost(&mut block.output);
            trimmed |= lost(&mut block.end);
            block.trimmed |= trimmed;
        }
    }
    pub fn commands(&mut self) -> Vec<BlockInfo> {
        self.release_trimmed();
        self.state.commands.blocks.iter().map(info).collect()
    }
    /// One block by id, searching from the newest. Costs one block's marks,
    /// unlike `commands()`, so hosts can report each completion cheaply.
    pub fn command(&self, id: u32) -> Option<BlockInfo> {
        let block = self
            .state
            .commands
            .blocks
            .iter()
            .rev()
            .find(|b| b.id == id)?;
        let mut info = info(block);
        let lost = |m: &Option<Mark>, row: Option<u32>| m.is_some() && row.is_none();
        info.truncated |= lost(&block.prompt, info.prompt_row)
            || lost(&block.input, info.input_row)
            || lost(&block.output, info.output_row)
            || lost(&block.end, info.end_row);
        Some(info)
    }
    fn range_text(&mut self, start: (u32, u32), end: (u32, u32)) -> Result<String, String> {
        if (end.1, end.0) < (start.1, start.0) {
            return Ok(String::new());
        }
        let result =
            unsafe { wraith_bridge_range_text(self.bridge_ptr(), start.0, start.1, end.0, end.1) };
        let mut output = Vec::new();
        self.state.events.retain(|(kind, bytes)| {
            if *kind == RANGE_TEXT {
                output.extend_from_slice(bytes);
                false
            } else {
                true
            }
        });
        if result < 0 {
            return Err(format!("libghostty-vt error {result}"));
        }
        let text = String::from_utf8_lossy(&output);
        Ok(text.trim_end_matches(['\n', '\r']).to_owned())
    }
    /// The exclusive end of a block's output: its end mark, else the next
    /// block's first mark, else (still running) the cursor.
    fn block_end(&self, index: usize) -> Option<(u32, u32)> {
        let blocks = &self.state.commands.blocks;
        let block = &blocks[index];
        if let Some(end) = &block.end {
            return end.point(SCREEN);
        }
        if let Some(next) = blocks.get(index + 1) {
            return next.first().and_then(|m| m.point(SCREEN));
        }
        let screen = self.screen();
        Some((screen.cursor_col as u32, screen.cursor_row as u32))
    }
    /// A block's output (`input == false`) or typed command line, and whether
    /// rows of it were trimmed from the scrollback. None for unknown ids.
    pub fn command_text(&mut self, id: u32, input: bool) -> Result<Option<(String, bool)>, String> {
        self.release_trimmed();
        let blocks = &self.state.commands.blocks;
        let Some(index) = blocks.iter().position(|b| b.id == id) else {
            return Ok(None);
        };
        let block = &blocks[index];
        let (from, to) = if input {
            (
                block.input.as_ref(),
                block.output.as_ref().and_then(|m| m.point(SCREEN)),
            )
        } else {
            (block.output.as_ref(), self.block_end(index))
        };
        let had_start = if input {
            block.input.is_some()
        } else {
            block.output.is_some() || block.trimmed
        };
        let truncated = block.trimmed;
        if !had_start {
            return Ok(Some((String::new(), truncated)));
        }
        let cols = self.state.cols as u32;
        let start = from.and_then(|m| m.point(SCREEN)).unwrap_or((0, 0));
        let Some(end) = to.and_then(|end| before(end, cols)) else {
            return Ok(Some((String::new(), truncated)));
        };
        Ok(Some((self.range_text(start, end)?, truncated)))
    }
    /// Visible block extents for a gutter: `[id, state, exit_kind, first_row,
    /// last_row]` per block in viewport rows, newest first. `exit_kind` is 0
    /// for no exit code, 1 for success and 2 for failure. Blocks still at their
    /// prompt are omitted. Walks from the newest block and stops at the first
    /// block wholly above the viewport, so cost follows visible blocks.
    pub fn command_marks(&self) -> Vec<i32> {
        let mut marks = Vec::new();
        let blocks = &self.state.commands.blocks;
        if blocks.is_empty() {
            return marks;
        }
        let screen = self.screen();
        if !screen.primary {
            return marks;
        }
        let rows = screen.len as i64;
        let cols = self.state.cols as u32;
        let cursor = (
            screen.cursor_col as u32,
            (screen.cursor_row as i64 - screen.offset as i64).max(0) as u32,
        );
        // Viewport start of the newer neighbour: None when above the viewport.
        let mut newer: Option<Option<(u32, u32)>> = None;
        for block in blocks.iter().rev() {
            let start = block.first().and_then(|m| m.point(VIEWPORT));
            let end = match (&block.end, newer) {
                (Some(end), _) => end.point(VIEWPORT),
                (None, Some(next)) => next,
                (None, None) => Some(cursor),
            };
            newer = Some(start);
            let Some(end) = end else {
                // The block ends above the viewport; so do all older blocks.
                break;
            };
            if matches!(block.state, BlockState::Prompt | BlockState::Input) {
                continue;
            }
            let Some((_, last)) = before(end, cols) else {
                continue;
            };
            let last = last as i64;
            let first = start.map_or(0, |p| p.1 as i64);
            if first >= rows || last < 0 {
                continue;
            }
            let exit = match block.exit {
                None => 0,
                Some(0) => 1,
                Some(_) => 2,
            };
            marks.extend_from_slice(&[
                block.id as i32,
                block.state as i32,
                exit,
                first as i32,
                last.max(first).min(rows - 1) as i32,
            ]);
        }
        marks
    }
    /// Scroll so the previous (`direction < 0`) or next prompt is the top
    /// viewport row. Past the newest prompt, return to the bottom. Returns the
    /// new viewport offset, or None when there is no prompt to move to.
    pub fn jump_to_prompt(&mut self, direction: i32) -> Option<u64> {
        let screen = self.screen();
        if !screen.primary || self.state.commands.blocks.is_empty() {
            return None;
        }
        let offset = screen.offset;
        let rows = self
            .state
            .commands
            .blocks
            .iter()
            .filter_map(|b| b.first().and_then(|m| m.point(SCREEN)))
            .map(|p| p.1 as u64);
        let target = if direction < 0 {
            rows.filter(|&r| r < offset).max()
        } else {
            rows.filter(|&r| r > offset).min()
        };
        let bottom = screen.total.saturating_sub(screen.len);
        let target = match target {
            Some(row) => row.min(bottom),
            None if direction > 0 && offset < bottom => bottom,
            None => return None,
        };
        if target == offset {
            return None;
        }
        unsafe { wraith_bridge_scroll_row(self.bridge_ptr(), target) };
        Some(self.screen().offset)
    }
}
