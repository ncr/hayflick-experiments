//! Minimal CUDA *driver API* FFI (libcuda.so), just enough for async OIDN
//! interop: a primary context + a stream, plus importing two Vulkan-exported
//! binary semaphores as CUDA external semaphores so the OIDN denoise can wait
//! on / signal Vulkan entirely GPU-side (no CPU round-trip).
//!
//! We bind the driver API (cu*) rather than the runtime (cudart) because only
//! libcuda.so is guaranteed present here. A `CudaSync` owns the context, the
//! stream (shared with OIDN), and the two imported semaphores; per frame it
//! enqueues a wait (semA) and a signal (semB) around the OIDN async execute.

use std::ffi::{c_int, c_uint, c_void};

pub type CUresult = c_int;
pub type CUdevice = c_int;
pub type CUcontext = *mut c_void;
pub type CUstream = *mut c_void;
pub type CUexternalSemaphore = *mut c_void;

const CUDA_SUCCESS: CUresult = 0;
// CUexternalSemaphoreHandleType
const CU_EXTERNAL_SEMAPHORE_HANDLE_TYPE_OPAQUE_FD: c_int = 1;

#[repr(C)]
union ExtSemHandle {
    fd: c_int,
    win32: [usize; 2],
    nvsci: *const c_void,
}

#[repr(C)]
struct ExtSemHandleDesc {
    type_: c_int,
    handle: ExtSemHandle,
    flags: c_uint,
    reserved: [c_uint; 16],
}

// The signal/wait param structs are only read for keyed-mutex / timeline
// semaphores; for an OPAQUE_FD *binary* semaphore every field is ignored, so a
// generously-oversized zeroed block is safe (CUDA reads only its own sizeof,
// which is smaller than this) and means flags = 0 → default binary behaviour.
#[repr(C)]
#[derive(Clone, Copy)]
struct ExtSemParams {
    blob: [u64; 32],
}
impl ExtSemParams {
    fn zeroed() -> ExtSemParams {
        ExtSemParams { blob: [0; 32] }
    }
}

#[link(name = "cuda")]
extern "C" {
    fn cuInit(flags: c_uint) -> CUresult;
    fn cuDeviceGet(device: *mut CUdevice, ordinal: c_int) -> CUresult;
    fn cuDevicePrimaryCtxRetain(pctx: *mut CUcontext, dev: CUdevice) -> CUresult;
    fn cuCtxSetCurrent(ctx: CUcontext) -> CUresult;
    fn cuStreamCreate(phStream: *mut CUstream, flags: c_uint) -> CUresult;
    fn cuImportExternalSemaphore(extSem_out: *mut CUexternalSemaphore, desc: *const ExtSemHandleDesc) -> CUresult;
    fn cuWaitExternalSemaphoresAsync(extSemArray: *const CUexternalSemaphore, paramsArray: *const ExtSemParams, num: c_uint, stream: CUstream) -> CUresult;
    fn cuSignalExternalSemaphoresAsync(extSemArray: *const CUexternalSemaphore, paramsArray: *const ExtSemParams, num: c_uint, stream: CUstream) -> CUresult;
    fn cuDestroyExternalSemaphore(extSem: CUexternalSemaphore) -> CUresult;
}

/// CUDA context + stream + two imported Vulkan semaphores for async interop.
/// The stream is handed to OIDN (`oidnNewCUDADevice`) so OIDN kernels enqueue
/// onto it, ordered after the `wait` and before the `signal` we record.
pub struct CudaSync {
    _ctx: CUcontext,
    pub stream: CUstream,
    sem_wait: CUexternalSemaphore,   // CUDA waits this (Vulkan signals it: copy-in done)
    sem_signal: CUexternalSemaphore, // CUDA signals this (Vulkan waits it: denoise done)
}

impl CudaSync {
    /// Initialise CUDA, retain device 0's primary context, create a stream, and
    /// import the two Vulkan-exported OPAQUE_FD semaphores. `fd_wait` is the
    /// semaphore Vulkan signals after the copy-in; `fd_signal` is the one CUDA
    /// signals when the denoise is done. CUDA takes ownership of both fds.
    pub unsafe fn new(fd_wait: c_int, fd_signal: c_int) -> Result<CudaSync, String> {
        chk(cuInit(0), "cuInit")?;
        let mut dev: CUdevice = 0;
        chk(cuDeviceGet(&mut dev, 0), "cuDeviceGet")?;
        let mut ctx: CUcontext = std::ptr::null_mut();
        chk(cuDevicePrimaryCtxRetain(&mut ctx, dev), "cuDevicePrimaryCtxRetain")?;
        chk(cuCtxSetCurrent(ctx), "cuCtxSetCurrent")?;
        let mut stream: CUstream = std::ptr::null_mut();
        chk(cuStreamCreate(&mut stream, 0), "cuStreamCreate")?;
        let sem_wait = import_sem(fd_wait)?;
        let sem_signal = import_sem(fd_signal)?;
        Ok(CudaSync { _ctx: ctx, stream, sem_wait, sem_signal })
    }

    /// Enqueue, on the OIDN stream, a wait on `sem_wait` (Vulkan's copy-in).
    pub unsafe fn enqueue_wait(&self) -> Result<(), String> {
        let p = ExtSemParams::zeroed();
        chk(cuWaitExternalSemaphoresAsync(&self.sem_wait, &p, 1, self.stream), "cuWaitExternalSemaphoresAsync")
    }

    /// Enqueue, on the OIDN stream, a signal of `sem_signal` (denoise done).
    pub unsafe fn enqueue_signal(&self) -> Result<(), String> {
        let p = ExtSemParams::zeroed();
        chk(cuSignalExternalSemaphoresAsync(&self.sem_signal, &p, 1, self.stream), "cuSignalExternalSemaphoresAsync")
    }
}

impl Drop for CudaSync {
    fn drop(&mut self) {
        unsafe {
            cuDestroyExternalSemaphore(self.sem_wait);
            cuDestroyExternalSemaphore(self.sem_signal);
            // primary context is left retained (released at process exit)
        }
    }
}

unsafe fn import_sem(fd: c_int) -> Result<CUexternalSemaphore, String> {
    let desc = ExtSemHandleDesc {
        type_: CU_EXTERNAL_SEMAPHORE_HANDLE_TYPE_OPAQUE_FD,
        handle: ExtSemHandle { fd },
        flags: 0,
        reserved: [0; 16],
    };
    let mut sem: CUexternalSemaphore = std::ptr::null_mut();
    chk(cuImportExternalSemaphore(&mut sem, &desc), "cuImportExternalSemaphore")?;
    Ok(sem)
}

fn chk(r: CUresult, what: &str) -> Result<(), String> {
    if r == CUDA_SUCCESS {
        Ok(())
    } else {
        Err(format!("{what} -> CUresult {r}"))
    }
}
