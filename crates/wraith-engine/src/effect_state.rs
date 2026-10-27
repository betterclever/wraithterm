//! CPU-side effect settings and cursor-trail animation, shared by the GPU
//! post-process stage and native unit tests.

/// Number of f32 parameters `Settings::parse` expects.
pub const PARAMS: usize = 11;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Settings {
    /// Curvature, scanlines, vignette, chromatic aberration.
    pub crt: Option<[f32; 4]>,
    /// Intensity, threshold, spread.
    pub bloom: Option<[f32; 3]>,
    /// Trail duration in milliseconds.
    pub trail: Option<f32>,
    /// Redraw the custom shader every display frame.
    pub animate: bool,
}
impl Settings {
    /// `[crt, curvature, scanlines, vignette, aberration, bloom, threshold,
    /// spread, trail, trail_ms, animate]`; a zero switch disables a group.
    pub fn parse(p: &[f32]) -> Result<Self, String> {
        if p.len() != PARAMS || p.iter().any(|v| !v.is_finite()) {
            return Err("invalid effect parameters".into());
        }
        let unit = |v: f32| v.clamp(0., 1.);
        Ok(Self {
            crt: (p[0] != 0.).then(|| [unit(p[1]), unit(p[2]), unit(p[3]), unit(p[4])]),
            bloom: (p[5] > 0.).then(|| [p[5].min(4.), unit(p[6]), p[7].clamp(0.25, 4.)]),
            trail: (p[8] != 0.).then(|| p[9].clamp(16., 1000.)),
            animate: p[10] != 0.,
        })
    }
    pub fn composite(&self) -> bool {
        self.crt.is_some() || self.bloom.is_some() || self.trail.is_some()
    }
}

/// Smooth cursor: the drawn cursor eases from its previous position to the
/// new cell while a tail follows more slowly, then the native cursor returns.
#[derive(Default)]
pub struct Cursor {
    pub known: bool,
    pub visible: bool,
    pub target: [f32; 4],
    pub previous: [f32; 4],
    pub head_from: [f32; 4],
    pub tail_from: [f32; 4],
    pub color: [f32; 3],
    /// Animation start in ms; negative infinity when idle.
    pub started: f64,
    /// Time of the last position change, in ms.
    pub changed: f64,
}
fn lerp(a: [f32; 4], b: [f32; 4], t: f32) -> [f32; 4] {
    std::array::from_fn(|i| a[i] + (b[i] - a[i]) * t)
}
fn ease(t: f64) -> f32 {
    let t = t.clamp(0., 1.);
    (1. - (1. - t).powi(3)) as f32
}
impl Cursor {
    pub fn progress(&self, now: f64, duration: f64) -> f64 {
        (now - self.started) / duration
    }
    pub fn animating(&self, now: f64, duration: Option<f32>) -> bool {
        duration.is_some_and(|d| self.visible && self.progress(now, d as f64) < 1.)
    }
    /// Head and tail rects at `now`.
    pub fn positions(&self, now: f64, duration: f64) -> ([f32; 4], [f32; 4]) {
        let p = self.progress(now, duration);
        if p >= 1. {
            return (self.target, self.target);
        }
        (
            lerp(self.head_from, self.target, ease(p / 0.45)),
            lerp(self.tail_from, self.target, ease(p)),
        )
    }
    pub fn observe(
        &mut self,
        rect: [f32; 4],
        visible: bool,
        color: [f32; 3],
        now: f64,
        trail: Option<f32>,
    ) {
        self.color = color;
        if !self.known {
            *self = Self {
                known: true,
                visible,
                target: rect,
                previous: rect,
                head_from: rect,
                tail_from: rect,
                color,
                started: f64::NEG_INFINITY,
                changed: now,
            };
            return;
        }
        if rect != self.target {
            match trail {
                Some(d) if visible && self.visible => {
                    let (head, tail) = self.positions(now, d as f64);
                    self.head_from = head;
                    self.tail_from = tail;
                    self.started = now;
                }
                _ => self.started = f64::NEG_INFINITY,
            }
            self.previous = self.target;
            self.target = rect;
            self.changed = now;
        }
        if !visible {
            self.started = f64::NEG_INFINITY;
        }
        self.visible = visible;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn settings_parse_and_clamp() {
        assert!(Settings::parse(&[0.; 3]).is_err());
        assert!(Settings::parse(&[f32::NAN; PARAMS]).is_err());
        let off = Settings::parse(&[0.; PARAMS]).unwrap();
        assert!(!off.composite() && !off.animate);
        let on = Settings::parse(&[1., 2., 0.5, 0.5, 0.5, 9., 0.5, 1., 1., 5., 1.]).unwrap();
        assert_eq!(on.crt, Some([1., 0.5, 0.5, 0.5]));
        assert_eq!(on.bloom, Some([4., 0.5, 1.]));
        assert_eq!(on.trail, Some(16.));
        assert!(on.animate && on.composite());
    }
    #[test]
    fn cursor_trail_animates_then_settles() {
        let mut c = Cursor::default();
        let trail = Some(100.);
        c.observe([0., 0., 10., 20.], true, [1.; 3], 0., trail);
        assert!(
            !c.animating(0., trail),
            "first observation does not animate"
        );
        c.observe([50., 0., 10., 20.], true, [1.; 3], 10., trail);
        assert!(c.animating(10., trail));
        let (head, tail) = c.positions(40., 100.);
        assert!(head[0] > tail[0] && head[0] < 50. && tail[0] > 0.);
        assert!(!c.animating(110., trail));
        assert_eq!(
            c.positions(110., 100.),
            ([50., 0., 10., 20.], [50., 0., 10., 20.])
        );
        // A hidden cursor or no trail never animates.
        c.observe([0., 0., 10., 20.], false, [1.; 3], 120., trail);
        assert!(!c.animating(121., trail));
        c.observe([20., 0., 10., 20.], true, [1.; 3], 130., None);
        assert!(!c.animating(131., None));
    }
}
