//! Minimal Rust bindings for the NanoArch/libretro C interface.
//!
//! This crate mirrors the Go/CGo glue layout used by the Go worker implementation
//! and focuses on a deterministic, low-overhead native boundary:
//! - load a libretro core with dlopen
//! - configure callbacks/symbols
//! - load and run a game
//! - optional serialize/unserialize/snapshot handling

pub mod libretro;

pub use libretro::{
    Core,
    CoreCallbacks,
    EmulatorMetadata,
    FrameTiming,
    GameGeometry,
    LibretroError,
};

pub type Result<T, E = LibretroError> = std::result::Result<T, E>;
