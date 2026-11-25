# Сборка и локальная проверка

Команды выполняются из корня репозитория. Для сборки нужны Node.js 22, pnpm из `module/panel/package.json`, Docker с поддержкой `linux/arm64` и Python 3.9 или новее. Версия Rust закреплена в `module-rust/rust-toolchain.toml`.

## Пакет для Keenetic

Сборщик встраивает HTML, стили, JavaScript и шрифты панели в демон Rust, затем упаковывает бинарник и интеграции Entware.

```sh
python3 module/packaging/build_ipk.py --rebuild-panel
```

Результат — `dist/routehub_0.6.11~rust3-1_aarch64-3.10.ipk`. Без `--rebuild-panel` сборщик использует существующий HTML или собирает панель, если его ещё нет. Для упаковки готового бинарника RouteHub для Linux ARM64 передайте `--binary`. Аргумент `--version` задаёт версию пакета. Для побайтового сравнения выпусков фиксируйте инструменты сборки и `SOURCE_DATE_EPOCH`.

## Демонстрационная панель

Демо берёт данные из локальной фикстуры. Оно показывает интерфейс без работающего роутера и изменений сетевых настроек.

```sh
pnpm --dir module/panel install --frozen-lockfile
pnpm --dir module/panel dev --host 127.0.0.1
```

Вариант для отдельного просмотра создаётся командой `pnpm --dir module/panel build:demo`. Готовый файл находится в `module/panel/dist-demo/index.html`.

## Проверки

```sh
pnpm --dir module/panel lint
pnpm --dir module/panel build
(cd module-rust && cargo test --locked --workspace --lib --bins --tests)
(cd module-rust && cargo test --locked --manifest-path crates/native-awg/Cargo.toml --lib)
```

Тесты Rust охватывают маршруты, импорт, авторизацию, хранилище и сетевые фикстуры. Для сквозной проверки демона и настоящего Xray в Linux ARM64 используйте `module-rust/tools/smoke-panel.py`. Скрипт принимает пути к исполняемым файлам RouteHub и Xray, собранным для Linux ARM64. Он проверяет HTTP, импорты, сохранение, откат и SOCKS5 в локальном окружении.
