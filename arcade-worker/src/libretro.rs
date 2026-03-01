//! Rust-side libretro bridge.
//!
//! This module focuses on:
//! - loading a core via `dlopen`/`LoadLibrary` (through `libloading`)
//! - registering the six libretro callbacks (environment/video/input/audio)
//! - loading ROMs and running frames
//! - save-state serialization and restore
//! - a thin compatibility input/event layer used by room input channels

use std::collections::HashMap;
use std::ffi::{CStr, CString};
use std::fs;
use std::os::raw::{
    c_char,
    c_double,
    c_short,
    c_uchar,
    c_uint,
    c_void,
};
use std::ops::{Deref, DerefMut};
use std::path::{Path, PathBuf};
use std::ptr;
use std::sync::atomic::{AtomicBool, AtomicPtr, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use libloading::Library;
use thiserror::Error;

const MAX_PLAYERS: usize = 8;
const MAX_AXES: usize = 4;
const EMULATOR_EXTENSIONS: &[&str] = &[".so", ".armv7-neon-hf.so", ".dylib", ".dll"];

const RETRO_ENVIRONMENT_GET_CAN_DUPE: c_uint = 3;
const RETRO_ENVIRONMENT_GET_OVERSCAN: c_uint = 2;
const RETRO_ENVIRONMENT_SET_ROTATION: c_uint = 1;
const RETRO_ENVIRONMENT_SHUTDOWN: c_uint = 7;
const RETRO_ENVIRONMENT_SET_PIXEL_FORMAT: c_uint = 10;
const RETRO_ENVIRONMENT_SET_HW_RENDER: c_uint = 14;
const RETRO_ENVIRONMENT_SET_MESSAGE: c_uint = 6;
const RETRO_ENVIRONMENT_SET_VARIABLES: c_uint = 16;
const RETRO_ENVIRONMENT_GET_VARIABLE: c_uint = 15;
const RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY: c_uint = 9;
const RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE: c_uint = 17;
const RETRO_ENVIRONMENT_SET_INPUT_DESCRIPTORS: c_uint = 11;
const RETRO_ENVIRONMENT_SET_KEYBOARD_CALLBACK: c_uint = 12;
const RETRO_ENVIRONMENT_SET_DISK_CONTROL_INTERFACE: c_uint = 13;
const RETRO_ENVIRONMENT_SET_FRAME_TIME_CALLBACK: c_uint = 21;
const RETRO_ENVIRONMENT_SET_CONTROLLER_INFO: c_uint = 35;
const RETRO_ENVIRONMENT_GET_LOG_INTERFACE: c_uint = 27;
const RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY: c_uint = 31;
const RETRO_ENVIRONMENT_GET_USERNAME: c_uint = 38;
const RETRO_ENVIRONMENT_GET_LANGUAGE: c_uint = 39;

const RETRO_PIXEL_FORMAT_0RGB1555: c_uint = 0;
const RETRO_PIXEL_FORMAT_XRGB8888: c_uint = 1;
const RETRO_PIXEL_FORMAT_RGB565: c_uint = 2;

const RETRO_DEVICE_JOYPAD: c_uint = 1;
const RETRO_DEVICE_ANALOG: c_uint = 5;
const RETRO_DEVICE_INDEX_ANALOG_RIGHT: c_uint = 1;
const RETRO_DEVICE_ID_ANALOG_Y: c_uint = 1;

const RETRO_DEVICE_ID_JOYPAD_A: u16 = 8;
const RETRO_DEVICE_ID_JOYPAD_B: u16 = 0;
const RETRO_DEVICE_ID_JOYPAD_X: u16 = 9;
const RETRO_DEVICE_ID_JOYPAD_Y: u16 = 1;
const RETRO_DEVICE_ID_JOYPAD_L: u16 = 10;
const RETRO_DEVICE_ID_JOYPAD_R: u16 = 11;
const RETRO_DEVICE_ID_JOYPAD_SELECT: u16 = 2;
const RETRO_DEVICE_ID_JOYPAD_START: u16 = 3;
const RETRO_DEVICE_ID_JOYPAD_UP: u16 = 4;
const RETRO_DEVICE_ID_JOYPAD_DOWN: u16 = 5;
const RETRO_DEVICE_ID_JOYPAD_LEFT: u16 = 6;
const RETRO_DEVICE_ID_JOYPAD_RIGHT: u16 = 7;
const RETRO_DEVICE_ID_JOYPAD_L2: u16 = 12;
const RETRO_DEVICE_ID_JOYPAD_R2: u16 = 13;
const RETRO_DEVICE_ID_JOYPAD_L3: u16 = 14;
const RETRO_DEVICE_ID_JOYPAD_R3: u16 = 15;

const RETRO_HW_FRAME_BUFFER_VALID: usize = usize::MAX;

const DEFAULT_SYSTEM_DIRECTORY: &str = "./pkg/emulator/libretro/system";
const DEFAULT_SAVE_DIRECTORY: &str = ".";
const CALLBACK_CONTEXT_USERNAME: &str = "cloud-arcade";
const VIDEO_BUFFER_POOL_MAX_BUFFERS: usize = 4;
const VIDEO_BUFFER_POOL_MAX_CAPACITY_BYTES: usize = 8 * 1024 * 1024;
const AUDIO_BUFFER_POOL_MAX_BUFFERS: usize = 16;
const AUDIO_BUFFER_POOL_MAX_CAPACITY_SAMPLES: usize = 256_000;

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct RetroSystemInfo {
    pub library_name: *const c_char,
    pub library_version: *const c_char,
    pub valid_extensions: *const c_char,
    pub need_fullpath: c_uchar,
    pub block_extract: c_uchar,
}

impl Default for RetroSystemInfo {
    fn default() -> Self {
        Self {
            library_name: ptr::null(),
            library_version: ptr::null(),
            valid_extensions: ptr::null(),
            need_fullpath: 0,
            block_extract: 0,
        }
    }
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct RetroSystemGeometry {
    pub base_width: c_uint,
    pub base_height: c_uint,
    pub aspect_ratio: c_double,
    pub max_width: c_uint,
    pub max_height: c_uint,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct RetroSystemTiming {
    pub fps: c_double,
    pub sample_rate: c_double,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct RetroSystemAvInfo {
    pub geometry: RetroSystemGeometry,
    pub timing: RetroSystemTiming,
}

#[repr(C)]
#[derive(Debug)]
pub struct RetroGameInfo {
    pub path: *const c_char,
    pub data: *const c_void,
    pub size: usize,
    pub meta: *const c_char,
}

#[repr(C)]
#[derive(Debug)]
struct RetroVariable {
    pub key: *const c_char,
    pub value: *const c_char,
}

#[derive(Debug)]
pub struct VideoFrame {
    format: RetroPixelFormat,
    width: u32,
    height: u32,
    pitch: usize,
    data: PooledVec<u8>,
}

impl VideoFrame {
    pub fn new(
        format: RetroPixelFormat,
        width: u32,
        height: u32,
        pitch: usize,
        data: Vec<u8>,
    ) -> Self {
        Self {
            format,
            width,
            height,
            pitch,
            data: data.into(),
        }
    }

    pub fn format(&self) -> RetroPixelFormat {
        self.format
    }

    pub fn width(&self) -> u32 {
        self.width
    }

    pub fn height(&self) -> u32 {
        self.height
    }

    pub fn pitch(&self) -> usize {
        self.pitch
    }

    pub fn data(&self) -> &[u8] {
        &self.data
    }
}

#[derive(Debug)]
pub struct AudioFrame {
    samples: PooledVec<i16>,
}

impl AudioFrame {
    pub fn new(samples: Vec<i16>) -> Self {
        Self {
            samples: samples.into(),
        }
    }

    pub fn samples(&self) -> &[i16] {
        &self.samples
    }
}

#[derive(Debug)]
struct BufferPool<T> {
    buffers: Mutex<Vec<Vec<T>>>,
    max_buffers: usize,
    max_capacity: usize,
}

impl<T> BufferPool<T> {
    fn new(max_buffers: usize, max_capacity: usize) -> Self {
        Self {
            buffers: Mutex::new(Vec::new()),
            max_buffers: max_buffers.max(1),
            max_capacity: max_capacity.max(1),
        }
    }

    fn take(&self) -> Vec<T> {
        self.buffers
            .lock()
            .ok()
            .and_then(|mut buffers| buffers.pop())
            .unwrap_or_default()
    }

    fn put(&self, mut buffer: Vec<T>) {
        buffer.clear();
        if buffer.capacity() > self.max_capacity {
            return;
        }

        let Ok(mut buffers) = self.buffers.lock() else {
            return;
        };
        if buffers.len() >= self.max_buffers {
            return;
        }
        buffers.push(buffer);
    }
}

#[derive(Debug)]
struct PooledVec<T> {
    data: Vec<T>,
    pool: Option<Arc<BufferPool<T>>>,
}

impl<T> PooledVec<T> {
    fn from_pool(pool: Arc<BufferPool<T>>, data: Vec<T>) -> Self {
        Self {
            data,
            pool: Some(pool),
        }
    }
}

impl<T> From<Vec<T>> for PooledVec<T> {
    fn from(data: Vec<T>) -> Self {
        Self { data, pool: None }
    }
}

impl<T> Deref for PooledVec<T> {
    type Target = [T];

    fn deref(&self) -> &Self::Target {
        &self.data
    }
}

impl<T> DerefMut for PooledVec<T> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.data
    }
}

impl<T> Drop for PooledVec<T> {
    fn drop(&mut self) {
        let Some(pool) = self.pool.take() else {
            return;
        };

        let data = std::mem::take(&mut self.data);
        pool.put(data);
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RetroPixelFormat {
    Rgb1555,
    Xrgb8888,
    Rgb565,
    Unknown(u32),
}

#[derive(Clone, Copy, Debug, Default)]
pub struct GameGeometry {
    pub base_width: u32,
    pub base_height: u32,
    pub aspect_ratio: f64,
    pub max_width: u32,
    pub max_height: u32,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct FrameTiming {
    pub fps: f64,
    pub sample_rate: f64,
}

#[derive(Clone, Debug, Default)]
pub struct EmulatorMetadata {
    pub library_name: String,
    pub library_version: String,
    pub valid_extensions: String,
    pub geometry: GameGeometry,
    pub timing: FrameTiming,
}

#[derive(Clone)]
pub struct CoreCallbacks {
    pub environment: Option<RetroEnvironmentCallback>,
    pub video_refresh: Option<RetroVideoRefreshCallback>,
    pub input_poll: Option<RetroInputPollCallback>,
    pub input_state: Option<RetroInputStateCallback>,
    pub audio_sample: Option<RetroAudioSampleCallback>,
    pub audio_sample_batch: Option<RetroAudioSampleBatchCallback>,
    pub on_video_frame: Option<Arc<dyn Fn(VideoFrame) + Send + Sync>>,
    pub on_audio_frame: Option<Arc<dyn Fn(AudioFrame) + Send + Sync>>,
}

impl Default for CoreCallbacks {
    fn default() -> Self {
        Self {
            environment: None,
            video_refresh: None,
            input_poll: None,
            input_state: None,
            audio_sample: None,
            audio_sample_batch: None,
            on_video_frame: None,
            on_audio_frame: None,
        }
    }
}

type RetroInit = unsafe extern "C" fn();
type RetroDeinit = unsafe extern "C" fn();
type RetroApiVersion = unsafe extern "C" fn() -> c_uint;
type RetroGetSystemInfo = unsafe extern "C" fn(*mut RetroSystemInfo);
type RetroGetSystemAvInfo = unsafe extern "C" fn(*mut RetroSystemAvInfo);
type RetroSetEnvironment = unsafe extern "C" fn(RetroEnvironmentCallback);
type RetroSetVideoRefresh = unsafe extern "C" fn(RetroVideoRefreshCallback);
type RetroSetInputPoll = unsafe extern "C" fn(RetroInputPollCallback);
type RetroSetInputState = unsafe extern "C" fn(RetroInputStateCallback);
type RetroSetAudioSample = unsafe extern "C" fn(RetroAudioSampleCallback);
type RetroSetAudioSampleBatch = unsafe extern "C" fn(RetroAudioSampleBatchCallback);
type RetroLoadGame = unsafe extern "C" fn(*const RetroGameInfo) -> c_uchar;
type RetroRun = unsafe extern "C" fn();
type RetroUnloadGame = unsafe extern "C" fn();
type RetroSerializeSize = unsafe extern "C" fn() -> usize;
type RetroSerialize = unsafe extern "C" fn(*const c_void, usize) -> c_uchar;
type RetroUnserialize = unsafe extern "C" fn(*const c_void, usize) -> c_uchar;

pub type RetroEnvironmentCallback = unsafe extern "C" fn(c_uint, *mut c_void) -> c_uchar;
pub type RetroVideoRefreshCallback = unsafe extern "C" fn(*const c_void, c_uint, c_uint, usize);
pub type RetroInputPollCallback = unsafe extern "C" fn();
pub type RetroInputStateCallback = unsafe extern "C" fn(c_uint, c_uint, c_uint, c_uint) -> c_short;
pub type RetroAudioSampleCallback = unsafe extern "C" fn(c_short, c_short);
pub type RetroAudioSampleBatchCallback = unsafe extern "C" fn(*const c_short, usize) -> usize;

#[derive(Clone, Copy, Default, Debug)]
struct ControllerState {
    key_state: u16,
    axes: [i16; MAX_AXES],
}

struct CallbackContext {
    system_dir: CString,
    save_dir: CString,
    username: CString,
    config: RwLock<HashMap<String, CString>>,
    callbacks: RwLock<CoreCallbacks>,
    pixel_format: AtomicU32,
    is_gl_allowed: bool,
    shutdown_requested: AtomicBool,
    controllers: RwLock<[ControllerState; MAX_PLAYERS]>,
    video_pool: Arc<BufferPool<u8>>,
    audio_pool: Arc<BufferPool<i16>>,
}

impl CallbackContext {
    fn new() -> Self {
        Self {
            system_dir: CString::new(DEFAULT_SYSTEM_DIRECTORY).unwrap_or_else(|_| {
                CString::new("./pkg/emulator/libretro/system").expect("constant path valid")
            }),
            save_dir: CString::new(DEFAULT_SAVE_DIRECTORY)
                .unwrap_or_else(|_| CString::new(".").expect("constant path valid")),
            username: CString::new(CALLBACK_CONTEXT_USERNAME)
                .unwrap_or_else(|_| CString::new("cloud-arcade").expect("constant path valid")),
            config: RwLock::new(HashMap::new()),
            callbacks: RwLock::new(CoreCallbacks::default()),
            pixel_format: AtomicU32::new(RETRO_PIXEL_FORMAT_XRGB8888),
            is_gl_allowed: false,
            shutdown_requested: AtomicBool::new(false),
            controllers: RwLock::new([ControllerState::default(); MAX_PLAYERS]),
            video_pool: Arc::new(BufferPool::new(
                VIDEO_BUFFER_POOL_MAX_BUFFERS,
                VIDEO_BUFFER_POOL_MAX_CAPACITY_BYTES,
            )),
            audio_pool: Arc::new(BufferPool::new(
                AUDIO_BUFFER_POOL_MAX_BUFFERS,
                AUDIO_BUFFER_POOL_MAX_CAPACITY_SAMPLES,
            )),
        }
    }

    fn pixel_format(&self) -> RetroPixelFormat {
        match self.pixel_format.load(Ordering::Relaxed) {
            RETRO_PIXEL_FORMAT_0RGB1555 => RetroPixelFormat::Rgb1555,
            RETRO_PIXEL_FORMAT_XRGB8888 => RetroPixelFormat::Xrgb8888,
            RETRO_PIXEL_FORMAT_RGB565 => RetroPixelFormat::Rgb565,
            value => RetroPixelFormat::Unknown(value),
        }
    }

    fn with_user_env_callback(&self, cmd: c_uint, data: *mut c_void) -> Option<c_uchar> {
        self.callbacks
            .read()
            .ok()
            .and_then(|callbacks| callbacks.environment)
            .map(|callback| unsafe { callback(cmd, data) })
    }

    fn with_user_video_refresh(&self, data: *const c_void, width: c_uint, height: c_uint, pitch: usize) {
        if let Some(cb) = self.callbacks.read().ok().and_then(|x| x.video_refresh) {
            unsafe { cb(data, width, height, pitch) };
        }
    }

    fn with_user_input_poll(&self) {
        if let Some(cb) = self.callbacks.read().ok().and_then(|x| x.input_poll) {
            unsafe { cb() }
        }
    }

    fn with_user_input_state(&self, port: c_uint, device: c_uint, index: c_uint, id: c_uint) -> Option<c_short> {
        if let Some(callback) = self
            .callbacks
            .read()
            .ok()
            .and_then(|callbacks| callbacks.input_state)
        {
            return Some(unsafe { callback(port, device, index, id) });
        }

        if port as usize >= MAX_PLAYERS {
            return Some(0);
        }

        if device == RETRO_DEVICE_ANALOG {
            if index > RETRO_DEVICE_INDEX_ANALOG_RIGHT || id > RETRO_DEVICE_ID_ANALOG_Y {
                return Some(0);
            }
            let axis = index.saturating_mul(2).saturating_add(id);
            if axis as usize >= MAX_AXES {
                return Some(0);
            }
            return self
                .controllers
                .read()
                .ok()
                .map(|controllers| controllers[port as usize].axes[axis as usize] as c_short)
                .or(Some(0));
        }

        if id >= 255 || index > 0 || device != RETRO_DEVICE_JOYPAD {
            return Some(0);
        }

        button_bit_index(id).and_then(|bit| {
            self.controllers
                .read()
                .ok()
                .and_then(|controllers| {
                    if ((controllers[port as usize].key_state >> bit) & 1) == 1 {
                        Some(1)
                    } else {
                        Some(0)
                    }
                })
        })
    }

    fn with_user_audio_sample(&self, left: c_short, right: c_short) {
        if let Some(cb) = self.callbacks.read().ok().and_then(|x| x.audio_sample) {
            unsafe { cb(left, right) }
        }
        let mut samples = self.audio_pool.take();
        samples.resize(2, 0);
        samples[0] = left;
        samples[1] = right;
        self.emit_audio(AudioFrame {
            samples: PooledVec::from_pool(self.audio_pool.clone(), samples),
        });
    }

    fn with_user_audio_batch(&self, samples: &[i16]) -> Option<usize> {
        let frame_count = samples.len() / 2;
        if frame_count == 0 {
            return self
                .callbacks
                .read()
                .ok()
                .and_then(|x| x.audio_sample_batch)
                .and_then(|cb| Some(unsafe { cb(samples.as_ptr(), frame_count) }))
                .or(Some(0));
        }

        let emitted = if let Some(cb) = self
            .callbacks
            .read()
            .ok()
            .and_then(|x| x.audio_sample_batch)
        {
            unsafe { cb(samples.as_ptr(), frame_count) }
        } else {
            frame_count
        };
        let emit_frames = emitted.min(frame_count);
        if emit_frames > 0 {
            let emit_samples = emit_frames.saturating_mul(2);
            let mut out = self.audio_pool.take();
            out.resize(emit_samples, 0);
            out[..emit_samples].copy_from_slice(&samples[..emit_samples]);
            self.emit_audio(AudioFrame {
                samples: PooledVec::from_pool(self.audio_pool.clone(), out),
            });
        }
        Some(emitted)
    }

    fn emit_video(&self, frame: VideoFrame) {
        if let Some(cb) = self.callbacks.read().ok().and_then(|x| x.on_video_frame.clone()) {
            cb(frame);
        }
    }

    fn emit_audio(&self, frame: AudioFrame) {
        if let Some(cb) = self.callbacks.read().ok().and_then(|x| x.on_audio_frame.clone()) {
            cb(frame);
        }
    }
}

static ACTIVE_CONTEXT: AtomicPtr<CallbackContext> = AtomicPtr::new(ptr::null_mut());

fn active_context() -> Option<&'static CallbackContext> {
    let ptr = ACTIVE_CONTEXT.load(Ordering::Acquire);
    if ptr.is_null() {
        None
    } else {
        Some(unsafe { &*ptr })
    }
}

fn button_bit_index(id: c_uint) -> Option<u16> {
    match id {
        // Libretro reports joypad ids in the same order as libretro.h:
        // B, Y, Select, Start, D-Pad, A, X, L, R, L2, R2, L3, R3.
        // Convert to frontend bit positions used by the packet bitmap.
        id if id == u32::from(RETRO_DEVICE_ID_JOYPAD_B) => Some(1),
        id if id == u32::from(RETRO_DEVICE_ID_JOYPAD_Y) => Some(3),
        id if id == u32::from(RETRO_DEVICE_ID_JOYPAD_SELECT) => Some(6),
        id if id == u32::from(RETRO_DEVICE_ID_JOYPAD_START) => Some(7),
        id if id == u32::from(RETRO_DEVICE_ID_JOYPAD_UP) => Some(8),
        id if id == u32::from(RETRO_DEVICE_ID_JOYPAD_DOWN) => Some(9),
        id if id == u32::from(RETRO_DEVICE_ID_JOYPAD_LEFT) => Some(10),
        id if id == u32::from(RETRO_DEVICE_ID_JOYPAD_RIGHT) => Some(11),
        id if id == u32::from(RETRO_DEVICE_ID_JOYPAD_A) => Some(0),
        id if id == u32::from(RETRO_DEVICE_ID_JOYPAD_X) => Some(2),
        id if id == u32::from(RETRO_DEVICE_ID_JOYPAD_L) => Some(4),
        id if id == u32::from(RETRO_DEVICE_ID_JOYPAD_R) => Some(5),
        id if id == u32::from(RETRO_DEVICE_ID_JOYPAD_L2) => Some(13),
        id if id == u32::from(RETRO_DEVICE_ID_JOYPAD_R2) => Some(12),
        id if id == u32::from(RETRO_DEVICE_ID_JOYPAD_L3) => Some(15),
        id if id == u32::from(RETRO_DEVICE_ID_JOYPAD_R3) => Some(14),
        _ => None,
    }
}

unsafe extern "C" fn environment_callback(cmd: c_uint, data: *mut c_void) -> c_uchar {
    let context = match active_context() {
        Some(context) => context,
        None => return 0,
    };

    if let Some(result) = context.with_user_env_callback(cmd, data) {
        return result;
    }

    match cmd {
        RETRO_ENVIRONMENT_GET_CAN_DUPE => {
            let flag = data as *mut c_uchar;
            if !flag.is_null() {
                // libretro is allowed to skip duplicate checks.
                unsafe { *flag = 1 };
            }
            1
        }
        RETRO_ENVIRONMENT_GET_OVERSCAN => {
            let flag = data as *mut c_uchar;
            if !flag.is_null() {
                // keep overscan enabled to preserve frame dimensions.
                unsafe { *flag = 1 };
            }
            1
        }
        RETRO_ENVIRONMENT_SET_PIXEL_FORMAT => {
            let format = unsafe { *(data as *const c_uint) };
            context.pixel_format.store(format, Ordering::Relaxed);
            match format {
                RETRO_PIXEL_FORMAT_0RGB1555 | RETRO_PIXEL_FORMAT_XRGB8888 | RETRO_PIXEL_FORMAT_RGB565 => 1,
                _ => 0,
            }
        }
        RETRO_ENVIRONMENT_SET_ROTATION => 1,
        RETRO_ENVIRONMENT_SET_VARIABLES => {
            // Accept variable registration requests and keep frontend permissive
            // with defaults by returning true.
            1
        }
        RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY => {
            let path = data as *mut *const c_char;
            if !path.is_null() {
                unsafe { *path = context.system_dir.as_ptr() };
            }
            1
        }
        RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY => {
            let path = data as *mut *const c_char;
            if !path.is_null() {
                unsafe { *path = context.save_dir.as_ptr() };
            }
            1
        }
        RETRO_ENVIRONMENT_GET_VARIABLE => {
            let mut status = 0;
            if !data.is_null() {
                let variable = data as *mut RetroVariable;
                if (*variable).key.is_null() {
                    return 0;
                }
                let key = unsafe { CStr::from_ptr((*variable).key).to_string_lossy().to_string() };
                let config = match context.config.read() {
                    Ok(config) => config,
                    Err(_) => return 0,
                };
                if let Some(value) = config.get(&key) {
                    unsafe { (*variable).value = value.as_ptr() };
                    status = 1;
                }
            }
            status
        }
        RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE => {
            let flag = data as *mut c_uchar;
            if !flag.is_null() {
                unsafe { *flag = 0 };
            }
            1
        }
        RETRO_ENVIRONMENT_SET_INPUT_DESCRIPTORS => 1,
        RETRO_ENVIRONMENT_SET_KEYBOARD_CALLBACK => 1,
        RETRO_ENVIRONMENT_SET_DISK_CONTROL_INTERFACE => 1,
        RETRO_ENVIRONMENT_SET_FRAME_TIME_CALLBACK => 1,
        RETRO_ENVIRONMENT_SET_CONTROLLER_INFO => 1,
        RETRO_ENVIRONMENT_SET_HW_RENDER => {
            if context.is_gl_allowed { 1 } else { 0 }
        }
        RETRO_ENVIRONMENT_GET_LOG_INTERFACE => 0,
        RETRO_ENVIRONMENT_GET_USERNAME => {
            let ptr = data as *mut *const c_char;
            if !ptr.is_null() {
                unsafe { *ptr = context.username.as_ptr() };
            }
            1
        }
        RETRO_ENVIRONMENT_GET_LANGUAGE => {
            let lang = data as *mut c_uint;
            if !lang.is_null() {
                unsafe {
                    // default to English when language is not explicitly requested.
                    *lang = 0;
                }
            }
            1
        }
        RETRO_ENVIRONMENT_SHUTDOWN => {
            context.shutdown_requested.store(true, Ordering::Release);
            1
        }
        RETRO_ENVIRONMENT_SET_MESSAGE => 1,
        _ => 0,
    }
}

unsafe extern "C" fn video_refresh_callback(data: *const c_void, width: c_uint, height: c_uint, pitch: usize) {
    let context = match active_context() {
        Some(context) => context,
        None => return,
    };

    context.with_user_video_refresh(data, width, height, pitch);
    if data.is_null() {
        return;
    }
    if data as usize == RETRO_HW_FRAME_BUFFER_VALID {
        return;
    }

    if pitch == 0 || width == 0 || height == 0 {
        return;
    }

    let bytes = pitch.saturating_mul(height as usize);
    if bytes == 0 {
        return;
    }

    let src = unsafe { std::slice::from_raw_parts(data as *const u8, bytes) };
    let mut payload = context.video_pool.take();
    payload.resize(bytes, 0);
    payload[..bytes].copy_from_slice(src);
    let frame = VideoFrame {
        format: context.pixel_format(),
        width,
        height,
        pitch,
        data: PooledVec::from_pool(context.video_pool.clone(), payload),
    };
    context.emit_video(frame);
}

unsafe extern "C" fn input_poll_callback() {
    if let Some(context) = active_context() {
        context.with_user_input_poll();
    }
}

unsafe extern "C" fn input_state_callback(port: c_uint, device: c_uint, index: c_uint, id: c_uint) -> c_short {
    let context = match active_context() {
        Some(context) => context,
        None => return 0,
    };

    if let Some(v) = context.with_user_input_state(port, device, index, id) {
        return v;
    }

    if port as usize >= MAX_PLAYERS {
        return 0;
    }
    if device == RETRO_DEVICE_ANALOG {
        if index > RETRO_DEVICE_INDEX_ANALOG_RIGHT || id > RETRO_DEVICE_ID_ANALOG_Y {
            return 0;
        }
        let axis = index.saturating_mul(2).saturating_add(id);
        if axis as usize >= MAX_AXES {
            return 0;
        }
        return context
            .controllers
            .read()
            .ok()
            .map(|controllers| controllers[port as usize].axes[axis as usize])
            .unwrap_or_default();
    }

    if id >= 255 || index > 0 || device != RETRO_DEVICE_JOYPAD {
        return 0;
    }

    button_bit_index(id).and_then(|bit| {
        context
            .controllers
            .read()
            .ok()
            .and_then(|controllers| {
                if ((controllers[port as usize].key_state >> bit) & 1) == 1 {
                    Some(1)
                } else {
                    Some(0)
                }
            })
    }).unwrap_or_default()
}

unsafe extern "C" fn audio_sample_callback(left: c_short, right: c_short) {
    let context = match active_context() {
        Some(context) => context,
        None => return,
    };
    context.with_user_audio_sample(left, right);
}

unsafe extern "C" fn audio_batch_callback(samples: *const c_short, frames: usize) -> usize {
    let context = match active_context() {
        Some(context) => context,
        None => return 0,
    };
    if samples.is_null() || frames == 0 {
        return 0;
    }

    let slice = unsafe { std::slice::from_raw_parts(samples, frames.saturating_mul(2)) };
    context.with_user_audio_batch(slice).unwrap_or(frames)
}

pub struct Core {
    library: Library,
    path: PathBuf,
    need_fullpath: bool,
    loaded_game: Option<Vec<u8>>,
    retained_path: Option<CString>,
    config_path: Option<PathBuf>,
    context: Arc<CallbackContext>,
    initialized: bool,
    callbacks: CoreCallbacks,
}

#[derive(Error, Debug)]
pub enum LibretroError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid path: {0}")]
    InvalidPath(String),
    #[error("unable to load core: {0}")]
    LoadFailure(#[from] libloading::Error),
    #[error("invalid CString conversion: {0}")]
    InvalidCString(String),
    #[error("ffi call failed: {0}")]
    Ffi(String),
    #[error("library requested fullpath mode but game path is missing")]
    MissingGamePath,
}

pub type Result<T, E = LibretroError> = std::result::Result<T, E>;

impl Core {
    pub fn load_library(core_path_without_ext: impl AsRef<Path>) -> Result<Self, LibretroError> {
        let path = core_path_without_ext.as_ref();
        if path.as_os_str().is_empty() {
            return Err(LibretroError::InvalidPath(
                "core path may not be empty".to_string(),
            ));
        }

        let base = path.to_string_lossy().to_string();
        let mut last_error = String::new();
        let mut candidates = Vec::new();
        let mut loaded = None;

        if path.exists() {
            candidates.push(base.clone());
            match unsafe { Library::new(path) } {
                Ok(library) => {
                    loaded = Some((library, PathBuf::from(&base)));
                }
                Err(err) => {
                    last_error = format!("{err}");
                }
            }
        }

        if loaded.is_none() {
            for ext in EMULATOR_EXTENSIONS {
                let candidate = format!("{}{}", base, ext);
                if candidates.iter().any(|c| c == &candidate) {
                    continue;
                }
                candidates.push(candidate.clone());
                if Path::new(&candidate).exists() {
                    match unsafe { Library::new(&candidate) } {
                        Ok(library) => {
                            loaded = Some((library, PathBuf::from(candidate)));
                            break;
                        }
                        Err(err) => {
                            last_error = format!("{err}");
                        }
                    }
                }
            }
        }

        let (library, found_path) = loaded.ok_or_else(|| {
            LibretroError::InvalidPath(format!(
                "could not open libretro core. tried: {}. last error: {}",
                candidates.join(", "),
                last_error
            ))
        })?;

        Ok(Self {
            library,
            path: found_path,
            need_fullpath: false,
            loaded_game: None,
            retained_path: None,
            config_path: None,
            context: Arc::new(CallbackContext::new()),
            initialized: false,
            callbacks: CoreCallbacks::default(),
        })
    }

    pub fn with_config(mut self, config_path: impl AsRef<Path>) -> Self {
        self.config_path = Some(config_path.as_ref().to_path_buf());
        if let Ok(content) = std::fs::read_to_string(config_path) {
            if let Ok(mut map) = self.context.config.write() {
                for (key, value) in parse_config_data(&content) {
                    map.insert(key, CString::new(value).unwrap_or_default());
                }
            }
        }
        self
    }

    pub fn initialize(&mut self, callbacks: Option<CoreCallbacks>) -> Result<EmulatorMetadata, LibretroError> {
        self.set_callbacks(callbacks.unwrap_or_default())?;
        ACTIVE_CONTEXT.store(Arc::as_ptr(&self.context) as *mut _, Ordering::Release);

        let system_info = self.read_system_info()?;
        self.need_fullpath = system_info.need_fullpath != 0;
        let api_version = self.retro_api_version()?;
        if api_version == 0 {
            return Err(LibretroError::Ffi("retro_api_version returned 0".to_string()));
        }

        unsafe {
            self.retro_init()?;
        }

        self.initialized = true;
        Ok(EmulatorMetadata {
            library_name: cstring_to_string(system_info.library_name)?,
            library_version: cstring_to_string(system_info.library_version)?,
            valid_extensions: cstring_to_string(system_info.valid_extensions)?,
            geometry: GameGeometry::default(),
            timing: FrameTiming::default(),
        })
    }

    pub fn set_callbacks(&mut self, callbacks: CoreCallbacks) -> Result<(), LibretroError> {
        {
            let mut slot = self
                .context
                .callbacks
                .write()
                .map_err(|_| LibretroError::Ffi("callback lock poisoned".to_string()))?;
            *slot = callbacks.clone();
        }
        self.callbacks = callbacks;

        unsafe {
            let set_environment = self.symbol::<RetroSetEnvironment>(b"retro_set_environment\0")?;
            set_environment(environment_callback);

            let set_video_refresh = self.symbol::<RetroSetVideoRefresh>(b"retro_set_video_refresh\0")?;
            set_video_refresh(video_refresh_callback);

            let set_input_poll = self.symbol::<RetroSetInputPoll>(b"retro_set_input_poll\0")?;
            set_input_poll(input_poll_callback);

            let set_input_state = self.symbol::<RetroSetInputState>(b"retro_set_input_state\0")?;
            set_input_state(input_state_callback);

            let set_audio_sample = self.symbol::<RetroSetAudioSample>(b"retro_set_audio_sample\0")?;
            set_audio_sample(audio_sample_callback);

            let set_audio_sample_batch =
                self.symbol::<RetroSetAudioSampleBatch>(b"retro_set_audio_sample_batch\0")?;
            set_audio_sample_batch(audio_batch_callback);
        }

        Ok(())
    }

    pub fn load_game(&mut self, game_path: impl AsRef<Path>) -> Result<EmulatorMetadata, LibretroError> {
        if !self.initialized {
            return Err(LibretroError::Ffi(
                "core must be initialized before loading a game".to_string(),
            ));
        }

        let game_path = game_path.as_ref();
        let game_path_string = game_path
            .to_str()
            .ok_or_else(|| LibretroError::InvalidPath("game path is not valid UTF-8".to_string()))?
            .to_string();

        let c_path = CString::new(game_path_string.clone())
            .map_err(|err| LibretroError::InvalidCString(format!("path contains NUL byte: {err}")))?;

        // Keep the path buffer alive across load/game usage for cores that retain the pointer.
        if self.need_fullpath {
            self.retained_path = Some(c_path.clone());
        } else {
            self.retained_path = None;
        }

        let mut game_data: Vec<u8> = Vec::new();
        let game_size = fs::metadata(game_path)
            .map_err(LibretroError::Io)?
            .len() as usize;

        let game_data_ptr = if self.need_fullpath {
            if game_path_string.is_empty() {
                return Err(LibretroError::MissingGamePath);
            }

            (ptr::null::<c_void>(), game_size)
        } else {
            game_data = fs::read(game_path)?;
            let size = game_data.len();
            (game_data.as_ptr() as *const c_void, size)
        };

        let info = RetroGameInfo {
            path: c_path.as_ptr(),
            data: game_data_ptr.0,
            size: game_data_ptr.1,
            meta: ptr::null(),
        };

        let loader = self.symbol::<RetroLoadGame>(b"retro_load_game\0")?;
        let loaded = unsafe { loader(&info as *const RetroGameInfo) };
        if loaded != 0 {
            if self.need_fullpath {
                self.loaded_game = None;
            } else {
                self.loaded_game = Some(game_data);
            }
        } else {
            return Err(LibretroError::Ffi("retro_load_game returned false".to_string()));
        }

        let mut av_info = RetroSystemAvInfo::default();
        let get_av_info = self.symbol::<RetroGetSystemAvInfo>(b"retro_get_system_av_info\0")?;
        unsafe { get_av_info(&mut av_info as *mut _) };

        let geometry = GameGeometry {
            base_width: av_info.geometry.base_width,
            base_height: av_info.geometry.base_height,
            aspect_ratio: if av_info.geometry.aspect_ratio > 0.0 {
                av_info.geometry.aspect_ratio
            } else if av_info.geometry.base_height > 0 {
                av_info.geometry.base_width as f64 / av_info.geometry.base_height as f64
            } else {
                0.0
            },
            max_width: av_info.geometry.max_width,
            max_height: av_info.geometry.max_height,
        };
        let timing = FrameTiming {
            fps: av_info.timing.fps,
            sample_rate: av_info.timing.sample_rate,
        };

        Ok(EmulatorMetadata {
            library_name: String::new(),
            library_version: String::new(),
            valid_extensions: String::new(),
            geometry,
            timing,
        })
    }

    pub fn run_once(&mut self) -> Result<(), LibretroError> {
        if !self.initialized {
            return Err(LibretroError::Ffi("core is not initialized".to_string()));
        }
        let run = self.symbol::<RetroRun>(b"retro_run\0")?;
        unsafe { run() };
        Ok(())
    }

    pub fn serialize(&mut self) -> Result<Vec<u8>, LibretroError> {
        let size = self.serialize_size()?;
        if size == 0 {
            return Ok(Vec::new());
        }

        let bytes = vec![0u8; size];
        let serialize = self.symbol::<RetroSerialize>(b"retro_serialize\0")?;
        let success = unsafe { serialize(bytes.as_ptr() as *const c_void, size) };
        if success == 0 {
            return Err(LibretroError::Ffi("retro_serialize returned false".to_string()));
        }
        Ok(bytes)
    }

    pub fn unserialize(&mut self, data: &[u8]) -> Result<(), LibretroError> {
        if data.is_empty() {
            return Ok(());
        }
        let unserialize = self.symbol::<RetroUnserialize>(b"retro_unserialize\0")?;
        let success = unsafe { unserialize(data.as_ptr() as *const c_void, data.len()) };
        if success == 0 {
            return Err(LibretroError::Ffi(
                "retro_unserialize returned false".to_string(),
            ));
        }
        Ok(())
    }

    pub fn serialize_size(&mut self) -> Result<usize, LibretroError> {
        let serialize_size = self.symbol::<RetroSerializeSize>(b"retro_serialize_size\0")?;
        Ok(unsafe { serialize_size() })
    }

    pub fn update_input_state(&self, port: usize, raw: &[u8]) -> Result<(), LibretroError> {
        if port >= MAX_PLAYERS {
            return Err(LibretroError::InvalidPath(format!("port {port} out of range")));
        }
        if raw.len() < 2 {
            return Ok(());
        }

        let key_state = (u16::from(raw[1]) << 8) | u16::from(raw[0]);
        let mut axes = [0i16; MAX_AXES];
        for i in 0..MAX_AXES {
            let offset = (i + 1) * 2;
            if offset + 1 < raw.len() {
                axes[i] = i16::from_le_bytes([raw[offset], raw[offset + 1]]);
            }
        }

        let mut controllers = self
            .context
            .controllers
            .write()
            .map_err(|_| LibretroError::Ffi("controller lock poisoned".to_string()))?;
        controllers[port].key_state = key_state;
        controllers[port].axes = axes;
        Ok(())
    }

    pub fn shutdown_requested(&self) -> bool {
        self.context.shutdown_requested.load(Ordering::Acquire)
    }

    pub fn core_path(&self) -> &Path {
        &self.path
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn read_system_info(&mut self) -> Result<RetroSystemInfo, LibretroError> {
        let get_system_info = self.symbol::<RetroGetSystemInfo>(b"retro_get_system_info\0")?;
        let mut info = RetroSystemInfo::default();
        unsafe { get_system_info(&mut info as *mut _) };
        Ok(info)
    }

    fn retro_api_version(&mut self) -> Result<c_uint, LibretroError> {
        let get_api = self.symbol::<RetroApiVersion>(b"retro_api_version\0")?;
        Ok(unsafe { get_api() })
    }

    unsafe fn retro_init(&mut self) -> Result<(), LibretroError> {
        let init = self.symbol::<RetroInit>(b"retro_init\0")?;
        init();
        Ok(())
    }

    fn symbol<T>(&self, name: &[u8]) -> Result<T, LibretroError>
    where
        T: Copy,
    {
        // Safety: libloading returns a typed symbol with lifetime bound to `Library`;
        // copying into an owned function pointer avoids pinning this borrow.
        unsafe { self.library.get::<T>(name).map(|s| *s).map_err(LibretroError::from) }
    }

    pub fn shutdown(&mut self) -> Result<(), LibretroError> {
        if self.initialized {
            let unload = self.symbol::<RetroUnloadGame>(b"retro_unload_game\0")?;
            let deinit = self.symbol::<RetroDeinit>(b"retro_deinit\0")?;
            unsafe {
                unload();
                deinit();
            }
            self.initialized = false;
        }
        Ok(())
    }
}

impl Drop for Core {
    fn drop(&mut self) {
        let _ = self.shutdown();
        ACTIVE_CONTEXT.store(ptr::null_mut(), Ordering::Release);
    }
}

fn cstring_to_string(raw: *const c_char) -> Result<String, LibretroError> {
    if raw.is_null() {
        return Ok(String::new());
    }
    Ok(unsafe { CStr::from_ptr(raw) }
        .to_str()
        .map_err(|err| {
            LibretroError::InvalidCString(format!("invalid UTF-8 in library metadata: {err}"))
        })?
        .to_string())
}

pub fn parse_config_data(raw: &str) -> Vec<(String, String)> {
    raw.lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                return None;
            }
            let mut iter = trimmed.splitn(2, '=');
            let key = iter.next()?.trim();
            if key.is_empty() {
                return None;
            }
            let value = iter.next().unwrap_or_default().trim().to_string();
            Some((key.to_string(), value))
        })
        .collect()
}
