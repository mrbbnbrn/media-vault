//! WASAPI loopback capture of the default sound output (Windows only): what
//! plays through the speakers or headphones, read straight from the Windows
//! audio engine. Used by beatlisten.rs; nothing is written anywhere.
//!
//! Plain, well-trodden WASAPI: the real default render endpoint from
//! IMMDeviceEnumerator, IAudioClient in shared mode with
//! AUDCLNT_STREAMFLAGS_LOOPBACK, its own mix format, and polling (no event
//! handle: event-driven loopback has had OS bugs, and polling every 10 ms
//! against a 200 ms buffer loses nothing). While nothing plays, Windows
//! delivers no packets at all; the caller treats that as silence.

use std::ffi::c_void;

use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
use windows::Win32::Media::Audio::{
    AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, IAudioCaptureClient,
    IAudioClient, IMMDevice, IMMDeviceEnumerator, MMDeviceEnumerator, WAVEFORMATEX, WAVEFORMATEXTENSIBLE, eConsole,
    eRender,
};
use windows::Win32::System::Com::{
    CLSCTX_ALL, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, STGM_READ,
};

use crate::beatloop::{Capture, Health, Opener, SampleKind, StreamInfo, decode_mono};

/// COM for the listening thread. Dropped last, after every COM object.
pub struct Com(bool);

impl Com {
    pub fn init() -> Self {
        // S_OK and S_FALSE both need a matching CoUninitialize; a thread
        // that already had another apartment type still works, untouched.
        let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        Com(hr.is_ok())
    }
}

impl Drop for Com {
    fn drop(&mut self) {
        if self.0 {
            unsafe { CoUninitialize() };
        }
    }
}

fn err(what: &str, e: &windows::core::Error) -> String {
    format!("{what} ({:#010x}: {})", e.code().0, e.message().trim())
}

#[derive(Default)]
pub struct WasapiOpener {
    enumerator: Option<IMMDeviceEnumerator>,
}

impl WasapiOpener {
    fn enumerator(&mut self) -> Result<IMMDeviceEnumerator, String> {
        if let Some(e) = &self.enumerator {
            return Ok(e.clone());
        }
        let e: IMMDeviceEnumerator = unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
            .map_err(|e| err("Windows audio isn't available", &e))?;
        self.enumerator = Some(e.clone());
        Ok(e)
    }
}

fn default_output(enumerator: &IMMDeviceEnumerator) -> Result<IMMDevice, String> {
    unsafe { enumerator.GetDefaultAudioEndpoint(eRender, eConsole) }
        .map_err(|e| err("No speakers or headphones are set as the default output", &e))
}

fn device_id(device: &IMMDevice) -> Option<String> {
    unsafe {
        let p = device.GetId().ok()?;
        let s = p.to_string().ok();
        CoTaskMemFree(Some(p.0 as *const c_void));
        s
    }
}

fn friendly_name(device: &IMMDevice) -> Option<String> {
    unsafe {
        let store = device.OpenPropertyStore(STGM_READ).ok()?;
        let value = store.GetValue(&PKEY_Device_FriendlyName).ok()?;
        let name = value.to_string();
        (!name.trim().is_empty()).then_some(name)
    }
}

/// The parts of the mix format the decoder needs.
struct Format {
    kind: SampleKind,
    rate: u32,
    channels: u16,
    block_align: u16,
}

/// # Safety
/// `p` must point at a WAVEFORMATEX from GetMixFormat (still allocated).
unsafe fn read_format(p: *const WAVEFORMATEX) -> Result<Format, String> {
    // The structs are packed: copy them out, then read fields by value.
    let wf: WAVEFORMATEX = unsafe { std::ptr::read_unaligned(p) };
    let tag = wf.wFormatTag;
    let bits = wf.wBitsPerSample;
    let channels = wf.nChannels;
    let rate = wf.nSamplesPerSec;
    let block_align = wf.nBlockAlign;
    let extra = wf.cbSize;
    let sub_tag = if tag == 0xFFFE && usize::from(extra) >= 22 {
        let ext: WAVEFORMATEXTENSIBLE = unsafe { std::ptr::read_unaligned(p.cast::<WAVEFORMATEXTENSIBLE>()) };
        let sub = ext.SubFormat;
        Some(sub.data1)
    } else {
        None
    };
    let kind = SampleKind::from_wave_format(tag, bits, sub_tag).ok_or_else(|| {
        format!("the sound output uses a format beat sync can't read (tag {tag:#x}, {bits} bits)")
    })?;
    if channels == 0 || rate == 0 || usize::from(block_align) < usize::from(channels) * kind.bytes() {
        return Err(format!("the sound output reported an odd format ({channels} channels, {rate} Hz)"));
    }
    Ok(Format { kind, rate, channels, block_align })
}

impl Opener for WasapiOpener {
    type C = WasapiCapture;

    fn open(&mut self) -> Result<WasapiCapture, String> {
        let enumerator = self.enumerator()?;
        let device = default_output(&enumerator)?;
        let id = device_id(&device);
        let name = friendly_name(&device).unwrap_or_else(|| "the default sound output".to_string());
        let client: IAudioClient =
            unsafe { device.Activate(CLSCTX_ALL, None) }.map_err(|e| err(&format!("{name}: couldn't use it"), &e))?;
        let mix = unsafe { client.GetMixFormat() }.map_err(|e| err(&format!("{name}: couldn't read its sound format"), &e))?;
        if mix.is_null() {
            return Err(format!("{name}: couldn't read its sound format"));
        }
        let format = unsafe { read_format(mix) };
        // 200 ms of buffer, in 100 ns units.
        let init = unsafe {
            client.Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, 2_000_000, 0, mix, None)
        };
        unsafe { CoTaskMemFree(Some(mix as *const c_void)) };
        let format = format.map_err(|e| format!("{name}: {e}"))?;
        init.map_err(|e| err(&format!("{name}: Windows refused to share its sound (loopback)"), &e))?;
        let capture: IAudioCaptureClient =
            unsafe { client.GetService() }.map_err(|e| err(&format!("{name}: no capture service"), &e))?;
        let volume: Option<IAudioEndpointVolume> = unsafe { device.Activate(CLSCTX_ALL, None) }.ok();
        unsafe { client.Start() }.map_err(|e| err(&format!("{name}: couldn't start listening"), &e))?;
        Ok(WasapiCapture { enumerator, client, capture, volume, id, name, format })
    }
}

pub struct WasapiCapture {
    enumerator: IMMDeviceEnumerator,
    client: IAudioClient,
    capture: IAudioCaptureClient,
    volume: Option<IAudioEndpointVolume>,
    id: Option<String>,
    name: String,
    format: Format,
}

impl Drop for WasapiCapture {
    fn drop(&mut self) {
        let _ = unsafe { self.client.Stop() };
    }
}

impl Capture for WasapiCapture {
    fn info(&self) -> StreamInfo {
        StreamInfo {
            device: self.name.clone(),
            rate: self.format.rate,
            channels: self.format.channels,
            kind: self.format.kind,
        }
    }

    fn read(&mut self, out: &mut Vec<f32>) -> Result<(), String> {
        let f = &self.format;
        // Bounded, in case a driver keeps reporting packets forever.
        for _ in 0..64 {
            let next = unsafe { self.capture.GetNextPacketSize() }.map_err(|e| err("reading failed", &e))?;
            if next == 0 {
                return Ok(());
            }
            let mut data: *mut u8 = std::ptr::null_mut();
            let mut frames: u32 = 0;
            let mut flags: u32 = 0;
            unsafe { self.capture.GetBuffer(&mut data, &mut frames, &mut flags, None, None) }
                .map_err(|e| err("reading failed", &e))?;
            if frames == 0 {
                let _ = unsafe { self.capture.ReleaseBuffer(0) };
                return Ok(());
            }
            let silent = flags & (AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0;
            if silent || data.is_null() {
                out.resize(out.len() + frames as usize, 0.0);
            } else {
                let len = frames as usize * usize::from(f.block_align);
                // Valid until ReleaseBuffer, below.
                let bytes = unsafe { std::slice::from_raw_parts(data.cast_const(), len) };
                decode_mono(bytes, f.kind, usize::from(f.channels), usize::from(f.block_align), out);
            }
            unsafe { self.capture.ReleaseBuffer(frames) }.map_err(|e| err("reading failed", &e))?;
        }
        Ok(())
    }

    fn health(&mut self) -> Health {
        let now = default_output(&self.enumerator).ok().and_then(|d| device_id(&d));
        let (volume, muted) = match &self.volume {
            Some(v) => unsafe {
                (v.GetMasterVolumeLevelScalar().ok(), v.GetMute().map(|b| b.as_bool()).unwrap_or(false))
            },
            None => (None, false),
        };
        // Moved when the default output is now another one, or gone.
        let moved = match (&self.id, &now) {
            (_, None) => true,
            (Some(was), Some(is)) => was != is,
            (None, Some(_)) => false,
        };
        Health { moved, volume, muted }
    }
}
