#![deny(unsafe_op_in_unsafe_fn)]
pub mod core;
#[cfg(any(target_arch = "wasm32", test))]
mod effect_state;
#[cfg(target_arch = "wasm32")]
mod effects;
#[cfg(target_arch = "wasm32")]
mod gpu;
pub mod image;
#[cfg(target_arch = "wasm32")]
mod images;
#[cfg(any(target_arch = "wasm32", test))]
mod retained;
#[cfg(target_arch = "wasm32")]
mod shared;
#[cfg(any(target_arch = "wasm32", test))]
mod staging;
pub mod text;
#[cfg(target_arch = "wasm32")]
mod web;
