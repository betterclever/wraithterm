// Kitty graphics placements: one textured quad per instance, in viewport pixels.
struct Uniforms {
    view: vec4<f32>, // viewport width/height, cell width/height
    grid: vec4<u32>,
    theme: vec4<u32>,
    text: vec4<f32>,
    images: vec4<u32>,
}
struct Quad {
    dst: vec4<f32>, // x, y, width, height in pixels
    src: vec4<f32>, // u0, v0, u1, v1
}
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read> quads: array<Quad>;
@group(0) @binding(2) var image_sampler: sampler;
@group(1) @binding(0) var image: texture_2d<f32>;
struct Vertex {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
}
@vertex fn vs(@builtin(vertex_index) vertex: u32, @builtin(instance_index) index: u32) -> Vertex {
    let points = array<vec2<f32>, 6>(vec2(0.,0.), vec2(1.,0.), vec2(0.,1.), vec2(0.,1.), vec2(1.,0.), vec2(1.,1.));
    let p = points[vertex];
    let q = quads[index];
    let pixel = q.dst.xy + p * q.dst.zw;
    var output: Vertex;
    output.position = vec4<f32>(pixel.x / u.view.x * 2. - 1., 1. - pixel.y / u.view.y * 2., 0., 1.);
    output.uv = mix(q.src.xy, q.src.zw, p);
    return output;
}
@fragment fn fs(v: Vertex) -> @location(0) vec4<f32> {
    // One mip level; unscaled placements land on texel centers and stay exact.
    return textureSampleLevel(image, image_sampler, v.uv, 0.);
}
