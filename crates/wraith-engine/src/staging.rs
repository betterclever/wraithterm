//! Compositor-owned storage that JavaScript fills between synchronous calls.
//! Slots use interior mutability because JS views can outlive an immutable
//! compositor borrow. Readers must not overlap JS writes to the same slots.
use std::{cell::UnsafeCell, slice};
/// u32 words per packed cell, matching the renderer's GPU cell.
const CELL_WORDS: usize = 5;

pub struct Staging {
    words: Vec<UnsafeCell<u32>>,
    cells: usize,
}
pub struct StagedFrame<'a> {
    pub cells: &'a [u32],
    pub dimensions: &'a [f32],
    pub frame: &'a [u32],
}
impl Staging {
    pub fn new() -> Self {
        Self {
            words: (0..12).map(|_| UnsafeCell::new(0)).collect(),
            cells: 0,
        }
    }
    pub fn resize(&mut self, cells: usize) -> Result<(), String> {
        let words = cells
            .checked_mul(CELL_WORDS)
            .and_then(|n| n.checked_add(12))
            .filter(|n| u32::try_from(*n).is_ok())
            .ok_or("compositor staging size overflow")?;
        self.words
            .try_reserve_exact(words.saturating_sub(self.words.len()))
            .map_err(|_| "could not allocate compositor staging")?;
        self.words.resize_with(words, || UnsafeCell::new(0));
        self.cells = cells;
        // A resized uniform region may overlap old cells. Reset every slot,
        // including reserved fields that JavaScript does not update per frame.
        for word in &mut self.words[cells * CELL_WORDS..] {
            *word.get_mut() = 0;
        }
        Ok(())
    }
    pub fn pointer(&self) -> *mut u32 {
        self.words.as_ptr().cast::<u32>().cast_mut()
    }
    pub fn cell_words(&self) -> usize {
        self.cells * CELL_WORDS
    }
    pub fn read(&self, cells: usize) -> Result<StagedFrame<'_>, String> {
        if cells > self.cells {
            return Err("staged cell count exceeds configured capacity".into());
        }
        let pointer = self.pointer();
        // SAFETY: UnsafeCell<u32> has u32's layout and alignment. All slots are
        // initialized, cell count is bounded, and the final 12 slots hold four
        // f32 bit patterns and eight frame words. The synchronous caller keeps
        // JS writes paused until these borrowed slices have been consumed.
        unsafe {
            Ok(StagedFrame {
                cells: slice::from_raw_parts(pointer, cells * CELL_WORDS),
                dimensions: slice::from_raw_parts(pointer.add(self.cell_words()).cast(), 4),
                frame: slice::from_raw_parts(pointer.add(self.cell_words() + 4), 8),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cells_and_uniforms_have_disjoint_initialized_regions() {
        let mut staging = Staging::new();
        staging.resize(2).unwrap();
        let pointer = staging.pointer();
        // SAFETY: all offsets are within the configured allocation, with no
        // outstanding read borrow. These writes model the browser's views.
        unsafe {
            *pointer = 0xff112233;
            *pointer.add(10) = 9.5_f32.to_bits();
            *pointer.add(14) = 2;
        }
        let frame = staging.read(1).unwrap();
        assert_eq!(frame.cells.len(), 5);
        assert_eq!(frame.cells[0], 0xff112233);
        assert_eq!(frame.dimensions, &[9.5, 0., 0., 0.]);
        assert_eq!(frame.frame, &[2, 0, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn invalid_counts_and_overflow_leave_existing_storage_valid() {
        let mut staging = Staging::new();
        staging.resize(2).unwrap();
        assert!(staging.read(3).is_err());
        assert!(staging.resize(usize::MAX).is_err());
        assert_eq!(staging.cell_words(), 10);
        assert_eq!(staging.read(0).unwrap().cells.len(), 0);
        assert_eq!(staging.read(2).unwrap().cells, &[0; 10]);
    }

    #[test]
    fn shrinking_resets_uniforms_that_previously_contained_cells() {
        let mut staging = Staging::new();
        staging.resize(4).unwrap();
        // SAFETY: mutate initialized slots before creating any read borrow.
        unsafe {
            for index in 0..staging.cell_words() {
                *staging.pointer().add(index) = u32::MAX;
            }
        }
        staging.resize(1).unwrap();
        let frame = staging.read(1).unwrap();
        assert_eq!(frame.cells, &[u32::MAX; 5]);
        assert_eq!(frame.dimensions, &[0.; 4]);
        assert_eq!(frame.frame, &[0; 8]);
    }
}
