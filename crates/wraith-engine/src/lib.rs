#![deny(unsafe_op_in_unsafe_fn)]
pub mod core;
#[cfg(target_arch = "wasm32")]
mod gpu;
#[cfg(any(target_arch = "wasm32", test))]
mod retained;
#[cfg(any(target_arch = "wasm32", test))]
mod staging;
pub mod text;
#[cfg(target_arch = "wasm32")]
mod web;
