#!/usr/bin/env python3
"""Build a reproducible Entware IPK for RouteHub."""

import argparse
import gzip
import io
import os
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile
import tomllib

PACKAGING = Path(__file__).resolve().parent
MODULE = PACKAGING.parent
ROOT = MODULE.parent
ARCH = "aarch64-3.10"


def default_package_version():
    with (ROOT / "module-rust/app/Cargo.toml").open("rb") as manifest:
        version = tomllib.load(manifest)["package"]["version"]
    # Entware orders the new public release series above previously shipped packages.
    return f"1:{version.replace('-', '~', 1)}-1"


def archive(files, epoch):
    result = io.BytesIO()
    with gzip.GzipFile(filename="", fileobj=result, mode="wb", mtime=epoch) as compressed:
        with tarfile.open(fileobj=compressed, mode="w", format=tarfile.GNU_FORMAT) as tar:
            directories = {
                directory
                for name in files
                for directory in Path(name).parents
                if directory != Path(".")
            }
            for directory in sorted(directories):
                info = tarfile.TarInfo(f"./{directory.as_posix()}")
                info.type = tarfile.DIRTYPE
                info.mode = 0o755
                info.mtime = epoch
                tar.addfile(info)
            for name in sorted(files, key=lambda item: (item != "debian-binary", item)):
                contents, mode = files[name]
                info = tarfile.TarInfo(f"./{name}")
                info.mode = mode
                info.mtime = epoch
                info.size = len(contents)
                tar.addfile(info, io.BytesIO(contents))
    return result.getvalue()


def build_binary():
    destination = ROOT / "build" / "arm64"
    subprocess.run(
        ["sh", str(ROOT / "module-rust/tools/build-arm64.sh"), str(destination)],
        cwd=ROOT,
        check=True,
    )
    return destination / "routehub-rust"


def package_files(binary):
    files = {
        "opt/sbin/routehub": (binary, 0o755),
        "opt/etc/init.d/S98routehub": (PACKAGING / "S98routehub", 0o755),
        "opt/etc/routehub/config.json": (MODULE / "example.json", 0o600),
        "opt/share/routehub/profiles.example.json": (MODULE / "profiles.example.json", 0o644),
        "opt/share/routehub/S98routehub-internal": (PACKAGING / "S98routehub-internal", 0o755),
        "opt/share/routehub/61-routehub-dns-internal.sh": (PACKAGING / "61-routehub-dns-internal.sh", 0o755),
        "opt/share/routehub/60-routehub-transparent-internal.sh": (PACKAGING / "60-routehub-transparent-internal.sh", 0o755),
        "opt/share/routehub/90-routehub-zapret-internal.sh": (PACKAGING / "90-routehub-zapret-internal.sh", 0o755),
    }
    integrations = {
        "redirect": {
            "opt/lib/routehub/routehub-transparent": ("routehub-transparent", 0o755),
            "opt/lib/routehub/routehub-redirect-tcp": ("routehub-redirect-tcp", 0o755),
            "opt/etc/ndm/netfilter.d/60-routehub.sh": ("60-routehub.sh", 0o755),
        },
        "zapret": {
            "opt/lib/routehub/routehub-zapret": ("routehub-zapret", 0o755),
            "opt/etc/routehub/zapret.conf": ("zapret.conf", 0o600),
            "opt/etc/routehub/zapret.args": ("zapret.args", 0o600),
            "opt/etc/ndm/netfilter.d/90-routehub-zapret": ("90-routehub-zapret", 0o755),
        },
        "dns": {
            "opt/lib/routehub/routehub-dns": ("routehub-dns", 0o755),
            "opt/etc/ndm/netfilter.d/61-routehub-dns.sh": ("61-routehub-dns.sh", 0o755),
        },
    }
    for integration, members in integrations.items():
        source = MODULE / integration
        if source.is_dir():
            files.update({name: (source / file, mode) for name, (file, mode) in members.items()})

    presets = MODULE / "zapret" / "managed-presets"
    for source in presets.glob("*.args"):
        files[f"opt/etc/routehub/zapret-strategies/{source.name}"] = (source, 0o600)
    for subdirectory in (".", "packaging", "redirect", "zapret", "zapret/managed-presets", "awg", "dns"):
        for source in (MODULE / subdirectory).glob("*.md"):
            relative = source.relative_to(MODULE)
            files[f"opt/share/routehub/{relative.as_posix()}"] = (source, 0o644)
    return {name: (source.read_bytes(), mode) for name, (source, mode) in files.items()}


def build(version, output_dir, epoch, binary=None):
    binary = binary if binary is not None else build_binary()
    with binary.open("rb") as executable:
        header = executable.read(64)
    # ELF64, little-endian, EM_AARCH64. Avoid packaging a host Mach-O.
    if len(header) != 64 or header[:6] != b"\x7fELF\x02\x01" or header[18:20] != b"\xb7\x00":
        raise ValueError("RouteHub executable must be Linux ARM64 ELF")
    payload = package_files(binary)

    config_files = sorted(f"/{name}" for name, (_, mode) in payload.items() if mode == 0o600)
    control = (
        "Package: routehub\n"
        f"Version: {version}\n"
        f"Architecture: {ARCH}\n"
        "Section: net\n"
        "Priority: optional\n"
        "Depends: xray-core\n"
        f"Installed-Size: {sum(len(data) for data, _ in payload.values())}\n"
        "Maintainer: RouteHub\n"
        "Description: Local policy routing and control for Keenetic Entware\n"
    ).encode()
    metadata = {
        "control": (control, 0o644),
        "conffiles": (("\n".join(config_files) + "\n").encode(), 0o644),
        "prerm": ((PACKAGING / "prerm").read_bytes(), 0o755),
        "postrm": ((PACKAGING / "postrm").read_bytes(), 0o755),
    }
    package = archive({
        "debian-binary": (b"2.0\n", 0o644),
        "control.tar.gz": (archive(metadata, epoch), 0o644),
        "data.tar.gz": (archive(payload, epoch), 0o644),
    }, epoch)
    output_dir.mkdir(parents=True, exist_ok=True)
    filename_version = version.split(":", 1)[-1]
    destination = output_dir / f"routehub_{filename_version}_{ARCH}.ipk"
    with tempfile.NamedTemporaryFile(dir=output_dir, prefix=".routehub-", delete=False) as temp:
        partial = Path(temp.name)
    try:
        partial.write_bytes(package)
        partial.chmod(0o644)
        partial.replace(destination)
    finally:
        partial.unlink(missing_ok=True)
    return destination


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", default=default_package_version())
    parser.add_argument("--output-dir", type=Path, default=ROOT / "dist")
    parser.add_argument("--binary", type=Path, help="package a prebuilt ARM64 RouteHub Rust executable")
    parser.add_argument("--rebuild-panel", action="store_true", help="build panel from the pnpm lockfile")
    options = parser.parse_args()
    if not re.fullmatch(r"(?:[0-9]+:)?[0-9][0-9A-Za-z.+~-]*", options.version):
        parser.error("invalid package version")
    try:
        epoch = int(os.environ.get("SOURCE_DATE_EPOCH", "0"))
        if not 0 <= epoch <= 0xFFFFFFFF:
            raise ValueError
    except ValueError:
        parser.error("SOURCE_DATE_EPOCH must be an unsigned 32-bit integer")
    panel_missing = not (MODULE / "panel/dist/index.html").is_file()
    if options.rebuild_panel or (options.binary is None and panel_missing):
        subprocess.run(["pnpm", "install", "--frozen-lockfile"], cwd=MODULE / "panel", check=True)
        subprocess.run(["pnpm", "build"], cwd=MODULE / "panel", check=True)
    print(build(options.version, options.output_dir.resolve(), epoch, options.binary))


if __name__ == "__main__":
    main()
