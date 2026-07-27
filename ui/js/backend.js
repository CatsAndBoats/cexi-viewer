// File access backend. In the Tauri app this uses IPC commands; when opened in
// a plain browser it falls back to the dev server's /fs endpoints (dev/serve.py).

const isTauri = () => !!window.__TAURI__;

async function tauriInvoke(cmd, args) {
  return window.__TAURI__.core.invoke(cmd, args);
}

export const backend = {
  async listDir(path) {
    if (isTauri()) return tauriInvoke('list_dir', { path });
    const res = await fetch(`/fs/list?path=${encodeURIComponent(path)}`);
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },

  async readFile(path) {
    if (isTauri()) {
      const data = await tauriInvoke('read_file', { path });
      return data instanceof ArrayBuffer ? data : new Uint8Array(data).buffer;
    }
    const res = await fetch(`/fs/read?path=${encodeURIComponent(path)}`);
    if (!res.ok) throw new Error(await res.text());
    return res.arrayBuffer();
  },

  async defaultGamePath() {
    if (isTauri()) return tauriInvoke('default_game_path');
    const res = await fetch('/fs/default');
    return res.text();
  },

  /** Native folder picker. Returns the chosen path, or null (cancelled / browser mode). */
  async pickFolder(initial) {
    if (!isTauri()) return null;
    return tauriInvoke('pick_folder', { initial: initial || null });
  },

  /** Decodes any .bgw/.spw (incl. ATRAC3) to WAV bytes via bundled vgmstream. */
  async decodeVgmstream(path) {
    if (isTauri()) {
      const data = await tauriInvoke('decode_vgmstream', { path });
      return data instanceof ArrayBuffer ? data : new Uint8Array(data).buffer;
    }
    const res = await fetch(`/fs/vgmstream?path=${encodeURIComponent(path)}`);
    if (!res.ok) throw new Error(await res.text());
    return res.arrayBuffer();
  },

  /** Runs `cexi mesh export DAT --output DIR [args]`. Returns the CLI output text. */
  async cexiMeshExport(datPath, outputDir, args, cexiPath) {
    if (isTauri()) return tauriInvoke('cexi_mesh_export', { datPath, outputDir, args, cexiPath: cexiPath || null });
    const res = await fetch('/fs/mesh-export', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ datPath, outputDir, args, cexiPath }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(text);
    return text;
  },

  /** True if a runnable cexi is resolvable from the configured path (or PATH). */
  async cexiAvailable(cexiPath) {
    if (isTauri()) return tauriInvoke('cexi_available', { cexiPath: cexiPath || null });
    return !!(cexiPath && cexiPath.trim());   // dev shim can't check; trust the field
  },

  /** Native file picker (Tauri only). Returns the chosen path or null. */
  async pickFile(initial) {
    if (!isTauri()) return null;
    return tauriInvoke('pick_file', { initial: initial || null });
  },

  /** Writes bytes to a file (creates parent dirs). */
  async writeFile(path, bytes) {
    const arr = Array.from(new Uint8Array(bytes));
    if (isTauri()) return tauriInvoke('write_file', { path, contents: arr });
    const res = await fetch(`/fs/write?path=${encodeURIComponent(path)}`, {
      method: 'POST', body: new Uint8Array(bytes),
    });
    if (!res.ok) throw new Error(await res.text());
  },

  /** Lists filenames (not dirs) directly in a directory. Returns [] if missing. */
  async listFiles(path) {
    try {
      const entries = await this.listDir(path);
      return entries.filter((e) => !e.isDir).map((e) => e.name);
    } catch {
      return [];
    }
  },

  /** Opens a URL in the system browser. */
  async openUrl(url) {
    if (isTauri()) return tauriInvoke('open_url', { url });
    window.open(url, '_blank', 'noopener,noreferrer');
  },
};
