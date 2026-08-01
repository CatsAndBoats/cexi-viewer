// CEXI Model Viewer — Tauri shell. The frontend (../ui) does all parsing and
// rendering; these commands only provide filesystem access to the FFXI install.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::path::Path;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DirEntry {
    name: String,
    is_dir: bool,
}

/// The frontend joins paths Windows-style (`gamePath\ROM\1\58.DAT`); accept those
/// on POSIX boxes, matching what dev/serve.py does. Backslash is a legal filename
/// character on unix, but no FFXI DAT uses one.
fn norm(path: &str) -> std::path::PathBuf {
    if cfg!(windows) {
        std::path::PathBuf::from(path)
    } else {
        std::path::PathBuf::from(path.replace('\\', "/"))
    }
}

#[tauri::command]
fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let path = norm(&path);
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        out.push(DirEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            is_dir: entry.file_type().map(|t| t.is_dir()).unwrap_or(false),
        });
    }
    Ok(out)
}

#[tauri::command]
fn read_file(path: String) -> Result<tauri::ipc::Response, String> {
    std::fs::read(norm(&path))
        .map(tauri::ipc::Response::new)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn file_exists(path: String) -> bool {
    norm(&path).is_file()
}

#[tauri::command]
fn write_file(path: String, contents: Vec<u8>) -> Result<(), String> {
    let path = norm(&path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, contents).map_err(|e| e.to_string())
}

#[tauri::command]
fn pick_folder(initial: Option<String>) -> Option<String> {
    let mut dialog = rfd::FileDialog::new().set_title("Select FFXI game folder");
    if let Some(p) = initial {
        if Path::new(&p).is_dir() {
            dialog = dialog.set_directory(p);
        }
    }
    dialog
        .pick_folder()
        .map(|p| p.to_string_lossy().into_owned())
}

// ---------------------------------------------------------------------------
// Machine-specific paths. Each default below is what shipped hardcoded; set the
// matching env var to point the app elsewhere (non-Windows boxes, alt installs).
//   CEXI_GAME_DIR   FFXI install directory
//   CEXI_VGMSTREAM  vgmstream-cli executable
//   CEXI_CLI        cexi-tools executable (or a folder containing it)
//   CEXI_CACHE_DIR  where the embedded vgmstream is unpacked
// ---------------------------------------------------------------------------
const DEFAULT_GAME_DIR: &str = r"D:\cexi\catseyexi-client\Game\FINAL FANTASY XI";
const DEFAULT_VGMSTREAM: &str = r"D:\xidata\AltanaListener_Windows\Dependencies\vgmstream-cli.exe";

/// Loads `.env` so the overrides work when the app is launched directly (Finder,
/// `cargo run`, a shortcut) and not just through start.sh / build.sh. Real
/// environment variables are never overwritten; the first file found wins.
/// Searched: `$CEXI_ENV_FILE`, the cwd and its parents, then next to the binary.
fn load_dotenv() {
    if let Some(f) = env_path("CEXI_ENV_FILE") {
        if dotenvy::from_path(&f).is_ok() {
            return;
        }
        eprintln!("CEXI_ENV_FILE set but unreadable: {}", f.display());
    }
    if dotenvy::dotenv().is_ok() {
        return;
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let _ = dotenvy::from_path(dir.join(".env"));
        }
    }
}

/// Reads an env var, treating unset and blank as "not configured".
fn env_path(name: &str) -> Option<std::path::PathBuf> {
    let v = std::env::var(name).ok()?;
    let v = v.trim();
    (!v.is_empty()).then(|| std::path::PathBuf::from(v))
}

// vgmstream (ATRAC3 decoder) is embedded in the exe so the app is a single
// self-contained file. On first use it's extracted to a per-user cache dir.
// Bump VGM_VERSION whenever these files change to force a re-extract.
const VGM_VERSION: &str = "1";
const VGM_FILES: &[(&str, &[u8])] = &[
    ("vgmstream-cli.exe", include_bytes!("../vgmstream/vgmstream-cli.exe")),
    ("avcodec-vgmstream-59.dll", include_bytes!("../vgmstream/avcodec-vgmstream-59.dll")),
    ("avformat-vgmstream-59.dll", include_bytes!("../vgmstream/avformat-vgmstream-59.dll")),
    ("avutil-vgmstream-57.dll", include_bytes!("../vgmstream/avutil-vgmstream-57.dll")),
    ("swresample-vgmstream-4.dll", include_bytes!("../vgmstream/swresample-vgmstream-4.dll")),
    ("libatrac9.dll", include_bytes!("../vgmstream/libatrac9.dll")),
    ("libcelt-0061.dll", include_bytes!("../vgmstream/libcelt-0061.dll")),
    ("libcelt-0110.dll", include_bytes!("../vgmstream/libcelt-0110.dll")),
    ("libg719_decode.dll", include_bytes!("../vgmstream/libg719_decode.dll")),
    ("libmpg123-0.dll", include_bytes!("../vgmstream/libmpg123-0.dll")),
    ("libspeex-1.dll", include_bytes!("../vgmstream/libspeex-1.dll")),
    ("libvorbis.dll", include_bytes!("../vgmstream/libvorbis.dll")),
];

/// Extracts the embedded vgmstream to %LOCALAPPDATA%\CexiViewerGL2\vgmstream on
/// first run (or after a version bump) and returns the cli path.
fn extract_vgmstream() -> Option<std::path::PathBuf> {
    // CEXI_CACHE_DIR wins; otherwise the Windows locations, then the XDG/HOME
    // cache on unix, then the system temp dir as a last resort.
    let base = env_path("CEXI_CACHE_DIR").or_else(|| {
        std::env::var("LOCALAPPDATA")
            .or_else(|_| std::env::var("APPDATA"))
            .or_else(|_| std::env::var("TEMP"))
            .ok()
            .map(std::path::PathBuf::from)
            .or_else(|| env_path("XDG_CACHE_HOME"))
            .or_else(|| env_path("HOME").map(|h| h.join(".cache")))
            .or_else(|| Some(std::env::temp_dir()))
    })?;
    let dir = base.join("CexiViewerGL2").join("vgmstream");
    let cli = dir.join("vgmstream-cli.exe");
    let marker = dir.join(".version");

    let up_to_date = std::fs::read_to_string(&marker)
        .map(|v| v.trim() == VGM_VERSION)
        .unwrap_or(false);

    if !up_to_date || !cli.is_file() {
        if std::fs::create_dir_all(&dir).is_err() {
            return None;
        }
        for (name, bytes) in VGM_FILES {
            let p = dir.join(name);
            let needs = std::fs::metadata(&p).map(|m| m.len() != bytes.len() as u64).unwrap_or(true);
            if needs && std::fs::write(&p, bytes).is_err() {
                return None;
            }
        }
        let _ = std::fs::write(&marker, VGM_VERSION);
    }
    cli.is_file().then_some(cli)
}

/// Locate vgmstream-cli. Order: CEXI_VGMSTREAM, a co-located `vgmstream` folder
/// (dev), the embedded copy extracted to the user cache (Windows — the bundled
/// build is win32), a `vgmstream-cli` on PATH, then the AltanaListener install.
fn find_vgmstream() -> Option<std::path::PathBuf> {
    if let Some(p) = env_path("CEXI_VGMSTREAM") {
        if p.is_file() {
            return Some(p);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for name in ["vgmstream-cli.exe", "vgmstream-cli"] {
                let co = dir.join("vgmstream").join(name);
                if co.is_file() {
                    return Some(co);
                }
            }
        }
    }
    if cfg!(windows) {
        if let Some(p) = extract_vgmstream() {
            return Some(p);
        }
    }
    for name in ["vgmstream-cli", "vgmstream-cli.exe"] {
        if let Ok(p) = which_on_path(name) {
            return Some(p);
        }
    }
    let altana = std::path::PathBuf::from(DEFAULT_VGMSTREAM);
    altana.is_file().then_some(altana)
}

/// Decodes any .bgw/.spw (including ATRAC3) to WAV bytes via vgmstream-cli.
/// `-i` = single linear pass (no fake loop expansion). Returns the WAV file bytes.
#[tauri::command]
fn decode_vgmstream(path: String) -> Result<tauri::ipc::Response, String> {
    let vgm = find_vgmstream().ok_or("vgmstream-cli not found")?;
    let out = std::env::temp_dir().join(format!("cexi_vgm_{}.wav", std::process::id()));

    let status = std::process::Command::new(&vgm)
        .arg("-i")
        .arg("-o")
        .arg(&out)
        .arg(norm(&path))
        .output()
        .map_err(|e| format!("failed to run vgmstream: {e}"))?;

    if !status.status.success() || !out.exists() {
        let msg = String::from_utf8_lossy(&status.stderr);
        return Err(format!("vgmstream failed: {}", msg.trim()));
    }

    let bytes = std::fs::read(&out).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&out);
    Ok(tauri::ipc::Response::new(bytes))
}

/// Finds the `cexi` CLI (cexi-tools). Checks CEXI_CLI, then PATH, then the
/// `~/.local/bin` install shim.
fn find_cexi() -> Option<std::path::PathBuf> {
    if let Some(p) = env_path("CEXI_CLI") {
        if let Some(f) = cexi_in(&p) {
            return Some(f);
        }
    }
    for name in ["cexi.exe", "cexi.cmd", "cexi.bat", "cexi"] {
        if let Ok(p) = which_on_path(name) {
            return Some(p);
        }
    }
    let home = env_path("USERPROFILE").or_else(|| env_path("HOME"))?;
    cexi_in(&home.join(".local").join("bin"))
}

/// Resolves `p` to a runnable cexi: `p` itself if it's a file, else the first
/// cexi variant inside it if it's a folder.
fn cexi_in(p: &Path) -> Option<std::path::PathBuf> {
    if p.is_file() {
        return Some(p.to_path_buf());
    }
    if p.is_dir() {
        for n in ["cexi.exe", "cexi.cmd", "cexi.bat", "cexi"] {
            let f = p.join(n);
            if f.is_file() {
                return Some(f);
            }
        }
    }
    None
}

fn which_on_path(name: &str) -> Result<std::path::PathBuf, ()> {
    let paths = std::env::var_os("PATH").ok_or(())?;
    for dir in std::env::split_paths(&paths) {
        let full = dir.join(name);
        if full.is_file() {
            return Ok(full);
        }
    }
    Err(())
}

/// Resolves the cexi executable: a user-configured path (file, or a folder to
/// search) wins; otherwise fall back to PATH / the known shim.
fn resolve_cexi(configured: &Option<String>) -> Option<std::path::PathBuf> {
    if let Some(c) = configured {
        if !c.trim().is_empty() {
            if let Some(f) = cexi_in(Path::new(c.trim())) {
                return Some(f);
            }
        }
    }
    find_cexi()
}

/// True if a runnable cexi can be resolved from the given path (or PATH).
#[tauri::command]
fn cexi_available(cexi_path: Option<String>) -> bool {
    resolve_cexi(&cexi_path).is_some()
}

#[tauri::command]
fn pick_file(initial: Option<String>) -> Option<String> {
    let mut dialog = rfd::FileDialog::new().set_title("Select the cexi executable");
    if let Some(p) = initial {
        if let Some(dir) = Path::new(&p).parent() {
            if dir.is_dir() {
                dialog = dialog.set_directory(dir);
            }
        }
    }
    dialog.pick_file().map(|p| p.to_string_lossy().into_owned())
}

/// Runs `cexi mesh export DAT [args…]`. Returns the CLI's combined stdout/stderr.
#[tauri::command]
fn cexi_mesh_export(
    dat_path: String,
    output_dir: String,
    args: Vec<String>,
    cexi_path: Option<String>,
) -> Result<String, String> {
    let cexi = resolve_cexi(&cexi_path)
        .ok_or("cexi CLI not found — set the cexi-tools path in Settings")?;
    let mut cmd = std::process::Command::new(&cexi);
    cmd.arg("mesh")
        .arg("export")
        .arg(norm(&dat_path))
        .arg("--output")
        .arg(norm(&output_dir));
    for a in &args {
        cmd.arg(a);
    }
    let out = cmd.output().map_err(|e| format!("failed to run cexi: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    if out.status.success() {
        Ok(format!("{stdout}{stderr}").trim().to_string())
    } else {
        Err(format!("cexi export failed:\n{}", format!("{stdout}{stderr}").trim()))
    }
}

#[tauri::command]
fn default_game_path() -> String {
    // CEXI_GAME_DIR is returned as-is so a mistyped override is visible in the
    // UI rather than silently falling back to the Windows default.
    if let Some(p) = env_path("CEXI_GAME_DIR") {
        return p.to_string_lossy().into_owned();
    }
    if Path::new(DEFAULT_GAME_DIR).exists() {
        DEFAULT_GAME_DIR.to_string()
    } else {
        String::new()
    }
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    // Empty title arg so `start` treats the URL as the target, not a window title.
    std::process::Command::new("cmd")
        .args(["/C", "start", "", &url])
        .spawn()
        .map_err(|e| format!("failed to open url: {e}"))?;
    Ok(())
}

/// Opens the system file manager with `path` selected.
///
/// The path goes in as a single argument and never through a shell, so it can't
/// be re-read as further arguments. Explorer exits non-zero even when it works,
/// so spawning is the only thing worth checking.
#[tauri::command]
fn reveal_path(path: String) -> Result<(), String> {
    let target = Path::new(&path);
    if !target.exists() {
        return Err(format!("not found: {path}"));
    }

    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = std::process::Command::new("explorer");
        c.arg(format!("/select,{}", target.display()));
        c
    };
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = std::process::Command::new("open");
        c.arg("-R").arg(target);
        c
    };
    // No portable "select the file" on Linux, so settle for its folder.
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(target.parent().unwrap_or(target));
        c
    };

    cmd.spawn()
        .map_err(|e| format!("failed to open file manager: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // One test: these all mutate process-wide env, so they must not run in
    // parallel with each other.
    #[test]
    fn env_overrides_win_over_hardcoded_defaults() {
        assert!(env_path("CEXI_DEFINITELY_UNSET_VAR").is_none());

        std::env::set_var("CEXI_GAME_DIR", "   ");
        assert!(env_path("CEXI_GAME_DIR").is_none(), "blank must count as unset");

        std::env::set_var("CEXI_GAME_DIR", "/tmp/fake-ffxi");
        assert_eq!(default_game_path(), "/tmp/fake-ffxi");

        std::env::remove_var("CEXI_GAME_DIR");
        let fallback = default_game_path();
        assert!(fallback.is_empty() || fallback == DEFAULT_GAME_DIR);

        // A non-existent override is ignored so the normal search still runs.
        std::env::set_var("CEXI_VGMSTREAM", "/tmp/definitely-not-here/vgmstream-cli");
        assert_ne!(
            find_vgmstream().as_deref(),
            Some(Path::new("/tmp/definitely-not-here/vgmstream-cli"))
        );
        std::env::remove_var("CEXI_VGMSTREAM");

        // CEXI_CLI accepts a folder as well as a file.
        let dir = std::env::temp_dir().join("cexi_cli_test");
        std::fs::create_dir_all(&dir).unwrap();
        let shim = dir.join("cexi");
        std::fs::write(&shim, b"#!/bin/sh\n").unwrap();
        std::env::set_var("CEXI_CLI", &dir);
        assert_eq!(find_cexi(), Some(shim));
        std::env::remove_var("CEXI_CLI");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The file tree sends `<gamePath>\ROM\1`, so listing must work with either
    /// separator on unix. Runs against the real install when CEXI_GAME_DIR (or
    /// .env) points at one; otherwise a temp dir stands in.
    #[test]
    fn list_dir_accepts_windows_style_separators() {
        load_dotenv();
        let (root, sub) = match env_path("CEXI_GAME_DIR").filter(|p| p.join("ROM").is_dir()) {
            Some(game) => (game, "ROM"),
            None => {
                let tmp = std::env::temp_dir().join("cexi_norm_test");
                std::fs::create_dir_all(tmp.join("ROM")).unwrap();
                (tmp, "ROM")
            }
        };

        let backslashed = format!("{}\\{sub}", root.display());
        let listed = list_dir(backslashed.clone())
            .unwrap_or_else(|e| panic!("failed to list {backslashed}: {e}"));
        let forward = list_dir(root.join(sub).display().to_string()).unwrap();
        assert_eq!(listed.len(), forward.len());
    }

    #[test]
    fn dotenv_fills_gaps_but_never_overwrites_the_environment() {
        let f = std::env::temp_dir().join("cexi_dotenv_test.env");
        std::fs::write(
            &f,
            "# comment\n\nCEXI_TEST_FROM_FILE=/tmp/from-file\nexport CEXI_TEST_QUOTED=\"/tmp/quoted\"\nCEXI_TEST_PRESET=/tmp/from-file\n",
        )
        .unwrap();

        std::env::set_var("CEXI_TEST_PRESET", "/tmp/from-env");
        std::env::set_var("CEXI_ENV_FILE", &f);
        load_dotenv();

        assert_eq!(env_path("CEXI_TEST_FROM_FILE").unwrap().to_str(), Some("/tmp/from-file"));
        assert_eq!(env_path("CEXI_TEST_QUOTED").unwrap().to_str(), Some("/tmp/quoted"));
        assert_eq!(
            env_path("CEXI_TEST_PRESET").unwrap().to_str(),
            Some("/tmp/from-env"),
            "a real env var must beat the .env file"
        );

        for k in ["CEXI_ENV_FILE", "CEXI_TEST_FROM_FILE", "CEXI_TEST_QUOTED", "CEXI_TEST_PRESET"] {
            std::env::remove_var(k);
        }
        let _ = std::fs::remove_file(&f);
    }
}

fn main() {
    load_dotenv();
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            list_dir,
            read_file,
            file_exists,
            write_file,
            default_game_path,
            pick_folder,
            pick_file,
            decode_vgmstream,
            cexi_mesh_export,
            cexi_available,
            open_url,
            reveal_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
