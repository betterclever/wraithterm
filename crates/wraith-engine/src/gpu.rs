use crate::{
    core::Core,
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
    atlas: [f32; 4],
}
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct Uniforms {
    view: [f32; 4],
    grid: [u32; 4],
    theme: [u32; 4],
    text: [f32; 4],
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
    uniform: wgpu::Buffer,
    texture: wgpu::Texture,
    atlas_view: wgpu::TextureView,
    sampler: wgpu::Sampler,
    cells: Vec<GpuCell>,
    pub atlas: Atlas,
    pub frames: u64,
    pub upload_bytes: u64,
    pub adapter: String,
    pub lost: Arc<Mutex<Option<String>>>,
    last_blink: bool,
    pending_present: bool,
}
impl Renderer {
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
        let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
        descriptor.backends = wgpu::Backends::BROWSER_WEBGPU;
        let instance = wgpu::Instance::new(descriptor);
        let surface = instance
            .create_surface(wgpu::SurfaceTarget::OffscreenCanvas(canvas.clone()))
            .map_err(|e| e.to_string())?;
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                compatible_surface: Some(&surface),
                force_fallback_adapter: false,
                ..Default::default()
            })
            .await
            .map_err(|e| format!("WebGPU adapter unavailable: {e}"))?;
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
            *lost_clone.lock().unwrap() =
                Some(format!("WebGPU device lost ({reason:?}): {message}"));
        });
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
        let cells = vec![GpuCell::default(); cols as usize * rows as usize];
        let cell_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Wraith packed cells"),
            size: (cells.len() * std::mem::size_of::<GpuCell>()) as u64,
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
        let bind = Self::bind(
            &device,
            &pipeline,
            &cell_buffer,
            &uniform,
            &atlas_view,
            &sampler,
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
            uniform,
            texture,
            atlas_view,
            sampler,
            cells,
            atlas,
            frames: 0,
            upload_bytes: 0,
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
            ],
        })
    }
    pub fn resize(&mut self, cols: u16, rows: u16) {
        self.config.width = cols as u32 * self.atlas.cell_width;
        self.config.height = rows as u32 * self.atlas.cell_height;
        self.canvas.set_width(self.config.width);
        self.canvas.set_height(self.config.height);
        self.surface.configure(&self.device, &self.config);
        self.cells
            .resize(cols as usize * rows as usize, GpuCell::default());
        self.cell_buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Wraith resized packed cells"),
            size: (self.cells.len() * 32) as u64,
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
    pub fn render(&mut self, core: &mut Core, time: f64, force: bool) -> Result<bool, String> {
        if let Some(error) = &*self.lost.lock().unwrap() {
            return Err(error.clone());
        }
        let changed = core.update()?;
        if core.frame.held != 0 {
            return Ok(false);
        }
        let blink = ((time / 500.) as u64).is_multiple_of(2);
        let blinking =
            core.frame.cursor_blink != 0 || core.state.cells.iter().any(|c| c.flags & 8 != 0);
        if !force
            && !self.pending_present
            && !changed
            && !core.state.dirty.iter().any(|d| *d)
            && (!blinking || blink == self.last_blink)
        {
            return Ok(false);
        }
        let state = &mut *core.state;
        self.atlas
            .begin(&state.cells, &mut state.dirty, state.cols)?;
        let cols = core.state.cols;
        for (y, dirty) in core.state.dirty.iter().enumerate() {
            if !dirty {
                continue;
            }
            for x in 0..cols {
                let i = y * cols + x;
                let cell = &core.state.cells[i];
                let tile = self.atlas.tile(cell);
                self.cells[i] = GpuCell {
                    foreground: cell.foreground,
                    background: cell.background,
                    underline: cell.underline,
                    flags: cell.flags | ((tile.colored as u32) << 19),
                    atlas: tile.rect,
                };
            }
        }
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
        // Adjacent dirty rows merge into one writeBuffer call.
        let mut row = 0;
        while row < core.state.rows {
            if !core.state.dirty[row] {
                row += 1;
                continue;
            }
            let start = row;
            while row < core.state.rows && core.state.dirty[row] {
                row += 1;
            }
            let bytes = bytemuck::cast_slice(&self.cells[start * cols..row * cols]);
            self.queue
                .write_buffer(&self.cell_buffer, (start * cols * 32) as u64, bytes);
            self.upload_bytes += bytes.len() as u64;
        }
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
        };
        let rendered = self.present(uniforms)?;
        if rendered {
            core.state.dirty.fill(false);
            self.last_blink = blink;
        }
        Ok(rendered)
    }
    fn present(&mut self, uniforms: Uniforms) -> Result<bool, String> {
        if let Some(error) = &*self.lost.lock().unwrap() {
            return Err(error.clone());
        }
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
                        load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                ..Default::default()
            });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &self.bind, &[]);
            pass.draw(0..6, 0..self.cells.len() as u32);
            pass.draw(6..12, 0..self.cells.len() as u32);
        }
        self.queue.submit([encoder.finish()]);
        self.queue.present(texture);
        self.frames += 1;
        self.pending_present = false;
        Ok(true)
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
        self.cells
            .resize(cols as usize * rows as usize, GpuCell::default());
        self.cell_buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Wraith xterm cells"),
            size: (self.cells.len() * 32) as u64,
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
        let bytes = cols as u64 * rows as u64 * 32;
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
        if !packed.len().is_multiple_of(8)
            || start as usize > self.cells.len()
            || packed.len() / 8 > self.cells.len() - start as usize
            || dimensions.len() != 4
            || dimensions.iter().any(|v| !v.is_finite() || *v <= 0.)
            || frame.len() != 8
            || frame[0] == 0
            || frame[1] == 0
            || (frame[0] as usize).checked_mul(frame[1] as usize) != Some(self.cells.len())
        {
            return Err("invalid compositor frame".into());
        }
        if !packed.is_empty() {
            let bytes = bytemuck::cast_slice(packed);
            self.queue
                .write_buffer(&self.cell_buffer, start as u64 * 32, bytes);
            self.upload_bytes += bytes.len() as u64;
        }
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
