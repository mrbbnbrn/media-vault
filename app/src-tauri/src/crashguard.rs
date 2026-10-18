//! The window's own processes (WebView2 draws the window in separate
//! processes: the page, the graphics) can end on their own — most often when
//! the graphics card's memory runs out. Then the window stays black and the
//! only way out was closing the app. Now the page is loaded again at once
//! (the vault stays open, so it comes straight back to the library), and
//! what happened goes into the 3D model log, so the timing report
//! (Ctrl+Shift+T) shows it afterwards.

#[cfg(windows)]
pub fn watch(win: &tauri::WebviewWindow) {
    let _ = win.with_webview(|wv| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::*;
        use webview2_com::ProcessFailedEventHandler;
        use windows::core::Interface;
        let Ok(core) = wv.controller().CoreWebView2() else { return };
        let handler = ProcessFailedEventHandler::create(Box::new(|sender, args| {
            let (Some(sender), Some(args)) = (sender, args) else { return Ok(()) };
            let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
            args.ProcessFailedKind(&mut kind)?;
            let (what, reload) = match kind {
                COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED => ("its graphics process ended", true),
                COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED => ("its page process ended", true),
                COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE => ("its page stopped answering", true),
                COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED => ("its main process ended", false),
                _ => ("a helper process ended", false),
            };
            let mut why = String::new();
            if let Ok(a2) = args.cast::<ICoreWebView2ProcessFailedEventArgs2>() {
                let mut reason = COREWEBVIEW2_PROCESS_FAILED_REASON::default();
                if a2.Reason(&mut reason).is_ok() {
                    why = match reason {
                        COREWEBVIEW2_PROCESS_FAILED_REASON_OUT_OF_MEMORY => "out of memory",
                        COREWEBVIEW2_PROCESS_FAILED_REASON_CRASHED => "crashed",
                        COREWEBVIEW2_PROCESS_FAILED_REASON_UNRESPONSIVE => "not answering",
                        COREWEBVIEW2_PROCESS_FAILED_REASON_TERMINATED => "ended by something else",
                        COREWEBVIEW2_PROCESS_FAILED_REASON_LAUNCH_FAILED => "couldn't start",
                        _ => "unexpected",
                    }
                    .to_string();
                }
                let mut code = 0i32;
                if a2.ExitCode(&mut code).is_ok() && code != 0 {
                    why = format!("{why} (exit code {code:#x})");
                }
            }
            crate::gpuroom::note_window(what, &why);
            if reload {
                // Give the graphics card's memory back before the page comes again.
                std::thread::spawn(crate::gpuroom::free_idle);
                sender.Reload()?;
            }
            Ok(())
        }));
        let mut token = 0i64;
        let _ = core.add_ProcessFailed(&handler, &mut token);
    });
}

#[cfg(not(windows))]
pub fn watch(_win: &tauri::WebviewWindow) {}
