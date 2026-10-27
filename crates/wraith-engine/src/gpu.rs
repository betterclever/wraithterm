use crate::shared::SharedContext;
use crate::{
    core::Core,
    effect_state::Settings,
    effects::{self, Effects},
    images::ImageLayer,
    retained::{RetainedRows, NEW_ROW},
    text::{Atlas, ATLAS_SIZE},
};
use bytemuck::{Pod, Zeroable};
use std::{
    cell::{RefCell, RefMut},
    rc::Rc,
    sync::{Arc, Mutex},
};

#[repr(C)]
#[derive(Clone, Copy, Default, Pod, Zeroable)]
struct GpuCell {
    foreground: u32,
    background: u32,
    underline: u32,
    flags: u32,
    glyph: u32,
}
/// Bytes and u32 words per packed GPU cell; terminal.wgsl's `Cell` matches.
pub const CELL_BYTES: usize = std::mem::size_of::<GpuCell>();
pub const CELL_WORDS: usize = CELL_BYTES / 4;
const _: () = assert!(CELL_BYTES == 20);
#[repr(C)]
#[derive(Clone, Copy, Default, Pod, Zeroable)]
pub(crate) struct Uniforms {
    view: [f32; 4],
    grid: [u32; 4],
    theme: [u32; 4],
    text: [f32; 4],
    /// Images below backgrounds, default background, and on a shared surface
    /// the target's width and height (zero for a terminal's own canvas).
    images: [u32; 4],
    /// Shared surfaces: origin in target pixels, scale, linear sampling.
    place: [f32; 4],
}
/// A glyph atlas and its texture. A terminal's own canvas has its own; on a
/// shared surface, terminals with the same fonts and geometry share one.
pub struct Glyphs {
    pub atlas: RefCell<Atlas>,
    texture: wgpu::Texture,
    view: wgpu::TextureView,
}
impl Glyphs {
    pub fn new(device: &wgpu::Device, atlas: Atlas) -> Rc<Self> {
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Wraith RGBA glyph atlas"),
            size: wgpu::Extent3d {
                width: ATLAS_SIZE,
                height: ATLAS_SIZE,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let view = texture.create_view(&Default::default());
        Rc::new(Self {
            atlas: RefCell::new(atlas),
            texture,
            view,
        })
    }
}
/// Blending for a target. A shared surface is composited premultiplied over
/// the page, so terminal pixels keep the largest alpha written (the opaque
/// background fill) instead of a blended 254 at glyph edges.
pub fn blend(shared: bool) -> wgpu::BlendState {
    let mut state = wgpu::BlendState::ALPHA_BLENDING;
    if shared {
        state.alpha = wgpu::BlendComponent {
            src_factor: wgpu::BlendFactor::One,
            dst_factor: wgpu::BlendFactor::One,
            operation: wgpu::BlendOperation::Max,
        };
    }
    state
}
/// The terminal WGSL pipeline for one target format.
pub fn terminal_pipeline(
    device: &wgpu::Device,
    format: wgpu::TextureFormat,
    shared: bool,
) -> wgpu::RenderPipeline {
    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("Wraith terminal WGSL"),
        source: wgpu::ShaderSource::Wgsl(include_str!("terminal.wgsl").into()),
    });
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("Wraith two-draw terminal pipeline"),
        layout: None,
        vertex: wgpu::VertexState {
            module: &shader,
            entry_point: Some("vs"),
            compilation_options: Default::default(),
            buffers: &[],
        },
        fragment: Some(wgpu::FragmentState {
            module: &shader,
            entry_point: Some("fs"),
            compilation_options: Default::default(),
            targets: &[Some(wgpu::ColorTargetState {
                format,
                blend: Some(blend(shared)),
                write_mask: wgpu::ColorWrites::ALL,
            })],
        }),
        primitive: Default::default(),
        depth_stencil: None,
        multisample: Default::default(),
        multiview_mask: None,
        cache: None,
    })
}
pub fn scaled_sampler(device: &wgpu::Device) -> wgpu::Sampler {
    device.create_sampler(&wgpu::SamplerDescriptor {
        label: Some("Wraith scaled atlas sampler"),
        mag_filter: wgpu::FilterMode::Linear,
        min_filter: wgpu::FilterMode::Linear,
        ..Default::default()
    })
}
/// Where a renderer's frames go: its own canvas, or a worker's shared surface.
pub enum Target {
    Own(web_sys::OffscreenCanvas),
    Shared(Rc<SharedContext>),
}
pub struct Renderer {
    device: wgpu::Device,
    queue: wgpu::Queue,
    /// A terminal's own canvas and surface; `None` on a shared surface.
    surface: Option<wgpu::Surface<'static>>,
    config: wgpu::SurfaceConfiguration,
    canvas: Option<web_sys::OffscreenCanvas>,
    /// The shared surface's pipelines and glyph registry.
    shared: Option<Rc<SharedContext>>,
    /// Shared surfaces: the uniforms of the last staged frame, placed when drawn.
    staged: Option<Uniforms>,
    pipeline: wgpu::RenderPipeline,
    bind: wgpu::BindGroup,
    cell_buffer: wgpu::Buffer,
    row_buffer: wgpu::Buffer,
    retained: RetainedRows,
    row_sources: Vec<u32>,
    uniform: wgpu::Buffer,
    sampler: wgpu::Sampler,
    scaled: wgpu::Sampler,
    /// Packed native cells. The external compositor packs into its own
    /// staging, so this stays empty there and `cell_count` sizes the draw.
    cells: Vec<GpuCell>,
    cell_count: usize,
    /// The core row version each packed native row holds (zero: none), so
    /// unchanged rows are skipped and moved rows are copied, not repacked.
    packed_versions: Vec<u64>,
    /// Pack pass that last wrote each row; copy sources must predate it.
    pack_stamps: Vec<u32>,
    pack_stamp: u32,
    /// Atlas resets already reflected in packed rows; any other reset (a
    /// font change, say) invalidates every packed glyph reference.
    atlas_resets: u64,
    /// Glyph words for the row being packed.
    glyphs: Vec<u32>,
    /// Cursor cell the packed ligature rows were split for, as (x, y).
    ligature_cursor: Option<(u32, u32)>,
    text: Rc<Glyphs>,
    pub images: ImageLayer,
    pub frames: u64,
    pub upload_bytes: u64,
    pub cell_upload_bytes: u64,
    pub row_map_upload_bytes: u64,
    pub adapter: String,
    pub lost: Arc<Mutex<Option<String>>>,
    last_blink: bool,
    pending_present: bool,
    /// Opt-in post-processing. `None` (the default) adds no passes, textures
    /// or pipelines: the terminal pass draws straight to the surface.
    effects: Option<Box<Effects>>,
    /// The last terminal uniforms, kept only while effects are on so an
    /// animation can redraw the retained scene without new cell data.
    effect_uniforms: Option<Uniforms>,
}
#[derive(Clone)]
pub struct SharedGpu {
    pub instance: wgpu::Instance,
    pub adapter: wgpu::Adapter,
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    /// The device's first uncaptured error or loss, seen by every renderer on it.
    pub lost: Arc<Mutex<Option<String>>>,
}
thread_local! {
    static GPU: std::cell::RefCell<Option<SharedGpu>> = const { std::cell::RefCell::new(None) };
}
/// The worker's shared GPU, created on first use. A lost device is replaced
/// for later terminals; terminals already on it keep reporting the loss.
pub async fn shared_gpu(canvas: &web_sys::OffscreenCanvas) -> Result<SharedGpu, String> {
    if let Some(gpu) = GPU.with(|g| g.borrow().clone()) {
        if gpu.lost.lock().unwrap().is_none() {
            return Ok(gpu);
        }
    }
    let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
    descriptor.backends = wgpu::Backends::BROWSER_WEBGPU;
    let instance = wgpu::Instance::new(descriptor);
    let probe = instance
        .create_surface(wgpu::SurfaceTarget::OffscreenCanvas(canvas.clone()))
        .map_err(|e| e.to_string())?;
    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            compatible_surface: Some(&probe),
            force_fallback_adapter: false,
            ..Default::default()
        })
        .await
        .map_err(|e| format!("WebGPU adapter unavailable: {e}"))?;
    drop(probe);
    let (device, queue) = adapter
        .request_device(&wgpu::DeviceDescriptor {
            label: Some("Wraith WebGPU device"),
            ..Default::default()
        })
        .await
        .map_err(|e| e.to_string())?;
    let lost = Arc::new(Mutex::new(None));
    let errors = lost.clone();
    device.on_uncaptured_error(Arc::new(move |error| {
        let mut first = errors.lock().unwrap();
        if first.is_none() {
            *first = Some(format!("WebGPU validation: {error}"));
        }
    }));
    let lost_clone = lost.clone();
    device.set_device_lost_callback(move |reason, message| {
        *lost_clone.lock().unwrap() = Some(format!("WebGPU device lost ({reason:?}): {message}"));
    });
    let gpu = SharedGpu {
        instance,
        adapter,
        device,
        queue,
        lost,
    };
    GPU.with(|g| *g.borrow_mut() = Some(gpu.clone()));
    Ok(gpu)
}
impl Renderer {
    pub fn row_slots(&self) -> &[u32] {
        &self.retained.slots
    }
    pub fn needs_present(&self) -> bool {
        self.pending_present || self.effects_due()
    }
    /// An effect animation needs another frame even though no cells changed.
    pub fn effects_due(&self) -> bool {
        self.effects.as_ref().is_some_and(|fx| {
            let now = effects::now();
            fx.wants_post(now) || fx.scene_stale(now, self.config.width, self.config.height)
        })
    }
    /// Replace the post-process stage. Pipelines are built and validated
    /// before anything changes; a shader error leaves the current effects.
    pub async fn set_effects(
        &mut self,
        params: &[f32],
        shader: Option<String>,
    ) -> Result<(), String> {
        let settings = Settings::parse(params)?;
        let off = !settings.composite() && shader.is_none();
        // Post-processing runs over a terminal's own surface. A shared surface
        // draws every terminal in one pass, with no per-terminal image to
        // process.
        if self.surface.is_none() && !off {
            return Err("effects need the terminal's own canvas; on a shared-surface pool use pool.setEffects()".into());
        }
        if off {
            // Off: drop every effect resource and return to the direct path.
            self.effects = None;
            self.effect_uniforms = None;
            self.pending_present = true;
            return Ok(());
        }
        let mut next = Effects::new(
            &self.device,
            self.config.format,
            settings,
            shader.as_deref(),
        )
        .await?;
        if let Some(previous) = &self.effects {
            next.inherit(previous);
        }
        self.effects = Some(Box::new(next));
        self.pending_present = true;
        Ok(())
    }
    pub fn set_effect_mouse(&mut self, mouse: [f32; 4]) {
        if let Some(fx) = &mut self.effects {
            fx.set_mouse(mouse);
        }
    }
    /// Passes the last frame's post-processing encoded (zero with effects off).
    pub fn effect_passes(&self) -> u32 {
        self.effects.as_ref().map_or(0, |fx| fx.passes)
    }
    /// Advance effect animations without new terminal content. Returns
    /// whether a frame was presented.
    pub fn animate(&mut self) -> Result<bool, String> {
        let Some(fx) = &self.effects else {
            return Ok(false);
        };
        let now = effects::now();
        if fx.scene_stale(now, self.config.width, self.config.height) {
            return match self.effect_uniforms {
                Some(uniforms) => self.present(uniforms),
                None => Ok(false),
            };
        }
        if !fx.wants_post(now) {
            return Ok(false);
        }
        self.present_post(now)
    }
    /// The glyph atlas. On a shared surface it may be shared with other
    /// terminals; borrows must not outlive one synchronous call.
    pub fn atlas(&self) -> RefMut<'_, Atlas> {
        self.text.atlas.borrow_mut()
    }
    pub fn shared_context(&self) -> Option<&Rc<SharedContext>> {
        self.shared.as_ref()
    }
    pub async fn new(
        canvas: web_sys::OffscreenCanvas,
        font: Vec<u8>,
        font_size: f32,
        line_height: f32,
        cols: u16,
        rows: u16,
    ) -> Result<Self, String> {
        let atlas = Atlas::new(font, font_size, line_height)?;
        Self::create(Target::Own(canvas), Some(atlas), None, cols, rows).await
    }
    /// A renderer drawing into a shared surface, using `glyphs` (usually shared).
    pub async fn shared(
        context: Rc<SharedContext>,
        glyphs: Rc<Glyphs>,
        cols: u16,
        rows: u16,
    ) -> Result<Self, String> {
        Self::create(Target::Shared(context), None, Some(glyphs), cols, rows).await
    }
    pub async fn external(canvas: web_sys::OffscreenCanvas) -> Result<Self, String> {
        Self::create(Target::Own(canvas), Some(Atlas::external()), None, 1, 1).await
    }
    async fn create(
        target: Target,
        atlas: Option<Atlas>,
        glyphs: Option<Rc<Glyphs>>,
        cols: u16,
        rows: u16,
    ) -> Result<Self, String> {
        // Terminals in one worker share one instance, adapter, device and queue.
        let (gpu, surface, canvas, shared) = match target {
            Target::Own(canvas) => {
                let gpu = shared_gpu(&canvas).await?;
                let surface = gpu
                    .instance
                    .create_surface(wgpu::SurfaceTarget::OffscreenCanvas(canvas.clone()))
                    .map_err(|e| e.to_string())?;
                (gpu, Some(surface), Some(canvas), None)
            }
            Target::Shared(context) => (context.gpu.clone(), None, None, Some(context)),
        };
        let SharedGpu {
            adapter,
            device,
            queue,
            lost,
            ..
        } = gpu;
        let text = match glyphs {
            Some(glyphs) => glyphs,
            None => Glyphs::new(&device, atlas.ok_or("renderer needs an atlas")?),
        };
        let info = adapter.get_info();
        let adapter_name = format!(
            "{} ({:?})",
            if info.name.is_empty() {
                "WebGPU adapter"
            } else {
                &info.name
            },
            info.backend
        );
        let (cell_width, cell_height, external) = {
            let atlas = text.atlas.borrow();
            (atlas.cell_width, atlas.cell_height, atlas.is_external())
        };
        let width = cols as u32 * cell_width;
        let height = rows as u32 * cell_height;
        if width > device.limits().max_texture_dimension_2d
            || height > device.limits().max_texture_dimension_2d
        {
            return Err("terminal pixel dimensions exceed this GPU's texture limit".into());
        }
        let config = match (&surface, &canvas, &shared) {
            (Some(surface), Some(canvas), _) => {
                canvas.set_width(width);
                canvas.set_height(height);
                let config = surface
                    .get_default_config(&adapter, width, height)
                    .ok_or("unsupported WebGPU surface")?;
                surface.configure(&device, &config);
                config
            }
            (_, _, Some(context)) => wgpu::SurfaceConfiguration {
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
                format: context.format,
                width,
                height,
                present_mode: wgpu::PresentMode::Fifo,
                desired_maximum_frame_latency: 2,
                alpha_mode: wgpu::CompositeAlphaMode::Opaque,
                view_formats: Vec::new(),
                color_space: Default::default(),
            },
            _ => unreachable!("a renderer has its own canvas or a shared surface"),
        };
        let error_scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
        // A shared surface compiles its pipelines once for every terminal.
        let pipeline = match &shared {
            Some(context) => context.pipeline.clone(),
            None => terminal_pipeline(&device, config.format, false),
        };
        let (sampler, scaled) = match &shared {
            Some(context) => (context.sampler.clone(), context.scaled.clone()),
            None => (
                device.create_sampler(&wgpu::SamplerDescriptor {
                    label: Some("Wraith pixel-aligned atlas sampler"),
                    mag_filter: wgpu::FilterMode::Nearest,
                    min_filter: wgpu::FilterMode::Nearest,
                    ..Default::default()
                }),
                scaled_sampler(&device),
            ),
        };
        let cell_count = cols as usize * rows as usize;
        let cells = if external {
            Vec::new()
        } else {
            vec![GpuCell::default(); cell_count]
        };
        let cell_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Wraith packed cells"),
            size: (cell_count * CELL_BYTES) as u64,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let uniform = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Wraith frame uniforms"),
            size: std::mem::size_of::<Uniforms>() as u64,
            usage: wgpu::BufferUsages::UNIFORM
                | wgpu::BufferUsages::COPY_DST
                | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let row_buffer = Self::row_buffer(&device, rows as usize);
        let images = match &shared {
            Some(context) => ImageLayer::with_pipeline(
                &device,
                context.image_pipeline.clone(),
                context.image_sampler.clone(),
                &uniform,
            ),
            None => ImageLayer::new(&device, config.format, &uniform),
        };
        let bind = Self::bind(
            &device,
            &pipeline,
            &cell_buffer,
            &uniform,
            &text.view,
            &sampler,
            &scaled,
            &row_buffer,
        );
        if let Some(error) = error_scope.pop().await {
            return Err(format!("WebGPU pipeline initialization: {error}"));
        }
        Ok(Self {
            device,
            queue,
            surface,
            config,
            canvas,
            shared,
            staged: None,
            pipeline,
            bind,
            cell_buffer,
            row_buffer,
            retained: RetainedRows::new(rows as usize),
            row_sources: vec![NEW_ROW; rows as usize],
            uniform,
            sampler,
            scaled,
            cells,
            cell_count,
            packed_versions: vec![0; rows as usize],
            pack_stamps: vec![0; rows as usize],
            pack_stamp: 0,
            atlas_resets: 0,
            glyphs: Vec::new(),
            ligature_cursor: None,
            text,
            images,
            frames: 0,
            upload_bytes: 0,
            cell_upload_bytes: 0,
            row_map_upload_bytes: 0,
            adapter: adapter_name,
            lost,
            last_blink: true,
            pending_present: true,
            effects: None,
            effect_uniforms: None,
        })
    }
    /// Swap in another glyph atlas (a font change on a shared surface). Every
    /// row is repacked against it.
    pub fn set_glyphs(&mut self, glyphs: Rc<Glyphs>, cols: u16, rows: u16) {
        self.text = glyphs;
        self.atlas_resets = u64::MAX;
        self.staged = None;
        self.resize(cols, rows);
    }
    /// Replace this renderer's own atlas contents in place (own canvas only).
    pub fn replace_atlas(&mut self, atlas: Atlas) {
        *self.text.atlas.borrow_mut() = atlas;
    }
    #[allow(clippy::too_many_arguments)]
    fn bind(
        device: &wgpu::Device,
        pipeline: &wgpu::RenderPipeline,
        cells: &wgpu::Buffer,
        uniform: &wgpu::Buffer,
        texture: &wgpu::TextureView,
        sampler: &wgpu::Sampler,
        scaled: &wgpu::Sampler,
        rows: &wgpu::Buffer,
    ) -> wgpu::BindGroup {
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Wraith frame bindings"),
            layout: &pipeline.get_bind_group_layout(0),
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: cells.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: uniform.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(texture),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::Sampler(sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: rows.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 5,
                    resource: wgpu::BindingResource::Sampler(scaled),
                },
            ],
        })
    }
    fn rebind(&mut self) {
        self.bind = Self::bind(
            &self.device,
            &self.pipeline,
            &self.cell_buffer,
            &self.uniform,
            &self.text.view,
            &self.sampler,
            &self.scaled,
            &self.row_buffer,
        );
    }
    fn row_buffer(device: &wgpu::Device, rows: usize) -> wgpu::Buffer {
        device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Wraith retained row map"),
            size: rows as u64 * 4,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        })
    }
    pub fn resize(&mut self, cols: u16, rows: u16) {
        let (cell_width, cell_height) = {
            let atlas = self.atlas();
            (atlas.cell_width, atlas.cell_height)
        };
        self.config.width = cols as u32 * cell_width;
        self.config.height = rows as u32 * cell_height;
        if let (Some(canvas), Some(surface)) = (&self.canvas, &self.surface) {
            canvas.set_width(self.config.width);
            canvas.set_height(self.config.height);
            surface.configure(&self.device, &self.config);
        }
        // A shared surface draws nothing for this terminal until it repacks.
        self.staged = None;
        self.cell_count = cols as usize * rows as usize;
        self.cells.resize(self.cell_count, GpuCell::default());
        self.packed_versions = vec![0; rows as usize];
        self.pack_stamps = vec![0; rows as usize];
        self.retained = RetainedRows::new(rows as usize);
        self.row_sources = vec![NEW_ROW; rows as usize];
        self.row_buffer = Self::row_buffer(&self.device, rows as usize);
        self.cell_buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Wraith resized packed cells"),
            size: (self.cell_count * CELL_BYTES) as u64,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        self.rebind();
    }
    pub fn validate_size(&self, cols: u16, rows: u16) -> Result<(), String> {
        let limit = self.device.limits().max_texture_dimension_2d;
        let atlas = self.atlas();
        if cols as u32 * atlas.cell_width > limit || rows as u32 * atlas.cell_height > limit {
            return Err("terminal pixel dimensions exceed this GPU's texture limit".into());
        }
        Ok(())
    }
    pub fn set_transparency(&mut self, enabled: bool) {
        let mode = if enabled {
            wgpu::CompositeAlphaMode::PreMultiplied
        } else {
            wgpu::CompositeAlphaMode::Opaque
        };
        if self.config.alpha_mode != mode {
            self.config.alpha_mode = mode;
            if let Some(surface) = &self.surface {
                surface.configure(&self.device, &self.config);
            }
            self.pending_present = true;
        }
    }
    pub fn render(&mut self, core: &mut Core, time: f64, force: bool) -> Result<bool, String> {
        if let Some(error) = &*self.lost.lock().unwrap() {
            return Err(error.clone());
        }
        let changed = core.update()?;
        if core.frame.held != 0 {
            return Ok(false);
        }
        let blink = ((time / 500.) as u64).is_multiple_of(2);
        let blinking = core.frame.cursor_blink != 0 || core.state.blinking != 0;
        // A shared atlas reset by another terminal invalidates every glyph this
        // terminal packed: repack all rows before it is drawn again.
        let stale = self.atlas().resets != self.atlas_resets;
        if stale && self.shared.is_some() {
            core.state.dirty.fill(true);
        }
        if !force
            && !(stale && self.shared.is_some())
            && !self.pending_present
            && !changed
            && !core.state.dirty.iter().any(|d| *d)
            && (!blinking || blink == self.last_blink)
        {
            // Effects may still animate over the retained scene.
            return if self.effects.is_some() {
                self.animate()
            } else {
                Ok(false)
            };
        }
        // A miss with no free atlas slot resets the atlas; every visible row
        // is then repacked once so no stale glyph reference is drawn.
        if stale {
            self.packed_versions.fill(0);
        }
        self.pack(core);
        if self.atlas().overflow {
            self.atlas().reset();
            self.packed_versions.fill(0);
            core.state.dirty.fill(true);
            self.pack(core);
            if self.atlas().overflow {
                self.atlas().reset();
                return Err(
                    "visible glyph set exceeds atlas capacity; reduce font size or grid size"
                        .into(),
                );
            }
        }
        let mut atlas = self.text.atlas.borrow_mut();
        self.atlas_resets = atlas.resets;
        let (tile_width, tile_height) = (atlas.tile_width, atlas.tile_height);
        let (cell_width, cell_height) = (atlas.cell_width, atlas.cell_height);
        for upload in atlas.uploads.drain(..) {
            self.queue.write_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: &self.text.texture,
                    mip_level: 0,
                    origin: wgpu::Origin3d {
                        x: upload.x,
                        y: upload.y,
                        z: 0,
                    },
                    aspect: wgpu::TextureAspect::All,
                },
                &upload.pixels,
                wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(tile_width * 4),
                    rows_per_image: Some(tile_height),
                },
                wgpu::Extent3d {
                    width: tile_width,
                    height: tile_height,
                    depth_or_array_layers: 1,
                },
            );
            self.upload_bytes += upload.pixels.len() as u64;
        }
        drop(atlas);
        // Scrolls retain GPU slots; only newly packed rows cross the bus.
        let cols = core.state.cols;
        self.retained.plan(&self.row_sources)?;
        for &(source, slot, rows) in &self.retained.uploads {
            let bytes = bytemuck::cast_slice(&self.cells[source * cols..(source + rows) * cols]);
            self.queue
                .write_buffer(&self.cell_buffer, (slot * cols * CELL_BYTES) as u64, bytes);
            self.upload_bytes += bytes.len() as u64;
            self.cell_upload_bytes += bytes.len() as u64;
        }
        self.upload_row_map();
        self.images
            .prepare(&self.device, &self.queue, &self.uniform, core);
        let frame = core.frame;
        let cursor_visible = frame.cursor_visible != 0 && (frame.cursor_blink == 0 || blink);
        let uniforms = Uniforms {
            view: [
                self.config.width as f32,
                self.config.height as f32,
                cell_width as f32,
                cell_height as f32,
            ],
            grid: [
                frame.cols,
                frame.rows,
                frame.cursor_y * frame.cols + frame.cursor_x,
                cursor_visible as u32 | (frame.cursor_style << 1),
            ],
            theme: [frame.cursor_color, 0x17120e, 0xf0d691, 0],
            text: [
                tile_width as f32,
                tile_height as f32,
                ATLAS_SIZE as f32,
                blink as u8 as f32,
            ],
            images: [
                self.images.below_background() as u32,
                frame.background,
                0,
                0,
            ],
            place: [0.; 4],
        };
        let rendered = if self.surface.is_some() {
            self.present(uniforms)?
        } else {
            self.stage(uniforms)
        };
        if rendered {
            core.state.dirty.fill(false);
            self.last_blink = blink;
        }
        Ok(rendered)
    }
    /// Pack dirty rows. A row already holding its core version is left alone;
    /// a row whose version another packed row holds (it moved) is copied from
    /// that row unless this pass already overwrote it; others are packed.
    fn pack(&mut self, core: &Core) {
        let state = &*core.state;
        let cols = state.cols;
        // Ligatures split under the cursor: repack the rows it left and entered.
        let frame = core.frame;
        let cursor = (self.text.atlas.borrow().ligatures && frame.cursor_visible != 0)
            .then_some((frame.cursor_x, frame.cursor_y));
        let mut forced = [usize::MAX; 2];
        if cursor != self.ligature_cursor {
            for (slot, at) in forced.iter_mut().zip([self.ligature_cursor, cursor]) {
                if let Some((_, y)) = at.filter(|&(_, y)| (y as usize) < state.rows) {
                    *slot = y as usize;
                    self.packed_versions[y as usize] = 0;
                }
            }
            self.ligature_cursor = cursor;
        }
        self.pack_stamp = self.pack_stamp.wrapping_add(1);
        for (y, source) in self.row_sources.iter_mut().enumerate() {
            *source = y as u32;
        }
        let (mut shift, mut searched) = (1isize, false);
        for y in 0..state.rows {
            if !state.dirty[y] && !forced.contains(&y) {
                continue;
            }
            let version = state.versions[y];
            if version != 0 && self.packed_versions[y] == version {
                continue;
            }
            let usable = |r: usize| {
                r != y
                    && self.packed_versions[r] == version
                    && self.pack_stamps[r] != self.pack_stamp
            };
            let guess = y as isize + shift;
            let cursor_row = cursor.is_some_and(|(_, cy)| cy as usize == y);
            let source = if version == 0 || cursor_row {
                None
            } else if guess >= 0 && (guess as usize) < state.rows && usable(guess as usize) {
                Some(guess as usize)
            } else if !searched {
                // One full search per pass, as in the core's snapshot reuse.
                searched = true;
                (0..state.rows).find(|&r| usable(r))
            } else {
                None
            };
            if let Some(r) = source {
                self.row_sources[y] = r as u32;
                shift = r as isize - y as isize;
                self.cells.copy_within(r * cols..(r + 1) * cols, y * cols);
            } else {
                self.row_sources[y] = NEW_ROW;
                let row = &state.cells[y * cols..(y + 1) * cols];
                self.glyphs.resize(cols, 0);
                let at = cursor
                    .filter(|&(_, cy)| cy as usize == y)
                    .map(|(x, _)| x as usize);
                self.text.atlas.borrow_mut().row(row, &mut self.glyphs, at);
                for ((cell, gpu), &glyph) in row
                    .iter()
                    .zip(&mut self.cells[y * cols..(y + 1) * cols])
                    .zip(&self.glyphs)
                {
                    *gpu = GpuCell {
                        foreground: cell.foreground,
                        background: cell.background,
                        underline: cell.underline,
                        flags: cell.flags,
                        glyph,
                    };
                }
                if cursor_row {
                    // Split for the cursor: never a copy source for moved rows.
                    self.packed_versions[y] = 0;
                    self.pack_stamps[y] = self.pack_stamp;
                    continue;
                }
            }
            self.packed_versions[y] = version;
            self.pack_stamps[y] = self.pack_stamp;
        }
    }
    fn upload_row_map(&mut self) {
        if self.retained.changed {
            let bytes = bytemuck::cast_slice(&self.retained.slots);
            self.queue.write_buffer(&self.row_buffer, 0, bytes);
            self.row_map_upload_bytes += bytes.len() as u64;
            self.upload_bytes += bytes.len() as u64;
        }
    }
    fn present(&mut self, mut uniforms: Uniforms) -> Result<bool, String> {
        if let Some(error) = &*self.lost.lock().unwrap() {
            return Err(error.clone());
        }
        // Dense identity frames bypass row indirection in the vertex shader.
        uniforms.grid[3] |= u32::from(!self.retained.identity) << 20;
        let now = if let Some(fx) = &mut self.effects {
            self.effect_uniforms = Some(uniforms);
            let now = effects::now();
            fx.observe(
                uniforms.grid,
                uniforms.theme,
                [uniforms.view[2], uniforms.view[3]],
                now,
            );
            // The animated cursor stands in for the native one while it moves.
            if fx.hide_cursor(now) {
                uniforms.grid[3] &= !1;
            }
            now
        } else {
            0.
        };
        self.queue
            .write_buffer(&self.uniform, 0, bytemuck::bytes_of(&uniforms));
        // An acquired surface can be temporarily unavailable. Retain the need
        // to present even when only uniforms changed and no rows are dirty.
        self.pending_present = true;
        let Some(surface) = &self.surface else {
            return Ok(self.stage(uniforms));
        };
        let texture = match surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(t)
            | wgpu::CurrentSurfaceTexture::Suboptimal(t) => t,
            wgpu::CurrentSurfaceTexture::Timeout | wgpu::CurrentSurfaceTexture::Occluded => {
                return Ok(false)
            }
            wgpu::CurrentSurfaceTexture::Outdated => {
                surface.configure(&self.device, &self.config);
                return Ok(false);
            }
            status => return Err(format!("WebGPU surface failure: {status:?}")),
        };
        let view = texture.texture.create_view(&Default::default());
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("Wraith frame"),
            });
        if let Some(fx) = &mut self.effects {
            fx.scene(&self.device, self.config.width, self.config.height);
        }
        {
            let target = match &self.effects {
                Some(fx) => fx.scene_view(),
                None => &view,
            };
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Wraith backgrounds + glyphs"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: target,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(
                            if self.config.alpha_mode == wgpu::CompositeAlphaMode::PreMultiplied {
                                wgpu::Color::TRANSPARENT
                            } else if uniforms.images[0] & 1 != 0 {
                                // Default-colored cells are skipped; the clear supplies them.
                                self.clear_color(uniforms.images[1])
                            } else {
                                wgpu::Color::BLACK
                            },
                        ),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                ..Default::default()
            });
            // Kitty z-order: below backgrounds, backgrounds, below text,
            // glyphs and decorations, above text.
            self.images.draw(&mut pass, 1);
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &self.bind, &[]);
            pass.draw(0..6, 0..self.cell_count as u32);
            self.images.draw(&mut pass, 2);
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &self.bind, &[]);
            pass.draw(6..12, 0..self.cell_count as u32);
            self.images.draw(&mut pass, 3);
        }
        if let Some(fx) = &mut self.effects {
            let hid = fx.hide_cursor(now);
            fx.scene_drawn(hid);
            fx.post(&self.queue, &mut encoder, &view, now);
        }
        self.queue.submit([encoder.finish()]);
        self.queue.present(texture);
        self.frames += 1;
        self.pending_present = false;
        Ok(true)
    }
    /// Run only the post passes over the retained scene texture.
    fn present_post(&mut self, now: f64) -> Result<bool, String> {
        if let Some(error) = &*self.lost.lock().unwrap() {
            return Err(error.clone());
        }
        // Effects need the terminal's own surface; a shared surface has none.
        let Some(surface) = &self.surface else {
            return Ok(false);
        };
        let texture = match surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(t)
            | wgpu::CurrentSurfaceTexture::Suboptimal(t) => t,
            wgpu::CurrentSurfaceTexture::Timeout | wgpu::CurrentSurfaceTexture::Occluded => {
                return Ok(false)
            }
            wgpu::CurrentSurfaceTexture::Outdated => {
                surface.configure(&self.device, &self.config);
                return Ok(false);
            }
            status => return Err(format!("WebGPU surface failure: {status:?}")),
        };
        let Some(fx) = &mut self.effects else {
            return Ok(false);
        };
        let view = texture.texture.create_view(&Default::default());
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("Wraith effect frame"),
            });
        fx.post(&self.queue, &mut encoder, &view, now);
        self.queue.submit([encoder.finish()]);
        self.queue.present(texture);
        self.frames += 1;
        Ok(true)
    }
    /// Shared surfaces: keep the frame's uniforms for the next draw into the
    /// surface. Packed rows and uploads are already queued.
    fn stage(&mut self, mut uniforms: Uniforms) -> bool {
        uniforms.grid[3] |= u32::from(!self.retained.identity) << 20;
        self.staged = Some(uniforms);
        self.frames += 1;
        self.pending_present = false;
        true
    }
    /// Whether this terminal holds a complete staged frame that references
    /// the current atlas, so it can be drawn into a shared surface.
    pub fn drawable(&self) -> bool {
        self.staged.is_some() && self.atlas_resets == self.text.atlas.borrow().resets
    }
    /// Record this terminal's staged frame into a shared surface's open pass,
    /// at `origin` (target pixels) and `scale`, clipped to `scissor`.
    pub fn draw_shared(
        &self,
        pass: &mut wgpu::RenderPass<'static>,
        target: (u32, u32),
        origin: (f32, f32),
        scale: f32,
        scissor: (u32, u32, u32, u32),
    ) -> bool {
        let Some(mut uniforms) = self.staged else {
            return false;
        };
        if !self.drawable() || scissor.2 == 0 || scissor.3 == 0 {
            return false;
        }
        uniforms.images[2] = target.0;
        uniforms.images[3] = target.1;
        let scaled = (scale - 1.).abs() > 1e-3;
        uniforms.place = [origin.0, origin.1, scale, scaled as u32 as f32];
        self.queue
            .write_buffer(&self.uniform, 0, bytemuck::bytes_of(&uniforms));
        pass.set_scissor_rect(scissor.0, scissor.1, scissor.2, scissor.3);
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, &self.bind, &[]);
        // Default background first: a redraw replaces every previous pixel.
        pass.draw(12..18, 0..1);
        self.images.draw(pass, 1);
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, &self.bind, &[]);
        pass.draw(0..6, 0..self.cell_count as u32);
        self.images.draw(pass, 2);
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, &self.bind, &[]);
        pass.draw(6..12, 0..self.cell_count as u32);
        self.images.draw(pass, 3);
        true
    }
    fn clear_color(&self, rgb: u32) -> wgpu::Color {
        let channel = |shift: u32| {
            let c = ((rgb >> shift) & 255) as f64 / 255.;
            if self.config.format.is_srgb() {
                if c <= 0.04045 {
                    c / 12.92
                } else {
                    ((c + 0.055) / 1.055).powf(2.4)
                }
            } else {
                c
            }
        };
        wgpu::Color {
            r: channel(0),
            g: channel(8),
            b: channel(16),
            a: 1.,
        }
    }
    /// External semantic cores submit the same packed GPU cell layout. No ANSI
    /// replay or duplicate parser state is involved in the compatibility path.
    pub fn configure_external(
        &mut self,
        cols: u16,
        rows: u16,
        width: u32,
        height: u32,
    ) -> Result<(), String> {
        self.validate_external(cols, rows, width, height)?;
        self.config.width = width;
        self.config.height = height;
        if let (Some(canvas), Some(surface)) = (&self.canvas, &self.surface) {
            canvas.set_width(width);
            canvas.set_height(height);
            surface.configure(&self.device, &self.config);
        }
        self.cell_count = cols as usize * rows as usize;
        self.retained = RetainedRows::new(rows as usize);
        self.row_sources = vec![NEW_ROW; rows as usize];
        self.row_buffer = Self::row_buffer(&self.device, rows as usize);
        self.cell_buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Wraith xterm cells"),
            size: (self.cell_count * CELL_BYTES) as u64,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        self.rebind();
        Ok(())
    }
    pub fn validate_external(
        &self,
        cols: u16,
        rows: u16,
        width: u32,
        height: u32,
    ) -> Result<(), String> {
        let limit = self.device.limits().max_texture_dimension_2d;
        if cols == 0 || rows == 0 || width == 0 || height == 0 || width > limit || height > limit {
            return Err("invalid compositor dimensions".into());
        }
        let bytes = cols as u64 * rows as u64 * CELL_BYTES as u64;
        let limits = self.device.limits();
        if bytes > limits.max_buffer_size || bytes > limits.max_storage_buffer_binding_size {
            return Err("compositor cell buffer exceeds this GPU's storage limit".into());
        }
        Ok(())
    }
    pub fn upload_external(
        &mut self,
        x: u32,
        y: u32,
        width: u32,
        height: u32,
        pixels: &[u8],
    ) -> Result<(), String> {
        if width == 0
            || height == 0
            || x.checked_add(width).is_none_or(|v| v > ATLAS_SIZE)
            || y.checked_add(height).is_none_or(|v| v > ATLAS_SIZE)
            || pixels.len() != width as usize * height as usize * 4
        {
            return Err("invalid atlas upload".into());
        }
        self.queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &self.text.texture,
                mip_level: 0,
                origin: wgpu::Origin3d { x, y, z: 0 },
                aspect: wgpu::TextureAspect::All,
            },
            pixels,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(width * 4),
                rows_per_image: Some(height),
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );
        self.upload_bytes += pixels.len() as u64;
        Ok(())
    }
    pub fn render_external(
        &mut self,
        packed: &[u32],
        start: u32,
        dimensions: &[f32],
        frame: &[u32],
    ) -> Result<bool, String> {
        self.validate_frame(packed, start, dimensions, frame)?;
        if !packed.is_empty() {
            let cols = frame[0] as usize;
            if self.retained.identity {
                self.write_cells(start as usize, packed);
            } else {
                // Legacy partial uploads remain valid even after retained
                // rendering has rotated physical slots.
                let mut cell = start as usize;
                let end = cell + packed.len() / CELL_WORDS;
                while cell < end {
                    let count = (cols - cell % cols).min(end - cell);
                    let physical = self.retained.slots[cell / cols] as usize * cols + cell % cols;
                    let offset = (cell - start as usize) * CELL_WORDS;
                    self.write_cells(physical, &packed[offset..offset + count * CELL_WORDS]);
                    cell += count;
                }
            }
        }
        self.present_external(dimensions, frame)
    }
    fn validate_frame(
        &self,
        packed: &[u32],
        start: u32,
        dimensions: &[f32],
        frame: &[u32],
    ) -> Result<(), String> {
        if !packed.len().is_multiple_of(CELL_WORDS)
            || start as usize > self.cell_count
            || packed.len() / CELL_WORDS > self.cell_count - start as usize
            || dimensions.len() != 4
            || dimensions.iter().any(|v| !v.is_finite() || *v <= 0.)
            || frame.len() != 8
            || frame[0] == 0
            || frame[1] == 0
            || (frame[0] as usize).checked_mul(frame[1] as usize) != Some(self.cell_count)
        {
            return Err("invalid compositor frame".into());
        }
        Ok(())
    }
    fn write_cells(&mut self, start: usize, packed: &[u32]) {
        let bytes = bytemuck::cast_slice(packed);
        self.queue
            .write_buffer(&self.cell_buffer, start as u64 * CELL_BYTES as u64, bytes);
        self.upload_bytes += bytes.len() as u64;
        self.cell_upload_bytes += bytes.len() as u64;
    }
    pub fn render_retained(
        &mut self,
        packed: &[u32],
        sources: &[u32],
        dimensions: &[f32],
        frame: &[u32],
    ) -> Result<bool, String> {
        self.validate_frame(packed, 0, dimensions, frame)?;
        if packed.len() / CELL_WORDS != self.cell_count {
            return Err("incomplete retained frame".into());
        }
        self.retained.plan(sources)?;
        let cols = frame[0] as usize;
        // Coalesce only when both logical input and physical destination are
        // contiguous. Sparse damage must never upload the clean gap between it.
        for i in 0..self.retained.uploads.len() {
            let (source, slot, rows) = self.retained.uploads[i];
            self.write_cells(
                slot * cols,
                &packed[source * cols * CELL_WORDS..(source + rows) * cols * CELL_WORDS],
            );
        }
        self.upload_row_map();
        self.present_external(dimensions, frame)
    }
    fn present_external(&mut self, dimensions: &[f32], frame: &[u32]) -> Result<bool, String> {
        self.present(Uniforms {
            view: [
                self.config.width as f32,
                self.config.height as f32,
                dimensions[0],
                dimensions[1],
            ],
            grid: [frame[0], frame[1], frame[2], frame[3]],
            theme: [frame[4], frame[5], frame[6], frame[7]],
            text: [dimensions[2], dimensions[3], ATLAS_SIZE as f32, 1.],
            images: [0; 4],
            place: [0.; 4],
        })
    }
    /// Calls `done` once the GPU finishes work submitted so far, without
    /// holding a borrow while waiting (GPUQueue.onSubmittedWorkDone on the web).
    pub fn on_submitted_work_done(&self, done: js_sys::Function) {
        thread_local! {
            static WAITING: std::cell::RefCell<(u32, std::collections::HashMap<u32, js_sys::Function>)> =
                Default::default();
        }
        // wgpu requires a Send callback; the JS function stays in this
        // (single-threaded) Wasm instance and the callback carries only its key.
        let key = WAITING.with(|w| {
            let mut w = w.borrow_mut();
            w.0 = w.0.wrapping_add(1);
            let key = w.0;
            w.1.insert(key, done);
            key
        });
        self.queue.on_submitted_work_done(move || {
            if let Some(done) = WAITING.with(|w| w.borrow_mut().1.remove(&key)) {
                let _ = done.call0(&wasm_bindgen::JsValue::NULL);
            }
        });
    }
    pub async fn fence(&self) -> Result<(), String> {
        // A tiny readback waits for prior GPU work without affecting normal frames.
        let buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Wraith benchmark fence"),
            size: 4,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("Wraith fence copy"),
            });
        encoder.copy_buffer_to_buffer(&self.uniform, 0, &buffer, 0, 4);
        self.queue.submit([encoder.finish()]);
        let completed = js_sys::Promise::new(&mut |resolve, reject| {
            buffer.map_async(wgpu::MapMode::Read, .., move |result| {
                if result.is_ok() {
                    let _ = resolve.call0(&wasm_bindgen::JsValue::NULL);
                } else {
                    let _ = reject.call1(
                        &wasm_bindgen::JsValue::NULL,
                        &wasm_bindgen::JsValue::from_str("GPU fence failed"),
                    );
                }
            });
        });
        let result = wasm_bindgen_futures::JsFuture::from(completed).await;
        buffer.unmap();
        result
            .map(|_| ())
            .map_err(|e| e.as_string().unwrap_or_else(|| "GPU fence failed".into()))
    }
}
