#![deny(unsafe_op_in_unsafe_fn)]
pub mod core;
#[cfg(target_arch = "wasm32")]
mod gpu;
pub mod text;
