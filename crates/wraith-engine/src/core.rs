//! A safe owner for libghostty-vt. C callbacks mutate one pinned state allocation.
use std::{
    alloc::{alloc, dealloc, Layout},
    ffi::c_void,
    ops::{Deref, DerefMut},
    ptr::NonNull,
};

#[repr(C)]
#[derive(Default, Clone, Copy, Debug, PartialEq)]
pub struct Frame {
    pub cols: u32,
    pub rows: u32,
    pub cursor_x: u32,
    pub cursor_y: u32,
    pub cursor_style: u32,
    pub cursor_visible: u32,
    pub cursor_blink: u32,
    pub background: u32,
    pub foreground: u32,
    pub cursor_color: u32,
    pub held: u32,
}

#[derive(Default, Clone, Debug)]
pub struct Cell {
    pub text: String,
    /// The Unicode scalar when `text` is exactly one scalar, otherwise zero.
    pub scalar: u32,
    pub foreground: u32,
    pub background: u32,
    pub underline: u32,
    pub flags: u32,
}
impl Cell {
    pub fn with_text(text: &str) -> Self {
        let mut cell = Self::default();
        cell.set_text(text);
        cell
    }
    fn set_scalar(&mut self, scalar: char) {
        self.text.clear();
        self.text.push(scalar);
        self.scalar = scalar as u32;
    }
    fn set_text(&mut self, text: &str) {
        self.text.clear();
        self.text.push_str(text);
        let mut chars = text.chars();
        self.scalar = match (chars.next(), chars.next()) {
            (Some(c), None) => c as u32,
            _ => 0,
        };
    }
}
pub(crate) const BLINK: u32 = 8;

#[derive(Default)]
pub(crate) struct State {
    pub cols: usize,
    pub rows: usize,
    pub cells: Vec<Cell>,
    pub dirty: Vec<bool>,
    pub events: Vec<(u32, Vec<u8>)>,
    /// Visible cells with the blink attribute, maintained as cells are copied
    /// so idle frames need not scan the grid.
    pub blinking: usize,
    /// What produced each viewport row, for reusing rows that only moved.
    pub keys: Vec<RowKey>,
    /// Update stamp of the last write to each row; copy sources must predate
    /// the current update.
    pub stamps: Vec<u32>,
    pub stamp: u32,
    /// The last source-minus-destination shift, tried first.
    pub shift: isize,
    /// Stamp of the update that already ran its one full search for a
    /// moved row; later misses in that update only try `shift`.
    pub searched: u32,
    /// Rows copied instead of snapshotted, for diagnostics.
    pub reused: u64,
    /// A unique version per snapshotted row content; a moved row keeps its
    /// version. Zero is unknown. The renderer keys packed GPU rows by it.
    pub versions: Vec<u64>,
    pub next_version: u64,
}
/// Ghostty's row identity, its raw cells and its selection range. Equal keys
/// produce equal snapshots: a row id changes when the row is edited in place,
/// raw cells hold codepoints, widths and page-local style ids, and rows with
/// grapheme clusters are never reusable.
#[derive(Default, Clone)]
pub(crate) struct RowKey {
    id: [u64; 2],
    raw: Vec<u64>,
    selection: u32,
    reusable: bool,
}

/// Owns the stable callback allocation through a raw pointer. Unlike keeping a
/// self-referenced Box field, borrowing Core does not retag an owning Box's
/// pointee while foreign code uses the original userdata pointer.
pub(crate) struct StateOwner(NonNull<State>);
impl StateOwner {
    fn new(state: State) -> Self {
        Self(NonNull::new(Box::into_raw(Box::new(state))).unwrap())
    }
}
impl Deref for StateOwner {
    type Target = State;
    fn deref(&self) -> &State {
        // SAFETY: StateOwner uniquely owns this live allocation. Foreign
        // callbacks run only during Core's synchronous exclusive operations.
        unsafe { self.0.as_ref() }
    }
}
impl DerefMut for StateOwner {
    fn deref_mut(&mut self) -> &mut State {
        // SAFETY: the exclusive owner borrow excludes all snapshot readers;
        // callers do not enter Ghostty while this reference is live.
        unsafe { self.0.as_mut() }
    }
}
impl Drop for StateOwner {
    fn drop(&mut self) {
        // SAFETY: Core has already destroyed the bridge and its callbacks.
        // This pointer came from exactly one Box::into_raw allocation.
        unsafe { drop(Box::from_raw(self.0.as_ptr())) }
    }
}

pub struct Core {
    bridge: NonNull<c_void>,
    pub(crate) state: StateOwner,
    pub(crate) frame: Frame,
}

extern "C" {
    fn wraith_bridge_new(user: *mut c_void, cols: u16, rows: u16, history: usize) -> *mut c_void;
    fn wraith_bridge_free(b: *mut c_void);
    fn wraith_bridge_write(b: *mut c_void, data: *const u8, len: usize);
    fn wraith_bridge_resize(b: *mut c_void, cols: u16, rows: u16, cw: u32, ch: u32) -> i32;
    fn wraith_bridge_update(b: *mut c_void, frame: *mut Frame) -> i32;
    fn wraith_bridge_theme(b: *mut c_void, fg: u32, bg: u32, cursor: u32);
    fn wraith_bridge_scroll(b: *mut c_void, delta: i32);
    fn wraith_bridge_key(
        b: *mut c_void,
        key: u32,
        mods: u32,
        action: u32,
        text: *const u8,
        len: usize,
        unshifted: u32,
    ) -> i32;
    fn wraith_bridge_mouse(
        b: *mut c_void,
        action: u32,
        button: u32,
        mods: u32,
        x: f32,
        y: f32,
        pressed: u32,
    ) -> i32;
    fn wraith_bridge_mode(b: *mut c_void, mode: u16) -> i32;
    fn wraith_bridge_hold_release(b: *mut c_void);
    fn wraith_bridge_select(b: *mut c_void, x1: i32, y1: i32, x2: i32, y2: i32) -> i32;
    fn wraith_bridge_link(b: *mut c_void, x: u16, y: u16, output: *mut u8, cap: usize) -> usize;
    fn wraith_bridge_selection_text(b: *mut c_void) -> i32;
}

fn check(result: i32) -> Result<(), String> {
    if result < 0 {
        Err(format!("libghostty-vt error {result}"))
    } else {
        Ok(())
    }
}
fn dimensions(cols: u16, rows: u16) -> Result<(), String> {
    if cols == 0 || rows == 0 || cols > 512 || rows > 512 || cols as usize * rows as usize > 65_536
    {
        return Err("grid must be 1..512 per dimension and at most 65,536 cells".into());
    }
    Ok(())
}
impl Core {
    pub fn new(cols: u16, rows: u16, history: usize) -> Result<Self, String> {
        dimensions(cols, rows)?;
        let state = StateOwner::new(State {
            cols: cols.into(),
            rows: rows.into(),
            cells: vec![Cell::default(); cols as usize * rows as usize],
            dirty: vec![true; rows.into()],
            events: Vec::new(),
            blinking: 0,
            keys: vec![RowKey::default(); rows.into()],
            stamps: vec![0; rows.into()],
            stamp: 0,
            shift: 1,
            searched: 0,
            reused: 0,
            versions: vec![0; rows.into()],
            next_version: 0,
        });
        // Ghostty borrows the stable allocation only for synchronous callbacks
        // and never after bridge_free. StateOwner then releases the allocation.
        let bridge = NonNull::new(unsafe {
            wraith_bridge_new(state.0.as_ptr().cast(), cols, rows, history)
        })
        .ok_or("could not allocate Ghostty terminal")?;
        Ok(Self {
            bridge,
            state,
            frame: Frame::default(),
        })
    }
    pub fn write(&mut self, bytes: &[u8]) {
        unsafe { wraith_bridge_write(self.bridge.as_ptr(), bytes.as_ptr(), bytes.len()) }
    }
    pub fn frame(&self) -> Frame {
        self.frame
    }
    pub fn cells(&self) -> &[Cell] {
        &self.state.cells
    }
    /// Rows copied from a moved, unchanged row instead of being snapshotted.
    pub fn reused_rows(&self) -> u64 {
        self.state.reused
    }
    pub fn blinking(&self) -> usize {
        self.state.blinking
    }
    pub fn dirty_rows(&self) -> &[bool] {
        &self.state.dirty
    }
    pub fn events(&self) -> &[(u32, Vec<u8>)] {
        &self.state.events
    }
    pub fn take_events(&mut self) -> Vec<(u32, Vec<u8>)> {
        std::mem::take(&mut self.state.events)
    }
    /// A custom renderer calls this only after consuming the current snapshot.
    pub fn acknowledge_damage(&mut self) {
        self.state.dirty.fill(false);
    }
    pub fn update(&mut self) -> Result<bool, String> {
        self.state.stamp = self.state.stamp.wrapping_add(1);
        let previous = self.frame;
        let dirty = unsafe { wraith_bridge_update(self.bridge.as_ptr(), &mut self.frame) };
        check(dirty)?;
        Ok(dirty > 0 || previous != self.frame)
    }
    pub fn resize(&mut self, cols: u16, rows: u16, cw: u32, ch: u32) -> Result<(), String> {
        dimensions(cols, rows)?;
        check(unsafe {
            wraith_bridge_resize(self.bridge.as_ptr(), cols, rows, cw.max(1), ch.max(1))
        })?;
        self.state.cols = cols.into();
        self.state.rows = rows.into();
        self.state
            .cells
            .resize(cols as usize * rows as usize, Cell::default());
        self.state.blinking = self
            .state
            .cells
            .iter()
            .filter(|c| c.flags & BLINK != 0)
            .count();
        self.state.dirty = vec![true; rows.into()];
        self.state.keys = vec![RowKey::default(); rows.into()];
        self.state.stamps = vec![0; rows.into()];
        self.state.versions = vec![0; rows.into()];
        Ok(())
    }
    pub fn theme(&mut self, fg: u32, bg: u32, cursor: u32) {
        unsafe { wraith_bridge_theme(self.bridge.as_ptr(), fg, bg, cursor) }
        self.state.dirty.fill(true);
        self.state.keys.iter_mut().for_each(|k| k.reusable = false);
    }
    pub fn scroll(&mut self, delta: i32) {
        unsafe { wraith_bridge_scroll(self.bridge.as_ptr(), delta) }
    }
    pub fn key(
        &mut self,
        key: u32,
        mods: u32,
        action: u32,
        text: &str,
        unshifted: u32,
    ) -> Result<(), String> {
        check(unsafe {
            wraith_bridge_key(
                self.bridge.as_ptr(),
                key,
                mods,
                action,
                text.as_ptr(),
                text.len(),
                unshifted,
            )
        })
    }
    pub fn mouse(
        &mut self,
        action: u32,
        button: u32,
        mods: u32,
        x: f32,
        y: f32,
        pressed: u32,
    ) -> Result<(), String> {
        check(unsafe {
            wraith_bridge_mouse(self.bridge.as_ptr(), action, button, mods, x, y, pressed)
        })
    }
    pub fn mode(&self, mode: u16) -> bool {
        unsafe { wraith_bridge_mode(self.bridge.as_ptr(), mode) != 0 }
    }
    pub fn release_hold(&mut self) {
        unsafe { wraith_bridge_hold_release(self.bridge.as_ptr()) }
    }
    pub fn select(&mut self, x1: i32, y1: i32, x2: i32, y2: i32) -> Result<(), String> {
        check(unsafe { wraith_bridge_select(self.bridge.as_ptr(), x1, y1, x2, y2) })
    }
    pub fn link(&self, x: u16, y: u16) -> String {
        let mut output = vec![0; 8192];
        let n = unsafe {
            wraith_bridge_link(
                self.bridge.as_ptr(),
                x,
                y,
                output.as_mut_ptr(),
                output.len(),
            )
        };
        String::from_utf8_lossy(&output[..n.min(output.len())]).into_owned()
    }
    pub fn selection_text(&mut self) -> Result<String, String> {
        check(unsafe { wraith_bridge_selection_text(self.bridge.as_ptr()) })?;
        let mut output = Vec::new();
        self.state.events.retain(|(kind, bytes)| {
            if *kind == 4 {
                output.extend_from_slice(bytes);
                false
            } else {
                true
            }
        });
        Ok(String::from_utf8_lossy(&output).into_owned())
    }
    pub fn text(&self, selected: bool) -> String {
        let mut output = String::new();
        for row in self.state.cells.chunks(self.state.cols) {
            let mut line = String::new();
            for cell in row {
                if selected && cell.flags & (1 << 17) == 0 {
                    continue;
                }
                if cell.flags & (1 << 20) != 0 {
                    continue;
                }
                if cell.text.is_empty() {
                    line.push(' ');
                } else {
                    line.push_str(&cell.text);
                }
            }
            if selected && line.is_empty() {
                continue;
            }
            output.push_str(line.trim_end());
            output.push('\n');
        }
        output.trim_end_matches('\n').into()
    }
}
impl Drop for Core {
    fn drop(&mut self) {
        unsafe { wraith_bridge_free(self.bridge.as_ptr()) }
    }
}

// SAFETY: allocation callbacks match GhosttyAllocatorVtable's length and
// alignment contracts. Resize/remap decline changes, preserving the original
// Layout until free. All pointers below are borrowed for one synchronous call.
#[no_mangle]
/// Allocate storage for the Ghostty C adapter.
///
/// # Safety
/// The returned allocation must be freed exactly once with its original length
/// and alignment exponent, using `wraith_dealloc`.
pub unsafe extern "C" fn wraith_alloc(len: usize, alignment: u8) -> *mut c_void {
    let Some(align) = 1usize.checked_shl(alignment.into()) else {
        return std::ptr::null_mut();
    };
    let Ok(layout) = Layout::from_size_align(len.max(1), align) else {
        return std::ptr::null_mut();
    };
    unsafe { alloc(layout).cast() }
}
#[no_mangle]
/// Release storage allocated by `wraith_alloc`.
///
/// # Safety
/// `ptr` must be null or a live allocation from `wraith_alloc` with exactly
/// the same `len` and alignment exponent. It must not be used after this call.
pub unsafe extern "C" fn wraith_dealloc(ptr: *mut c_void, len: usize, alignment: u8) {
    if ptr.is_null() {
        return;
    }
    let Some(align) = 1usize.checked_shl(alignment.into()) else {
        return;
    };
    if let Ok(layout) = Layout::from_size_align(len.max(1), align) {
        unsafe { dealloc(ptr.cast(), layout) }
    }
}
#[no_mangle]
/// Copy a synchronous terminal effect into the owning state.
///
/// # Safety
/// `user` must point to the live, uniquely borrowed `State` owned by this Core.
/// When `len` is nonzero, `ptr` must remain readable for `len` bytes during the
/// call. Ghostty must not reenter the callback while Rust accesses the state.
pub unsafe extern "C" fn wraith_emit(user: *mut c_void, kind: u32, ptr: *const u8, len: usize) {
    let state = unsafe { &mut *user.cast::<State>() };
    let bytes = if len == 0 {
        Vec::new()
    } else {
        unsafe { std::slice::from_raw_parts(ptr, len).to_vec() }
    };
    state.events.push((kind, bytes));
}
#[no_mangle]
/// Mark a row for GPU upload.
///
/// # Safety
/// `user` must point to the live, uniquely borrowed owning State for a
/// synchronous Ghostty render update. No Rust reference may alias that state.
pub unsafe extern "C" fn wraith_row(user: *mut c_void, row: u32) {
    let state = unsafe { &mut *user.cast::<State>() };
    if let Some(dirty) = state.dirty.get_mut(row as usize) {
        *dirty = true;
        // Unknown until wraith_row_store completes the snapshot.
        state.versions[row as usize] = 0;
    }
}
#[no_mangle]
/// Copy one cell from Ghostty's borrowed render snapshot. A nonzero `scalar`
/// is the cell's sole codepoint; otherwise `ptr`/`len` hold its UTF-8 cluster.
///
/// # Safety
/// `user` must point to a live, uniquely borrowed State. For nonzero `len`,
/// `ptr` must remain readable for `len` bytes for the duration of this call.
/// The adapter must not invoke this callback during another state access.
pub unsafe extern "C" fn wraith_cell(
    user: *mut c_void,
    x: u32,
    y: u32,
    scalar: u32,
    ptr: *const u8,
    len: usize,
    foreground: u32,
    background: u32,
    underline: u32,
    flags: u32,
) {
    let state = unsafe { &mut *user.cast::<State>() };
    if x as usize >= state.cols || y as usize >= state.rows {
        return;
    }
    let cell = &mut state.cells[y as usize * state.cols + x as usize];
    if let Some(c) = char::from_u32(scalar).filter(|_| scalar != 0) {
        cell.set_scalar(c);
    } else {
        let bytes = if len == 0 {
            &[][..]
        } else {
            unsafe { std::slice::from_raw_parts(ptr, len) }
        };
        match std::str::from_utf8(bytes) {
            Ok(text) => cell.set_text(text),
            Err(_) => cell.set_text(&String::from_utf8_lossy(bytes)),
        }
    }
    state.blinking += (flags & BLINK != 0) as usize;
    state.blinking -= (cell.flags & BLINK != 0) as usize;
    cell.foreground = foreground;
    cell.background = background;
    cell.underline = underline;
    cell.flags = flags;
}

#[no_mangle]
/// Reuse a dirty row whose identity, raw cells and selection equal a row staged
/// earlier and not overwritten during this update. Returns whether it did.
///
/// # Safety
/// `user` must point to the live, uniquely borrowed State. For nonzero `len`,
/// `raw` must remain readable for `len` u64 values during this call.
pub unsafe extern "C" fn wraith_row_reuse(
    user: *mut c_void,
    row: u32,
    id0: u64,
    id1: u64,
    raw: *const u64,
    len: usize,
    selection: u32,
) -> bool {
    let state = unsafe { &mut *user.cast::<State>() };
    let y = row as usize;
    if y >= state.rows || len != state.cols || raw.is_null() || (id0 | id1) == 0 {
        return false;
    }
    let raw = unsafe { std::slice::from_raw_parts(raw, len) };
    let matches = |state: &State, s: usize| {
        let key = &state.keys[s];
        key.reusable
            && key.id == [id0, id1]
            && key.selection == selection
            && (s == y || state.stamps[s] != state.stamp)
            && key.raw == raw
    };
    let guess = y as isize + state.shift;
    let source = if matches(state, y) {
        Some(y)
    } else if guess >= 0 && (guess as usize) < state.rows && matches(state, guess as usize) {
        Some(guess as usize)
    } else if state.searched != state.stamp {
        // One full search per update finds a new shift; rows rewritten in
        // place (dense output) then cost two comparisons each, not a scan.
        state.searched = state.stamp;
        (0..state.rows).find(|&s| s != y && matches(state, s))
    } else {
        None
    };
    let Some(source) = source else {
        return false;
    };
    state.reused += 1;
    if source == y {
        // Conservatively dirty but unchanged: nothing to copy or upload.
        state.stamps[y] = state.stamp;
        return true;
    }
    state.shift = source as isize - y as isize;
    let cols = state.cols;
    for x in 0..cols {
        let (from, to) = (source * cols + x, y * cols + x);
        state.blinking += (state.cells[from].flags & BLINK != 0) as usize;
        state.blinking -= (state.cells[to].flags & BLINK != 0) as usize;
        let (a, b) = if from < to {
            let (head, tail) = state.cells.split_at_mut(to);
            (&head[from], &mut tail[0])
        } else {
            let (head, tail) = state.cells.split_at_mut(from);
            (&tail[0], &mut head[to])
        };
        b.clone_from(a);
    }
    let key = state.keys[source].clone();
    state.keys[y].clone_from(&key);
    state.versions[y] = state.versions[source];
    state.stamps[y] = state.stamp;
    state.dirty[y] = true;
    true
}
#[no_mangle]
/// Record what produced a freshly snapshotted row.
///
/// # Safety
/// `user` must point to the live, uniquely borrowed State. For nonzero `len`,
/// `raw` must remain readable for `len` u64 values during this call.
pub unsafe extern "C" fn wraith_row_store(
    user: *mut c_void,
    row: u32,
    id0: u64,
    id1: u64,
    raw: *const u64,
    len: usize,
    selection: u32,
    reusable: bool,
) {
    let state = unsafe { &mut *user.cast::<State>() };
    let y = row as usize;
    if y >= state.rows {
        return;
    }
    state.stamps[y] = state.stamp;
    state.next_version += 1;
    state.versions[y] = state.next_version;
    let key = &mut state.keys[y];
    key.id = [id0, id1];
    key.selection = selection;
    key.reusable = reusable && len == state.cols && !raw.is_null();
    key.raw.clear();
    if key.reusable {
        key.raw
            .extend_from_slice(unsafe { std::slice::from_raw_parts(raw, len) });
    }
}
