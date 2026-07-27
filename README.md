# CEXI Model Viewer

FFXI NPC/monster model viewer: file explorer on the left, **WebGL2** viewport on
the right, wrapped in a **Tauri 2** shell (~7 MB standalone exe, no Electron).
Skinning runs on the GPU — the vertex shader rotates pre-weighted joint-local
positions by per-joint pose quaternions; the CPU only evaluates the skeleton
pose (one quat/trans/scale triplet per joint per frame).

## Download

Get the latest release by going to: [Github Releases](https://github.com/CatsAndBoats/cexi-viewer/releases)

## Screenshots

![CEXI Model Viewer screenshot](ss/Screenshot%202026-07-25%20005737.png)

![CEXI Model Viewer screenshot](ss/Screenshot%202026-07-25%20005840.png)

---

## Setup

| Path | Purpose |
|---|---|
| `ui/` | The whole frontend, vanilla ES modules — no bundler, no npm. `dat.js` (DAT section walker + skeleton/mesh/texture/animation parsers), `pose.js` (pose evaluation), `renderer.js` (WebGL2, GPU skinning, DXT via `WEBGL_compressed_texture_s3tc` + CPU fallback), `camera.js`, `app.js`, `backend.js`. |
| `src-tauri/` | Rust shell. Three IPC commands: `list_dir`, `read_file` (binary via `tauri::ipc::Response`), `default_game_path`. |
| `dev/serve.py` | Dev server: serves `ui/` plus `/fs` endpoints so the frontend runs in a plain browser without Tauri (`backend.js` falls back automatically). |

## Build & run

Requires Rust (no Node needed):

```
Start.bat
```

or:

```
cd src-tauri
cargo run
```

Release exe: `cargo build --release` → `src-tauri/target/release/cexi-model-viewer.exe`
(frontend assets are embedded; the exe is standalone, needing only the WebView2
runtime that ships with Windows 11).

Browser dev mode (no Rust):

```
python dev/serve.py 8766
```

then open http://localhost:8766. `window.cexi` exposes the renderer for
debugging.
