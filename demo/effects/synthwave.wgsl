// Synthwave: a dusk sky, a striped retro sun and a neon grid rolling toward
// you, all behind the text.
fn mainImage(fragCoord: vec2<f32>) -> vec4<f32> {
    let res = iResolution.xy;
    let uv = fragCoord / res;
    let c = textureSample(iChannel0, iChannel0Sampler, uv);
    let bg = textureSample(iChannel0, iChannel0Sampler, (res - vec2<f32>(3.0)) / res).rgb;
    let ink = smoothstep(0.03, 0.15, distance(c.rgb, bg));
    let p = vec2<f32>((fragCoord.x - res.x * 0.5) / res.y, 1.0 - uv.y);
    let horizon = 0.38;
    // Sky: deep violet into magenta at the horizon.
    let skyT = clamp((p.y - horizon) / (1.0 - horizon), 0.0, 1.0);
    var col = mix(vec3<f32>(0.42, 0.08, 0.38), vec3<f32>(0.04, 0.02, 0.10), pow(skyT, 0.6));
    // Sun with the classic horizontal cut-outs.
    let sunCenter = vec2<f32>(0.0, horizon + 0.2);
    let sd = length(p - sunCenter);
    let stripes = step(0.0, sin((p.y - horizon) * 120.0 - iTime * 2.0) + (p.y - horizon) * 14.0 - 1.4);
    let sunMask = smoothstep(0.24, 0.235, sd) * select(stripes, 1.0, p.y > sunCenter.y);
    let sunCol = mix(vec3<f32>(1.0, 0.25, 0.55), vec3<f32>(1.0, 0.85, 0.3), clamp((p.y - horizon) / 0.42, 0.0, 1.0));
    col = mix(col, sunCol, sunMask * step(horizon, p.y));
    col = col + vec3<f32>(1.0, 0.3, 0.6) * exp(-sd * 6.0) * 0.25 * step(horizon, p.y);
    // Ground: a perspective grid scrolling toward the viewer.
    let below = horizon - p.y;
    if below > 0.0 {
        let z = 0.35 / below;
        let gx = p.x * z;
        let gz = z + iTime * 1.6;
        // Distance to the nearest grid line, widened with distance so far
        // lines stay visible instead of shimmering.
        let fx = 0.5 - abs(fract(gx) - 0.5);
        let fz = 0.5 - abs(fract(gz) - 0.5);
        let wx = 0.03 * z;
        let wz = 0.04 * z;
        let lineX = smoothstep(wx, 0.0, fx);
        let lineZ = smoothstep(wz, 0.0, fz);
        let fade = clamp(2.0 - z * 0.15, 0.0, 1.0);
        let grid = max(lineX, lineZ) * fade;
        col = vec3<f32>(0.04, 0.0, 0.07) + vec3<f32>(1.0, 0.25, 0.9) * grid;
        col = col + vec3<f32>(0.9, 0.2, 0.7) * exp(-below * 25.0) * 0.5;
    }
    // Keep the scene dim enough that text reads clearly over it.
    let scene = mix(bg, col, 0.6);
    return vec4<f32>(mix(scene, c.rgb * 1.08, ink), c.a);
}
