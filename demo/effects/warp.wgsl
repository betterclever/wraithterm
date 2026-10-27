// Hyperspace: star streaks race out from the centre behind the text, and
// every keystroke kicks the ship forward for a moment.
fn hash2(p: vec2<f32>) -> f32 {
    return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453);
}
fn mainImage(fragCoord: vec2<f32>) -> vec4<f32> {
    let res = iResolution.xy;
    let uv = fragCoord / res;
    let c = textureSample(iChannel0, iChannel0Sampler, uv);
    // The bottom-right pixel is terminal background; anything far from it is ink.
    let bg = textureSample(iChannel0, iChannel0Sampler, (res - vec2<f32>(3.0)) / res).rgb;
    let ink = smoothstep(0.03, 0.15, distance(c.rgb, bg));
    let p = (fragCoord - res * 0.5) / res.y;
    let angle = atan2(p.y, p.x);
    let radius = length(p);
    let boost = 1.0 + 3.0 * exp(-(iTime - iTimeCursorChange) * 4.0);
    var stars = 0.0;
    for (var layer = 0; layer < 3; layer = layer + 1) {
        let lanes = 90.0 + f32(layer) * 70.0;
        let lane = floor((angle / 6.2831 + 0.5) * lanes);
        let seed = hash2(vec2<f32>(lane, f32(layer)));
        let speed = (0.35 + seed * 0.9) * boost;
        let z = fract(seed * 7.0 + iTime * speed * 0.25);
        let head = z * z * 1.4;
        let len = 0.04 + 0.25 * z * z * boost * 0.4;
        let along = smoothstep(head - len, head, radius) * step(radius, head);
        let width = abs(fract((angle / 6.2831 + 0.5) * lanes) - 0.5);
        stars = stars + along * smoothstep(0.18, 0.0, width) * z * step(0.55, seed);
    }
    let tint = mix(vec3<f32>(0.45, 0.65, 1.0), vec3<f32>(1.0, 0.85, 0.7), fract(angle * 3.0));
    let glow = 0.06 * exp(-radius * 5.0) * vec3<f32>(0.4, 0.5, 1.0);
    let space = bg + tint * stars * 0.9 + glow * boost;
    return vec4<f32>(mix(space, c.rgb, ink), c.a);
}
