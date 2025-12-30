use crate::streamer::{ChunkTransport, WsChunkKind};
use anyhow::Result;
use std::io::Write;
use std::net::TcpStream;

pub struct TcpTransport<'a> {
    pub stream: &'a mut TcpStream,
    pub flow_control_step: usize,
}

impl ChunkTransport for TcpTransport<'_> {
    fn send(
        &mut self,
        kind: WsChunkKind,
        layer_key: &str,
        cell_name: Option<&str>,
        chunk_index: u32,
        total_chunks: u32,
        payload: &[u8],
    ) -> Result<()> {
        let cell_name = cell_name.unwrap_or("");
        let layer_bytes = layer_key.as_bytes();
        let cell_bytes = cell_name.as_bytes();
        if layer_bytes.len() > u16::MAX as usize {
            return Err(anyhow::anyhow!("layer_key too long"));
        }
        if cell_bytes.len() > u16::MAX as usize {
            return Err(anyhow::anyhow!("cell_name too long"));
        }

        // Frame (little-endian), forwarded by extension over WebSocket as a single binary message:
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
        let mut frame = Vec::with_capacity(
            1 + 1 + 2 + 4 + 4 + 2 + 2 + layer_bytes.len() + cell_bytes.len() + payload.len(),
        );
        let version: u8 = if matches!(kind, WsChunkKind::FlatPolygons) && cell_name.starts_with("__snap__:") {
            2u8
        } else {
            1u8
        };
        frame.push(version);
        frame.push(kind as u8);
        frame.extend_from_slice(&0u16.to_le_bytes());
        frame.extend_from_slice(&chunk_index.to_le_bytes());
        frame.extend_from_slice(&total_chunks.to_le_bytes());
        frame.extend_from_slice(&(layer_bytes.len() as u16).to_le_bytes());
        frame.extend_from_slice(&(cell_bytes.len() as u16).to_le_bytes());
        frame.extend_from_slice(layer_bytes);
        frame.extend_from_slice(cell_bytes);
        frame.extend_from_slice(payload);

        // TCP is length-prefixed to allow reassembly in Node.
        let len = frame.len() as u32;
        self.stream.write_all(&len.to_le_bytes())?;
        self.stream.write_all(&frame)?;
        self.stream.flush()?;

        if self.flow_control_step > 0 && ((chunk_index as usize + 1) % self.flow_control_step == 0)
        {
            let mut input = String::new();
            let _ = std::io::stdin().read_line(&mut input);
        }
        Ok(())
    }
}
