# AmneziaWG через штатный интерфейс Keenetic

Адаптер отправляет TCP и UDP через уже настроенный интерфейс WireGuard ASC. Подключение, ключи, `AllowedIPs` и handshake остаются в KeeneticOS. Модуль добавляет выход в Xray по имени Linux-интерфейса и не меняет конфигурацию WireGuard или таблицы маршрутизации. В KeeneticOS 5.1 документирован импорт расширенных параметров ASC. Проверяйте их совместимость с версией AmneziaWG удалённого узла. [WireGuard на KN‑3811](https://support.keenetic.com/hopper/kn-3811/en/16937-wireguard-vpn.html), [изменения ASC](https://support.keenetic.com/hopper/kn-3811/en/107768-os-5-1.html).

## Профиль

Задайте `protocol` равным `amneziawg` и укажите `interface`. В примере `wg0` обозначает имя Linux-интерфейса, которое нужно сверить с `ip link` на самом роутере. Имя подключения в веб-панели может отличаться.

```json
{
  "id": "awg-home",
  "protocol": "amneziawg",
  "interface": "wg0"
}
```

RouteHub задаёт для Xray следующий выход.

```json
{
  "tag": "awg-home",
  "protocol": "freedom",
  "settings": {},
  "streamSettings": {
    "sockopt": {"interface": "wg0"}
  }
}
```

При включении RouteHub проверяет, что Linux-интерфейс существует, поднят и не является loopback. После этого требуется проверка handshake и фактического egress. Наличие интерфейса и успешный `xray run -test` сами по себе доступность удалённой сети не подтверждают.

Интерфейс и `AllowedIPs` должны покрывать адреса, которые выбраны для этого выхода. `ip route get <контрольный-IPv4> oif wg0` позволяет посмотреть, есть ли подходящий маршрут у сокета, закреплённого за `wg0`. Для IPv6 используется `ip -6 route get`. Если используется отдельная policy table, ядру нужно правило, подходящее для локальных сокетов с этим выходным интерфейсом. Пользовательский процесс должен иметь возможность выполнить `SO_BINDTODEVICE` на версии ядра роутера. [Политики `ip rule`](https://www.man7.org/linux/man-pages/man8/ip-rule.8.html), [параметры сокетов Xray](https://xtls.github.io/en/config/transports/sockopt.html).

Адаптер привязывает сокеты к интерфейсу. Запросы DNS обрабатываются настройками резолвера Xray или системы. Если им положено идти через тот же туннель, задайте эту политику отдельно, с IP-адресом DNS-сервера в допустимых `AllowedIPs`, и проверьте её на клиенте. [DNS в Xray](https://xtls.github.io/en/config/dns.html).

## Проверки

- `python3 awg/verify_binding.py /path/to/xray` выполняет локальный тест с SOCKS5, TCP- и UDP-эхо. Запускайте его в Linux. Проверен ARM64-бинарник Entware `xray-core 26.10.29-1`, Xray `26.10.29` (`0afec660`), в контейнере без внешней сети с `--network none --cap-drop ALL`. Через `lo` прошли TCP и UDP. С несуществующим интерфейсом оба потока завершились без пересылки по штатному маршруту. Повторите тест, если меняете сборку Xray. [Код привязки сокета](https://github.com/XTLS/Xray-core/blob/0afec660/transport/internet/sockopt_linux.go), [обработка ошибки для TCP и UDP](https://github.com/XTLS/Xray-core/blob/0afec660/transport/internet/system_dialer.go).
- На реальном KN‑3811 проверку дополнить контрольными IPv4 и IPv6, DNS, UDP и выходным IP профиля. Затем временно остановить специально заведённый тестовый интерфейс и убедиться, что трафик выбранного правила не ушёл по обычному WAN. Рабочий интерфейс, маршруты и перезапуск роутера в локальном тесте не использовались.

## Встроенный адаптер

При импорте клиентского файла AmneziaWG можно использовать адаптер RouteHub в userspace. Он входит в основной бинарник и обслуживает туннель через локальный SOCKS. [Исходники адаптера](../../module-rust/crates/native-awg/)
