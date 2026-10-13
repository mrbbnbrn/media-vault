//! vault-export — standalone rescue tool for Media Vault.
//!
//! Works without the main app, its web engine, or anything installed.
//! Never modifies the vault.

use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use vault_core::{Access, ObjectKind, Vault, db, export, read_header};

const USAGE: &str = "\
vault-export — get your files out of a Media Vault, without the main app.

USAGE
  vault-export info    <vault folder>
  vault-export verify  <vault folder> [--recovery]
  vault-export export  <vault folder> <output folder> [--recovery]
  vault-export dump-db <vault folder> <output file.db> [--recovery]

COMMANDS
  info     Show basic facts about the vault (no password needed).
  verify   Check every encrypted file for damage. Changes nothing.
  export   Decrypt every file into <output folder>, with original names
           and folders. Damaged files are skipped and listed at the end.
  dump-db  Save the decrypted library database as a normal SQLite file.

OPTIONS
  --recovery   Unlock with the 24-word recovery key instead of the password.

You will be asked for the password or recovery words; they are never
accepted on the command line.
";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let recovery = args.iter().any(|a| a == "--recovery");
    let pos: Vec<&String> = args.iter().filter(|a| !a.starts_with("--")).collect();
    if args.iter().any(|a| a == "--help" || a == "-h") || pos.is_empty() {
        print!("{USAGE}");
        return if pos.is_empty() && !args.iter().any(|a| a == "--help" || a == "-h") {
            ExitCode::from(2)
        } else {
            ExitCode::SUCCESS
        };
    }
    let result = match (pos[0].as_str(), pos.len()) {
        ("info", 2) => info(pos[1].into()),
        ("verify", 2) => verify(pos[1].into(), recovery),
        ("export", 3) => run_export(pos[1].into(), pos[2].into(), recovery),
        ("dump-db", 3) => dump_db(pos[1].into(), pos[2].into(), recovery),
        _ => {
            eprint!("{USAGE}");
            return ExitCode::from(2);
        }
    };
    match result {
        Ok(code) => code,
        Err(e) => {
            eprintln!("\nError: {e}");
            ExitCode::FAILURE
        }
    }
}

type R = Result<ExitCode, Box<dyn std::error::Error>>;

fn unlock(root: &Path, recovery: bool) -> Result<Vault, Box<dyn std::error::Error>> {
    if recovery {
        eprintln!("Type or paste the 24 recovery words, then press Enter (twice if needed):");
        let mut words = String::new();
        let stdin = io::stdin();
        for line in stdin.lock().lines() {
            let line = line?;
            words.push_str(&line);
            words.push(' ');
            if words
                .split_whitespace()
                .filter(|w| w.chars().any(|c| c.is_ascii_alphabetic()))
                .count()
                >= 24
                || line.trim().is_empty()
            {
                break;
            }
        }
        eprintln!("Unlocking...");
        Ok(Vault::unlock_with_recovery(root, &words, Access::ReadOnly)?)
    } else {
        let pw = rpassword::prompt_password("Password: ")?;
        eprintln!("Unlocking (this takes a second)...");
        Ok(Vault::unlock(root, &pw, Access::ReadOnly)?)
    }
}

fn load_conn(v: &Vault) -> Result<db::Connection, Box<dyn std::error::Error>> {
    let (bytes, backup) = v.load_db()?;
    if let Some(b) = backup {
        eprintln!(
            "Note: the main database was damaged; using backup {}",
            b.display()
        );
    }
    Ok(db::deserialize(&bytes)?)
}

fn info(root: PathBuf) -> R {
    let h = read_header(&root)?;
    println!("Vault:          {}", root.display());
    println!("Format:         {} v{}", h.format, h.version);
    println!("Vault id:       {}", h.vault_id);
    println!("Created (unix): {}", h.created_at);
    println!(
        "Password KDF:   {:?}, {} MiB, {} passes, {} lanes",
        h.kdf.alg,
        h.kdf.memory_kib / 1024,
        h.kdf.iterations,
        h.kdf.parallelism
    );
    Ok(ExitCode::SUCCESS)
}

fn verify(root: PathBuf, recovery: bool) -> R {
    let v = unlock(&root, recovery)?;
    let conn = load_conn(&v)?;
    println!("Database: OK");

    let items = export::list_items(&conn, None)?;
    let mut bad = Vec::new();
    for (i, item) in items.iter().enumerate() {
        let r = vault_core::ObjectId::from_hex(&item.object_id)
            .and_then(|id| v.verify_object(ObjectKind::Media, &id));
        if let Err(e) = r {
            bad.push(format!("{}: {e}", item.original_name));
        }
        progress(i + 1, items.len(), "Checking");
    }
    eprintln!();
    let on_disk = v.list_objects(ObjectKind::Media)?.len();
    println!("Files in library: {}", items.len());
    println!("Encrypted files on disk: {on_disk}");
    if bad.is_empty() {
        println!("All files are intact.");
        Ok(ExitCode::SUCCESS)
    } else {
        println!("{} damaged or missing file(s):", bad.len());
        for b in &bad {
            println!("  {b}");
        }
        Ok(ExitCode::FAILURE)
    }
}

fn run_export(root: PathBuf, out: PathBuf, recovery: bool) -> R {
    if out.exists() && std::fs::read_dir(&out)?.next().is_some() {
        eprintln!(
            "Note: {} is not empty; existing files are never overwritten.",
            out.display()
        );
    }
    let v = unlock(&root, recovery)?;
    let conn = load_conn(&v)?;
    let items = export::list_items(&conn, None)?;
    let total: u64 = items.iter().map(|i| i.size).sum();
    eprintln!(
        "Exporting {} files ({:.1} GB) to {}",
        items.len(),
        total as f64 / 1e9,
        out.display()
    );
    let report = export::export_items(&v, &conn, &items, &out, |d, t, _| {
        progress(d, t, "Exporting")
    })?;
    eprintln!();
    println!(
        "Exported {} files ({:.1} GB).",
        report.exported,
        report.bytes as f64 / 1e9
    );
    if report.failed.is_empty() {
        Ok(ExitCode::SUCCESS)
    } else {
        println!("{} file(s) could not be exported:", report.failed.len());
        for (name, why) in &report.failed {
            println!("  {name}: {why}");
        }
        Ok(ExitCode::FAILURE)
    }
}

fn dump_db(root: PathBuf, out: PathBuf, recovery: bool) -> R {
    if out.exists() {
        return Err(format!("{} already exists", out.display()).into());
    }
    let v = unlock(&root, recovery)?;
    let (bytes, _) = v.load_db()?;
    std::fs::write(&out, &bytes[..])?;
    println!("Wrote {} — this file is NOT encrypted.", out.display());
    Ok(ExitCode::SUCCESS)
}

fn progress(done: usize, total: usize, what: &str) {
    if done == total || done.is_multiple_of(25) {
        eprint!("\r{what} {done}/{total}");
        let _ = io::stderr().flush();
    }
}
