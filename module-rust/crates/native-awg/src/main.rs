use std::{io, io::Read, net::SocketAddr};

use routehub_imports::parse_managed_awg;
use routehub_native_awg::{Tunnel, serve_socks};
use tokio::net::TcpListener;

#[tokio::main(flavor = "current_thread")]
async fn main() -> io::Result<()> {
    let mut args = std::env::args().skip(1);
    let usage = || {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "usage: routehub-native-awg [2.0|3.1|auto] [127.0.0.1:0], AWG config on stdin",
        )
    };
    let version = args.next().unwrap_or_else(|| "auto".into());
    let version = match version.as_str() {
        "2.0" | "3.1" => version.as_str(),
        "auto" => "",
        _ => return Err(usage()),
    };
    let listen = args
        .next()
        .as_deref()
        .unwrap_or("127.0.0.1:0")
        .parse::<SocketAddr>()
        .map_err(|_| usage())?;
    if args.next().is_some() || !listen.ip().is_loopback() {
        return Err(usage());
    }
    let config = {
        let mut input = String::new();
        io::stdin()
            .take((128 << 10) + 1)
            .read_to_string(&mut input)?;
        parse_managed_awg(&input, version)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))?
    };
    let listener = TcpListener::bind(listen).await?;
    let tunnel = Tunnel::start(&config).await?;
    println!("{}", listener.local_addr()?);
    serve_socks(listener, tunnel).await
}
