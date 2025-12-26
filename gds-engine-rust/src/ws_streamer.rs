use rand::{distributions::Alphanumeric, Rng};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::Duration;
use tungstenite::protocol::Message;

#[derive(Clone, Copy, Debug)]
#[repr(u8)]
pub enum WsChunkKind {
    FlatTriangles = 1,
    DefinitionTriangles = 2,
    Instances = 3,
    FlatPolygons = 4,
}

pub struct WsServer {
    listener: TcpListener,
    port: u16,
    token: String,
    ws: Option<tungstenite::WebSocket<TcpStream>>,
}

impl WsServer {
    pub fn bind_localhost(port: u16) -> anyhow::Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", port))?;
        listener.set_nonblocking(false)?;
        let port = listener.local_addr()?.port();

        let token: String = rand::thread_rng()
            .sample_iter(&Alphanumeric)
            .take(32)
            .map(char::from)
            .collect();

        Ok(Self {
            listener,
            port,
            token,
            ws: None,
        })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    pub fn ensure_connected(&mut self) -> anyhow::Result<()> {
        if self.ws.is_some() {
            return Ok(());
        }

        // Accept exactly one client.
        let (stream, _) = self.listener.accept()?;
        stream.set_nodelay(true).ok();
        stream.set_read_timeout(Some(Duration::from_secs(10))).ok();
        stream.set_write_timeout(Some(Duration::from_secs(10))).ok();

        let mut ws = tungstenite::accept(stream)?;

        // Expect an auth token as the first message.
        match ws.read_message() {
            Ok(Message::Text(txt)) => {
                if txt.trim() != self.token {
                    let _ = ws.write_message(Message::Close(None));
                    return Err(anyhow::anyhow!("WebSocket auth failed"));
                }
            }
            Ok(Message::Binary(b)) => {
                let txt = String::from_utf8_lossy(&b);
                if txt.trim() != self.token {
                    let _ = ws.write_message(Message::Close(None));
                    return Err(anyhow::anyhow!("WebSocket auth failed"));
                }
            }
            Ok(_) | Err(_) => {
                let _ = ws.write_message(Message::Close(None));
                return Err(anyhow::anyhow!("WebSocket auth handshake missing"));
            }
        }

        self.ws = Some(ws);
        Ok(())
    }

    pub fn send_chunk(
        &mut self,
        kind: WsChunkKind,
        layer_key: &str,
        cell_name: Option<&str>,
        chunk_index: u32,
        total_chunks: u32,
        payload: &[u8],
    ) -> anyhow::Result<()> {
        self.ensure_connected()?;

        let cell_name = cell_name.unwrap_or("");
        let layer_bytes = layer_key.as_bytes();
        let cell_bytes = cell_name.as_bytes();

        if layer_bytes.len() > u16::MAX as usize {
            return Err(anyhow::anyhow!("layer_key too long"));
        }
        if cell_bytes.len() > u16::MAX as usize {
            return Err(anyhow::anyhow!("cell_name too long"));
        }

        // Binary envelope (little-endian):
        // u8 version
        // u8 kind
        // u16 flags
        // u32 chunk_index
        // u32 total_chunks (0 means unknown)
        // u16 layer_len
        // u16 cell_len
        // [layer utf8]
        // [cell utf8]
        // [payload]
        let mut frame = Vec::with_capacity(1 + 1 + 2 + 4 + 4 + 2 + 2 + layer_bytes.len() + cell_bytes.len() + payload.len());
        frame.push(1u8);
        frame.push(kind as u8);
        frame.extend_from_slice(&0u16.to_le_bytes());
        frame.extend_from_slice(&chunk_index.to_le_bytes());
        frame.extend_from_slice(&total_chunks.to_le_bytes());
        frame.extend_from_slice(&(layer_bytes.len() as u16).to_le_bytes());
        frame.extend_from_slice(&(cell_bytes.len() as u16).to_le_bytes());
        frame.extend_from_slice(layer_bytes);
        frame.extend_from_slice(cell_bytes);
        frame.extend_from_slice(payload);

        if let Some(ws) = &mut self.ws {
            ws.write_message(Message::Binary(frame))?;
            ws.flush()?;
        }

        Ok(())
    }
}
