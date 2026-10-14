MEDIA VAULT — portable app
==========================

Run MediaVault.exe. No installation needed. You can keep this whole folder
anywhere (another drive, a USB stick) and copy it to back it up.

Settings (accent colour, the list of your vaults, lock options) are saved
in the "data" folder that appears next to MediaVault.exe. They contain no
passwords and no media.

Shortcuts
  Ctrl + Shift + L   Panic key: lock immediately and minimise

If the main app ever stops working
  vault-export.exe can decrypt any vault back into normal files:
    vault-export export "D:\Vaults\Photos" "D:\Restored"
  Add --recovery to use the 24 recovery words instead of the password.
  FORMAT.md describes the storage format in full, and reference_decrypt.py
  is a second, independent decrypter (needs Python).

What's in the full package
  WebView2\   The app's own copy of Microsoft's web engine (draws the window
              and plays videos), so Windows updates can't change how things
              play. If it ever fails to start, the app uses the one that
              comes with Windows instead and says so in Settings.
  models\     Offline smart-search models (find pictures by describing
              them, in 50+ languages). Without this folder smart search is
              simply turned off; everything else works.
  tools\      The video tool (ffmpeg, LGPL build; licence and source in the
              folder) for converting items and making animations. It works
              in memory: nothing decrypted is written to disk. Without this
              folder those two options are simply not available.
  Face recognition is built into MediaVault.exe and also works offline.

Requirements
  Windows 10 or 11. The full package brings its own web engine. The light
  package uses the Microsoft Edge WebView2 runtime that is part of Windows 11
  and of up-to-date Windows 10.
