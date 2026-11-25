#!/bin/sh
set -eu

workspace=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd -P)
destination=${1:?Specify an output directory for the local ARM64 binary}
mkdir -p "$destination"
destination=$(CDPATH= cd -- "$destination" && pwd -P)

docker run --rm --platform linux/arm64 \
    --user "$(id -u):$(id -g)" \
    --mount "type=bind,src=$workspace,dst=/src,readonly" \
    --mount "type=bind,src=$destination,dst=/out" \
    -e CARGO_TARGET_DIR=/out/target \
    -e CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_RUSTFLAGS='-C target-feature=+crt-static' \
    -w /src/module-rust rust:1.97-alpine sh -ec '
        cargo build --locked --manifest-path /src/module-rust/Cargo.toml \
            --target aarch64-unknown-linux-musl --release -p routehub
        cp /out/target/aarch64-unknown-linux-musl/release/routehub /out/routehub-rust
    '
