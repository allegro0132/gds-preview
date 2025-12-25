use serde::Serialize;
use std::io::Write;
use std::sync::Mutex;
use std::net::TcpStream;
use tungstenite::{WebSocket, Message};

static WS_SOCKET: Mutex<Option<WebSocket<TcpStream>>> = Mutex::new(None);

pub fn set_socket(socket: WebSocket<TcpStream>) {
    let mut lock = WS_SOCKET.lock().unwrap();
    *lock = Some(socket);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChunkMsg {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub r#type: Option<String>,
    pub layer_key: String,
    pub chunk_index: usize,
    pub total_chunks: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cell_name: Option<String>,
    // Add length field for binary protocol
    pub len: usize,
}

pub fn send_binary_chunk(msg: &ChunkMsg, data: &[u8], chunk_index: usize, flow_control_step: usize) {
    // Check if WS is available
    let mut lock = WS_SOCKET.lock().unwrap();
    if let Some(socket) = lock.as_mut() {
        // Send Header as Text
        let header = serde_json::to_string(msg).unwrap();
        if let Err(e) = socket.write_message(Message::Text(header)) {
            eprintln!("WS Error: {}", e);
            return;
        }
        // Send Data as Binary
        if let Err(e) = socket.write_message(Message::Binary(data.to_vec())) {
            eprintln!("WS Error: {}", e);
            return;
        }
        // No flow control needed for WS (TCP handles it)
        return;
    }

    // Fallback to stdout
    // New Binary Protocol: CHUNK_BIN|<json_header>\n<binary_data>
    // Note: msg already contains 'len' which matches data.len()

    let header = serde_json::to_string(msg).unwrap();
    print!("CHUNK_BIN|{}\n", header);
    std::io::stdout().flush().unwrap();
    std::io::stdout().write_all(data).unwrap();
    std::io::stdout().flush().unwrap();

    if flow_control_step > 0 && (chunk_index + 1) % flow_control_step == 0 {
        let mut input = String::new();
        let _ = std::io::stdin().read_line(&mut input);
    }
}

pub fn send_json<T: Serialize>(data: &T) {
    println!("{}", serde_json::to_string(data).unwrap());
    std::io::stdout().flush().unwrap();
}
