//! Map visible rows to persistent GPU slots. Moves change the small map, not
//! cell uploads. Every physical slot has one owner, including duplicate rows.
pub const NEW_ROW: u32 = u32::MAX;

pub struct RetainedRows {
    pub slots: Vec<u32>,
    next: Vec<u32>,
    used: Vec<bool>,
    valid: Vec<bool>,
    pub uploads: Vec<(usize, usize, usize)>, // logical source, physical slot, rows
    pub changed: bool,
    pub identity: bool,
}
impl RetainedRows {
    pub fn new(rows: usize) -> Self {
        Self {
            slots: (0..rows as u32).collect(),
            next: vec![NEW_ROW; rows],
            used: vec![false; rows],
            valid: vec![false; rows],
            uploads: Vec::with_capacity(rows),
            changed: false,
            identity: true,
        }
    }
    /// Sources refer to the previous frame's logical rows, or NEW_ROW for
    /// freshly packed content. Validate the whole plan before changing state.
    pub fn plan(&mut self, sources: &[u32]) -> Result<(), String> {
        let rows = self.slots.len();
        if sources.len() != rows || sources.iter().any(|&s| s != NEW_ROW && s as usize >= rows) {
            return Err("invalid retained row source".into());
        }
        self.next.fill(NEW_ROW);
        self.used.fill(false);
        self.uploads.clear();
        // Reserve retained slots first, before assigning new content. A second
        // use of the same source is uploaded into an unclaimed slot instead;
        // future edits can then never overwrite another visible row's cells.
        for (y, &source) in sources.iter().enumerate() {
            if source == NEW_ROW {
                continue;
            }
            let slot = self.slots[source as usize] as usize;
            if self.valid[slot] && !self.used[slot] {
                self.next[y] = slot as u32;
                self.used[slot] = true;
            }
        }
        let mut free = 0;
        for y in 0..rows {
            if self.next[y] != NEW_ROW {
                continue;
            }
            let old = self.slots[y] as usize;
            let slot = if !self.used[old] {
                old
            } else {
                while self.used[free] {
                    free += 1;
                }
                free
            };
            self.next[y] = slot as u32;
            self.used[slot] = true;
            self.valid[slot] = true;
            if let Some((src, dst, count)) = self.uploads.last_mut() {
                if *src + *count == y && *dst + *count == slot {
                    *count += 1;
                    continue;
                }
            }
            self.uploads.push((y, slot, 1));
        }
        self.changed = self.next != self.slots;
        self.identity = self
            .next
            .iter()
            .enumerate()
            .all(|(y, &slot)| slot as usize == y);
        std::mem::swap(&mut self.slots, &mut self.next);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn apply(plan: &mut RetainedRows, sources: &[u32], desired: &[u32], gpu: &mut [u32]) {
        plan.plan(sources).unwrap();
        for &(src, dst, count) in &plan.uploads {
            gpu[dst..dst + count].copy_from_slice(&desired[src..src + count]);
        }
        let visible: Vec<_> = plan.slots.iter().map(|&slot| gpu[slot as usize]).collect();
        assert_eq!(visible, desired);
        let mut unique = plan.slots.clone();
        unique.sort_unstable();
        assert_eq!(unique, (0..gpu.len() as u32).collect::<Vec<_>>());
    }
    #[test]
    fn scrolls_rotate_slots_and_upload_only_exposed_rows() {
        let mut plan = RetainedRows::new(4);
        let mut gpu = vec![0; 4];
        apply(&mut plan, &[NEW_ROW; 4], &[10, 20, 30, 40], &mut gpu);
        assert_eq!(plan.uploads, [(0, 0, 4)]);
        apply(&mut plan, &[1, 2, 3, NEW_ROW], &[20, 30, 40, 50], &mut gpu);
        assert_eq!(plan.uploads, [(3, 0, 1)]);
        assert!(plan.changed && !plan.identity);
        apply(&mut plan, &[1, 2, 3, NEW_ROW], &[30, 40, 50, 60], &mut gpu);
        assert_eq!(plan.uploads, [(3, 1, 1)]);
        apply(&mut plan, &[NEW_ROW, 0, 1, 2], &[20, 30, 40, 50], &mut gpu);
        assert_eq!(plan.uploads, [(0, 1, 1)]);
    }
    #[test]
    fn sparse_edits_duplicates_and_uniform_only_frames_preserve_ownership() {
        let mut plan = RetainedRows::new(4);
        let mut gpu = vec![0; 4];
        apply(&mut plan, &[NEW_ROW; 4], &[10, 20, 30, 40], &mut gpu);
        apply(&mut plan, &[0, 1, 2, 3], &[10, 20, 30, 40], &mut gpu);
        assert!(plan.uploads.is_empty() && !plan.changed && plan.identity);
        apply(
            &mut plan,
            &[NEW_ROW, 1, 2, NEW_ROW],
            &[11, 20, 30, 41],
            &mut gpu,
        );
        assert_eq!(plan.uploads, [(0, 0, 1), (3, 3, 1)]);
        apply(&mut plan, &[1, 1, 1, 1], &[20; 4], &mut gpu);
        apply(&mut plan, &[0, NEW_ROW, 2, 3], &[20, 99, 20, 20], &mut gpu);
    }
    #[test]
    fn malformed_plans_leave_mapping_and_uploads_unchanged() {
        let mut plan = RetainedRows::new(2);
        plan.plan(&[NEW_ROW; 2]).unwrap();
        let slots = plan.slots.clone();
        let uploads = plan.uploads.clone();
        assert!(plan.plan(&[0]).is_err());
        assert!(plan.plan(&[0, 2]).is_err());
        assert_eq!(plan.slots, slots);
        assert_eq!(plan.uploads, uploads);
    }
    #[test]
    fn a_fresh_or_resized_buffer_cannot_retain_uninitialized_slots() {
        let mut plan = RetainedRows::new(4);
        let mut gpu = vec![0; 4];
        apply(&mut plan, &[0, 1, 2, 3], &[10, 20, 30, 40], &mut gpu);
        assert_eq!(plan.uploads, [(0, 0, 4)]);
    }
    #[test]
    fn arbitrary_moves_replacements_and_duplicates_match_a_full_upload() {
        let mut seed = 123456789u32;
        let mut random = || {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            seed
        };
        for rows in [1, 2, 6, 80] {
            let mut plan = RetainedRows::new(rows);
            let mut gpu = vec![0; rows];
            let mut visible = vec![0; rows];
            for _ in 0..500 {
                let sources: Vec<_> = (0..rows)
                    .map(|_| {
                        let r = random();
                        if r % 4 == 0 {
                            NEW_ROW
                        } else {
                            r % rows as u32
                        }
                    })
                    .collect();
                let desired: Vec<_> = sources
                    .iter()
                    .map(|&s| {
                        if s == NEW_ROW {
                            random()
                        } else {
                            visible[s as usize]
                        }
                    })
                    .collect();
                apply(&mut plan, &sources, &desired, &mut gpu);
                visible = desired;
            }
        }
    }
}
