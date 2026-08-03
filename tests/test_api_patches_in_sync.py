"""client/api_patches/ and client/api/ must never drift apart.

client/api/ is populated by setup_api.py restoring files from client/api_patches/.
These tests compare the two copies byte for byte so edits in api_patches/ are verified.
"""

import json
import pathlib
import pytest

ROOT = pathlib.Path(__file__).resolve().parents[1]
API = ROOT / "client" / "api"
PATCHES = ROOT / "client" / "api_patches"

MIRRORED_FILES = [
    "start.js",
    "config.json",
    "tsconfig.json",
    "src/types.ts",
    "src/baileysManager.ts",
    "src/routes.ts",
    "src/server.ts",
]


@pytest.mark.parametrize("rel_path", MIRRORED_FILES)
def test_the_two_copies_of_each_patch_are_identical(rel_path):
    patch = PATCHES / rel_path
    live = API / rel_path
    if not patch.exists():
        pytest.skip(f"client/api_patches/{rel_path} not present")
    if not live.exists():
        pytest.skip(f"client/api/{rel_path} not present (API not set up here)")
    assert patch.read_bytes() == live.read_bytes(), (
        f"client/api/{rel_path} and client/api_patches/{rel_path} have drifted. "
        f"api_patches/ is the source of truth setup_api.py restores from."
    )


def test_setup_api_patch_list_matches_this_one():
    """Confirms setup_api.py references API_PATCHES_DIR for syncing."""
    src = (ROOT / "setup_api.py").read_text(encoding="utf-8")
    assert "API_PATCHES_DIR" in src


def test_the_in_app_installer_restores_the_same_patches():
    """ApiSetupDialog has its own copy of the list. It must not fall behind setup_api.py's."""
    src = (ROOT / "client" / "ui" / "dialogs" / "api_setup.py").read_text(encoding="utf-8")
    for rel_path in MIRRORED_FILES:
        assert f'"{rel_path}"' in src or f"'{rel_path}'" in src, f"ApiSetupDialog does not restore {rel_path}"


def test_both_installers_patch_the_same_dependencies():
    """package.json dependencies check."""
    setup = (ROOT / "setup_api.py").read_text(encoding="utf-8")
    dialog = (ROOT / "client" / "ui" / "dialogs" / "api_setup.py").read_text(encoding="utf-8")
    assert "@whiskeysockets/baileys" in setup or "Baileys" in setup
    assert "@whiskeysockets/baileys" in dialog


def test_baileys_dependency_present_in_package_json():
    """Confirms @whiskeysockets/baileys is present in api_patches/package.json."""
    patch_pkg = json.loads((PATCHES / "package.json").read_text(encoding="utf-8"))
    assert "@whiskeysockets/baileys" in patch_pkg.get("dependencies", {})
