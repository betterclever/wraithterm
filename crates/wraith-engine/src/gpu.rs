use crate::{
    core::Core,
    images::ImageLayer,
    retained::{RetainedRows, NEW_ROW},
    text::{Atlas, ATLAS_SIZE},
};
use bytemuck::{Pod, Zeroable};
use std::sync::{Arc, Mutex};

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
#[derive(Clone, Copy, Pod, Zeroable)]
struct Uniforms {
    view: [f32; 4],
    grid: [u32; 4],
    theme: [u32; 4],
    text: [f32; 4],
    images: [u32; 4],
}
pub struct Renderer {
    device: wgpu::Device,
    queue: wgpu::Queue,
    surface: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
    canvas: web_sys::OffscreenCanvas,
    pipeline: wgpu::RenderPipeline,
    bind: wgpu::BindGroup,
    cell_buffer: wgpu::Buffer,
    row_buffer: wgpu::Buffer,
    retained: RetainedRows,
    row_sources: Vec<u32>,
    uniform: wgpu::Buffer,
    texture: wgpu::Texture,
    atlas_view: wgpu::TextureView,
    sampler: wgpu::Sampler,
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
    pub atlas: Atlas,
    pub images: ImageLayer,
    pub frames: u64,
    pub upload_bytes: u64,
    pub cell_upload_bytes: u64,
    pub row_map_upload_bytes: u64,
    pub adapter: String,
    pub lost: Arc<Mutex<Option<String>>>,
    last_blink: bool,
    pending_present: bool,
}
#[derive(Clone)]
struct SharedGpu {
    instance: wgpu::Instance,
    adapter: wgpu::Adapter,
    device: wgpu::Device,
    queue: wgpu::Queue,
    /// The device's first uncaptured error or loss, seen by every renderer on it.
    lost: Arc<Mutex<Option<String>>>,
}
thread_local! {
    static GPU: std::cell::RefCell<Option<SharedGpu>> = const { std::cell::RefCell::new(None) };
}
/// The worker's shared GPU, created on first use. A lost device is replaced
/// for later terminals; terminals already on it keep reporting the loss.
async fn shared_gpu(canvas: &web_sys::OffscreenCanvas) -> Result<SharedGpu, String> {
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
        self.pending_present
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
        Self::with_atlas(canvas, atlas, cols, rows).await
    }
    pub async fn external(canvas: web_sys::OffscreenCanvas) -> Result<Self, String> {
        Self::with_atlas(canvas, Atlas::external(), 1, 1).await
    }
    async fn with_atlas(
        canvas: web_sys::OffscreenCanvas,
        atlas: Atlas,
        cols: u16,
        rows: u16,
    ) -> Result<Self, String> {
        // Terminals in one worker share one instance, adapter, device and queue.
        let gpu = shared_gpu(&canvas).await?;
        let SharedGpu {
            instance,
            adapter,
            device,
            queue,
            lost,
        } = gpu;
        let surface = instance
            .create_surface(wgpu::SurfaceTarget::OffscreenCanvas(canvas.clone()))
            .map_err(|e| e.to_string())?;
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
        let width = cols as u32 * atlas.cell_width;
        let height = rows as u32 * atlas.cell_height;
        if width > device.limits().max_texture_dimension_2d
            || height > device.limits().max_texture_dimension_2d
        {
            return Err("terminal pixel dimensions exceed this GPU's texture limit".into());
        }
        canvas.set_width(width);
        canvas.set_height(height);
        let config = surface
            .get_default_config(&adapter, width, height)
            .ok_or("unsupported WebGPU surface")?;
        surface.configure(&device, &config);
        let error_scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Wraith terminal WGSL"),
            source: wgpu::ShaderSource::Wgsl(include_str!("terminal.wgsl").into()),
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
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
                    format: config.format,
                    blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            primitive: Default::default(),
            depth_stencil: None,
            multisample: Default::default(),
            multiview_mask: None,
            cache: None,
        });
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
        let atlas_view = texture.create_view(&Default::default());
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("Wraith pixel-aligned atlas sampler"),
            mag_filter: wgpu::FilterMode::Nearest,
            min_filter: wgpu::FilterMode::Nearest,
            ..Default::default()
        });
        let cell_count = cols as usize * rows as usize;
        let cells = if atlas.is_external() {
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
        let images = ImageLayer::new(&device, config.format, &uniform);
        let bind = Self::bind(
            &device,
            &pipeline,
            &cell_buffer,
            &uniform,
            &atlas_view,
            &sampler,
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
            pipeline,
            bind,
            cell_buffer,
            row_buffer,
            retained: RetainedRows::new(rows as usize),
            row_sources: vec![NEW_ROW; rows as usize],
            uniform,
            texture,
            atlas_view,
            sampler,
            cells,
            cell_count,
            packed_versions: vec![0; rows as usize],
            pack_stamps: vec![0; rows as usize],
            pack_stamp: 0,
            atlas_resets: 0,
            glyphs: Vec::new(),
            ligature_cursor: None,
            atlas,
            images,
            frames: 0,
            upload_bytes: 0,
            cell_upload_bytes: 0,
            row_map_upload_bytes: 0,
            adapter: adapter_name,
            lost,
            last_blink: true,
            pending_present: true,
        })
    }
    fn bind(
        device: &wgpu::Device,
        pipeline: &wgpu::RenderPipeline,
        cells: &wgpu::Buffer,
        uniform: &wgpu::Buffer,
        texture: &wgpu::TextureView,
        sampler: &wgpu::Sampler,
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
            ],
        })
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
        self.config.width = cols as u32 * self.atlas.cell_width;
        self.config.height = rows as u32 * self.atlas.cell_height;
        self.canvas.set_width(self.config.width);
        self.canvas.set_height(self.config.height);
        self.surface.configure(&self.device, &self.config);
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
        self.bind = Self::bind(
            &self.device,
            &self.pipeline,
            &self.cell_buffer,
            &self.uniform,
            &self.atlas_view,
            &self.sampler,
            &self.row_buffer,
        );
    }
    pub fn validate_size(&self, cols: u16, rows: u16) -> Result<(), String> {
        let limit = self.device.limits().max_texture_dimension_2d;
        if cols as u32 * self.atlas.cell_width > limit
            || rows as u32 * self.atlas.cell_height > limit
        {
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
            self.surface.configure(&self.device, &self.config);
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
        if !force
            && !self.pending_present
            && !changed
            && !core.state.dirty.iter().any(|d| *d)
            && (!blinking || blink == self.last_blink)
        {
            return Ok(false);
        }
        // A miss with no free atlas slot resets the atlas; every visible row
        // is then repacked once so no stale glyph reference is drawn.
        if self.atlas.resets != self.atlas_resets {
            self.packed_versions.fill(0);
        }
        self.pack(core);
        if self.atlas.overflow {
            self.atlas.reset();
            self.packed_versions.fill(0);
            core.state.dirty.fill(true);
            self.pack(core);
            if self.atlas.overflow {
                self.atlas.reset();
                return Err(
                    "visible glyph set exceeds atlas capacity; reduce font size or grid size"
                        .into(),
                );
            }
        }
        self.atlas_resets = self.atlas.resets;
        for upload in self.atlas.uploads.drain(..) {
            self.queue.write_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: &self.texture,
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
                    bytes_per_row: Some(self.atlas.tile_width * 4),
                    rows_per_image: Some(self.atlas.tile_height),
                },
                wgpu::Extent3d {
                    width: self.atlas.tile_width,
                    height: self.atlas.tile_height,
                    depth_or_array_layers: 1,
                },
            );
            self.upload_bytes += upload.pixels.len() as u64;
        }
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
                self.atlas.cell_width as f32,
                self.atlas.cell_height as f32,
            ],
            grid: [
                frame.cols,
                frame.rows,
                frame.cursor_y * frame.cols + frame.cursor_x,
                cursor_visible as u32 | (frame.cursor_style << 1),
            ],
            theme: [frame.cursor_color, 0x17120e, 0xf0d691, 0],
            text: [
                self.atlas.tile_width as f32,
                self.atlas.tile_height as f32,
                ATLAS_SIZE as f32,
                blink as u8 as f32,
            ],
            images: [
                self.images.below_background() as u32,
                frame.background,
                0,
                0,
            ],
        };
        let rendered = self.present(uniforms)?;
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
        let cursor = (self.atlas.ligatures && frame.cursor_visible != 0)
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
                self.atlas.row(row, &mut self.glyphs, at);
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
        self.queue
            .write_buffer(&self.uniform, 0, bytemuck::bytes_of(&uniforms));
        // An acquired surface can be temporarily unavailable. Retain the need
        // to present even when only uniforms changed and no rows are dirty.
        self.pending_present = true;
        let texture = match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(t)
            | wgpu::CurrentSurfaceTexture::Suboptimal(t) => t,
            wgpu::CurrentSurfaceTexture::Timeout | wgpu::CurrentSurfaceTexture::Occluded => {
                return Ok(false)
            }
            wgpu::CurrentSurfaceTexture::Outdated => {
                self.surface.configure(&self.device, &self.config);
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
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Wraith backgrounds + glyphs"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
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
        self.queue.submit([encoder.finish()]);
        self.queue.present(texture);
        self.frames += 1;
        self.pending_present = false;
        Ok(true)
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
        self.canvas.set_width(width);
        self.canvas.set_height(height);
        self.surface.configure(&self.device, &self.config);
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
        self.bind = Self::bind(
            &self.device,
            &self.pipeline,
            &self.cell_buffer,
            &self.uniform,
            &self.atlas_view,
            &self.sampler,
            &self.row_buffer,
        );
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
                texture: &self.texture,
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
        })
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
