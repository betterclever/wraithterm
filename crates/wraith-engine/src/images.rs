//! GPU textures and draws for Kitty graphics placements. Textures are keyed by
//! image id and Ghostty's per-image generation: a static image uploads once, and
//! a same-size replacement (an animation or video frame) reuses its texture.
use crate::core::{Core, Placement};
use bytemuck::{Pod, Zeroable};
use std::collections::HashMap;

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct Quad {
    dst: [f32; 4],
    src: [f32; 4],
}
struct Texture {
    generation: u64,
    width: u32,
    height: u32,
    texture: wgpu::Texture,
    bind: wgpu::BindGroup,
    last_used: u64,
}
/// Resident image textures beyond this are evicted, least recently used first,
/// keeping only those drawn in the current frame.
const TEXTURE_BUDGET: u64 = 256 << 20;
/// Textures unused for this many presented frames are released.
const IDLE_FRAMES: u64 = 600;

pub struct ImageLayer {
    pipeline: wgpu::RenderPipeline,
    sampler: wgpu::Sampler,
    quads: wgpu::Buffer,
    capacity: usize,
    globals: wgpu::BindGroup,
    textures: HashMap<u32, Texture>,
    /// (layer, image id) per quad, in draw order.
    draws: Vec<(u32, u32)>,
    staged: Vec<Quad>,
    scratch: Vec<u8>,
    /// Placements and storage generation the current quads were built from.
    placements: Vec<Placement>,
    generation: u64,
    frame: u64,
    pub upload_bytes: u64,
    pub uploads: u64,
}
impl ImageLayer {
    pub fn new(device: &wgpu::Device, format: wgpu::TextureFormat, uniform: &wgpu::Buffer) -> Self {
        let (pipeline, sampler) = Self::pipeline(device, format, false);
        Self::with_pipeline(device, pipeline, sampler, uniform)
    }
    /// The image quad pipeline and sampler for one target format. A shared
    /// surface builds them once for all of its terminals.
    pub fn pipeline(
        device: &wgpu::Device,
        format: wgpu::TextureFormat,
        shared: bool,
    ) -> (wgpu::RenderPipeline, wgpu::Sampler) {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Wraith Kitty graphics WGSL"),
            source: wgpu::ShaderSource::Wgsl(include_str!("image.wgsl").into()),
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Wraith image quads"),
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
                    blend: Some(crate::gpu::blend(shared)),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            primitive: Default::default(),
            depth_stencil: None,
            multisample: Default::default(),
            multiview_mask: None,
            cache: None,
        });
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("Wraith image sampler"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        (pipeline, sampler)
    }
    pub fn with_pipeline(
        device: &wgpu::Device,
        pipeline: wgpu::RenderPipeline,
        sampler: wgpu::Sampler,
        uniform: &wgpu::Buffer,
    ) -> Self {
        let capacity = 16;
        let quads = Self::quad_buffer(device, capacity);
        let globals = Self::globals(device, &pipeline, uniform, &quads, &sampler);
        Self {
            pipeline,
            sampler,
            quads,
            capacity,
            globals,
            textures: HashMap::new(),
            draws: Vec::new(),
            staged: Vec::new(),
            scratch: Vec::new(),
            placements: Vec::new(),
            generation: 0,
            frame: 0,
            upload_bytes: 0,
            uploads: 0,
        }
    }
    fn quad_buffer(device: &wgpu::Device, capacity: usize) -> wgpu::Buffer {
        device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Wraith image quads"),
            size: (capacity * std::mem::size_of::<Quad>()) as u64,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        })
    }
    fn globals(
        device: &wgpu::Device,
        pipeline: &wgpu::RenderPipeline,
        uniform: &wgpu::Buffer,
        quads: &wgpu::Buffer,
        sampler: &wgpu::Sampler,
    ) -> wgpu::BindGroup {
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Wraith image globals"),
            layout: &pipeline.get_bind_group_layout(0),
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: uniform.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: quads.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::Sampler(sampler),
                },
            ],
        })
    }
    /// Whether any placement draws below cell backgrounds.
    pub fn below_background(&self) -> bool {
        self.draws.first().is_some_and(|d| d.0 == 1)
    }
    /// Upload stale textures and rebuild quads when placements changed.
    /// Placements without resident pixels (a pending payload, or a size the GPU
    /// cannot hold) are skipped.
    pub fn prepare(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        uniform: &wgpu::Buffer,
        core: &Core,
    ) {
        self.frame += 1;
        let placements = core.placements();
        if placements.is_empty() && self.textures.is_empty() {
            self.draws.clear();
            self.placements.clear();
            return;
        }
        if placements != self.placements || core.image_generation() != self.generation {
            self.generation = core.image_generation();
            self.staged.clear();
            self.draws.clear();
            let limit = device.limits().max_texture_dimension_2d;
            for p in placements {
                let Some(texture) = self.texture(device, queue, core, p, limit) else {
                    continue;
                };
                let (w, h) = (texture.width as f32, texture.height as f32);
                self.staged.push(Quad {
                    dst: [p.x as f32, p.y as f32, p.width as f32, p.height as f32],
                    src: [
                        p.source_x as f32 / w,
                        p.source_y as f32 / h,
                        (p.source_x + p.source_width) as f32 / w,
                        (p.source_y + p.source_height) as f32 / h,
                    ],
                });
                self.draws.push((p.layer, p.image_id));
            }
            if self.staged.len() > self.capacity {
                self.capacity = self.staged.len().next_power_of_two();
                self.quads = Self::quad_buffer(device, self.capacity);
                self.globals =
                    Self::globals(device, &self.pipeline, uniform, &self.quads, &self.sampler);
            }
            if !self.staged.is_empty() {
                queue.write_buffer(&self.quads, 0, bytemuck::cast_slice(&self.staged));
            }
            self.placements.clear();
            self.placements.extend_from_slice(placements);
        }
        for &(_, id) in &self.draws {
            if let Some(t) = self.textures.get_mut(&id) {
                t.last_used = self.frame;
            }
        }
        self.evict();
    }
    fn texture(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        core: &Core,
        p: &Placement,
        limit: u32,
    ) -> Option<&Texture> {
        let fresh = self
            .textures
            .get(&p.image_id)
            .is_some_and(|t| t.generation == p.generation);
        if !fresh {
            let image = core.image(p.image_id)?;
            if image.width == 0 || image.height == 0 || image.width > limit || image.height > limit
            {
                return None;
            }
            let reuse = self
                .textures
                .get(&p.image_id)
                .is_some_and(|t| t.width == image.width && t.height == image.height);
            if !reuse {
                let texture = device.create_texture(&wgpu::TextureDescriptor {
                    label: Some("Wraith Kitty image"),
                    size: wgpu::Extent3d {
                        width: image.width,
                        height: image.height,
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
                let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("Wraith Kitty image binding"),
                    layout: &self.pipeline.get_bind_group_layout(1),
                    entries: &[wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(&view),
                    }],
                });
                self.textures.insert(
                    p.image_id,
                    Texture {
                        generation: 0,
                        width: image.width,
                        height: image.height,
                        texture,
                        bind,
                        last_used: self.frame,
                    },
                );
            }
            // RGBA uploads straight from Ghostty's storage; other formats
            // expand once into reusable scratch.
            let rgba = if image.format == crate::image::RGBA {
                image.pixels
            } else {
                self.scratch
                    .resize(image.width as usize * image.height as usize * 4, 0);
                if !crate::image::expand(image.format, image.pixels, &mut self.scratch) {
                    return None;
                }
                &self.scratch
            };
            let entry = self.textures.get_mut(&p.image_id)?;
            queue.write_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: &entry.texture,
                    mip_level: 0,
                    origin: wgpu::Origin3d::ZERO,
                    aspect: wgpu::TextureAspect::All,
                },
                rgba,
                wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(image.width * 4),
                    rows_per_image: Some(image.height),
                },
                wgpu::Extent3d {
                    width: image.width,
                    height: image.height,
                    depth_or_array_layers: 1,
                },
            );
            entry.generation = image.generation;
            self.upload_bytes += rgba.len() as u64;
            self.uploads += 1;
        }
        self.textures.get(&p.image_id)
    }
    fn evict(&mut self) {
        let frame = self.frame;
        self.textures
            .retain(|_, t| frame.saturating_sub(t.last_used) < IDLE_FRAMES);
        let resident = |t: &HashMap<u32, Texture>| {
            t.values()
                .map(|t| t.width as u64 * t.height as u64 * 4)
                .sum::<u64>()
        };
        while resident(&self.textures) > TEXTURE_BUDGET {
            let oldest = self
                .textures
                .iter()
                .filter(|(_, t)| t.last_used != frame)
                .min_by_key(|(_, t)| t.last_used)
                .map(|(&id, _)| id);
            let Some(id) = oldest else { break };
            self.textures.remove(&id);
        }
    }
    /// Draw this frame's quads in one z-layer (1 below backgrounds, 2 below
    /// text, 3 above text).
    pub fn draw(&self, pass: &mut wgpu::RenderPass<'_>, layer: u32) {
        let mut bound = false;
        for (index, &(l, id)) in self.draws.iter().enumerate() {
            if l != layer {
                continue;
            }
            let Some(texture) = self.textures.get(&id) else {
                continue;
            };
            if !bound {
                pass.set_pipeline(&self.pipeline);
                pass.set_bind_group(0, &self.globals, &[]);
                bound = true;
            }
            pass.set_bind_group(1, &texture.bind, &[]);
            pass.draw(0..6, index as u32..index as u32 + 1);
        }
    }
}
