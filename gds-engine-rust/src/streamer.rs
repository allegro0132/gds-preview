use serde::Serialize;
use base64::{Engine as _, engine::general_purpose};
use std::io::Write;

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
}

pub fn send_binary_chunk(msg: &ChunkMsg, data: &[u8], chunk_index: usize, flow_control_step: usize) {
    let b64_data = general_purpose::STANDARD.encode(data);
    let mut msg_json = serde_json::to_value(msg).unwrap();
    msg_json.as_object_mut().unwrap().insert("data".to_string(), serde_json::Value::String(b64_data));
    
    println!("CHUNK_B64|{}", serde_json::to_string(&msg_json).unwrap());
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
