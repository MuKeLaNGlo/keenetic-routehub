# RouteHub

RouteHub is a Rust daemon and React panel for Keenetic ARM64 with Entware. The main branch is published at `git@github.com:MuKeLaNGlo/keenetic-routehub.git`.

## Layout

- `module-rust/app/` contains the daemon, HTTP API, configuration transactions, and runtime integration.
- `module-rust/crates/` contains routing policy, importers, subscriptions, and native AmneziaWG.
- `module/panel/` contains the React panel. `dist/index.html` is generated and embedded in the daemon.
- `module/packaging/` builds the IPK. `module/{redirect,dns,zapret}/` contains the Entware helpers and hooks.
- `docs/` contains installation and build instructions. Update these when changing user-facing commands or compatibility.

## Development checks

Run from the repository root. Build the panel before testing or building the daemon in a fresh checkout.

```sh
pnpm --dir module/panel install --frozen-lockfile
pnpm --dir module/panel lint
pnpm --dir module/panel build
(cd module-rust && cargo fmt --all --check)
(cd module-rust && cargo test --locked --workspace --lib --bins --tests)
(cd module-rust && cargo test --locked --manifest-path crates/native-awg/Cargo.toml --lib)
python3 module/packaging/build_ipk.py --rebuild-panel
```

Use the ARM64 IPK build and an isolated Linux/Xray smoke test when changing packaging or runtime startup. Check panel behavior with its real API contract, including slow writes, failed saves, and stale revisions where relevant.

## Router and data boundaries

- Use fixtures and an isolated test environment by default. Obtain explicit permission before deploying to Keenetic, restarting the installed service, or rebooting the router.
- Preserve existing configuration files, authentication state, and a verified rollback path on upgrades. Account for internal flash and tmpfs separately. Keep netfilter cleanup limited to resources owned by RouteHub.
- Keep credentials, private profiles, subscription URLs, live exports, and build outputs out of commits, fixtures, logs, and support reports. Use fabricated examples.
- Preserve backwards readability of on-device configuration or provide an explicit migration and rollback. Keep user-visible revision labels separate from the API token used for concurrent writes.
