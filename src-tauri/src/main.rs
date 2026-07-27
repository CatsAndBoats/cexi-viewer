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

#[tauri::command]
fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
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
    std::fs::read(&path)
        .map(tauri::ipc::Response::new)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn write_file(path: String, contents: Vec<u8>) -> Result<(), String> {
    if let Some(parent) = Path::new(&path).parent() {
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
    let base = std::env::var("LOCALAPPDATA")
        .or_else(|_| std::env::var("APPDATA"))
        .or_else(|_| std::env::var("TEMP"))
        .ok()?;
    let dir = std::path::PathBuf::from(base).join("CexiViewerGL2").join("vgmstream");
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

/// Locate vgmstream-cli.exe. Prefers a co-located `vgmstream` folder (dev), then
/// the embedded copy extracted to the user cache, then the AltanaListener install.
fn find_vgmstream() -> Option<std::path::PathBuf> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let co = dir.join("vgmstream").join("vgmstream-cli.exe");
            if co.is_file() {
                return Some(co);
            }
        }
    }
    if let Some(p) = extract_vgmstream() {
        return Some(p);
    }
    let altana = std::path::PathBuf::from(
        r"D:\xidata\AltanaListener_Windows\Dependencies\vgmstream-cli.exe",
    );
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
        .arg(&path)
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

/// Finds the `cexi` CLI (cexi-tools). Checks PATH, then the known install shim.
fn find_cexi() -> Option<std::path::PathBuf> {
    for name in ["cexi.exe", "cexi.cmd", "cexi.bat", "cexi"] {
        if let Ok(p) = which_on_path(name) {
            return Some(p);
        }
    }
    let home = std::env::var("USERPROFILE").ok()?;
    for cand in [
        format!(r"{home}\.local\bin\cexi.exe"),
        format!(r"{home}\.local\bin\cexi.cmd"),
        format!(r"{home}\.local\bin\cexi"),
    ] {
        let p = std::path::PathBuf::from(cand);
        if p.is_file() {
            return Some(p);
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
            let p = std::path::PathBuf::from(c.trim());
            if p.is_file() {
                return Some(p);
            }
            if p.is_dir() {
                for n in ["cexi.exe", "cexi.cmd", "cexi.bat", "cexi"] {
                    let f = p.join(n);
                    if f.is_file() {
                        return Some(f);
                    }
                }
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
    cmd.arg("mesh").arg("export").arg(&dat_path).arg("--output").arg(&output_dir);
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
    let p = r"D:\cexi\catseyexi-client\Game\FINAL FANTASY XI";
    if Path::new(p).exists() {
        p.to_string()
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

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            list_dir,
            read_file,
            write_file,
            default_game_path,
            pick_folder,
            pick_file,
            decode_vgmstream,
            cexi_mesh_export,
            cexi_available,
            open_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
