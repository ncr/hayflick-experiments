//! Minimal FFI to Intel Open Image Denoise (libOpenImageDenoise, v2.x C API).
//!
//! We bind the few stable C entry points directly rather than take a crate
//! dependency (the `oidn` crate tracks 1.x; the system lib here is 2.4). Used
//! as a denoise *dial* over the path tracer's HDR accumulation buffer — the
//! grain is liked, so this is opt-in.
//!
//! A `Denoiser` owns the OIDN device + filter + I/O buffer and is reused across
//! frames: CUDA device/context creation + the first filter commit cost ~250ms
//! (one-time), after which each `denoise()` is just write+execute+read (~1-2ms
//! on the RTX 5080). Prefers the CUDA device, falls back to CPU. The host<->
//! device copy still happens via OIDN buffers; true zero-copy would need
//! Vulkan/CUDA external-memory sharing.

use std::ffi::{c_char, c_int, c_void, CStr, CString};

#[repr(C)]
struct DeviceImpl {
    _p: [u8; 0],
}
#[repr(C)]
struct FilterImpl {
    _p: [u8; 0],
}
#[repr(C)]
struct BufferImpl {
    _p: [u8; 0],
}
type Device = *mut DeviceImpl;
type Filter = *mut FilterImpl;
type Buffer = *mut BufferImpl;

const OIDN_DEVICE_TYPE_CPU: c_int = 1;
const OIDN_DEVICE_TYPE_CUDA: c_int = 3;
const OIDN_FORMAT_FLOAT3: c_int = 3;

#[link(name = "OpenImageDenoise")]
extern "C" {
    fn oidnNewDevice(t: c_int) -> Device;
    fn oidnCommitDevice(d: Device);
    fn oidnReleaseDevice(d: Device);
    fn oidnGetDeviceError(d: Device, msg: *mut *const c_char) -> c_int;
    fn oidnNewFilter(d: Device, ty: *const c_char) -> Filter;
    #[allow(clippy::too_many_arguments)]
    fn oidnSetFilterImage(f: Filter, name: *const c_char, buf: Buffer, format: c_int, w: usize, h: usize, byte_offset: usize, pixel_stride: usize, row_stride: usize);
    fn oidnSetFilterBool(f: Filter, name: *const c_char, v: bool);
    fn oidnCommitFilter(f: Filter);
    fn oidnExecuteFilter(f: Filter);
    fn oidnReleaseFilter(f: Filter);
    fn oidnNewBuffer(d: Device, byte_size: usize) -> Buffer;
    fn oidnWriteBuffer(b: Buffer, byte_offset: usize, byte_size: usize, src: *const c_void);
    fn oidnReadBuffer(b: Buffer, byte_offset: usize, byte_size: usize, dst: *mut c_void);
    fn oidnReleaseBuffer(b: Buffer);
    fn oidnNewSharedBufferFromFD(d: Device, fd_type: c_int, fd: c_int, byte_size: usize) -> Buffer;
    fn oidnSyncDevice(d: Device);
    // CUDA-interop entry points (OIDN 2.x). `streams` are cudaStream_t, which is
    // ABI-identical to the driver API's CUstream (an opaque pointer).
    fn oidnNewCUDADevice(deviceIds: *const c_int, streams: *const *mut c_void, numPairs: c_int) -> Device;
    fn oidnExecuteFilterAsync(f: Filter);
}

const OIDN_EXTERNAL_MEMORY_TYPE_FLAG_OPAQUE_FD: c_int = 1 << 0;

unsafe fn device_error(dev: Device) -> Option<String> {
    let mut msg: *const c_char = std::ptr::null();
    if oidnGetDeviceError(dev, &mut msg) != 0 {
        Some(if msg.is_null() { "unknown".into() } else { CStr::from_ptr(msg).to_string_lossy().into_owned() })
    } else {
        None
    }
}

/// A persistent OIDN denoiser sized to one (w, h). Reused across frames.
pub struct Denoiser {
    dev: Device,
    filter: Filter,
    buf: Buffer,
    w: usize,
    h: usize,
    bytes: usize,
    cuda: bool,
}

impl Denoiser {
    /// Build a denoiser for `w×h` FLOAT3. Tries the CUDA device, falls back to
    /// CPU. The expensive device/commit cost is paid here, once.
    pub fn new(w: usize, h: usize) -> Result<Denoiser, String> {
        unsafe {
            // try CUDA, else CPU
            let (dev, cuda) = {
                let d = oidnNewDevice(OIDN_DEVICE_TYPE_CUDA);
                if !d.is_null() {
                    oidnCommitDevice(d);
                    if device_error(d).is_none() {
                        (d, true)
                    } else {
                        oidnReleaseDevice(d);
                        let c = oidnNewDevice(OIDN_DEVICE_TYPE_CPU);
                        oidnCommitDevice(c);
                        (c, false)
                    }
                } else {
                    let c = oidnNewDevice(OIDN_DEVICE_TYPE_CPU);
                    oidnCommitDevice(c);
                    (c, false)
                }
            };
            if dev.is_null() {
                return Err("no OIDN device".into());
            }
            let bytes = w * h * 3 * 4;
            let buf = oidnNewBuffer(dev, bytes);
            if buf.is_null() {
                oidnReleaseDevice(dev);
                return Err("oidnNewBuffer null".into());
            }
            let filter = oidnNewFilter(dev, CString::new("RT").unwrap().as_ptr());
            let (cn, on, hn) = (CString::new("color").unwrap(), CString::new("output").unwrap(), CString::new("hdr").unwrap());
            oidnSetFilterImage(filter, cn.as_ptr(), buf, OIDN_FORMAT_FLOAT3, w, h, 0, 0, 0);
            oidnSetFilterImage(filter, on.as_ptr(), buf, OIDN_FORMAT_FLOAT3, w, h, 0, 0, 0);
            oidnSetFilterBool(filter, hn.as_ptr(), true);
            oidnCommitFilter(filter); // one-time model load
            if let Some(e) = device_error(dev) {
                oidnReleaseFilter(filter);
                oidnReleaseBuffer(buf);
                oidnReleaseDevice(dev);
                return Err(e);
            }
            Ok(Denoiser { dev, filter, buf, w, h, bytes, cuda })
        }
    }

    pub fn matches(&self, w: usize, h: usize) -> bool {
        self.w == w && self.h == h
    }

    pub fn device_name(&self) -> &'static str {
        if self.cuda {
            "cuda"
        } else {
            "cpu"
        }
    }

    /// Denoise an HDR linear-RGB image in place (FLOAT3, len = w·h·3).
    pub fn denoise(&self, color: &mut [f32]) -> Result<(), String> {
        assert_eq!(color.len(), self.w * self.h * 3);
        unsafe {
            oidnWriteBuffer(self.buf, 0, self.bytes, color.as_ptr() as *const c_void);
            oidnExecuteFilter(self.filter);
            if let Some(e) = device_error(self.dev) {
                return Err(e);
            }
            oidnReadBuffer(self.buf, 0, self.bytes, color.as_mut_ptr() as *mut c_void);
        }
        Ok(())
    }
}

impl Drop for Denoiser {
    fn drop(&mut self) {
        unsafe {
            oidnReleaseFilter(self.filter);
            oidnReleaseBuffer(self.buf);
            oidnReleaseDevice(self.dev);
        }
    }
}

/// Zero-copy denoiser: the OIDN buffer aliases Vulkan-exported device memory
/// (imported via an OPAQUE_FD), so there is NO host readback — Vulkan writes the
/// HDR pixels into the shared VRAM, OIDN denoises them in place, Vulkan reads
/// them back, all on the GPU. Requires a CUDA device. The input may be the
/// *summed* accumulator (OIDN's HDR autoexposure is scale-invariant; the tonemap
/// divides by the sample count afterwards), so no normalize pass is needed.
pub struct InteropDenoiser {
    dev: Device,
    filter: Filter,
    buf: Buffer,
    w: usize,
    h: usize,
}

impl InteropDenoiser {
    /// `fd` is a Vulkan-exported OPAQUE_FD for a `byte_size`-byte allocation
    /// holding an rgba32f `w×h` image (16-byte stride). OIDN takes ownership of
    /// the fd. Denoises the RGB in place, skipping alpha.
    pub fn from_fd(fd: i32, byte_size: usize, w: usize, h: usize) -> Result<InteropDenoiser, String> {
        unsafe {
            let dev = oidnNewDevice(OIDN_DEVICE_TYPE_CUDA);
            if dev.is_null() {
                return Err("CUDA device null".into());
            }
            oidnCommitDevice(dev);
            if let Some(e) = device_error(dev) {
                oidnReleaseDevice(dev);
                return Err(e);
            }
            let buf = oidnNewSharedBufferFromFD(dev, OIDN_EXTERNAL_MEMORY_TYPE_FLAG_OPAQUE_FD, fd, byte_size);
            if buf.is_null() {
                let e = device_error(dev).unwrap_or_else(|| "shared buffer null".into());
                oidnReleaseDevice(dev);
                return Err(e);
            }
            let filter = oidnNewFilter(dev, CString::new("RT").unwrap().as_ptr());
            let (cn, on, hn) = (CString::new("color").unwrap(), CString::new("output").unwrap(), CString::new("hdr").unwrap());
            let stride = 16usize; // rgba32f
            let row = w * stride;
            oidnSetFilterImage(filter, cn.as_ptr(), buf, OIDN_FORMAT_FLOAT3, w, h, 0, stride, row);
            oidnSetFilterImage(filter, on.as_ptr(), buf, OIDN_FORMAT_FLOAT3, w, h, 0, stride, row);
            oidnSetFilterBool(filter, hn.as_ptr(), true);
            oidnCommitFilter(filter);
            if let Some(e) = device_error(dev) {
                oidnReleaseFilter(filter);
                oidnReleaseBuffer(buf);
                oidnReleaseDevice(dev);
                return Err(e);
            }
            Ok(InteropDenoiser { dev, filter, buf, w, h })
        }
    }

    pub fn matches(&self, w: usize, h: usize) -> bool {
        self.w == w && self.h == h
    }

    /// Denoise in place (the shared buffer already holds Vulkan's pixels). The
    /// caller must have completed the Vulkan write (queue idle) before this, and
    /// must wait for `sync` before Vulkan reads the result.
    pub fn denoise(&self) -> Result<(), String> {
        unsafe {
            oidnExecuteFilter(self.filter);
            oidnSyncDevice(self.dev);
            match device_error(self.dev) {
                Some(e) => Err(e),
                None => Ok(()),
            }
        }
    }
}

impl Drop for InteropDenoiser {
    fn drop(&mut self) {
        unsafe {
            oidnReleaseFilter(self.filter);
            oidnReleaseBuffer(self.buf);
            oidnReleaseDevice(self.dev);
        }
    }
}

/// Fully-async denoiser: like `InteropDenoiser` (zero-copy shared VRAM, no host
/// readback) but the OIDN device runs on an externally-supplied CUDA stream, so
/// `execute_async` only *enqueues* the denoise — no `oidnSyncDevice`, no CPU
/// block. Synchronisation with Vulkan is done with CUDA external-semaphore
/// waits/signals on that same stream (see `cuda::CudaSync`). The caller records
/// the wait *before* and the signal *after* `execute_async`.
pub struct AsyncInteropDenoiser {
    dev: Device,
    filter: Filter,
    buf: Buffer,
    w: usize,
    h: usize,
}

impl AsyncInteropDenoiser {
    /// `stream` is a CUstream (== cudaStream_t) the OIDN device should enqueue
    /// onto. `fd` is the Vulkan-exported OPAQUE_FD for the shared rgba32f image.
    pub fn from_fd_and_stream(fd: i32, byte_size: usize, w: usize, h: usize, stream: *mut c_void) -> Result<AsyncInteropDenoiser, String> {
        unsafe {
            let ids = [0i32];
            let streams = [stream];
            let dev = oidnNewCUDADevice(ids.as_ptr(), streams.as_ptr(), 1);
            if dev.is_null() {
                return Err("oidnNewCUDADevice null".into());
            }
            oidnCommitDevice(dev);
            if let Some(e) = device_error(dev) {
                oidnReleaseDevice(dev);
                return Err(e);
            }
            let buf = oidnNewSharedBufferFromFD(dev, OIDN_EXTERNAL_MEMORY_TYPE_FLAG_OPAQUE_FD, fd, byte_size);
            if buf.is_null() {
                let e = device_error(dev).unwrap_or_else(|| "shared buffer null".into());
                oidnReleaseDevice(dev);
                return Err(e);
            }
            let filter = oidnNewFilter(dev, CString::new("RT").unwrap().as_ptr());
            let (cn, on, hn) = (CString::new("color").unwrap(), CString::new("output").unwrap(), CString::new("hdr").unwrap());
            let (stride, row) = (16usize, w * 16);
            oidnSetFilterImage(filter, cn.as_ptr(), buf, OIDN_FORMAT_FLOAT3, w, h, 0, stride, row);
            oidnSetFilterImage(filter, on.as_ptr(), buf, OIDN_FORMAT_FLOAT3, w, h, 0, stride, row);
            oidnSetFilterBool(filter, hn.as_ptr(), true);
            oidnCommitFilter(filter);
            if let Some(e) = device_error(dev) {
                oidnReleaseFilter(filter);
                oidnReleaseBuffer(buf);
                oidnReleaseDevice(dev);
                return Err(e);
            }
            Ok(AsyncInteropDenoiser { dev, filter, buf, w, h })
        }
    }

    pub fn matches(&self, w: usize, h: usize) -> bool {
        self.w == w && self.h == h
    }

    /// Enqueue the denoise on the OIDN stream — does NOT block. Ordering with
    /// Vulkan is via the external-semaphore wait/signal the caller brackets
    /// this with on the same stream.
    pub fn execute_async(&self) -> Result<(), String> {
        unsafe {
            oidnExecuteFilterAsync(self.filter);
            match device_error(self.dev) {
                Some(e) => Err(e),
                None => Ok(()),
            }
        }
    }
}

impl Drop for AsyncInteropDenoiser {
    fn drop(&mut self) {
        unsafe {
            oidnReleaseFilter(self.filter);
            oidnReleaseBuffer(self.buf);
            oidnReleaseDevice(self.dev);
        }
    }
}
