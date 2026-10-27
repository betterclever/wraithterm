use crate::{
    core::Core,
    gpu::Renderer,
    shared::{atlas_key, SharedContext, Surface},
    staging::Staging,
    text::Atlas,
};
use std::rc::Rc;
use wasm_bindgen::prelude::*;
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = performance)]
    fn now() -> f64;
}
fn error(e: String) -> JsValue {
    js_sys::Error::new(&e).into()
}
fn events(core: &mut Core) -> js_sys::Array {
    let output = js_sys::Array::new();
    for (kind, data) in core.state.events.drain(..) {
        let event = js_sys::Array::new();
        event.push(&JsValue::from(kind));
        event.push(&js_sys::Uint8Array::from(data.as_slice()));
        output.push(&event);
    }
    output
}

/// Headless browser instance for tests, replay, and serverless terminal analysis.
#[wasm_bindgen]
pub struct Headless {
    core: Core,
}
#[wasm_bindgen]
impl Headless {
    #[wasm_bindgen(constructor)]
    pub fn new(cols: u16, rows: u16, history: u32) -> Result<Headless, JsValue> {
        Ok(Self {
            core: Core::new(cols, rows, history as usize).map_err(error)?,
        })
    }
    pub fn write(&mut self, data: &[u8]) {
        self.core.write(data);
    }
    pub fn text(&mut self) -> Result<String, JsValue> {
        self.core.update().map_err(error)?;
        Ok(self.core.text(false))
    }
    pub fn resize(&mut self, cols: u16, rows: u16) -> Result<(), JsValue> {
        self.core.resize(cols, rows, 9, 18).map_err(error)
    }
    pub fn key(
        &mut self,
        key: u32,
        mods: u32,
        action: u32,
        text: &str,
        unshifted: u32,
    ) -> Result<(), JsValue> {
        self.core
            .key(key, mods, action, text, unshifted)
            .map_err(error)
    }
    pub fn mode(&self, mode: u16) -> bool {
        self.core.mode(mode)
    }
    pub fn take_events(&mut self) -> js_sys::Array {
        events(&mut self.core)
    }
    pub fn release_hold(&mut self) {
        self.core.release_hold();
    }
    pub fn search(&mut self, needle: &str, action: u32) -> Result<Vec<u32>, JsValue> {
        self.core
            .search(needle, action)
            .map(|v| v.to_vec())
            .map_err(error)
    }
    pub fn scroll(&mut self, delta: i32) {
        self.core.scroll(delta);
    }
    pub fn cell(&mut self, x: u16, y: u16) -> Result<js_sys::Array, JsValue> {
        self.core.update().map_err(error)?;
        if x as usize >= self.core.state.cols || y as usize >= self.core.state.rows {
            return Err(error("cell out of bounds".into()));
        }
        let cell = self
            .core
            .state
            .cells
            .get(y as usize * self.core.state.cols + x as usize)
            .ok_or_else(|| error("cell out of bounds".into()))?;
        let result = js_sys::Array::new();
        result.push(&JsValue::from_str(&cell.text));
        result.push(&JsValue::from(cell.foreground));
        result.push(&JsValue::from(cell.background));
        result.push(&JsValue::from(cell.flags));
        Ok(result)
    }
}

#[wasm_bindgen]
pub struct Engine {
    core: Core,
    renderer: Renderer,
    bytes: u64,
    parse_ms: f64,
    render_ms: f64,
}
#[wasm_bindgen]
impl Engine {
    pub async fn create(
        canvas: web_sys::OffscreenCanvas,
        font: Vec<u8>,
        cols: u16,
        rows: u16,
        font_size: f32,
        line_height: f32,
        history: u32,
    ) -> Result<Engine, JsValue> {
        let core = Core::new(cols, rows, history as usize).map_err(error)?;
        let renderer = Renderer::new(canvas, font, font_size, line_height, cols, rows)
            .await
            .map_err(error)?;
        Self::finish(core, renderer, cols, rows)
    }
    fn finish(mut core: Core, renderer: Renderer, cols: u16, rows: u16) -> Result<Engine, JsValue> {
        let (cell_width, cell_height) = {
            let atlas = renderer.atlas();
            (atlas.cell_width, atlas.cell_height)
        };
        core.resize(cols, rows, cell_width, cell_height)
            .map_err(error)?;
        core.theme(0xe8e5de, 0x17120e, 0xf0d691);
        Ok(Self {
            core,
            renderer,
            bytes: 0,
            parse_ms: 0.,
            render_ms: 0.,
        })
    }
    /// A terminal drawn into a worker's shared surface. Terminals with the
    /// same fonts, size, line height and ligature setting share one atlas.
    #[allow(clippy::too_many_arguments)]
    pub async fn create_shared(
        context: SurfaceContext,
        font: Vec<u8>,
        fallbacks: js_sys::Array,
        cols: u16,
        rows: u16,
        font_size: f32,
        line_height: f32,
        history: u32,
        ligatures: bool,
    ) -> Result<Engine, JsValue> {
        let core = Core::new(cols, rows, history as usize).map_err(error)?;
        let fallbacks: Vec<Vec<u8>> = fallbacks
            .iter()
            .map(|bytes| js_sys::Uint8Array::new(&bytes).to_vec())
            .collect();
        let glyphs = shared_glyphs(
            &context.0,
            font,
            fallbacks,
            font_size,
            line_height,
            ligatures,
        )?;
        let renderer = Renderer::shared(context.0, glyphs, cols, rows)
            .await
            .map_err(error)?;
        Self::finish(core, renderer, cols, rows)
    }
    /// Whether a staged frame referencing the current atlas is ready to draw.
    #[wasm_bindgen(getter)]
    pub fn drawable(&self) -> bool {
        self.renderer.drawable()
    }
    /// Draw this terminal's staged frame into `surface`'s open frame at device
    /// pixel `x`, `y` and `scale`, clipped to the given rectangle. Returns
    /// false if it has nothing drawable (render it first) or is fully clipped.
    #[allow(clippy::too_many_arguments)]
    pub fn draw(
        &self,
        surface: &mut Surface,
        x: f32,
        y: f32,
        scale: f32,
        clip_x: f32,
        clip_y: f32,
        clip_width: f32,
        clip_height: f32,
    ) -> bool {
        let (width, height) = surface.target();
        if !(x.is_finite() && y.is_finite() && scale.is_finite() && scale > 0.) {
            return false;
        }
        let x0 = clip_x.max(0.).floor().min(width as f32) as u32;
        let y0 = clip_y.max(0.).floor().min(height as f32) as u32;
        let x1 = (clip_x + clip_width).ceil().clamp(0., width as f32) as u32;
        let y1 = (clip_y + clip_height).ceil().clamp(0., height as f32) as u32;
        let Some(pass) = surface.pass.as_mut() else {
            return false;
        };
        if x1 <= x0 || y1 <= y0 {
            return false;
        }
        self.renderer.draw_shared(
            pass,
            (width, height),
            (x, y),
            scale,
            (x0, y0, x1 - x0, y1 - y0),
        )
    }
    pub fn write(&mut self, bytes: &[u8]) {
        let started = now();
        self.core.write(bytes);
        self.parse_ms += now() - started;
        self.bytes += bytes.len() as u64;
    }
    pub fn render(&mut self, time: f64, force: bool) -> Result<bool, JsValue> {
        let started = now();
        let result = self
            .renderer
            .render(&mut self.core, time, force)
            .map_err(error);
        self.render_ms += now() - started;
        result
    }
    #[wasm_bindgen(getter)]
    pub fn needs_present(&self) -> bool {
        self.renderer.needs_present() && self.core.frame.held == 0
    }
    pub fn resize(&mut self, cols: u16, rows: u16) -> Result<(), JsValue> {
        self.renderer.validate_size(cols, rows).map_err(error)?;
        let (cell_width, cell_height) = {
            let atlas = self.renderer.atlas();
            (atlas.cell_width, atlas.cell_height)
        };
        self.core
            .resize(cols, rows, cell_width, cell_height)
            .map_err(error)?;
        self.renderer.resize(cols, rows);
        Ok(())
    }
    pub fn add_font(&mut self, bytes: Vec<u8>) -> Result<(), JsValue> {
        if self.renderer.shared_context().is_some() {
            return Err(error(
                "pass fallback fonts when creating a shared-surface terminal".into(),
            ));
        }
        self.renderer.atlas().add_font(bytes).map_err(error)?;
        self.core.state.dirty.fill(true);
        Ok(())
    }
    /// Construct and validate the entire new atlas before changing live state.
    pub fn configure_font(
        &mut self,
        font: Vec<u8>,
        fallbacks: js_sys::Array,
        size: f32,
        line_height: f32,
    ) -> Result<Vec<u32>, JsValue> {
        let cols = self.core.state.cols as u16;
        let rows = self.core.state.rows as u16;
        if let Some(context) = self.renderer.shared_context().cloned() {
            // Join (or start) the shared atlas for the new configuration.
            let ligatures = self.renderer.atlas().ligatures;
            let fallbacks: Vec<Vec<u8>> = fallbacks
                .iter()
                .map(|bytes| js_sys::Uint8Array::new(&bytes).to_vec())
                .collect();
            let glyphs = shared_glyphs(&context, font, fallbacks, size, line_height, ligatures)?;
            let (cell_width, cell_height) = {
                let atlas = glyphs.atlas.borrow();
                (atlas.cell_width, atlas.cell_height)
            };
            self.renderer
                .validate_external(
                    cols,
                    rows,
                    cols as u32 * cell_width,
                    rows as u32 * cell_height,
                )
                .map_err(error)?;
            self.core
                .resize(cols, rows, cell_width, cell_height)
                .map_err(error)?;
            self.renderer.set_glyphs(glyphs, cols, rows);
            return Ok(vec![cell_width, cell_height]);
        }
        let mut atlas = crate::text::Atlas::new(font, size, line_height).map_err(error)?;
        for bytes in fallbacks.iter() {
            atlas
                .add_font(js_sys::Uint8Array::new(&bytes).to_vec())
                .map_err(error)?;
        }
        self.renderer
            .validate_external(
                cols,
                rows,
                cols as u32 * atlas.cell_width,
                rows as u32 * atlas.cell_height,
            )
            .map_err(error)?;
        self.core
            .resize(cols, rows, atlas.cell_width, atlas.cell_height)
            .map_err(error)?;
        let dimensions = vec![atlas.cell_width, atlas.cell_height];
        self.renderer.replace_atlas(atlas);
        self.renderer.resize(cols, rows);
        Ok(dimensions)
    }
    /// Rasterize printable ASCII ahead of first use, `count` glyphs per call,
    /// so idle time after creation absorbs that work. Returns where to
    /// continue, or -1 when done.
    pub fn prefill_glyphs(&mut self, from: u32, count: u32) -> i32 {
        self.renderer
            .atlas()
            .prefill_ascii(from, count)
            .map_or(-1, |next| next as i32)
    }
    /// Shape operator runs together to form programming-font ligatures.
    pub fn set_ligatures(&mut self, enabled: bool) -> Result<(), JsValue> {
        let shared = self.renderer.shared_context().is_some();
        let mut atlas = self.renderer.atlas();
        if atlas.ligatures != enabled {
            if shared {
                return Err(error(
                    "choose ligatures when creating a shared-surface terminal".into(),
                ));
            }
            atlas.ligatures = enabled;
            // Cached runs and packed rows reflect the old setting.
            atlas.reset();
        }
        Ok(())
    }
    /// Decoded Kitty graphics bytes each screen may store; zero disables them.
    pub fn set_image_limit(&mut self, bytes: f64) -> Result<(), JsValue> {
        self.core
            .set_image_limit(bytes.clamp(0., u64::MAX as f64) as u64)
            .map_err(error)
    }
    /// Kitty graphics textures uploaded and their bytes, for diagnostics.
    pub fn image_uploads(&self) -> f64 {
        self.renderer.images.uploads as f64
    }
    pub fn image_upload_bytes(&self) -> f64 {
        self.renderer.images.upload_bytes as f64
    }
    pub fn theme(&mut self, fg: u32, bg: u32, cursor: u32) {
        self.core.theme(fg, bg, cursor);
    }
    pub fn scroll(&mut self, delta: i32) {
        self.core.scroll(delta);
    }
    pub fn mode(&self, mode: u16) -> bool {
        self.core.mode(mode)
    }
    pub fn key(
        &mut self,
        key: u32,
        mods: u32,
        action: u32,
        text: &str,
        unshifted: u32,
    ) -> Result<(), JsValue> {
        self.core
            .key(key, mods, action, text, unshifted)
            .map_err(error)
    }
    pub fn mouse(
        &mut self,
        action: u32,
        button: u32,
        mods: u32,
        x: f32,
        y: f32,
        pressed: u32,
    ) -> Result<(), JsValue> {
        self.core
            .mouse(action, button, mods, x, y, pressed)
            .map_err(error)
    }
    pub fn select(&mut self, x1: i32, y1: i32, x2: i32, y2: i32) -> Result<(), JsValue> {
        self.core.select(x1, y1, x2, y2).map_err(error)
    }
    pub fn select_mode(
        &mut self,
        x1: i32,
        y1: i32,
        x2: i32,
        y2: i32,
        mode: u32,
    ) -> Result<(), JsValue> {
        self.core.select_mode(x1, y1, x2, y2, mode).map_err(error)
    }
    pub fn search(&mut self, needle: &str, action: u32) -> Result<Vec<u32>, JsValue> {
        self.core
            .search(needle, action)
            .map(|v| v.to_vec())
            .map_err(error)
    }
    pub fn text(&mut self, selected: bool) -> Result<String, JsValue> {
        if selected {
            self.core.selection_text().map_err(error)
        } else {
            self.core.update().map_err(error)?;
            Ok(self.core.text(false))
        }
    }
    pub fn link(&self, x: u16, y: u16) -> String {
        self.core.link(x, y)
    }
    pub fn take_events(&mut self) -> js_sys::Array {
        events(&mut self.core)
    }
    pub fn release_hold(&mut self) {
        self.core.release_hold();
    }
    pub fn metrics(&self) -> Vec<f64> {
        let atlas = self.renderer.atlas();
        vec![
            self.renderer.frames as f64,
            self.bytes as f64,
            self.parse_ms,
            self.render_ms,
            self.renderer.upload_bytes as f64,
            atlas.count() as f64,
            atlas.hits as f64,
            atlas.misses as f64,
            atlas.resets as f64,
            self.core.reused_rows() as f64,
        ]
    }
    #[wasm_bindgen(getter)]
    pub fn cell_upload_bytes(&self) -> u64 {
        self.renderer.cell_upload_bytes
    }
    #[wasm_bindgen(getter)]
    pub fn row_map_upload_bytes(&self) -> u64 {
        self.renderer.row_map_upload_bytes
    }
    #[wasm_bindgen(getter)]
    pub fn cell_width(&self) -> u32 {
        self.renderer.atlas().cell_width
    }
    #[wasm_bindgen(getter)]
    pub fn cell_height(&self) -> u32 {
        self.renderer.atlas().cell_height
    }
    #[wasm_bindgen(getter)]
    pub fn adapter(&self) -> String {
        self.renderer.adapter.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn cursor_x(&self) -> u32 {
        self.core.frame.cursor_x
    }
    #[wasm_bindgen(getter)]
    pub fn cursor_y(&self) -> u32 {
        self.core.frame.cursor_y
    }
    pub async fn fence(&self) -> Result<(), JsValue> {
        self.renderer.fence().await.map_err(error)
    }
    /// Calls `done` when the GPU has finished all work submitted so far.
    /// Unlike `fence`, this returns at once and holds no borrow while waiting.
    pub fn on_submitted_work_done(&self, done: js_sys::Function) {
        self.renderer.on_submitted_work_done(done);
    }
}

/// A handle on a shared surface's pipelines and atlases, passed by value to
/// `Engine.create_shared` (take a fresh one from `Surface.context()` each time).
#[wasm_bindgen]
pub struct SurfaceContext(Rc<SharedContext>);
#[wasm_bindgen]
impl Surface {
    pub fn context(&self) -> SurfaceContext {
        SurfaceContext(self.context.clone())
    }
}
fn shared_glyphs(
    context: &SharedContext,
    font: Vec<u8>,
    fallbacks: Vec<Vec<u8>>,
    size: f32,
    line_height: f32,
    ligatures: bool,
) -> Result<Rc<crate::gpu::Glyphs>, JsValue> {
    let key = atlas_key(&font, &fallbacks, size, line_height, ligatures);
    context
        .glyphs(key, move || {
            let mut atlas = Atlas::new(font, size, line_height)?;
            for bytes in fallbacks {
                atlas.add_font(bytes)?;
            }
            atlas.ligatures = ligatures;
            atlas.reset();
            Ok(atlas)
        })
        .map_err(error)
}

/// Stateless Rust/WebGPU compositor for the xterm-compatible semantic core.
#[wasm_bindgen]
pub struct Compositor {
    renderer: Renderer,
    staging: Staging,
}
#[wasm_bindgen]
impl Compositor {
    pub fn set_transparency(&mut self, enabled: bool) {
        self.renderer.set_transparency(enabled);
    }
    pub async fn create(canvas: web_sys::OffscreenCanvas) -> Result<Compositor, JsValue> {
        Ok(Self {
            renderer: Renderer::external(canvas).await.map_err(error)?,
            staging: Staging::new(),
        })
    }
    pub fn configure(
        &mut self,
        cols: u16,
        rows: u16,
        width: u32,
        height: u32,
    ) -> Result<(), JsValue> {
        self.renderer
            .validate_external(cols, rows, width, height)
            .map_err(error)?;
        self.staging
            .resize_grid(cols as usize * rows as usize, rows as usize)
            .map_err(error)?;
        self.renderer
            .configure_external(cols, rows, width, height)
            .map_err(error)
    }
    pub fn upload(
        &mut self,
        x: u32,
        y: u32,
        width: u32,
        height: u32,
        pixels: &[u8],
    ) -> Result<(), JsValue> {
        self.renderer
            .upload_external(x, y, width, height, pixels)
            .map_err(error)
    }
    pub fn render(
        &mut self,
        packed: &[u32],
        start: u32,
        dimensions: &[f32],
        frame: &[u32],
    ) -> Result<bool, JsValue> {
        self.renderer
            .render_external(packed, start, dimensions, frame)
            .map_err(error)
    }
    /// Cell words followed by four f32 dimensions and eight u32 frame words.
    /// Views are valid until configure/free; refresh them after memory growth.
    /// Fill them only between synchronous calls, with rendering paused at fences.
    #[wasm_bindgen(getter)]
    pub fn staging_ptr(&self) -> u32 {
        self.staging.pointer() as u32
    }
    #[wasm_bindgen(getter)]
    pub fn staging_words(&self) -> u32 {
        self.staging.cell_words() as u32
    }
    /// Upload staged cells `start..start + cells` (indices into the grid, at
    /// the same offsets in staging) and present with the staged uniforms.
    pub fn render_staged(&mut self, cells: u32, start: u32) -> Result<bool, JsValue> {
        let staged = self
            .staging
            .read(start as usize, cells as usize)
            .map_err(error)?;
        self.renderer
            .render_external(staged.cells, start, staged.dimensions, staged.frame)
            .map_err(error)
    }
    /// Retain previous GPU row slots using the staged source map, uploading
    /// only new logical rows. Cells and uniforms keep the legacy arena layout.
    pub fn render_retained(&mut self) -> Result<bool, JsValue> {
        let staged = self
            .staging
            .read(0, self.staging.cell_words() / 5)
            .map_err(error)?;
        self.renderer
            .render_retained(
                staged.cells,
                self.staging.sources(),
                staged.dimensions,
                staged.frame,
            )
            .map_err(error)
    }
    #[wasm_bindgen(getter)]
    pub fn cell_upload_bytes(&self) -> u64 {
        self.renderer.cell_upload_bytes
    }
    #[wasm_bindgen(getter)]
    pub fn row_map_upload_bytes(&self) -> u64 {
        self.renderer.row_map_upload_bytes
    }
    #[wasm_bindgen(getter)]
    pub fn row_slots(&self) -> Vec<u32> {
        self.renderer.row_slots().to_vec()
    }
    /// Wait for submitted GPU work. Call only while the renderer is paused;
    /// the Wasm borrow remains live until the asynchronous fence completes.
    pub async fn fence(&self) -> Result<(), JsValue> {
        self.renderer.fence().await.map_err(error)
    }
    #[wasm_bindgen(getter)]
    pub fn frames(&self) -> u64 {
        self.renderer.frames
    }
}
