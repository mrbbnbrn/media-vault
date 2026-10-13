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

Requirements
  Windows 10 or 11 with the Microsoft Edge WebView2 runtime, which is
  already part of Windows 11 and of up-to-date Windows 10. A later version
  of this package will carry its own copy so it never depends on Windows.
