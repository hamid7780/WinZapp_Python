#!/usr/bin/env python3
"""
WinZapp — Baileys Gateway Server setup script.

Copies WinZapp's Baileys Gateway Server from client/api_patches/ to client/api/
and runs npm install & npm run build to compile dist/server.js.

Usage:
  venv\\Scripts\\python.exe setup_api.py
"""

import json
import os
import shutil
import subprocess
import sys

ROOT_DIR        = os.path.dirname(os.path.abspath(__file__))
CLIENT_API_DIR  = os.path.join(ROOT_DIR, "client", "api")
API_PATCHES_DIR = os.path.join(ROOT_DIR, "client", "api_patches")


def _run(cmd: list, cwd: str = None):
    print(f"  $ {' '.join(str(c) for c in cmd)}")
    executable = cmd[0]
    if isinstance(executable, str) and not os.path.isabs(executable):
        resolved = shutil.which(executable)
        if resolved:
            cmd = [resolved] + cmd[1:]
    result = subprocess.run(cmd, cwd=cwd)
    if result.returncode != 0:
        print(f"\n[ERROR] Command failed (exit {result.returncode}).")
        sys.exit(result.returncode)


def main():
    print("[INFO] Setting up WinZapp Baileys Gateway Server...")
    if sys.platform == "win32":
        try:
            subprocess.run(["taskkill", "/F", "/IM", "node.exe"], stderr=subprocess.DEVNULL, stdout=subprocess.DEVNULL)
        except Exception:
            pass
    os.makedirs(CLIENT_API_DIR, exist_ok=True)

    # Clean old contents in CLIENT_API_DIR except node_modules and tokens
    if os.path.exists(CLIENT_API_DIR):
        for item in os.listdir(CLIENT_API_DIR):
            if item in ("node_modules", "tokens", ".git"):
                continue
            item_path = os.path.join(CLIENT_API_DIR, item)
            try:
                if os.path.isdir(item_path):
                    shutil.rmtree(item_path)
                else:
                    os.remove(item_path)
            except Exception as e:
                print(f"[WARNING] Failed to remove {item}: {e}")

    for root, dirs, files in os.walk(API_PATCHES_DIR):
        rel_dir = os.path.relpath(root, API_PATCHES_DIR)
        if rel_dir == "dist" or rel_dir == "node_modules":
            continue
        dest_dir = os.path.join(CLIENT_API_DIR, rel_dir) if rel_dir != "." else CLIENT_API_DIR
        os.makedirs(dest_dir, exist_ok=True)
        for f in files:
            src_file = os.path.join(root, f)
            dst_file = os.path.join(dest_dir, f)
            shutil.copy2(src_file, dst_file)

    print("[OK] Source files synced successfully.")

    # Automate npm install and build
    is_windows = sys.platform == "win32"
    node_bin = "node"
    npm_bin = "npm"

    if is_windows:
        win_node = os.path.join(ROOT_DIR, "client", "node", "node.exe")
        if os.path.isfile(win_node):
            node_bin = win_node
            win_npm = os.path.join(ROOT_DIR, "client", "node", "node_modules", "npm", "bin", "npm-cli.js")
            if os.path.isfile(win_npm):
                npm_bin = win_npm

    print("[INFO] Installing Node.js dependencies (Baileys, Express, Socket.IO)...")
    if npm_bin.endswith("npm-cli.js"):
        _run([node_bin, npm_bin, "install", "--no-audit", "--no-fund"], cwd=CLIENT_API_DIR)
    else:
        _run([npm_bin, "install", "--no-audit", "--no-fund"], cwd=CLIENT_API_DIR)

    print("[INFO] Compiling Baileys Gateway Server (npm run build)...")
    if npm_bin.endswith("npm-cli.js"):
        _run([node_bin, npm_bin, "run", "build"], cwd=CLIENT_API_DIR)
    else:
        _run([npm_bin, "run", "build"], cwd=CLIENT_API_DIR)

    print()
    print("[OK] WinZapp Baileys Gateway Server built successfully at client/api/dist/server.js")
    print()


if __name__ == "__main__":
    main()
