/* tslint:disable */
/* eslint-disable */

/**
 * Stateless Rust/WebGPU compositor for the xterm-compatible semantic core.
 */
export class Compositor {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    configure(cols: number, rows: number, width: number, height: number): void;
    static create(canvas: OffscreenCanvas): Promise<Compositor>;
    /**
     * Wait for submitted GPU work. Call only while the renderer is paused;
     * the Wasm borrow remains live until the asynchronous fence completes.
     */
    fence(): Promise<void>;
    render(packed: Uint32Array, start: number, dimensions: Float32Array, frame: Uint32Array): boolean;
    /**
     * Upload staged cells `start..start + cells` (indices into the grid, at
     * the same offsets in staging) and present with the staged uniforms.
     */
    render_staged(cells: number, start: number): boolean;
    upload(x: number, y: number, width: number, height: number, pixels: Uint8Array): void;
    readonly frames: bigint;
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
    static create(canvas: OffscreenCanvas, font: Uint8Array, cols: number, rows: number, font_size: number, line_height: number, history: number): Promise<Engine>;
    fence(): Promise<void>;
    key(key: number, mods: number, action: number, text: string, unshifted: number): void;
    link(x: number, y: number): string;
    metrics(): Float64Array;
    mode(mode: number): boolean;
    mouse(action: number, button: number, mods: number, x: number, y: number, pressed: number): void;
    release_hold(): void;
    render(time: number, force: boolean): boolean;
    resize(cols: number, rows: number): void;
    scroll(delta: number): void;
    select(x1: number, y1: number, x2: number, y2: number): void;
    take_events(): Array<any>;
    text(selected: boolean): string;
    theme(fg: number, bg: number, cursor: number): void;
    write(bytes: Uint8Array): void;
    readonly adapter: string;
    readonly cell_height: number;
    readonly cell_width: number;
    readonly cursor_x: number;
    readonly cursor_y: number;
    readonly needs_present: boolean;
}

/**
 * Headless browser instance for tests, replay, and serverless terminal analysis.
 */
export class Headless {
    free(): void;
    [Symbol.dispose](): void;
    cell(x: number, y: number): Array<any>;
    key(key: number, mods: number, action: number, text: string, unshifted: number): void;
    mode(mode: number): boolean;
    constructor(cols: number, rows: number, history: number);
    release_hold(): void;
    resize(cols: number, rows: number): void;
    scroll(delta: number): void;
    take_events(): Array<any>;
    text(): string;
    write(data: Uint8Array): void;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_compositor_free: (a: number, b: number) => void;
    readonly __wbg_engine_free: (a: number, b: number) => void;
    readonly __wbg_headless_free: (a: number, b: number) => void;
    readonly compositor_configure: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly compositor_create: (a: any) => any;
    readonly compositor_fence: (a: number) => any;
    readonly compositor_frames: (a: number) => bigint;
    readonly compositor_render: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number];
    readonly compositor_render_staged: (a: number, b: number, c: number) => [number, number, number];
    readonly compositor_staging_ptr: (a: number) => number;
    readonly compositor_staging_words: (a: number) => number;
    readonly compositor_upload: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number];
    readonly engine_adapter: (a: number) => [number, number];
    readonly engine_add_font: (a: number, b: number, c: number) => [number, number];
    readonly engine_cell_height: (a: number) => number;
    readonly engine_cell_width: (a: number) => number;
    readonly engine_create: (a: any, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => any;
    readonly engine_cursor_x: (a: number) => number;
    readonly engine_cursor_y: (a: number) => number;
    readonly engine_fence: (a: number) => any;
    readonly engine_key: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number];
    readonly engine_link: (a: number, b: number, c: number) => [number, number];
    readonly engine_metrics: (a: number) => [number, number];
    readonly engine_mode: (a: number, b: number) => number;
    readonly engine_mouse: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number];
    readonly engine_needs_present: (a: number) => number;
    readonly engine_release_hold: (a: number) => void;
    readonly engine_render: (a: number, b: number, c: number) => [number, number, number];
    readonly engine_resize: (a: number, b: number, c: number) => [number, number];
    readonly engine_scroll: (a: number, b: number) => void;
    readonly engine_select: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly engine_take_events: (a: number) => any;
    readonly engine_text: (a: number, b: number) => [number, number, number, number];
    readonly engine_theme: (a: number, b: number, c: number, d: number) => void;
    readonly engine_write: (a: number, b: number, c: number) => void;
    readonly headless_cell: (a: number, b: number, c: number) => [number, number, number];
    readonly headless_key: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number];
    readonly headless_mode: (a: number, b: number) => number;
    readonly headless_new: (a: number, b: number, c: number) => [number, number, number];
    readonly headless_release_hold: (a: number) => void;
    readonly headless_resize: (a: number, b: number, c: number) => [number, number];
    readonly headless_scroll: (a: number, b: number) => void;
    readonly headless_take_events: (a: number) => any;
    readonly headless_text: (a: number) => [number, number, number, number];
    readonly headless_write: (a: number, b: number, c: number) => void;
    readonly wraith_alloc: (a: number, b: number) => number;
    readonly wraith_cell: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => void;
    readonly wraith_dealloc: (a: number, b: number, c: number) => void;
    readonly wraith_emit: (a: number, b: number, c: number, d: number) => void;
    readonly wraith_row: (a: number, b: number) => void;
    readonly wasm_bindgen_6325b3aeff69b3ec___convert__closures_____invoke___js_sys_f456faec7bc9c5ad___Function_fn_wasm_bindgen_6325b3aeff69b3ec___JsValue_____wasm_bindgen_6325b3aeff69b3ec___sys__Undefined___js_sys_f456faec7bc9c5ad___Function_fn_wasm_bindgen_6325b3aeff69b3ec___JsValue_____wasm_bindgen_6325b3aeff69b3ec___sys__Undefined_______true_: (a: number, b: number, c: any, d: any) => void;
    readonly wasm_bindgen_6325b3aeff69b3ec___convert__closures_____invoke___wasm_bindgen_6325b3aeff69b3ec___JsValue__core_ed718c3d60ebd546___result__Result_____wasm_bindgen_6325b3aeff69b3ec___JsError___true_: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen_6325b3aeff69b3ec___convert__closures_____invoke___wasm_bindgen_6325b3aeff69b3ec___sys__JsNullable_wgpu_766cd644c37f70b3___backend__webgpu__webgpu_sys__gen_GpuError__GpuError___core_ed718c3d60ebd546___result__Result_____wasm_bindgen_6325b3aeff69b3ec___JsError___true_: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen_6325b3aeff69b3ec___convert__closures_____invoke___wasm_bindgen_6325b3aeff69b3ec___sys__JsNullable_wgpu_766cd644c37f70b3___backend__webgpu__webgpu_sys__gen_GpuError__GpuError___core_ed718c3d60ebd546___result__Result_____wasm_bindgen_6325b3aeff69b3ec___JsError___true__47: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen_6325b3aeff69b3ec___convert__closures_____invoke___wasm_bindgen_6325b3aeff69b3ec___sys__JsNullable_wgpu_766cd644c37f70b3___backend__webgpu__webgpu_sys__gen_GpuError__GpuError___core_ed718c3d60ebd546___result__Result_____wasm_bindgen_6325b3aeff69b3ec___JsError___true__48: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen_6325b3aeff69b3ec___convert__closures_____invoke___wgpu_766cd644c37f70b3___backend__webgpu__webgpu_sys__gen_GpuDeviceLostInfo__GpuDeviceLostInfo______true_: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen_6325b3aeff69b3ec___convert__closures_____invoke___wgpu_766cd644c37f70b3___backend__webgpu__webgpu_sys__gen_GpuDeviceLostInfo__GpuDeviceLostInfo______true__46: (a: number, b: number, c: any) => void;
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
