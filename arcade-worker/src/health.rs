use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::thread;

use tracing::{error, info, warn};

pub(crate) fn parse_port(addr: &str) -> u16 {
    addr.rfind(':')
        .and_then(|colon_pos| addr[colon_pos + 1..].parse::<u16>().ok())
        .unwrap_or(8081)
}

pub(crate) fn spawn_health_server(port: u16) {
    thread::spawn(move || {
        let listener = match TcpListener::bind(("0.0.0.0", port)) {
            Ok(listener) => listener,
            Err(err) => {
                error!(port, error = %err, "failed to bind worker health endpoint");
                return;
            }
        };

        info!(port, "worker health server started");
        for stream in listener.incoming() {
            match stream {
                Ok(mut socket) => {
                    thread::spawn(move || health_reply(&mut socket));
                }
                Err(err) => {
                    warn!(error = %err, "incoming connection failed");
                }
            }
        }
    });
}

fn health_reply(stream: &mut TcpStream) {
    let mut buf = [0u8; 1024];
    let _ = stream.read(&mut buf);

    let response = if buf.starts_with(b"GET /healthz") {
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 15\r\n\r\n{\"status\":\"ok\"}"
    } else {
        "HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\nContent-Length: 9\r\n\r\nnot-found"
    };
    let _ = stream.write_all(response.as_bytes());
}
