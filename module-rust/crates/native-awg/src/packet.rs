use std::{
    io,
    pin::Pin,
    task::{Context, Poll},
};

use futures::{Sink, Stream, channel::mpsc};
use smoltcp::phy::{DeviceCapabilities, Medium};
use tokio_smoltcp::device::{AsyncDevice, Packet};

pub(super) struct Device {
    inbound: mpsc::Receiver<Packet>,
    outbound: mpsc::Sender<Packet>,
    capabilities: DeviceCapabilities,
}

impl Device {
    pub(super) fn new(
        inbound: mpsc::Receiver<Packet>,
        outbound: mpsc::Sender<Packet>,
        mtu: usize,
    ) -> Self {
        let mut capabilities = DeviceCapabilities::default();
        capabilities.medium = Medium::Ip;
        capabilities.max_transmission_unit = mtu;
        capabilities.max_burst_size = Some(16);
        Self {
            inbound,
            outbound,
            capabilities,
        }
    }
}

impl Stream for Device {
    type Item = io::Result<Packet>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        match Pin::new(&mut self.inbound).poll_next(cx) {
            Poll::Ready(Some(packet)) => Poll::Ready(Some(Ok(packet))),
            // Park the reactor when the transport ends to avoid a ready loop.
            Poll::Pending | Poll::Ready(None) => Poll::Pending,
        }
    }
}

impl Sink<Packet> for Device {
    type Error = io::Error;

    fn poll_ready(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn start_send(mut self: Pin<&mut Self>, packet: Packet) -> io::Result<()> {
        let _ = self.outbound.try_send(packet);
        Ok(())
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_close(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

impl AsyncDevice for Device {
    fn capabilities(&self) -> &DeviceCapabilities {
        &self.capabilities
    }
}
