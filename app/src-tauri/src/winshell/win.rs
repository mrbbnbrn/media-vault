//! The Windows side: an OLE data object offering "virtual files"
//! (FileGroupDescriptorW + FileContents), streams that decrypt from the vault
//! while Explorer reads them, the drag itself, and the clipboard.
//!
//! OLE needs a single-threaded apartment with a message loop, so everything
//! that touches the data object runs on the app's main (UI) thread. The
//! clipboard object stays alive there until it is replaced or cleared.

use std::cell::{Cell, RefCell};
use std::ffi::c_void;
use std::io::{Seek, SeekFrom};
use std::mem::ManuallyDrop;
use std::sync::Weak;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Manager};
use windows::Win32::Foundation::{
    DATA_S_SAMEFORMATETC, DRAGDROP_S_CANCEL, DRAGDROP_S_DROP, DRAGDROP_S_USEDEFAULTCURSORS, DV_E_FORMATETC, DV_E_LINDEX,
    E_FAIL, E_NOTIMPL, E_POINTER, GlobalFree, HANDLE, HGLOBAL, HWND, OLE_E_ADVISENOTSUPPORTED, S_FALSE, S_OK,
    STG_E_ACCESSDENIED, STG_E_INVALIDFUNCTION, STG_E_READFAULT,
};
use windows::Win32::System::Com::{
    CoTaskMemAlloc, DATADIR_GET, DVASPECT_CONTENT, FORMATETC, IAdviseSink, IDataObject, IDataObject_Impl,
    IEnumFORMATETC, IEnumSTATDATA, ISequentialStream_Impl, IStream, IStream_Impl, LOCKTYPE, STATFLAG, STATFLAG_NONAME,
    STATSTG, STGC, STGM_READ, STGMEDIUM, STGMEDIUM_0, STGTY_STREAM, STREAM_SEEK, STREAM_SEEK_CUR, STREAM_SEEK_END,
    STREAM_SEEK_SET, TYMED_HGLOBAL, TYMED_ISTREAM,
};
use windows::Win32::System::DataExchange::{
    CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard, RegisterClipboardFormatW,
};
use windows::Win32::System::Memory::{GMEM_MOVEABLE, GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock};
use windows::Win32::System::Ole::{
    CF_DIB, CF_DIBV5, CF_HDROP, DROPEFFECT, DROPEFFECT_COPY, IDropSource, IDropSource_Impl, OleInitialize,
    OleSetClipboard, ReleaseStgMedium,
};
use windows::Win32::System::SystemServices::{MK_LBUTTON, MODIFIERKEYS_FLAGS};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_RBUTTON};
use windows::Win32::UI::Shell::{
    CFSTR_FILECONTENTS, CFSTR_FILEDESCRIPTORW, CFSTR_PREFERREDDROPEFFECT, DragQueryFileW, FD_ATTRIBUTES, FD_FILESIZE,
    FD_PROGRESSUI, FD_UNICODE, FILEDESCRIPTORW, FILEGROUPDESCRIPTORW, HDROP, SHCreateStdEnumFmtEtc, SHDoDragDrop,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetSystemMetrics, IDYES, MB_DEFBUTTON2, MB_ICONWARNING, MB_SETFOREGROUND, MB_TOPMOST, MB_YESNO, MessageBoxW,
    SM_SWAPBUTTON,
};
use windows::core::{BOOL, HRESULT, Interface, PCWSTR, PWSTR, Ref, implement, w};

use super::{ClipboardContent, VEntry, dib_to_png, file_count, is_png, paste_question};
use crate::session::Session;

const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x10;
const FILE_ATTRIBUTE_NORMAL: u32 = 0x80;
/// HRESULT_FROM_WIN32(ERROR_CANCELLED): Explorer treats it as "the user said no".
const E_CANCELLED: HRESULT = HRESULT(0x8007_04C7_u32 as i32);

// ---- running on the UI thread ---------------------------------------------------

/// Run `f` on the main thread and wait for its answer (call from a worker).
fn on_main<T: Send + 'static>(
    app: &AppHandle,
    f: impl FnOnce(&AppHandle) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    let a = app.clone();
    app.run_on_main_thread(move || {
        let _ = tx.send(f(&a));
    })
    .map_err(|e| e.to_string())?;
    rx.recv().map_err(|_| "The window is closing.".to_string())?
}

thread_local! {
    static OLE_READY: Cell<bool> = const { Cell::new(false) };
    /// Our object while it is on the clipboard (main thread only).
    static CLIP: RefCell<Option<IDataObject>> = const { RefCell::new(None) };
}

fn ensure_ole() -> Result<(), String> {
    if OLE_READY.get() {
        return Ok(());
    }
    // The window already set OLE up for drag and drop; this just makes sure.
    unsafe { OleInitialize(None) }.map_err(|_| "Windows drag and drop isn't available right now.".to_string())?;
    OLE_READY.set(true);
    Ok(())
}

fn main_hwnd(app: &AppHandle) -> Option<HWND> {
    app.get_webview_window("main").and_then(|w| w.hwnd().ok())
}

fn format_id(name: PCWSTR) -> u16 {
    unsafe { RegisterClipboardFormatW(name) as u16 }
}

struct Formats {
    descriptor: u16,
    contents: u16,
    preferred: u16,
    ours: u16,
    /// Keep the entry out of clipboard history and cloud clipboard.
    private: [u16; 3],
}

fn formats() -> Formats {
    Formats {
        descriptor: format_id(CFSTR_FILEDESCRIPTORW),
        contents: format_id(CFSTR_FILECONTENTS),
        preferred: format_id(CFSTR_PREFERREDDROPEFFECT),
        ours: format_id(w!("MediaVault.Items")),
        private: [
            format_id(w!("ExcludeClipboardContentFromMonitorProcessing")),
            format_id(w!("CanIncludeInClipboardHistory")),
            format_id(w!("CanUploadToCloudClipboard")),
        ],
    }
}

// ---- memory helpers -----------------------------------------------------------

fn hglobal_from(bytes: &[u8]) -> windows::core::Result<HGLOBAL> {
    unsafe {
        let h = GlobalAlloc(GMEM_MOVEABLE, bytes.len().max(1))?;
        let p = GlobalLock(h) as *mut u8;
        if p.is_null() {
            let _ = GlobalFree(Some(h));
            return Err(E_FAIL.into());
        }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), p, bytes.len());
        let _ = GlobalUnlock(h);
        Ok(h)
    }
}

fn bytes_of(h: HGLOBAL) -> Option<Vec<u8>> {
    unsafe {
        let p = GlobalLock(h) as *const u8;
        if p.is_null() {
            return None;
        }
        let v = std::slice::from_raw_parts(p, GlobalSize(h)).to_vec();
        let _ = GlobalUnlock(h);
        Some(v)
    }
}

fn hglobal_medium(bytes: &[u8]) -> windows::core::Result<STGMEDIUM> {
    Ok(STGMEDIUM {
        tymed: TYMED_HGLOBAL.0 as u32,
        u: STGMEDIUM_0 { hGlobal: hglobal_from(bytes)? },
        pUnkForRelease: ManuallyDrop::new(None),
    })
}

/// FILEGROUPDESCRIPTORW with one FILEDESCRIPTORW per entry.
fn descriptor_bytes(plan: &[VEntry]) -> Vec<u8> {
    let head = std::mem::offset_of!(FILEGROUPDESCRIPTORW, fgd);
    let one = std::mem::size_of::<FILEDESCRIPTORW>();
    let mut out = vec![0u8; head + one * plan.len()];
    out[..4].copy_from_slice(&(plan.len() as u32).to_le_bytes());
    for (i, e) in plan.iter().enumerate() {
        let mut d = FILEDESCRIPTORW {
            dwFlags: (FD_ATTRIBUTES.0 | FD_UNICODE.0 | FD_PROGRESSUI.0) as u32,
            ..Default::default()
        };
        match &e.file {
            Some(f) => {
                d.dwFileAttributes = FILE_ATTRIBUTE_NORMAL;
                // A cleaned picture's size is only known once it is read.
                if let Some(size) = f.known_size(&e.path) {
                    d.dwFlags |= FD_FILESIZE.0 as u32;
                    d.nFileSizeHigh = (size >> 32) as u32;
                    d.nFileSizeLow = size as u32;
                }
            }
            None => d.dwFileAttributes = FILE_ATTRIBUTE_DIRECTORY,
        }
        // (The struct is packed, so fill a copy of the name and store it whole.)
        let mut name = [0u16; 260];
        for (k, u) in e.path.encode_utf16().take(name.len() - 1).enumerate() {
            name[k] = u;
        }
        d.cFileName = name;
        let src = unsafe { std::slice::from_raw_parts((&d as *const FILEDESCRIPTORW) as *const u8, one) };
        out[head + i * one..head + (i + 1) * one].copy_from_slice(src);
    }
    out
}

// ---- a file being read out of the vault ---------------------------------------

use crate::stripmeta::ReadSeek;

#[implement(IStream)]
struct VaultStream {
    session: Weak<Session>,
    object: String,
    name: String,
    size: u64,
    /// Remove camera info, location and dates while reading.
    strip: bool,
    reader: RefCell<Option<Box<dyn ReadSeek>>>,
    pos: Cell<u64>,
}

impl VaultStream {
    /// The decrypting reader, opened on first use. Fails (and lets go of
    /// it) once the vault has been locked.
    fn with_reader<T>(&self, f: impl FnOnce(&mut dyn ReadSeek) -> std::io::Result<T>) -> windows::core::Result<T> {
        let open = self.session.upgrade().filter(|s| !s.is_closed());
        let Some(s) = open else {
            self.reader.borrow_mut().take();
            return Err(STG_E_ACCESSDENIED.into());
        };
        let mut slot = self.reader.borrow_mut();
        if slot.is_none() {
            let (mut r, _) = super::open_item(&s, &self.object, &self.name, self.strip)
                .map_err(|_| windows::core::Error::from(STG_E_READFAULT))?;
            r.seek(SeekFrom::Start(self.pos.get())).map_err(|_| windows::core::Error::from(STG_E_READFAULT))?;
            *slot = Some(r);
        }
        drop(s);
        f(slot.as_mut().unwrap().as_mut()).map_err(|_| STG_E_READFAULT.into())
    }
}

impl ISequentialStream_Impl for VaultStream_Impl {
    fn Read(&self, pv: *mut c_void, cb: u32, pcbread: *mut u32) -> HRESULT {
        if pv.is_null() {
            return E_POINTER;
        }
        let buf = unsafe { std::slice::from_raw_parts_mut(pv as *mut u8, cb as usize) };
        let r = self.with_reader(|r| {
            let mut n = 0;
            while n < buf.len() {
                let k = r.read(&mut buf[n..])?;
                if k == 0 {
                    break;
                }
                n += k;
            }
            Ok(n)
        });
        match r {
            Ok(n) => {
                self.pos.set(self.pos.get() + n as u64);
                if !pcbread.is_null() {
                    unsafe { *pcbread = n as u32 };
                }
                if n == cb as usize { S_OK } else { S_FALSE }
            }
            Err(e) => {
                if !pcbread.is_null() {
                    unsafe { *pcbread = 0 };
                }
                e.code()
            }
        }
    }

    fn Write(&self, _pv: *const c_void, _cb: u32, _pcbwritten: *mut u32) -> HRESULT {
        STG_E_ACCESSDENIED
    }
}

impl IStream_Impl for VaultStream_Impl {
    fn Seek(&self, dlibmove: i64, dworigin: STREAM_SEEK, plibnewposition: *mut u64) -> windows::core::Result<()> {
        let base = match dworigin {
            STREAM_SEEK_SET => 0i128,
            STREAM_SEEK_CUR => self.pos.get() as i128,
            STREAM_SEEK_END => self.size as i128,
            _ => return Err(STG_E_INVALIDFUNCTION.into()),
        };
        let to = base + dlibmove as i128;
        if to < 0 {
            return Err(STG_E_INVALIDFUNCTION.into());
        }
        let to = to as u64;
        if self.reader.borrow().is_some() {
            self.with_reader(|r| r.seek(SeekFrom::Start(to)))?;
        }
        self.pos.set(to);
        if !plibnewposition.is_null() {
            unsafe { *plibnewposition = to };
        }
        Ok(())
    }
    fn SetSize(&self, _libnewsize: u64) -> windows::core::Result<()> {
        Err(STG_E_ACCESSDENIED.into())
    }
    fn CopyTo(&self, _pstm: Ref<IStream>, _cb: u64, _pcbread: *mut u64, _pcbwritten: *mut u64) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }
    fn Commit(&self, _grfcommitflags: &STGC) -> windows::core::Result<()> {
        Ok(())
    }
    fn Revert(&self) -> windows::core::Result<()> {
        Ok(())
    }
    fn LockRegion(&self, _liboffset: u64, _cb: u64, _dwlocktype: &LOCKTYPE) -> windows::core::Result<()> {
        Err(STG_E_INVALIDFUNCTION.into())
    }
    fn UnlockRegion(&self, _liboffset: u64, _cb: u64, _dwlocktype: u32) -> windows::core::Result<()> {
        Err(STG_E_INVALIDFUNCTION.into())
    }
    fn Stat(&self, pstatstg: *mut STATSTG, grfstatflag: &STATFLAG) -> windows::core::Result<()> {
        if pstatstg.is_null() {
            return Err(E_POINTER.into());
        }
        let mut name = PWSTR::null();
        if grfstatflag.0 & STATFLAG_NONAME.0 == 0 {
            let wide: Vec<u16> = self.name.encode_utf16().chain(std::iter::once(0)).collect();
            unsafe {
                let p = CoTaskMemAlloc(wide.len() * 2) as *mut u16;
                if !p.is_null() {
                    std::ptr::copy_nonoverlapping(wide.as_ptr(), p, wide.len());
                    name = PWSTR(p);
                }
            }
        }
        unsafe {
            *pstatstg = STATSTG {
                pwcsName: name,
                r#type: STGTY_STREAM.0 as u32,
                cbSize: self.size,
                grfMode: STGM_READ,
                ..Default::default()
            };
        }
        Ok(())
    }
    fn Clone(&self) -> windows::core::Result<IStream> {
        Err(E_NOTIMPL.into())
    }
}

// ---- the data object ----------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
enum Ask {
    /// Dragging: the window already asked.
    Yes,
    /// Clipboard: ask once, when Explorer first wants the files.
    Pending,
    Asking,
    No,
}

#[implement(IDataObject)]
struct VaultData {
    plan: Vec<VEntry>,
    session: Weak<Session>,
    f: Formats,
    ask: Cell<Ask>,
    owner: isize,
    /// Whatever Explorer stores on the object while dragging/pasting
    /// (drag image, drop description, "paste succeeded"…), handed back on request.
    extra: RefCell<Vec<(u16, Vec<u8>)>>,
}

impl VaultData {
    fn new(plan: Vec<VEntry>, session: Weak<Session>, ask: Ask, owner: Option<HWND>) -> Self {
        VaultData {
            plan,
            session,
            f: formats(),
            ask: Cell::new(ask),
            owner: owner.map_or(0, |h| h.0 as isize),
            extra: RefCell::new(Vec::new()),
        }
    }

    fn allowed(&self) -> windows::core::Result<()> {
        match self.ask.get() {
            Ask::Yes => Ok(()),
            Ask::No | Ask::Asking => Err(E_CANCELLED.into()),
            Ask::Pending => {
                self.ask.set(Ask::Asking);
                let text: Vec<u16> = paste_question(file_count(&self.plan)).encode_utf16().chain([0]).collect();
                let owner = (self.owner != 0).then_some(HWND(self.owner as *mut c_void));
                let r = unsafe {
                    MessageBoxW(
                        owner,
                        PCWSTR(text.as_ptr()),
                        w!("Media Vault"),
                        MB_YESNO | MB_ICONWARNING | MB_DEFBUTTON2 | MB_TOPMOST | MB_SETFOREGROUND,
                    )
                };
                let yes = r == IDYES;
                self.ask.set(if yes { Ask::Yes } else { Ask::No });
                if yes { Ok(()) } else { Err(E_CANCELLED.into()) }
            }
        }
    }

    fn all_formats(&self) -> Vec<FORMATETC> {
        let fe = |cf: u16, tymed: i32| FORMATETC {
            cfFormat: cf,
            ptd: std::ptr::null_mut(),
            dwAspect: DVASPECT_CONTENT.0,
            lindex: -1,
            tymed: tymed as u32,
        };
        let mut v = vec![
            fe(self.f.descriptor, TYMED_HGLOBAL.0),
            fe(self.f.contents, TYMED_ISTREAM.0),
            fe(self.f.preferred, TYMED_HGLOBAL.0),
            fe(self.f.ours, TYMED_HGLOBAL.0),
        ];
        v.extend(self.f.private.iter().map(|cf| fe(*cf, TYMED_HGLOBAL.0)));
        v
    }

    fn stream(&self, lindex: i32) -> windows::core::Result<IStream> {
        let index = if lindex < 0 && self.plan.len() == 1 { 0 } else { lindex };
        let entry = usize::try_from(index).ok().and_then(|i| self.plan.get(i)).ok_or(DV_E_LINDEX)?;
        let file = entry.file.as_ref().ok_or(DV_E_LINDEX)?;
        let name = entry.path.rsplit('\\').next().unwrap_or(&entry.path).to_string();
        // A cleaned picture is made right away, so its real size is known.
        let (reader, size) = if file.known_size(&entry.path).is_none() {
            let s = self.session.upgrade().filter(|s| !s.is_closed()).ok_or(STG_E_ACCESSDENIED)?;
            let (r, n) = super::open_item(&s, &file.object, &name, true).map_err(|_| STG_E_READFAULT)?;
            (Some(r), n)
        } else {
            (None, file.size)
        };
        Ok(VaultStream {
            session: self.session.clone(),
            object: file.object.clone(),
            name,
            size,
            strip: file.strip,
            reader: RefCell::new(reader),
            pos: Cell::new(0),
        }
        .into())
    }
}

impl IDataObject_Impl for VaultData_Impl {
    fn GetData(&self, pformatetcin: *const FORMATETC) -> windows::core::Result<STGMEDIUM> {
        let fe = unsafe { pformatetcin.as_ref() }.ok_or(E_POINTER)?;
        let cf = fe.cfFormat;
        let wants = |t: i32| fe.tymed & t as u32 != 0;
        if cf == self.f.descriptor && wants(TYMED_HGLOBAL.0) {
            self.allowed()?;
            return hglobal_medium(&descriptor_bytes(&self.plan));
        }
        if cf == self.f.contents && wants(TYMED_ISTREAM.0) {
            self.allowed()?;
            let s = self.stream(fe.lindex)?;
            return Ok(STGMEDIUM {
                tymed: TYMED_ISTREAM.0 as u32,
                u: STGMEDIUM_0 { pstm: ManuallyDrop::new(Some(s)) },
                pUnkForRelease: ManuallyDrop::new(None),
            });
        }
        if !wants(TYMED_HGLOBAL.0) {
            return Err(DV_E_FORMATETC.into());
        }
        if let Some((_, b)) = self.extra.borrow().iter().find(|(c, _)| *c == cf) {
            return hglobal_medium(b);
        }
        if cf == self.f.preferred {
            return hglobal_medium(&DROPEFFECT_COPY.0.to_le_bytes());
        }
        if cf == self.f.ours {
            return hglobal_medium(&[1]);
        }
        if self.f.private.contains(&cf) {
            return hglobal_medium(&0u32.to_le_bytes());
        }
        Err(DV_E_FORMATETC.into())
    }

    fn GetDataHere(&self, _pformatetc: *const FORMATETC, _pmedium: *mut STGMEDIUM) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }

    fn QueryGetData(&self, pformatetc: *const FORMATETC) -> HRESULT {
        let Some(fe) = (unsafe { pformatetc.as_ref() }) else {
            return E_POINTER;
        };
        let known = self.all_formats().iter().any(|f| f.cfFormat == fe.cfFormat && f.tymed & fe.tymed != 0)
            || (fe.tymed & TYMED_HGLOBAL.0 as u32 != 0 && self.extra.borrow().iter().any(|(c, _)| *c == fe.cfFormat));
        if known { S_OK } else { DV_E_FORMATETC }
    }

    fn GetCanonicalFormatEtc(&self, _pformatectin: *const FORMATETC, pformatetcout: *mut FORMATETC) -> HRESULT {
        if let Some(out) = unsafe { pformatetcout.as_mut() } {
            out.ptd = std::ptr::null_mut();
        }
        DATA_S_SAMEFORMATETC
    }

    fn SetData(&self, pformatetc: *const FORMATETC, pmedium: *const STGMEDIUM, frelease: BOOL) -> windows::core::Result<()> {
        let fe = unsafe { pformatetc.as_ref() }.ok_or(E_POINTER)?;
        let m = unsafe { pmedium.as_ref() }.ok_or(E_POINTER)?;
        if m.tymed != TYMED_HGLOBAL.0 as u32 {
            return Err(E_NOTIMPL.into());
        }
        let bytes = bytes_of(unsafe { m.u.hGlobal }).ok_or(E_FAIL)?;
        if frelease.as_bool() {
            unsafe { ReleaseStgMedium(pmedium as *mut STGMEDIUM) };
        }
        let mut extra = self.extra.borrow_mut();
        extra.retain(|(c, _)| *c != fe.cfFormat);
        extra.push((fe.cfFormat, bytes));
        Ok(())
    }

    fn EnumFormatEtc(&self, dwdirection: u32) -> windows::core::Result<IEnumFORMATETC> {
        if dwdirection != DATADIR_GET.0 as u32 {
            return Err(E_NOTIMPL.into());
        }
        unsafe { SHCreateStdEnumFmtEtc(&self.all_formats()) }
    }

    fn DAdvise(&self, _pformatetc: *const FORMATETC, _advf: u32, _padvsink: Ref<IAdviseSink>) -> windows::core::Result<u32> {
        Err(OLE_E_ADVISENOTSUPPORTED.into())
    }
    fn DUnadvise(&self, _dwconnection: u32) -> windows::core::Result<()> {
        Err(OLE_E_ADVISENOTSUPPORTED.into())
    }
    fn EnumDAdvise(&self) -> windows::core::Result<IEnumSTATDATA> {
        Err(OLE_E_ADVISENOTSUPPORTED.into())
    }
}

// ---- dragging ------------------------------------------------------------------------

#[implement(IDropSource)]
struct DropSource;

impl IDropSource_Impl for DropSource_Impl {
    fn QueryContinueDrag(&self, fescapepressed: BOOL, grfkeystate: MODIFIERKEYS_FLAGS) -> HRESULT {
        if fescapepressed.as_bool() {
            DRAGDROP_S_CANCEL
        } else if grfkeystate.0 & MK_LBUTTON.0 == 0 {
            DRAGDROP_S_DROP
        } else {
            S_OK
        }
    }
    fn GiveFeedback(&self, _dweffect: DROPEFFECT) -> HRESULT {
        DRAGDROP_S_USEDEFAULTCURSORS
    }
}

fn primary_button_down() -> bool {
    unsafe {
        let vk = if GetSystemMetrics(SM_SWAPBUTTON) != 0 { VK_RBUTTON } else { VK_LBUTTON };
        GetAsyncKeyState(vk.0 as i32) as u16 & 0x8000 != 0
    }
}

static DRAGGING: AtomicBool = AtomicBool::new(false);

pub fn drag_out(app: &AppHandle, session: Weak<Session>, plan: Vec<VEntry>) -> Result<String, String> {
    if DRAGGING.swap(true, Ordering::SeqCst) {
        return Ok("cancelled".into());
    }
    let r = on_main(app, move |app| {
        ensure_ole()?;
        // The button was let go before the drag could start: nothing to do
        // (and nothing gets dropped by accident).
        if !primary_button_down() {
            return Ok("cancelled".to_string());
        }
        let hwnd = main_hwnd(app);
        let data: IDataObject = VaultData::new(plan, session, Ask::Yes, hwnd).into();
        let source: IDropSource = DropSource.into();
        let effect = unsafe { SHDoDragDrop(hwnd, &data, &source, DROPEFFECT_COPY) }
            .map_err(|e| format!("The drag didn't work: {}", e.message()))?;
        Ok(if effect.0 & DROPEFFECT_COPY.0 != 0 { "copied" } else { "cancelled" }.to_string())
    });
    DRAGGING.store(false, Ordering::SeqCst);
    r
}

// ---- clipboard -----------------------------------------------------------------------

pub fn clipboard_put(app: &AppHandle, session: Weak<Session>, plan: Vec<VEntry>) -> Result<usize, String> {
    let n = file_count(&plan);
    on_main(app, move |app| {
        ensure_ole()?;
        let data: IDataObject = VaultData::new(plan, session, Ask::Pending, main_hwnd(app)).into();
        let mut tries = 0;
        loop {
            match unsafe { OleSetClipboard(&data) } {
                Ok(()) => break,
                // Another program may have the clipboard open for a moment.
                Err(_) if tries < 5 => {
                    tries += 1;
                    std::thread::sleep(Duration::from_millis(30));
                }
                Err(_) => return Err("The clipboard is busy. Try again in a moment.".into()),
            }
        }
        CLIP.with_borrow_mut(|c| *c = Some(data));
        Ok(n)
    })
}

/// Main thread only.
pub fn clear_ours_here() {
    // The wrapper turns S_FALSE ("not current") into Ok, so ask directly.
    windows_core::link!("ole32.dll" "system" fn OleIsCurrentClipboard(pdataobj: *mut c_void) -> HRESULT);
    if let Some(obj) = CLIP.with_borrow_mut(|c| c.take())
        && unsafe { OleIsCurrentClipboard(obj.as_raw()) } == S_OK
    {
        let _ = unsafe { OleSetClipboard(None::<&IDataObject>) };
    }
}

pub fn clear_ours(app: &AppHandle) -> Result<(), String> {
    on_main(app, |_| {
        clear_ours_here();
        Ok(())
    })
}

struct OpenedClipboard;
impl Drop for OpenedClipboard {
    fn drop(&mut self) {
        let _ = unsafe { CloseClipboard() };
    }
}

fn open_clipboard() -> Result<OpenedClipboard, String> {
    for _ in 0..10 {
        if unsafe { OpenClipboard(None) }.is_ok() {
            return Ok(OpenedClipboard);
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    Err("The clipboard is busy. Try again in a moment.".into())
}

fn clip_bytes(format: u32) -> Option<Vec<u8>> {
    unsafe {
        IsClipboardFormatAvailable(format).ok()?;
        let h: HANDLE = GetClipboardData(format).ok()?;
        bytes_of(HGLOBAL(h.0))
    }
}

pub fn clipboard_read() -> Result<ClipboardContent, String> {
    let png_format = format_id(w!("PNG"));
    let ours_format = format_id(w!("MediaVault.Items"));
    let _open = open_clipboard()?;
    let mut out = ClipboardContent {
        ours: unsafe { IsClipboardFormatAvailable(ours_format as u32) }.is_ok(),
        ..Default::default()
    };
    if out.ours {
        // Our own items: there are no files or pictures to read (and asking
        // for them would only bring up the copy question).
        return Ok(out);
    }
    unsafe {
        if IsClipboardFormatAvailable(CF_HDROP.0 as u32).is_ok()
            && let Ok(h) = GetClipboardData(CF_HDROP.0 as u32)
        {
            let drop = HDROP(h.0);
            let count = DragQueryFileW(drop, u32::MAX, None);
            for i in 0..count {
                let len = DragQueryFileW(drop, i, None) as usize;
                let mut buf = vec![0u16; len + 1];
                let got = DragQueryFileW(drop, i, Some(&mut buf)) as usize;
                if got > 0 {
                    out.files.push(String::from_utf16_lossy(&buf[..got.min(len)]));
                }
            }
        }
    }
    out.image_png = clip_bytes(png_format as u32).filter(|b| is_png(b));
    if out.image_png.is_none() {
        for f in [CF_DIBV5, CF_DIB] {
            if let Some(dib) = clip_bytes(f.0 as u32)
                && let Ok(png) = dib_to_png(&dib)
            {
                out.image_png = Some(png);
                break;
            }
        }
    }
    Ok(out)
}
