// Rain on glass: the window fogs slightly, beads cling to it, and heavier
// drops slide down, refracting the terminal and wiping a clear trail.
fn hash(n: f32) -> f32 {
    return fract(sin(n * 78.233) * 43758.5453);
}
// One layer of sliding drops in units of the window height. Returns the
// refraction offset (xy) and how much glass the drop and its trail clear (z).
fn slide(p: vec2<f32>, t: f32, size: f32, seed: f32) -> vec3<f32> {
    let column = floor(p.x * size);
    let h = hash(column + seed);
    let lx = fract(p.x * size) - 0.5;
    let ty = p.y * size * 0.5 + h * 3.0;
    let row = floor(ty);
    let ly = fract(ty);
    let k = hash(column * 7.1 + row * 3.3 + seed);
    // Drops cling, then slip: a slow start and a fast finish.
    let phase = fract(t * (0.12 + k * 0.1) + k);
    let y = 0.1 + 0.8 * phase * phase;
    let x = sin(y * 9.0 + k * 40.0) * 0.18;
    let d = vec2<f32>(lx - x, (ly - y) * 2.0);
    let radius = 0.16 + 0.08 * k;
    let drop = smoothstep(radius, radius * 0.7, length(d)) * step(0.6, k);
    let trail = smoothstep(0.08, 0.03, abs(lx - x)) * smoothstep(y - 0.6, y, ly) * step(ly, y) * step(0.6, k);
    // Small droplets left behind in the trail.
    let bead = vec2<f32>(lx - x, (fract(ly * 7.0) - 0.5) / 3.5);
    let beads = smoothstep(0.06, 0.035, length(bead)) * trail;
    let offset = d * drop * 0.9 + bead * beads * 0.6;
    return vec3<f32>(offset / size, max(drop, trail * 0.8));
}
fn mainImage(fragCoord: vec2<f32>) -> vec4<f32> {
    let res = iResolution.xy;
    let uv = fragCoord / res;
    let p = fragCoord / res.y;
    let a = slide(p, iTime, 6.0, 1.0);
    let b = slide(p * 1.6 + vec2<f32>(0.31, 0.0), iTime * 1.2, 6.0, 5.0);
    // Static beads on the glass.
    let g = p * 34.0;
    let gid = floor(g);
    let gh = hash(gid.x * 3.1 + gid.y * 17.3);
    let gc = fract(g) - vec2<f32>(hash(gh * 9.0), hash(gh * 4.0)) * 0.5 - 0.25;
    let gr = 0.06 + (gh - 0.85) * 0.6;
    let gb = smoothstep(gr, gr * 0.6, length(gc)) * step(0.85, gh);
    let bend = a.xy + b.xy * 0.6 + gc * gb / 34.0 * 1.5;
    let clear = clamp(a.z + b.z + gb, 0.0, 1.0);
    // Fogged glass: a soft blur, lifted and cooled.
    let px = 2.5 / res;
    var fog = textureSample(iChannel0, iChannel0Sampler, uv).rgb * 0.2;
    fog = fog + textureSample(iChannel0, iChannel0Sampler, uv + vec2<f32>(px.x, 0.0)).rgb * 0.2;
    fog = fog + textureSample(iChannel0, iChannel0Sampler, uv - vec2<f32>(px.x, 0.0)).rgb * 0.2;
    fog = fog + textureSample(iChannel0, iChannel0Sampler, uv + vec2<f32>(0.0, px.y)).rgb * 0.2;
    fog = fog + textureSample(iChannel0, iChannel0Sampler, uv - vec2<f32>(0.0, px.y)).rgb * 0.2;
    fog = fog * 0.9 + vec3<f32>(0.025, 0.032, 0.045);
    // Through the water: sharp, slightly magnified and refracted.
    let through = textureSample(iChannel0, iChannel0Sampler, uv - bend * vec2<f32>(res.y / res.x, 1.0) * 1.2);
    let rim = smoothstep(0.2, 0.9, clear) * smoothstep(1.0, 0.6, clear);
    // A highlight on the upper left of each drop, where the light catches it.
    let shine = smoothstep(0.5, -2.5, (bend.x + bend.y) * 60.0) * clear * clear;
    let water = through.rgb * 1.08 + vec3<f32>(0.03, 0.04, 0.055);
    let rgb = mix(fog, water, clear) + vec3<f32>(0.6, 0.75, 0.9) * (rim * 0.15 + shine * 0.25);
    return vec4<f32>(rgb, through.a);
}
