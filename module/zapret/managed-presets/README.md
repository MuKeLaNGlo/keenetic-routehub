# Варианты Zapret для YouTube и Discord

IPK устанавливает файлы стратегий в `/opt/etc/routehub/zapret-strategies/` с правами `0600`. Все варианты ограничены доменами выбранного сервиса и исходящими TLS и QUIC-соединениями на порту 443. Варианты различаются способом обработки TLS и числом пробных пакетов QUIC. Они не охватывают голосовой UDP Discord без распознаваемого имени хоста.

Для этих файлов нужны ARM64 `nfqws2` v1.0.7 (Lua compat 6) и два Lua-файла из того же релиза. Поместите `zapret-lib.lua` и `zapret-antidpi.lua` в `/opt/lib/routehub/zapret2/lua/`. Укажите проверенный путь к исполняемому файлу в параметре `NFQWS` файла `/opt/etc/routehub/zapret.conf`. Пакет RouteHub не запускает установщик Zapret2. [Официальный релиз v1.0.7](https://github.com/bol-van/zapret2/releases/tag/v1.0.7), [документация nfqws2 этого релиза](https://github.com/bol-van/zapret2/blob/038c97e5819df10f8e8c22a2f1fffe57f2f7379b/docs/manual.md).

Помогут сверить файлы из релиза следующие SHA-256.

| Файл | SHA-256 |
| --- | --- |
| `zapret2-v1.0.7.tar.gz` | `547a5dce3f4820721a425680ea3f7f3971b7e9c772b8c795dd2d623148da0928` |
| `binaries/linux-arm64/nfqws2` | `ca522241267acc290259bce7ef8c99a2f37c5665d63c9f37226f9d14b9805243` |
| `lua/zapret-lib.lua` | `6bf528fef1f0fc3c65e189216fc8a06bb873f6e25d1c29d2bfa4695a09b73440` |
| `lua/zapret-antidpi.lua` | `6d1fa9168e5de1682fef91fd174f68b58c50f6739ef00f42ca7db2b940b6246d` |

Для запуска нужны `ENABLED=1` в `zapret.conf`, `zapret: true` в плане RouteHub, доступная очередь NFQUEUE и `flock` из Entware. `nfqws2` запускает Lua с ограниченными правами. У каталогов на пути к Lua-файлам должно быть право прохода, у самих файлов — право чтения. Для режима `connbytes` ядру нужен `net.netfilter.nf_conntrack_acct=1`. На Keenetic без этого параметра RouteHub ограничивает TCP и UDP 443 по метке и частоте пакетов. Для IPv6 нужен `ip6tables`. [Документация Linux](https://docs.kernel.org/networking/nf_conntrack-sysctl.html).

Официальный ARM64 `nfqws2` принял все шесть вариантов, девять пар активных стратегий и шесть диагностических комбинаций при `--dry-run` в изолированном Linux. На KN‑3811 третья стратегия прошла HTTPS-проверки через собственную очередь RouteHub для YouTube и Discord.
