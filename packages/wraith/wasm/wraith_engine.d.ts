/* tslint:disable */
/* eslint-disable */

/**
 * Stateless Rust/WebGPU compositor for the xterm-compatible semantic core.
 */
export class Compositor {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Advance effect animations over the last submitted frame.
     */
    animate(): boolean;
    configure(cols: number, rows: number, width: number, height: number): void;
    static create(canvas: OffscreenCanvas): Promise<Compositor>;
    /**
     * Wait for submitted GPU work. Call only while the renderer is paused;
     * the Wasm borrow remains live until the asynchronous fence completes.
     */
    fence(): Promise<void>;
    render(packed: Uint32Array, start: number, dimensions: Float32Array, frame: Uint32Array): boolean;
    /**
     * Retain previous GPU row slots using the staged source map, uploading
     * only new logical rows. Cells and uniforms keep the legacy arena layout.
     */
    render_retained(): boolean;
    /**
     * Upload staged cells `start..start + cells` (indices into the grid, at
     * the same offsets in staging) and present with the staged uniforms.
     */
    render_staged(cells: number, start: number): boolean;
    set_effect_mouse(x: number, y: number, z: number, w: number): void;
    /**
     * See `Engine::set_effects`. Call only while rendering is paused.
     */
    set_effects(params: Float32Array, shader?: string | null): Promise<void>;
    set_transparency(enabled: boolean): void;
    upload(x: number, y: number, width: number, height: number, pixels: Uint8Array): void;
    /**
     * An effect animation wants another display frame.
     */
    readonly animating: boolean;
    readonly cell_upload_bytes: bigint;
    readonly effect_passes: number;
    readonly frames: bigint;
    readonly row_map_upload_bytes: bigint;
    readonly row_slots: Uint32Array;
    /**
     * Cell words followed by four f32 dimensions and eight u32 frame words.
     * Views are valid until configure/free; refresh them after memory growth.
     * Fill them only between synchronous calls, with rendering paused at fences.
     */
    readonly staging_ptr: number;
    readonly staging_words: number;
}

export class Engine {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    add_font(bytes: Uint8Array): void;
    /**
     * One block in the `commands()` layout, or undefined.
     */
    command(id: number): any;
    command_marks(): Int32Array;
    command_text(id: number, input: boolean): any;
    commands(): Array<any>;
    /**
     * Construct and validate the entire new atlas before changing live state.
     */
    configure_font(font: Uint8Array, fallbacks: Array<any>, size: number, line_height: number): Uint32Array;
    static create(canvas: OffscreenCanvas, font: Uint8Array, cols: number, rows: number, font_size: number, line_height: number, history: number): Promise<Engine>;
    /**
     * A terminal drawn into a worker's shared surface. Terminals with the
     * same fonts, size, line height and ligature setting share one atlas.
     */
    static create_shared(context: SurfaceContext, font: Uint8Array, fallbacks: Array<any>, cols: number, rows: number, font_size: number, line_height: number, history: number, ligatures: boolean): Promise<Engine>;
    /**
     * Draw this terminal's staged frame into `surface`'s open frame at device
     * pixel `x`, `y` and `scale`, clipped to the given rectangle. Returns
     * false if it has nothing drawable (render it first) or is fully clipped.
     */
    draw(surface: Surface, x: number, y: number, scale: number, clip_x: number, clip_y: number, clip_width: number, clip_height: number): boolean;
    fence(): Promise<void>;
    image_upload_bytes(): number;
    /**
     * Kitty graphics textures uploaded and their bytes, for diagnostics.
     */
    image_uploads(): number;
    /**
     * The new viewport offset, or -1 when there is no prompt in that direction.
     */
    jump_to_prompt(direction: number): number;
    key(key: number, mods: number, action: number, text: string, unshifted: number): void;
    link(x: number, y: number): string;
    metrics(): Float64Array;
    mode(mode: number): boolean;
    mouse(action: number, button: number, mods: number, x: number, y: number, pressed: number): void;
    /**
     * Calls `done` when the GPU has finished all work submitted so far.
     * Unlike `fence`, this returns at once and holds no borrow while waiting.
     */
    on_submitted_work_done(done: Function): void;
    /**
     * Rasterize printable ASCII ahead of first use, `count` glyphs per call,
     * so idle time after creation absorbs that work. Returns where to
     * continue, or -1 when done.
     */
    prefill_glyphs(from: number, count: number): number;
    release_hold(): void;
    render(time: number, force: boolean): boolean;
    resize(cols: number, rows: number): void;
    /**
     * Total rows, viewport offset and length, cursor screen row and column,
     * and 1 when the primary screen is active.
     */
    screen(): Float64Array;
    scroll(delta: number): void;
    search(needle: string, action: number): Uint32Array;
    select(x1: number, y1: number, x2: number, y2: number): void;
    select_mode(x1: number, y1: number, x2: number, y2: number, mode: number): void;
    /**
     * Shadertoy `iMouse` in physical pixels.
     */
    set_effect_mouse(x: number, y: number, z: number, w: number): void;
    /**
     * Replace post-process effects (see `effect_state::Settings::parse`).
     * Rejects with compiler messages and keeps the previous effects when a
     * custom shader is invalid. Call only while rendering is paused.
     */
    set_effects(params: Float32Array, shader?: string | null): Promise<void>;
    /**
     * Decoded Kitty graphics bytes each screen may store; zero disables them.
     */
    set_image_limit(bytes: number): void;
    /**
     * Shape operator runs together to form programming-font ligatures.
     */
    set_ligatures(enabled: boolean): void;
    take_events(): Array<any>;
    text(selected: boolean): string;
    theme(fg: number, bg: number, cursor: number): void;
    write(bytes: Uint8Array): void;
    readonly adapter: string;
    readonly cell_height: number;
    readonly cell_upload_bytes: bigint;
    readonly cell_width: number;
    readonly cursor_x: number;
    readonly cursor_y: number;
    /**
     * Whether a staged frame referencing the current atlas is ready to draw.
     */
    readonly drawable: boolean;
    /**
     * Post-process passes in the last effect frame; zero with effects off.
     */
    readonly effect_passes: number;
    /**
     * OSC 133 command blocks; see `commands.rs`.
     */
    readonly has_commands: boolean;
    readonly needs_present: boolean;
    readonly row_map_upload_bytes: bigint;
}

/**
 * Headless browser instance for tests, replay, and serverless terminal analysis.
 */
export class Headless {
    free(): void;
    [Symbol.dispose](): void;
    cell(x: number, y: number): Array<any>;
    /**
     * One block in the `commands()` layout, or undefined.
     */
    command(id: number): any;
    command_marks(): Int32Array;
    command_text(id: number, input: boolean): any;
    commands(): Array<any>;
    /**
     * Hash of the visible grid, colours and cursor as hex; see `Core::digest`.
     */
    digest(): string;
    /**
     * The new viewport offset, or -1 when there is no prompt in that direction.
     */
    jump_to_prompt(direction: number): number;
    key(key: number, mods: number, action: number, text: string, unshifted: number): void;
    mode(mode: number): boolean;
    constructor(cols: number, rows: number, history: number);
    release_hold(): void;
    resize(cols: number, rows: number): void;
    /**
     * Total rows, viewport offset and length, cursor screen row and column,
     * and 1 when the primary screen is active.
     */
    screen(): Float64Array;
    scroll(delta: number): void;
    search(needle: string, action: number): Uint32Array;
    /**
     * Terminal state as VT sequences for replay keyframes; see `Core::snapshot`.
     */
    snapshot(): Uint8Array;
    take_events(): Array<any>;
    text(): string;
    write(data: Uint8Array): void;
    /**
     * OSC 133 command blocks; see `commands.rs`.
     */
    readonly has_commands: boolean;
}

/**
 * A worker's shared terminal surface: one canvas, swap chain and backing.
 */
export class Surface {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Start a frame into the backing. `clear` empties it first (geometry
     * changed); otherwise unchanged terminals keep their pixels.
     */
    begin(clear: boolean): void;
    context(): SurfaceContext;
    /**
     * Create the worker's surface on its shared device. `width` and `height`
     * are device pixels.
     */
    static create(canvas: OffscreenCanvas, width: number, height: number): Promise<Surface>;
    /**
     * Finish the frame: copy the backing to the canvas and present. `updates`
     * counts terminals drawn with new content, for GPU-completion counters.
     * Returns false when the canvas texture was unavailable; the backing is
     * kept and the next frame presents it.
     */
    end(updates: number): boolean;
    /**
     * Resize to the page's device-pixel size. The backing starts empty, so
     * the next frame must redraw every visible terminal.
     */
    resize(width: number, height: number): void;
    /**
     * Shadertoy `iMouse` in physical pixels of the surface.
     */
    set_effect_mouse(x: number, y: number, z: number, w: number): void;
    /**
     * Replace post-process effects over the whole surface (parameters as in
     * `Engine::set_effects`; the cursor trail does not apply). Pipelines are
     * validated first, so an invalid shader rejects and keeps the current
     * effects. Turning effects on or off empties the backing: redraw every
     * visible terminal next frame. Call only between frames.
     */
    set_effects(params: Float32Array, shader?: string | null): Promise<void>;
    /**
     * Distinct live glyph atlases on this surface.
     */
    readonly atlases: number;
    /**
     * Presented frames whose GPU work has completed.
     */
    readonly completed_frames: number;
    /**
     * Terminal updates (new content drawn) whose GPU work has completed.
     */
    readonly completed_updates: number;
    /**
     * Post-process passes in the last frame; zero with effects off.
     */
    readonly effect_passes: number;
    /**
     * An effect animation wants a frame even though no terminal changed.
     */
    readonly effects_due: boolean;
    /**
     * Frames submitted and presented to the canvas.
     */
    readonly frames: number;
    readonly height: number;
    /**
     * The backing has content the canvas has not presented.
     */
    readonly unpresented: boolean;
    readonly width: number;
}

/**
 * A handle on a shared surface's pipelines and atlases, passed by value to
 * `Engine.create_shared` (take a fresh one from `Surface.context()` each time).
 */
export class SurfaceContext {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_compositor_free: (a: number, b: number) => void;
    readonly __wbg_engine_free: (a: number, b: number) => void;
    readonly __wbg_headless_free: (a: number, b: number) => void;
    readonly __wbg_surface_free: (a: number, b: number) => void;
    readonly __wbg_surfacecontext_free: (a: number, b: number) => void;
    readonly compositor_animate: (a: number) => [number, number, number];
    readonly compositor_animating: (a: number) => number;
    readonly compositor_cell_upload_bytes: (a: number) => bigint;
    readonly compositor_configure: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly compositor_create: (a: any) => any;
    readonly compositor_effect_passes: (a: number) => number;
    readonly compositor_fence: (a: number) => any;
    readonly compositor_frames: (a: number) => bigint;
    readonly compositor_render: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number];
    readonly compositor_render_retained: (a: number) => [number, number, number];
    readonly compositor_render_staged: (a: number, b: number, c: number) => [number, number, number];
    readonly compositor_row_map_upload_bytes: (a: number) => bigint;
    readonly compositor_row_slots: (a: number) => [number, number];
    readonly compositor_set_effect_mouse: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly compositor_set_effects: (a: number, b: number, c: number, d: number, e: number) => any;
    readonly compositor_set_transparency: (a: number, b: number) => void;
    readonly compositor_staging_ptr: (a: number) => number;
    readonly compositor_staging_words: (a: number) => number;
    readonly compositor_upload: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number];
    readonly engine_adapter: (a: number) => [number, number];
    readonly engine_add_font: (a: number, b: number, c: number) => [number, number];
    readonly engine_cell_height: (a: number) => number;
    readonly engine_cell_upload_bytes: (a: number) => bigint;
    readonly engine_cell_width: (a: number) => number;
    readonly engine_command: (a: number, b: number) => any;
    readonly engine_command_marks: (a: number) => [number, number];
    readonly engine_command_text: (a: number, b: number, c: number) => [number, number, number];
    readonly engine_commands: (a: number) => any;
    readonly engine_configure_font: (a: number, b: number, c: number, d: any, e: number, f: number) => [number, number, number, number];
    readonly engine_create: (a: any, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => any;
    readonly engine_create_shared: (a: number, b: number, c: number, d: any, e: number, f: number, g: number, h: number, i: number, j: number) => any;
    readonly engine_cursor_x: (a: number) => number;
    readonly engine_cursor_y: (a: number) => number;
    readonly engine_draw: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => number;
    readonly engine_drawable: (a: number) => number;
    readonly engine_effect_passes: (a: number) => number;
    readonly engine_fence: (a: number) => any;
    readonly engine_has_commands: (a: number) => number;
    readonly engine_image_upload_bytes: (a: number) => number;
    readonly engine_image_uploads: (a: number) => number;
    readonly engine_jump_to_prompt: (a: number, b: number) => number;
    readonly engine_key: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number];
    readonly engine_link: (a: number, b: number, c: number) => [number, number];
    readonly engine_metrics: (a: number) => [number, number];
    readonly engine_mode: (a: number, b: number) => number;
    readonly engine_mouse: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number];
    readonly engine_needs_present: (a: number) => number;
    readonly engine_on_submitted_work_done: (a: number, b: any) => void;
    readonly engine_prefill_glyphs: (a: number, b: number, c: number) => number;
    readonly engine_release_hold: (a: number) => void;
    readonly engine_render: (a: number, b: number, c: number) => [number, number, number];
    readonly engine_resize: (a: number, b: number, c: number) => [number, number];
    readonly engine_row_map_upload_bytes: (a: number) => bigint;
    readonly engine_screen: (a: number) => [number, number];
    readonly engine_scroll: (a: number, b: number) => void;
    readonly engine_search: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly engine_select: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly engine_select_mode: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly engine_set_effect_mouse: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly engine_set_effects: (a: number, b: number, c: number, d: number, e: number) => any;
    readonly engine_set_image_limit: (a: number, b: number) => [number, number];
    readonly engine_set_ligatures: (a: number, b: number) => [number, number];
    readonly engine_take_events: (a: number) => any;
    readonly engine_text: (a: number, b: number) => [number, number, number, number];
    readonly engine_theme: (a: number, b: number, c: number, d: number) => void;
    readonly engine_write: (a: number, b: number, c: number) => void;
    readonly headless_cell: (a: number, b: number, c: number) => [number, number, number];
    readonly headless_command: (a: number, b: number) => any;
    readonly headless_command_marks: (a: number) => [number, number];
    readonly headless_command_text: (a: number, b: number, c: number) => [number, number, number];
    readonly headless_commands: (a: number) => any;
    readonly headless_digest: (a: number) => [number, number, number, number];
    readonly headless_has_commands: (a: number) => number;
    readonly headless_jump_to_prompt: (a: number, b: number) => number;
    readonly headless_key: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number];
    readonly headless_mode: (a: number, b: number) => number;
    readonly headless_new: (a: number, b: number, c: number) => [number, number, number];
    readonly headless_release_hold: (a: number) => void;
    readonly headless_resize: (a: number, b: number, c: number) => [number, number];
    readonly headless_screen: (a: number) => [number, number];
    readonly headless_scroll: (a: number, b: number) => void;
    readonly headless_search: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly headless_snapshot: (a: number) => [number, number, number, number];
    readonly headless_take_events: (a: number) => any;
    readonly headless_text: (a: number) => [number, number, number, number];
    readonly headless_write: (a: number, b: number, c: number) => void;
    readonly surface_atlases: (a: number) => number;
    readonly surface_begin: (a: number, b: number) => [number, number];
    readonly surface_completed_frames: (a: number) => number;
    readonly surface_completed_updates: (a: number) => number;
    readonly surface_context: (a: number) => number;
    readonly surface_create: (a: any, b: number, c: number) => any;
    readonly surface_effect_passes: (a: number) => number;
    readonly surface_effects_due: (a: number) => number;
    readonly surface_end: (a: number, b: number) => [number, number, number];
    readonly surface_frames: (a: number) => number;
    readonly surface_height: (a: number) => number;
    readonly surface_resize: (a: number, b: number, c: number) => void;
    readonly wraith_alloc: (a: number, b: number) => number;
    readonly wraith_cell: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => void;
    readonly wraith_dealloc: (a: number, b: number, c: number) => void;
    readonly wraith_emit: (a: number, b: number, c: number, d: number) => void;
    readonly wraith_placement: (a: number, b: number) => void;
    readonly wraith_row: (a: number, b: number) => void;
    readonly wraith_row_reuse: (a: number, b: number, c: bigint, d: bigint, e: number, f: number, g: number) => number;
    readonly wraith_row_store: (a: number, b: number, c: bigint, d: bigint, e: number, f: number, g: number, h: number) => void;
    readonly wraith_semantic: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly surface_set_effect_mouse: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly surface_set_effects: (a: number, b: number, c: number, d: number, e: number) => any;
    readonly surface_unpresented: (a: number) => number;
    readonly surface_width: (a: number) => number;
    readonly wasm_bindgen_6325b3aeff69b3ec___convert__closures_____invoke___js_sys_f456faec7bc9c5ad___Function_fn_wasm_bindgen_6325b3aeff69b3ec___JsValue_____wasm_bindgen_6325b3aeff69b3ec___sys__Undefined___js_sys_f456faec7bc9c5ad___Function_fn_wasm_bindgen_6325b3aeff69b3ec___JsValue_____wasm_bindgen_6325b3aeff69b3ec___sys__Undefined_______true_: (a: number, b: number, c: any, d: any) => void;
    readonly wasm_bindgen_6325b3aeff69b3ec___convert__closures_____invoke___wasm_bindgen_6325b3aeff69b3ec___JsValue__core_ed718c3d60ebd546___result__Result_____wasm_bindgen_6325b3aeff69b3ec___JsError___true_: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen_6325b3aeff69b3ec___convert__closures_____invoke___wasm_bindgen_6325b3aeff69b3ec___sys__JsNullable_wgpu_766cd644c37f70b3___backend__webgpu__webgpu_sys__gen_GpuError__GpuError___core_ed718c3d60ebd546___result__Result_____wasm_bindgen_6325b3aeff69b3ec___JsError___true_: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen_6325b3aeff69b3ec___convert__closures_____invoke___wasm_bindgen_6325b3aeff69b3ec___sys__JsNullable_wgpu_766cd644c37f70b3___backend__webgpu__webgpu_sys__gen_GpuError__GpuError___core_ed718c3d60ebd546___result__Result_____wasm_bindgen_6325b3aeff69b3ec___JsError___true__105: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen_6325b3aeff69b3ec___convert__closures_____invoke___wasm_bindgen_6325b3aeff69b3ec___sys__JsNullable_wgpu_766cd644c37f70b3___backend__webgpu__webgpu_sys__gen_GpuError__GpuError___core_ed718c3d60ebd546___result__Result_____wasm_bindgen_6325b3aeff69b3ec___JsError___true__108: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen_6325b3aeff69b3ec___convert__closures_____invoke___wasm_bindgen_6325b3aeff69b3ec___sys__JsNullable_wgpu_766cd644c37f70b3___backend__webgpu__webgpu_sys__gen_GpuError__GpuError___core_ed718c3d60ebd546___result__Result_____wasm_bindgen_6325b3aeff69b3ec___JsError___true__109: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen_6325b3aeff69b3ec___convert__closures_____invoke___wgpu_766cd644c37f70b3___backend__webgpu__webgpu_sys__gen_GpuDeviceLostInfo__GpuDeviceLostInfo______true_: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen_6325b3aeff69b3ec___convert__closures_____invoke___wgpu_766cd644c37f70b3___backend__webgpu__webgpu_sys__gen_GpuDeviceLostInfo__GpuDeviceLostInfo______true__107: (a: number, b: number, c: any) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_destroy_closure: (a: number, b: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
