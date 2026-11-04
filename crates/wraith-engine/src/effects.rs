//! Opt-in post-process effects: CRT, bloom, an animated cursor trail and
//! user WGSL shaders. The renderer holds `Option<Effects>`; with effects off it
//! creates none of these resources and draws straight to the surface as before.
//!
//! With effects on, the terminal pass targets an offscreen scene texture.
//! Bloom adds two half-resolution blur passes, the built-ins share one
//! composite pass, and a custom shader adds one final pass. While only an
//! animation advances, the retained scene is reused and just the post passes
//! run.
use crate::effect_state::{Cursor, Settings};
use bytemuck::{Pod, Zeroable};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = performance, js_name = now)]
    fn performance_now() -> f64;
}
pub fn now() -> f64 {
    performance_now()
}

#[repr(C)]
#[derive(Clone, Copy, Default, Pod, Zeroable)]
struct Fx {
    resolution: [f32; 4],
    crt: [f32; 4],
    bloom: [f32; 4],
    head: [f32; 4],
    tail: [f32; 4],
    cursor_color: [f32; 4],
    time: [f32; 4],
    mouse: [f32; 4],
    cursor: [f32; 4],
    previous: [f32; 4],
    flags: [u32; 4],
}
const _: () = assert!(std::mem::size_of::<Fx>() == 176);

struct Targets {
    width: u32,
    height: u32,
    scene_view: wgpu::TextureView,
    composite: Option<wgpu::BindGroup>,
    blur_h: Option<wgpu::BindGroup>,
    blur_v: Option<wgpu::BindGroup>,
    custom: Option<wgpu::BindGroup>,
    /// Half-resolution blur targets and the composite output a custom shader reads.
    half_a: Option<wgpu::TextureView>,
    half_b: Option<wgpu::TextureView>,
    post: Option<wgpu::TextureView>,
}

pub struct Effects {
    pub settings: Settings,
    format: wgpu::TextureFormat,
    layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    fx: wgpu::Buffer,
    composite: Option<wgpu::RenderPipeline>,
    blur: Option<(wgpu::RenderPipeline, wgpu::RenderPipeline)>,
    custom: Option<wgpu::RenderPipeline>,
    targets: Option<Targets>,
    cursor: Cursor,
    mouse: [f32; 4],
    mouse_dirty: bool,
    epoch: f64,
    last_post: f64,
    frame: u32,
    /// The scene texture holds a complete terminal frame.
    scene_valid: bool,
    /// Whether that frame was drawn with the native cursor hidden.
    scene_hid_cursor: bool,
    /// Post passes per presented frame, for diagnostics and tests.
    pub passes: u32,
    /// Post-processing a shared surface: the scene is the surface's backing,
    /// areas outside terminals stay transparent and there is no single cursor.
    shared: bool,
}

fn texture(
    device: &wgpu::Device,
    format: wgpu::TextureFormat,
    width: u32,
    height: u32,
    label: &str,
) -> wgpu::TextureView {
    device
        .create_texture(&wgpu::TextureDescriptor {
            label: Some(label),
            size: wgpu::Extent3d {
                width: width.max(1),
                height: height.max(1),
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        })
        .create_view(&Default::default())
}

fn pipeline(
    device: &wgpu::Device,
    layout: &wgpu::PipelineLayout,
    module: &wgpu::ShaderModule,
    vertex: &str,
    fragment: &str,
    format: wgpu::TextureFormat,
) -> wgpu::RenderPipeline {
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some(fragment),
        layout: Some(layout),
        vertex: wgpu::VertexState {
            module,
            entry_point: Some(vertex),
            compilation_options: Default::default(),
            buffers: &[],
        },
        fragment: Some(wgpu::FragmentState {
            module,
            entry_point: Some(fragment),
            compilation_options: Default::default(),
            targets: &[Some(wgpu::ColorTargetState {
                format,
                blend: None,
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

/// Format compiler messages as `line:column: message`; the user's source comes
/// first in the module, so its line numbers are the user's own.
fn describe(info: &wgpu::CompilationInfo, source_lines: u32) -> Option<String> {
    let lines: Vec<String> = info
        .messages
        .iter()
        .filter(|m| m.message_type == wgpu::CompilationMessageType::Error)
        .map(|m| match m.location {
            Some(at) if at.line_number <= source_lines => {
                format!("{}:{}: {}", at.line_number, at.line_position, m.message)
            }
            Some(_) => format!("(Wraith prelude) {}", m.message),
            None => m.message.clone(),
        })
        .collect();
    (!lines.is_empty()).then(|| lines.join("\n"))
}

impl Effects {
    /// Build every pipeline the settings need, inside one validation scope.
    /// A shader error leaves nothing behind and is returned as a message.
    pub async fn new(
        device: &wgpu::Device,
        format: wgpu::TextureFormat,
        settings: Settings,
        shader: Option<&str>,
    ) -> Result<Self, String> {
        let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let texture_entry = |binding| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: true },
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled: false,
            },
            count: None,
        };
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Wraith effect bindings"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                texture_entry(1),
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
                texture_entry(3),
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Wraith effect layout"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let (mut composite, mut blur) = (None, None);
        if settings.composite() {
            let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("Wraith effects WGSL"),
                source: wgpu::ShaderSource::Wgsl(include_str!("effects.wgsl").into()),
            });
            composite = Some(pipeline(
                device,
                &pipeline_layout,
                &module,
                "vs",
                "composite",
                format,
            ));
            if settings.bloom.is_some() {
                blur = Some((
                    pipeline(device, &pipeline_layout, &module, "vs", "blur_h", format),
                    pipeline(device, &pipeline_layout, &module, "vs", "blur_v", format),
                ));
            }
        }
        let mut custom = None;
        let mut module = None;
        if let Some(source) = shader {
            let code = format!("{source}\n{}", include_str!("shader_prelude.wgsl"));
            let m = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("Wraith custom shader"),
                source: wgpu::ShaderSource::Wgsl(code.into()),
            });
            custom = Some(pipeline(
                device,
                &pipeline_layout,
                &m,
                "wraith_vs",
                "wraith_fs",
                format,
            ));
            module = Some(m);
        }
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("Wraith effect sampler"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            ..Default::default()
        });
        let fx = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Wraith effect uniforms"),
            size: std::mem::size_of::<Fx>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        if let Some(error) = scope.pop().await {
            let lines = shader.map_or(0, |s| s.lines().count() as u32);
            let detail = match &module {
                Some(m) => describe(&m.get_compilation_info().await, lines),
                None => None,
            };
            return Err(match detail {
                Some(detail) => format!("Custom shader failed to compile:\n{detail}"),
                None if shader.is_some() => format!("Custom shader rejected: {error}"),
                None => format!("Effect pipeline failed: {error}"),
            });
        }
        let now = now();
        Ok(Self {
            settings,
            format,
            layout,
            sampler,
            fx,
            composite,
            blur,
            custom,
            targets: None,
            cursor: Cursor::default(),
            mouse: [0.; 4],
            mouse_dirty: false,
            epoch: now,
            last_post: now,
            frame: 0,
            scene_valid: false,
            scene_hid_cursor: false,
            passes: 0,
            shared: false,
        })
    }
    /// Post-process a shared surface: its retained backing is the scene (see
    /// `external_scene`), the cursor trail is dropped (a surface draws many
    /// terminals, not one cursor), CRT corners outside the tube and custom
    /// shader output outside terminal coverage stay transparent.
    pub fn for_shared_surface(&mut self) {
        self.shared = true;
        self.settings.trail = None;
    }
    /// Use `scene` (a texture the caller draws and keeps) as the post-process
    /// source. Call again after replacing that texture.
    pub fn external_scene(
        &mut self,
        device: &wgpu::Device,
        scene: &wgpu::TextureView,
        width: u32,
        height: u32,
    ) {
        self.targets = Some(self.build_targets(device, width, height, Some(scene)));
        self.scene_valid = true;
    }
    /// Keep cursor and timing state when settings change at runtime.
    pub fn inherit(&mut self, previous: &Effects) {
        self.cursor.known = previous.cursor.known;
        self.cursor.target = previous.cursor.target;
        self.cursor.previous = previous.cursor.previous;
        self.cursor.head_from = previous.cursor.target;
        self.cursor.tail_from = previous.cursor.target;
        self.cursor.visible = previous.cursor.visible;
        self.cursor.color = previous.cursor.color;
        self.cursor.started = f64::NEG_INFINITY;
        self.cursor.changed = previous.cursor.changed;
        self.mouse = previous.mouse;
        self.epoch = previous.epoch;
    }
    pub fn set_mouse(&mut self, mouse: [f32; 4]) {
        if self.custom.is_some() && mouse != self.mouse {
            self.mouse = mouse;
            self.mouse_dirty = true;
        }
    }
    /// Track the cursor from the frame's terminal uniforms
    /// (`grid`, `theme`, cell size) before they are written.
    pub fn observe(&mut self, grid: [u32; 4], theme: [u32; 4], cell: [f32; 2], now: f64) {
        let cols = grid[0].max(1);
        let (x, y) = (
            (grid[2] % cols) as f32 * cell[0],
            (grid[2] / cols) as f32 * cell[1],
        );
        let rect = match (grid[3] >> 1) & 7 {
            0 => {
                let custom = (theme[3] >> 8) as f32;
                let width = if custom > 0. {
                    custom
                } else {
                    (cell[0] * 0.13).max(1.)
                };
                [x, y, width, cell[1]]
            }
            2 => [x, y + cell[1] - 2., cell[0], 2.],
            _ => [x, y, cell[0], cell[1]],
        };
        let c = theme[0];
        let color = [
            (c & 255) as f32 / 255.,
            ((c >> 8) & 255) as f32 / 255.,
            ((c >> 16) & 255) as f32 / 255.,
        ];
        self.cursor
            .observe(rect, grid[3] & 1 != 0, color, now, self.settings.trail);
    }
    /// The animated cursor replaces the native one while it moves.
    pub fn hide_cursor(&self, now: f64) -> bool {
        self.cursor.animating(now, self.settings.trail)
    }
    fn animating(&self, now: f64) -> bool {
        (self.custom.is_some() && (self.settings.animate || self.mouse_dirty))
            || self.hide_cursor(now)
    }
    /// The retained scene no longer matches what should be drawn.
    pub fn scene_stale(&self, now: f64, width: u32, height: u32) -> bool {
        !self.scene_valid
            || self.scene_hid_cursor != self.hide_cursor(now)
            || self
                .targets
                .as_ref()
                .is_none_or(|t| t.width != width || t.height != height)
    }
    /// A post-only frame (scene reused) is due.
    pub fn wants_post(&self, now: f64) -> bool {
        self.animating(now)
    }
    /// The scene texture the terminal pass renders into.
    pub fn scene(&mut self, device: &wgpu::Device, width: u32, height: u32) {
        if self
            .targets
            .as_ref()
            .is_none_or(|t| t.width != width || t.height != height)
        {
            self.targets = Some(self.build_targets(device, width, height, None));
            self.scene_valid = false;
        }
    }
    /// The scene view; `scene` must have prepared it for this frame.
    pub fn scene_view(&self) -> &wgpu::TextureView {
        &self
            .targets
            .as_ref()
            .expect("effect targets prepared")
            .scene_view
    }
    pub fn scene_drawn(&mut self, hid_cursor: bool) {
        self.scene_valid = true;
        self.scene_hid_cursor = hid_cursor;
    }
    fn bind(
        &self,
        device: &wgpu::Device,
        source: &wgpu::TextureView,
        glow: &wgpu::TextureView,
    ) -> wgpu::BindGroup {
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Wraith effect pass"),
            layout: &self.layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: self.fx.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(source),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::Sampler(&self.sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::TextureView(glow),
                },
            ],
        })
    }
    fn build_targets(
        &self,
        device: &wgpu::Device,
        width: u32,
        height: u32,
        scene: Option<&wgpu::TextureView>,
    ) -> Targets {
        let scene_view = match scene {
            Some(view) => view.clone(),
            None => texture(device, self.format, width, height, "Wraith effect scene"),
        };
        let (mut half_a, mut half_b) = (None, None);
        let (mut blur_h, mut blur_v) = (None, None);
        if self.blur.is_some() {
            let (w, h) = (width.div_ceil(2), height.div_ceil(2));
            let a = texture(device, self.format, w, h, "Wraith bloom A");
            let b = texture(device, self.format, w, h, "Wraith bloom B");
            blur_h = Some(self.bind(device, &scene_view, &scene_view));
            blur_v = Some(self.bind(device, &a, &a));
            half_a = Some(a);
            half_b = Some(b);
        }
        let composite = self
            .composite
            .as_ref()
            .map(|_| self.bind(device, &scene_view, half_b.as_ref().unwrap_or(&scene_view)));
        let mut post = None;
        let custom = self.custom.as_ref().map(|_| {
            if self.composite.is_some() {
                let view = texture(device, self.format, width, height, "Wraith effect output");
                let group = self.bind(device, &view, &view);
                post = Some(view);
                group
            } else {
                self.bind(device, &scene_view, &scene_view)
            }
        });
        Targets {
            width,
            height,
            scene_view,
            composite,
            blur_h,
            blur_v,
            custom,
            half_a,
            half_b,
            post,
        }
    }
    /// Encode the post passes from the scene texture to `output`.
    pub fn post(
        &mut self,
        queue: &wgpu::Queue,
        encoder: &mut wgpu::CommandEncoder,
        output: &wgpu::TextureView,
        now: f64,
    ) {
        let Some(targets) = &self.targets else {
            return;
        };
        let (width, height) = (targets.width as f32, targets.height as f32);
        let trail = self.settings.trail.filter(|_| self.hide_cursor(now));
        let (head, tail) = match trail {
            Some(d) => self.cursor.positions(now, d as f64),
            None => (self.cursor.target, self.cursor.target),
        };
        let c = self.cursor.color;
        let crt = self.settings.crt;
        let bloom = self.settings.bloom.unwrap_or_default();
        let seconds = |ms: f64| ((ms - self.epoch) / 1000.) as f32;
        let uniforms = Fx {
            resolution: [width, height, 1. / width, 1. / height],
            crt: crt.unwrap_or_default(),
            bloom: [bloom[0], bloom[1], bloom[2], 0.],
            head,
            tail,
            cursor_color: [c[0], c[1], c[2], 1.],
            time: [
                seconds(now),
                ((now - self.last_post) / 1000.) as f32,
                self.frame as f32,
                seconds(self.cursor.changed),
            ],
            mouse: self.mouse,
            cursor: self.cursor.target,
            previous: self.cursor.previous,
            flags: [
                crt.is_some() as u32
                    | (self.settings.bloom.is_some() as u32) << 1
                    | (trail.is_some() as u32) << 2,
                self.shared as u32,
                0,
                0,
            ],
        };
        queue.write_buffer(&self.fx, 0, bytemuck::bytes_of(&uniforms));
        self.last_post = now;
        self.frame = self.frame.wrapping_add(1);
        self.mouse_dirty = false;
        let mut passes = 0;
        let mut run = |pipeline: &wgpu::RenderPipeline,
                       group: &wgpu::BindGroup,
                       view: &wgpu::TextureView,
                       label: &str| {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some(label),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                ..Default::default()
            });
            pass.set_pipeline(pipeline);
            pass.set_bind_group(0, group, &[]);
            pass.draw(0..3, 0..1);
            passes += 1;
        };
        if let (Some((h, v)), Some(a), Some(b)) = (&self.blur, &targets.half_a, &targets.half_b) {
            run(h, targets.blur_h.as_ref().unwrap(), a, "Wraith bloom H");
            run(v, targets.blur_v.as_ref().unwrap(), b, "Wraith bloom V");
        }
        if let Some(p) = &self.composite {
            let view = targets.post.as_ref().unwrap_or(output);
            run(
                p,
                targets.composite.as_ref().unwrap(),
                view,
                "Wraith composite",
            );
        }
        if let Some(p) = &self.custom {
            run(
                p,
                targets.custom.as_ref().unwrap(),
                output,
                "Wraith custom shader",
            );
        }
        self.passes = passes;
    }
}
