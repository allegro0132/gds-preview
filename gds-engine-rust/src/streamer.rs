use crate::args::Args;
use crate::geometry::{Matrix3x3, Polygon};
use anyhow::Result;
use base64::{engine::general_purpose, Engine as _};
use rayon::prelude::*;
use serde::Serialize;
use std::collections::HashMap;
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

#[derive(Clone, Copy, Debug)]
#[repr(u8)]
pub enum WsChunkKind {
    FlatTriangles = 1,
    DefinitionTriangles = 2,
    Instances = 3,
    FlatPolygons = 4,
    Control = 5,
}

pub trait ChunkTransport {
    fn send(
        &mut self,
        kind: WsChunkKind,
        layer_key: &str,
        cell_name: Option<&str>,
        chunk_index: u32,
        total_chunks: u32,
        payload: &[u8],
    ) -> Result<()>;
}

pub struct StdoutTransport {
    pub flow_control_step: usize,
}

impl ChunkTransport for StdoutTransport {
    fn send(
        &mut self,
        kind: WsChunkKind,
        layer_key: &str,
        cell_name: Option<&str>,
        chunk_index: u32,
        total_chunks: u32,
        payload: &[u8],
    ) -> Result<()> {
        let msg_type = match kind {
            WsChunkKind::FlatPolygons => {
                if cell_name.is_some() {
                    "definition"
                } else {
                    "flat"
                }
            }
            WsChunkKind::Instances => "instance",
            WsChunkKind::FlatTriangles | WsChunkKind::DefinitionTriangles => {
                return Err(anyhow::anyhow!("Triangles require WebSocket transport"));
            }
            WsChunkKind::Control => {
                return Err(anyhow::anyhow!(
                    "Control frames require WebSocket transport"
                ));
            }
        };

        let msg = ChunkMsg {
            r#type: Some(msg_type.to_string()),
            layer_key: layer_key.to_string(),
            chunk_index: chunk_index as usize,
            total_chunks: total_chunks as usize,
            cell_name: cell_name.map(|s| s.to_string()),
        };
        send_binary_chunk(&msg, payload, chunk_index as usize, self.flow_control_step);
        Ok(())
    }
}

pub fn send_binary_chunk(
    msg: &ChunkMsg,
    data: &[u8],
    chunk_index: usize,
    flow_control_step: usize,
) {
    let b64_data = general_purpose::STANDARD.encode(data);
    let mut msg_json = serde_json::to_value(msg).unwrap();
    msg_json
        .as_object_mut()
        .unwrap()
        .insert("data".to_string(), serde_json::Value::String(b64_data));

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

pub struct PolyChunkBuilder {
    pub chunk_index: u32,
    pub poly_count: u32,
    pub buffer: Vec<u8>,
}

impl PolyChunkBuilder {
    pub fn new() -> Self {
        Self {
            chunk_index: 0,
            poly_count: 0,
            buffer: Vec::new(),
        }
    }

    pub fn ensure_chunk_started(&mut self) {
        if self.buffer.is_empty() {
            self.buffer.extend_from_slice(&0u32.to_le_bytes());
            self.poly_count = 0;
        }
    }
}

pub struct TriChunkBuilder {
    pub chunk_index: u32,
    pub poly_count: u32,
    pub pending_coords: Vec<Vec<f64>>,
}

impl TriChunkBuilder {
    pub fn new() -> Self {
        Self {
            chunk_index: 0,
            poly_count: 0,
            pending_coords: Vec::new(),
        }
    }
}

pub fn push_polygon_transformed(
    layer_key: &str,
    poly: &Polygon,
    transform: &Matrix3x3,
    builders: &mut HashMap<String, PolyChunkBuilder>,
    args: &Args,
    transport: &mut dyn ChunkTransport,
    kind: WsChunkKind,
    cell_name: Option<&str>,
) -> Result<()> {
    let builder = builders
        .entry(layer_key.to_string())
        .or_insert_with(PolyChunkBuilder::new);
    builder.ensure_chunk_started();
    builder.poly_count += 1;

    builder
        .buffer
        .extend_from_slice(&(poly.points.len() as u32).to_le_bytes());
    for p in &poly.points {
        let pt = transform.transform_point(p);
        builder
            .buffer
            .extend_from_slice(&(pt.x as f32).to_le_bytes());
        builder
            .buffer
            .extend_from_slice(&(pt.y as f32).to_le_bytes());
    }

    if args.chunk_size > 0 && (builder.poly_count as usize) >= args.chunk_size {
        flush_polygon_builder(layer_key, builder, args, transport, kind, cell_name)?;
    }
    Ok(())
}

pub fn flush_polygon_builder(
    layer_key: &str,
    builder: &mut PolyChunkBuilder,
    _args: &Args,
    transport: &mut dyn ChunkTransport,
    kind: WsChunkKind,
    cell_name: Option<&str>,
) -> Result<()> {
    if builder.poly_count == 0 {
        return Ok(());
    }
    builder.buffer[0..4].copy_from_slice(&builder.poly_count.to_le_bytes());

    transport.send(
        kind,
        layer_key,
        cell_name,
        builder.chunk_index,
        0,
        &builder.buffer,
    )?;

    builder.chunk_index += 1;
    builder.poly_count = 0;
    builder.buffer.clear();
    Ok(())
}

pub fn flush_all_polygon_builders(
    builders: &mut HashMap<String, PolyChunkBuilder>,
    args: &Args,
    transport: &mut dyn ChunkTransport,
    kind: WsChunkKind,
    cell_name: Option<&str>,
) -> Result<()> {
    for (layer_key, builder) in builders.iter_mut() {
        flush_polygon_builder(layer_key, builder, args, transport, kind, cell_name)?;
    }
    Ok(())
}

pub fn push_triangles_transformed(
    layer_key: &str,
    poly: &Polygon,
    transform: &Matrix3x3,
    builders: &mut HashMap<String, TriChunkBuilder>,
    args: &Args,
    transport: &mut dyn ChunkTransport,
    kind: WsChunkKind,
    cell_name: Option<&str>,
) -> Result<()> {
    if poly.points.len() < 3 {
        return Ok(());
    }

    let mut coords: Vec<f64> = Vec::with_capacity(poly.points.len() * 2);
    for p in &poly.points {
        let pt = transform.transform_point(p);
        coords.push(pt.x);
        coords.push(pt.y);
    }

    // Chunk-level parallelism: buffer transformed polygon coordinates and triangulate in parallel on flush.
    // This keeps memory bounded to roughly chunk_size polygons per layer.
    let builder = builders
        .entry(layer_key.to_string())
        .or_insert_with(TriChunkBuilder::new);
    builder.poly_count += 1;
    builder.pending_coords.push(coords);

    if args.chunk_size > 0 && (builder.poly_count as usize) >= args.chunk_size {
        flush_triangle_builder(layer_key, builder, args, transport, kind, cell_name)?;
    }
    Ok(())
}

pub fn triangulate_coords_to_vertices(coords: &[f64]) -> Vec<f32> {
    if coords.len() < 6 {
        return Vec::new();
    }
    let indices: Vec<usize> = match earcutr::earcut(coords, &[], 2) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    if indices.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::with_capacity(indices.len() * 2);
    for idx in indices {
        let i2 = idx * 2;
        if i2 + 1 >= coords.len() {
            continue;
        }
        out.push(coords[i2] as f32);
        out.push(coords[i2 + 1] as f32);
    }
    out
}

pub fn flush_triangle_builder(
    layer_key: &str,
    builder: &mut TriChunkBuilder,
    _args: &Args,
    transport: &mut dyn ChunkTransport,
    kind: WsChunkKind,
    cell_name: Option<&str>,
) -> Result<()> {
    if builder.pending_coords.is_empty() {
        builder.poly_count = 0;
        return Ok(());
    }

    // Triangulate buffered polygons in parallel.
    // Note: We intentionally treat each boundary independently (no hole reconstruction).
    // GDSII has no explicit "hole" primitive; hole semantics require boolean ops or upstream fracture.
    let parts: Vec<Vec<f32>> = builder
        .pending_coords
        .par_iter()
        .map(|coords| triangulate_coords_to_vertices(coords))
        .collect();

    let total_floats: usize = parts.iter().map(|v| v.len()).sum();
    if total_floats == 0 {
        builder.chunk_index += 1;
        builder.poly_count = 0;
        builder.pending_coords.clear();
        return Ok(());
    }

    let vertex_count: u32 = (total_floats / 2) as u32;
    let mut payload = Vec::with_capacity(4 + total_floats * 4);
    payload.extend_from_slice(&vertex_count.to_le_bytes());
    for v in parts.iter().flat_map(|v| v.iter()) {
        payload.extend_from_slice(&v.to_le_bytes());
    }

    transport.send(kind, layer_key, cell_name, builder.chunk_index, 0, &payload)?;

    builder.chunk_index += 1;
    builder.poly_count = 0;
    builder.pending_coords.clear();
    Ok(())
}

pub fn flush_all_triangle_builders(
    builders: &mut HashMap<String, TriChunkBuilder>,
    args: &Args,
    transport: &mut dyn ChunkTransport,
    kind: WsChunkKind,
    cell_name: Option<&str>,
) -> Result<()> {
    for (layer_key, builder) in builders.iter_mut() {
        flush_triangle_builder(layer_key, builder, args, transport, kind, cell_name)?;
    }
    Ok(())
}
