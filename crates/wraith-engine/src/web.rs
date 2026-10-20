use crate::{core::Core, gpu::Renderer, staging::Staging};
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
        let mut core = Core::new(cols, rows, history as usize).map_err(error)?;
        let renderer = Renderer::new(canvas, font, font_size, line_height, cols, rows)
            .await
            .map_err(error)?;
        core.resize(
            cols,
            rows,
            renderer.atlas.cell_width,
            renderer.atlas.cell_height,
        )
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
        self.core
            .resize(
                cols,
                rows,
                self.renderer.atlas.cell_width,
                self.renderer.atlas.cell_height,
            )
            .map_err(error)?;
        self.renderer.resize(cols, rows);
        Ok(())
    }
    pub fn add_font(&mut self, bytes: Vec<u8>) -> Result<(), JsValue> {
        self.renderer.atlas.add_font(bytes).map_err(error)?;
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
        let mut atlas = crate::text::Atlas::new(font, size, line_height).map_err(error)?;
        for bytes in fallbacks.iter() {
            atlas
                .add_font(js_sys::Uint8Array::new(&bytes).to_vec())
                .map_err(error)?;
        }
        let cols = self.core.state.cols as u16;
        let rows = self.core.state.rows as u16;
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
        self.renderer.atlas = atlas;
        self.renderer.resize(cols, rows);
        Ok(dimensions)
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
        vec![
            self.renderer.frames as f64,
            self.bytes as f64,
            self.parse_ms,
            self.render_ms,
            self.renderer.upload_bytes as f64,
            self.renderer.atlas.count() as f64,
            self.renderer.atlas.hits as f64,
            self.renderer.atlas.misses as f64,
            self.renderer.atlas.resets as f64,
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
        self.renderer.atlas.cell_width
    }
    #[wasm_bindgen(getter)]
    pub fn cell_height(&self) -> u32 {
        self.renderer.atlas.cell_height
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
}

/// Stateless Rust/WebGPU compositor for the xterm-compatible semantic core.
#[wasm_bindgen]
pub struct Compositor {
    renderer: Renderer,
    staging: Staging,
}
#[wasm_bindgen]
impl Compositor {
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
