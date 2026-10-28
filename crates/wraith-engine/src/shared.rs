//! One WebGPU surface for many terminals. A pooled worker owns one surface
//! covering the page; each of its terminals draws its staged frame into that
//! surface at its host's rectangle. A retained backing texture keeps terminals
//! that did not change, so a frame redraws only those with new content unless
//! the geometry changed. Terminals with the same fonts share one glyph atlas.
use crate::effect_state::Settings;
use crate::effects::{self, Effects};
use crate::gpu::{scaled_sampler, shared_gpu, terminal_pipeline, Glyphs, SharedGpu};
use crate::images::ImageLayer;
use crate::text::Atlas;
use std::{
    cell::{Cell, RefCell},
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
    /// Every terminal's frame uniforms in one buffer, written once per frame.
    pub uniforms: UniformRing,
}

/// Terminal uniforms for a whole shared surface. Each terminal owns a fixed
/// 256-byte slot (the uniform offset alignment) its bind group points at;
/// draws stage their uniforms here and `flush` writes the touched range with
/// one `write_buffer` per frame instead of one per terminal. Terminals beyond
/// `SLOTS` keep their own uniform buffer.
pub struct UniformRing {
    pub buffer: wgpu::Buffer,
    free: RefCell<Vec<u32>>,
    next: Cell<u32>,
    mirror: RefCell<Vec<u8>>,
    /// Touched slots this frame: first and one past the last.
    dirty: Cell<(u32, u32)>,
}
impl UniformRing {
    pub const SLOT: u64 = 256;
    pub const SLOTS: u32 = 4096;
    fn new(device: &wgpu::Device) -> Self {
        Self {
            buffer: device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("Wraith shared terminal uniforms"),
                size: Self::SLOT * Self::SLOTS as u64,
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            }),
            free: RefCell::new(Vec::new()),
            next: Cell::new(0),
            mirror: RefCell::new(vec![0; (Self::SLOT * Self::SLOTS as u64) as usize]),
            dirty: Cell::new((u32::MAX, 0)),
        }
    }
    pub fn alloc(&self) -> Option<u32> {
        if let Some(slot) = self.free.borrow_mut().pop() {
            return Some(slot);
        }
        let slot = self.next.get();
        (slot < Self::SLOTS).then(|| {
            self.next.set(slot + 1);
            slot
        })
    }
    pub fn release(&self, slot: u32) {
        self.free.borrow_mut().push(slot);
    }
    /// Stage a slot's uniforms for this frame's `flush`.
    pub fn stage(&self, slot: u32, bytes: &[u8]) {
        let start = (slot as u64 * Self::SLOT) as usize;
        self.mirror.borrow_mut()[start..start + bytes.len()].copy_from_slice(bytes);
        let (first, end) = self.dirty.get();
        self.dirty.set((first.min(slot), end.max(slot + 1)));
    }
    /// Write every slot staged since the last flush, in one copy.
    pub fn flush(&self, queue: &wgpu::Queue) {
        let (first, end) = self.dirty.replace((u32::MAX, 0));
        if first >= end {
            return;
        }
        let (start, stop) = (
            (first as u64 * Self::SLOT) as usize,
            (end as u64 * Self::SLOT) as usize,
        );
        queue.write_buffer(
            &self.buffer,
            start as u64,
            &self.mirror.borrow()[start..stop],
        );
    }
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
    /// The terminal pipeline is set on the open pass (draws skip resetting it).
    pub(crate) pipeline_bound: bool,
    /// The backing holds content the canvas has not shown yet.
    unpresented: bool,
    frames: u64,
    completed_frames: Arc<AtomicU64>,
    completed_updates: Arc<AtomicU64>,
    /// Post-process effects over the whole surface. None (the default) keeps
    /// the direct path: the backing is copied to the canvas, nothing else.
    effects: Option<Box<Effects>>,
}
fn error(e: String) -> JsValue {
    js_sys::Error::new(&e).into()
}
impl Surface {
    /// The retained backing. With effects it is also sampled as their scene.
    fn backing(
        device: &wgpu::Device,
        format: wgpu::TextureFormat,
        width: u32,
        height: u32,
        sampled: bool,
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
            usage: if sampled {
                wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING
            } else {
                wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC
            },
            view_formats: &[],
        });
        let view = texture.create_view(&Default::default());
        (texture, view)
    }
    pub(crate) fn target(&self) -> (u32, u32) {
        (self.config.width, self.config.height)
    }
    /// Recreate the backing (empty) for the current size and effect state.
    fn rebuild_backing(&mut self) {
        let device = &self.context.gpu.device;
        let (width, height) = (self.config.width, self.config.height);
        (self.backing, self.backing_view) = Self::backing(
            device,
            self.config.format,
            width,
            height,
            self.effects.is_some(),
        );
        if let Some(fx) = &mut self.effects {
            fx.external_scene(device, &self.backing_view, width, height);
        }
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
        let (backing, backing_view) =
            Self::backing(&gpu.device, config.format, width, height, false);
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
                uniforms: UniformRing::new(&gpu.device),
                gpu,
            }),
            surface,
            config,
            canvas,
            backing,
            backing_view,
            encoder: None,
            pass: None,
            pipeline_bound: false,
            unpresented: false,
            frames: 0,
            completed_frames: Arc::new(AtomicU64::new(0)),
            completed_updates: Arc::new(AtomicU64::new(0)),
            effects: None,
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
        self.rebuild_backing();
    }
    /// Replace post-process effects over the whole surface (parameters as in
    /// `Engine::set_effects`; the cursor trail does not apply). Pipelines are
    /// validated first, so an invalid shader rejects and keeps the current
    /// effects. Turning effects on or off empties the backing: redraw every
    /// visible terminal next frame. Call only between frames.
    pub async fn set_effects(
        &mut self,
        params: Vec<f32>,
        shader: Option<String>,
    ) -> Result<(), JsValue> {
        let mut settings = Settings::parse(&params).map_err(error)?;
        settings.trail = None;
        if !settings.composite() && shader.is_none() {
            if self.effects.take().is_some() {
                self.pass = None;
                self.encoder = None;
                self.rebuild_backing();
            }
            return Ok(());
        }
        let context = self.context.clone();
        let mut next = Effects::new(
            &context.gpu.device,
            context.format,
            settings,
            shader.as_deref(),
        )
        .await
        .map_err(error)?;
        next.for_shared_surface();
        if let Some(previous) = &self.effects {
            next.inherit(previous);
        }
        let was_on = self.effects.is_some();
        self.effects = Some(Box::new(next));
        self.pass = None;
        self.encoder = None;
        if was_on {
            let (width, height) = (self.config.width, self.config.height);
            let device = &self.context.gpu.device;
            if let Some(fx) = &mut self.effects {
                fx.external_scene(device, &self.backing_view, width, height);
            }
        } else {
            self.rebuild_backing();
        }
        Ok(())
    }
    /// Shadertoy `iMouse` in physical pixels of the surface.
    pub fn set_effect_mouse(&mut self, x: f32, y: f32, z: f32, w: f32) {
        if let Some(fx) = &mut self.effects {
            fx.set_mouse([x, y, z, w]);
        }
    }
    /// An effect animation wants a frame even though no terminal changed.
    #[wasm_bindgen(getter)]
    pub fn effects_due(&self) -> bool {
        self.effects
            .as_ref()
            .is_some_and(|fx| fx.wants_post(effects::now()))
    }
    /// Post-process passes in the last frame; zero with effects off.
    #[wasm_bindgen(getter)]
    pub fn effect_passes(&self) -> u32 {
        self.effects.as_ref().map_or(0, |fx| fx.passes)
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
        self.pipeline_bound = false;
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
        if let (Some(texture), Some(fx)) = (&texture, &mut self.effects) {
            // Effects read the backing as their scene and write the canvas.
            let view = texture.texture.create_view(&Default::default());
            fx.post(&self.context.gpu.queue, &mut encoder, &view, effects::now());
        } else if let Some(texture) = &texture {
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
        // The frame's terminal uniforms, written before its commands run.
        self.context.uniforms.flush(queue);
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
