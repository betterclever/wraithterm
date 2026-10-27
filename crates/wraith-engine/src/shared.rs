//! One WebGPU surface for many terminals. A pooled worker owns one surface
//! covering the page; each of its terminals draws its staged frame into that
//! surface at its host's rectangle. A retained backing texture keeps terminals
//! that did not change, so a frame redraws only those with new content unless
//! the geometry changed. Terminals with the same fonts share one glyph atlas.
use crate::gpu::{scaled_sampler, shared_gpu, terminal_pipeline, Glyphs, SharedGpu};
use crate::images::ImageLayer;
use crate::text::Atlas;
use std::{
    cell::RefCell,
    rc::{Rc, Weak},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};
use wasm_bindgen::prelude::*;

/// What every terminal on a shared surface reuses: the device, compiled
/// pipelines, samplers and glyph atlases keyed by font configuration.
pub struct SharedContext {
    pub gpu: SharedGpu,
    pub format: wgpu::TextureFormat,
    pub pipeline: wgpu::RenderPipeline,
    pub sampler: wgpu::Sampler,
    pub scaled: wgpu::Sampler,
    pub image_pipeline: wgpu::RenderPipeline,
    pub image_sampler: wgpu::Sampler,
    atlases: RefCell<Vec<(u64, Weak<Glyphs>)>>,
}
/// FNV-1a over 8-byte words: font bytes are hashed once per terminal mount.
fn hash(state: &mut u64, bytes: &[u8]) {
    for chunk in bytes.chunks(8) {
        let mut word = [0; 8];
        word[..chunk.len()].copy_from_slice(chunk);
        *state = (*state ^ u64::from_le_bytes(word)).wrapping_mul(0x100_0000_01b3);
    }
    *state = (*state ^ bytes.len() as u64).wrapping_mul(0x100_0000_01b3);
}
/// Identifies a glyph atlas: font bytes, fallbacks, size, line height and
/// ligature shaping all change rasterized tiles.
pub fn atlas_key(
    font: &[u8],
    fallbacks: &[Vec<u8>],
    size: f32,
    line_height: f32,
    ligatures: bool,
) -> u64 {
    let mut state = 0xcbf2_9ce4_8422_2325;
    hash(&mut state, font);
    for bytes in fallbacks {
        hash(&mut state, bytes);
    }
    hash(&mut state, &size.to_bits().to_le_bytes());
    hash(&mut state, &line_height.to_bits().to_le_bytes());
    hash(&mut state, &[ligatures as u8]);
    state
}
impl SharedContext {
    /// The atlas for `key`, built by `create` if no live terminal holds one.
    pub fn glyphs(
        &self,
        key: u64,
        create: impl FnOnce() -> Result<Atlas, String>,
    ) -> Result<Rc<Glyphs>, String> {
        let mut atlases = self.atlases.borrow_mut();
        atlases.retain(|(_, weak)| weak.strong_count() > 0);
        if let Some(glyphs) = atlases
            .iter()
            .find(|(k, _)| *k == key)
            .and_then(|(_, weak)| weak.upgrade())
        {
            return Ok(glyphs);
        }
        let glyphs = Glyphs::new(&self.gpu.device, create()?);
        atlases.push((key, Rc::downgrade(&glyphs)));
        Ok(glyphs)
    }
    pub fn atlas_count(&self) -> usize {
        self.atlases
            .borrow()
            .iter()
            .filter(|(_, weak)| weak.strong_count() > 0)
            .count()
    }
}

/// A worker's shared terminal surface: one canvas, swap chain and backing.
#[wasm_bindgen]
pub struct Surface {
    pub(crate) context: Rc<SharedContext>,
    surface: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
    canvas: web_sys::OffscreenCanvas,
    backing: wgpu::Texture,
    backing_view: wgpu::TextureView,
    encoder: Option<wgpu::CommandEncoder>,
    pub(crate) pass: Option<wgpu::RenderPass<'static>>,
    /// The backing holds content the canvas has not shown yet.
    unpresented: bool,
    frames: u64,
    completed_frames: Arc<AtomicU64>,
    completed_updates: Arc<AtomicU64>,
}
fn error(e: String) -> JsValue {
    js_sys::Error::new(&e).into()
}
impl Surface {
    fn backing(
        device: &wgpu::Device,
        format: wgpu::TextureFormat,
        width: u32,
        height: u32,
    ) -> (wgpu::Texture, wgpu::TextureView) {
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Wraith shared surface backing"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let view = texture.create_view(&Default::default());
        (texture, view)
    }
    pub(crate) fn target(&self) -> (u32, u32) {
        (self.config.width, self.config.height)
    }
}
#[wasm_bindgen]
impl Surface {
    /// Create the worker's surface on its shared device. `width` and `height`
    /// are device pixels.
    pub async fn create(
        canvas: web_sys::OffscreenCanvas,
        width: u32,
        height: u32,
    ) -> Result<Surface, JsValue> {
        let gpu = shared_gpu(&canvas).await.map_err(error)?;
        let surface = gpu
            .instance
            .create_surface(wgpu::SurfaceTarget::OffscreenCanvas(canvas.clone()))
            .map_err(|e| error(e.to_string()))?;
        let limit = gpu.device.limits().max_texture_dimension_2d;
        let (width, height) = (width.clamp(1, limit), height.clamp(1, limit));
        canvas.set_width(width);
        canvas.set_height(height);
        let mut config = surface
            .get_default_config(&gpu.adapter, width, height)
            .ok_or_else(|| error("unsupported WebGPU surface".into()))?;
        // Regions no terminal covers stay transparent over the page.
        config.alpha_mode = wgpu::CompositeAlphaMode::PreMultiplied;
        config.usage = wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_DST;
        let error_scope = gpu.device.push_error_scope(wgpu::ErrorFilter::Validation);
        surface.configure(&gpu.device, &config);
        let pipeline = terminal_pipeline(&gpu.device, config.format, true);
        let (image_pipeline, image_sampler) =
            ImageLayer::pipeline(&gpu.device, config.format, true);
        let sampler = gpu.device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("Wraith pixel-aligned atlas sampler"),
            mag_filter: wgpu::FilterMode::Nearest,
            min_filter: wgpu::FilterMode::Nearest,
            ..Default::default()
        });
        let scaled = scaled_sampler(&gpu.device);
        let (backing, backing_view) = Self::backing(&gpu.device, config.format, width, height);
        if let Some(e) = error_scope.pop().await {
            return Err(error(format!("WebGPU shared surface initialization: {e}")));
        }
        Ok(Surface {
            context: Rc::new(SharedContext {
                format: config.format,
                pipeline,
                sampler,
                scaled,
                image_pipeline,
                image_sampler,
                atlases: RefCell::new(Vec::new()),
                gpu,
            }),
            surface,
            config,
            canvas,
            backing,
            backing_view,
            encoder: None,
            pass: None,
            unpresented: false,
            frames: 0,
            completed_frames: Arc::new(AtomicU64::new(0)),
            completed_updates: Arc::new(AtomicU64::new(0)),
        })
    }
    /// Resize to the page's device-pixel size. The backing starts empty, so
    /// the next frame must redraw every visible terminal.
    pub fn resize(&mut self, width: u32, height: u32) {
        let limit = self.context.gpu.device.limits().max_texture_dimension_2d;
        let (width, height) = (width.clamp(1, limit), height.clamp(1, limit));
        if (width, height) == (self.config.width, self.config.height) {
            return;
        }
        self.pass = None;
        self.encoder = None;
        self.config.width = width;
        self.config.height = height;
        self.canvas.set_width(width);
        self.canvas.set_height(height);
        self.surface
            .configure(&self.context.gpu.device, &self.config);
        (self.backing, self.backing_view) =
            Self::backing(&self.context.gpu.device, self.config.format, width, height);
    }
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 {
        self.config.width
    }
    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 {
        self.config.height
    }
    /// Start a frame into the backing. `clear` empties it first (geometry
    /// changed); otherwise unchanged terminals keep their pixels.
    pub fn begin(&mut self, clear: bool) -> Result<(), JsValue> {
        if let Some(e) = &*self.context.gpu.lost.lock().unwrap() {
            return Err(error(e.clone()));
        }
        self.pass = None;
        let mut encoder =
            self.context
                .gpu
                .device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("Wraith shared frame"),
                });
        let pass = encoder
            .begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Wraith shared terminals"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &self.backing_view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: if clear {
                            wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT)
                        } else {
                            wgpu::LoadOp::Load
                        },
                        store: wgpu::StoreOp::Store,
                    },
                })],
                ..Default::default()
            })
            .forget_lifetime();
        self.encoder = Some(encoder);
        self.pass = Some(pass);
        self.unpresented = true;
        Ok(())
    }
    /// Finish the frame: copy the backing to the canvas and present. `updates`
    /// counts terminals drawn with new content, for GPU-completion counters.
    /// Returns false when the canvas texture was unavailable; the backing is
    /// kept and the next frame presents it.
    pub fn end(&mut self, updates: u32) -> Result<bool, JsValue> {
        self.pass = None;
        let Some(mut encoder) = self.encoder.take() else {
            return Ok(false);
        };
        let texture = match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(t)
            | wgpu::CurrentSurfaceTexture::Suboptimal(t) => Some(t),
            wgpu::CurrentSurfaceTexture::Timeout | wgpu::CurrentSurfaceTexture::Occluded => None,
            wgpu::CurrentSurfaceTexture::Outdated => {
                self.surface
                    .configure(&self.context.gpu.device, &self.config);
                None
            }
            status => return Err(error(format!("WebGPU surface failure: {status:?}"))),
        };
        if let Some(texture) = &texture {
            encoder.copy_texture_to_texture(
                self.backing.as_image_copy(),
                texture.texture.as_image_copy(),
                wgpu::Extent3d {
                    width: self.config.width,
                    height: self.config.height,
                    depth_or_array_layers: 1,
                },
            );
        }
        let queue = &self.context.gpu.queue;
        queue.submit([encoder.finish()]);
        let (frames, total) = (
            self.completed_frames.clone(),
            self.completed_updates.clone(),
        );
        let presented = texture.is_some();
        queue.on_submitted_work_done(move || {
            if presented {
                frames.fetch_add(1, Ordering::Relaxed);
            }
            total.fetch_add(updates as u64, Ordering::Relaxed);
        });
        let Some(texture) = texture else {
            return Ok(false);
        };
        queue.present(texture);
        self.frames += 1;
        self.unpresented = false;
        Ok(true)
    }
    /// The backing has content the canvas has not presented.
    #[wasm_bindgen(getter)]
    pub fn unpresented(&self) -> bool {
        self.unpresented
    }
    /// Frames submitted and presented to the canvas.
    #[wasm_bindgen(getter)]
    pub fn frames(&self) -> f64 {
        self.frames as f64
    }
    /// Presented frames whose GPU work has completed.
    #[wasm_bindgen(getter)]
    pub fn completed_frames(&self) -> f64 {
        self.completed_frames.load(Ordering::Relaxed) as f64
    }
    /// Terminal updates (new content drawn) whose GPU work has completed.
    #[wasm_bindgen(getter)]
    pub fn completed_updates(&self) -> f64 {
        self.completed_updates.load(Ordering::Relaxed) as f64
    }
    /// Distinct live glyph atlases on this surface.
    #[wasm_bindgen(getter)]
    pub fn atlases(&self) -> u32 {
        self.context.atlas_count() as u32
    }
}
