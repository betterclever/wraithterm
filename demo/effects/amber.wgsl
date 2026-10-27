// Amber phosphor: a monochrome tube with a faint horizontal persistence haze.
fn mainImage(fragCoord: vec2<f32>) -> vec4<f32> {
    let uv = fragCoord / iResolution.xy;
    let c = textureSample(iChannel0, iChannel0Sampler, uv);
    let px = 3.0 / iResolution.x;
    var haze = 0.;
    for (var i = -2; i <= 2; i++) {
        let s = textureSample(iChannel0, iChannel0Sampler, uv + vec2<f32>(f32(i) * px, 0.)).rgb;
        haze += dot(s, vec3<f32>(0.3, 0.59, 0.11));
    }
    let luma = dot(c.rgb, vec3<f32>(0.3, 0.59, 0.11));
    let level = luma * 1.1 + haze * 0.05;
    let amber = vec3<f32>(1.0, 0.69, 0.18);
    return vec4<f32>(amber * level + vec3<f32>(0.035, 0.02, 0.0), c.a);
}
