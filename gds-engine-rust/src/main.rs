mod gds_parser;
mod geometry;
mod gds_loader;
mod oasis_loader;
mod oasis_parser;
mod streamer;
mod analysis;

use clap::Parser;
use std::collections::{HashMap, HashSet};
use std::collections::hash_map::DefaultHasher;
use std::fs::File;
use std::hash::{Hash, Hasher};
use std::io::{BufRead, Read, Seek, Write};
use std::path::Path;
use std::sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}};
use std::thread;
use std::time::Instant;
use crate::geometry::{Library, Cell, Matrix3x3, Point, Polygon};
use crate::streamer::{ChunkMsg, send_binary_chunk, send_json};
use crate::analysis::SearchEngine;
use anyhow::Result;
use rayon::prelude::*;
use std::net::TcpStream;

#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
struct Args {
    #[arg(help = "Input layout file path (GDSII or OASIS)")]
    input: String,

    #[arg(help = "Output directory (for compatibility)")]
    output_dir: String,

    #[arg(default_value = "", help = "Target cell name")]
    cell_name: String,

    #[arg(default_value = "2000", help = "Chunk size")]
    chunk_size: usize,

    #[arg(default_value = "5", help = "Flow control step")]
    flow_control_step: usize,

    #[arg(default_value = "0", help = "Use instancing (1 for true)")]
    use_instancing: i32,

    #[arg(long, help = "Negative mode (for SVG)")]
    negative: bool,

    #[arg(long, help = "TCP port (127.0.0.1) for binary geometry streaming to the VS Code extension. If set, binary chunks are streamed over TCP instead of stdout base64")]
    tcp_port: Option<u16>,

    #[arg(long, default_value = "polygons", value_parser = ["polygons", "triangles"], help = "Geometry payload mode for non-instance polygons")]
    geom_mode: String,

    #[arg(long, default_value_t = false, help = "(WebGL+Rust+Instancing) Enable viewport-driven streaming. The engine will stream definitions once, then only send instances/flat geometry for the current viewport on request.")]
    viewport_streaming: bool,
}

fn main() -> Result<()> {
    let args = Args::parse();

    let mut tcp_stream: Option<TcpStream> = match args.tcp_port {
        Some(port) => {
            let stream = TcpStream::connect(("127.0.0.1", port))?;
            stream.set_nodelay(true).ok();
            Some(stream)
        }
        None => None,
    };

    // Decide format (GDS vs OASIS) in the entrypoint so loader stays format-specific.
    let mut file = File::open(&args.input)?;

    let mut magic = [0u8; 12];
    let is_oasis = file.read_exact(&mut magic).map(|_| &magic[..11] == b"%SEMI-OASIS").unwrap_or(false);
    file.rewind()?;

    let ext_is_oasis = Path::new(&args.input)
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.eq_ignore_ascii_case("oas") || s.eq_ignore_ascii_case("oasis"))
        .unwrap_or(false);

    let mut library = if is_oasis || ext_is_oasis {
        oasis_loader::load_oasis(file)?
    } else {
        gds_loader::load_gds(file)?
    };

    // Extract ports from $$$CONTEXT_INFO$$$ if it exists
    let mut context_ports = Vec::new();
    if let Some(pos) = library.cells.iter().position(|c| c.name == "$$$CONTEXT_INFO$$$") {
        context_ports = library.cells[pos].ports.clone();
    }

    // Filter out metadata cells starting with "$$$" immediately
    library.cells.retain(|c| !c.name.starts_with("$$$"));

    if library.cells.is_empty() {
        return Err(anyhow::anyhow!("No cells found in GDS file"));
    }

    // 1. Find target cell
    let main_cell_name = if args.cell_name.is_empty() {
        let top_level = find_top_level_cells(&library);
        top_level.get(0).unwrap_or(&library.cells[0].name).clone()
    } else {
        args.cell_name.clone()
    };

    // Add ports to main cell
    if !context_ports.is_empty() {
        if let Some(cell) = library.cells.iter_mut().find(|c| c.name == main_cell_name) {
            cell.ports.extend(context_ports);
        }
    }

    let main_cell = library.cells.iter().find(|c| c.name == main_cell_name)
        .ok_or_else(|| anyhow::anyhow!("Cell '{}' not found", main_cell_name))?;

    // 2. Metadata
    let mut all_cell_names: Vec<String> = library.cells.iter()
        .map(|c| c.name.clone())
        .collect();
    all_cell_names.sort();
    let top_level_cells = find_top_level_cells(&library);

    let mut hierarchy: HashMap<String, Vec<String>> = HashMap::new();
    for cell in &library.cells {
        let mut deps: HashSet<String> = HashSet::new();
        for re in &cell.references {
            deps.insert(re.cell_name.clone());
        }
        let mut sorted_deps: Vec<String> = deps.into_iter().collect();
        sorted_deps.sort();
        hierarchy.insert(cell.name.clone(), sorted_deps);
    }

    let mut metadata = serde_json::json!({
        "cell_name": main_cell.name,
        "all_cells": all_cell_names,
        "top_level_cells": top_level_cells,
        "hierarchy": hierarchy,
        "layers": [],
        "bbox": { "x_min": 0, "x_max": 0, "y_min": 0, "y_max": 0 },
        "isInstanced": args.use_instancing != 0
    });

    // Wrap library in Arc for sharing with search thread
    let library = Arc::new(library);
    let main_cell = library.cells.iter().find(|c| c.name == main_cell_name)
        .ok_or_else(|| anyhow::anyhow!("Cell '{}' not found", main_cell_name))?;

    let mut instances_map = HashMap::new();
    let mut instances_by_name_opt = Some(analyze_instances(&library, main_cell, &mut instances_map));

    if args.geom_mode == "triangles" && tcp_stream.is_none() {
        return Err(anyhow::anyhow!("--geom-mode triangles requires --tcp-port"));
    }

    // Optional mode: stream only what the viewport needs (plus cached definitions).
    // This is designed to keep the webview memory bounded for huge hierarchical layouts.
    let mut viewport_runtime: Option<ViewportRuntime> = None;

    if args.viewport_streaming {
        if args.use_instancing == 0 {
            send_json(&serde_json::json!({
                "command": "status",
                "message": "Viewport streaming requires WebGL instancing; falling back to full streaming"
            }));
        } else {
            let tcp_ref = tcp_stream.as_mut().ok_or_else(|| anyhow::anyhow!("--viewport-streaming requires --tcp-port"))?;
            // IMPORTANT: In viewport-streaming mode, stdin carries JSON commands (viewport/find/etc).
            // The legacy flow-control mechanism reads from stdin inside `send()`, which can
            // accidentally consume those JSON commands and make the first viewport request disappear.
            // Disable stdin-based flow control for TCP streaming in this mode.
            let mut transport = TcpTransport { stream: tcp_ref, flow_control_step: 0 };
            let instances_by_name = instances_by_name_opt.take().ok_or_else(|| anyhow::anyhow!("instances already consumed"))?;
            let rt = process_instanced_viewport_preamble(&library, main_cell, &args, &mut metadata, instances_by_name, &mut transport)?;
            viewport_runtime = Some(rt);
        }
    }

    if viewport_runtime.is_none() {
        if args.use_instancing != 0 {
            let instances_by_name = instances_by_name_opt.take().ok_or_else(|| anyhow::anyhow!("instances already consumed"))?;
            process_instanced(&library, main_cell, &args, &mut metadata, instances_by_name, tcp_stream.as_mut())?;
        } else {
            process_flattened(&library, main_cell, &args, &mut metadata, tcp_stream.as_mut())?;
        }
    }

    // Stream Ports
    if !main_cell.ports.is_empty() {
        send_json(&serde_json::json!({
            "type": "ports",
            "ports": main_cell.ports
        }));
    }

    // Signal that initial loading is complete
    send_json(&serde_json::json!({
        "command": "done"
    }));

    // Start search engine in background thread
    let search_engine = Arc::new(Mutex::new(None));
    let search_engine_clone = search_engine.clone();
    let library_clone = library.clone();

    thread::spawn(move || {
        let engine = SearchEngine::new(library_clone, instances_map);
        *search_engine_clone.lock().unwrap() = Some(engine);
    });

    let current_search_cancel: Arc<Mutex<Option<Arc<AtomicBool>>>> = Arc::new(Mutex::new(None));

    // Start interactive loop for search
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() { continue; }

        if let Ok(cmd) = serde_json::from_str::<serde_json::Value>(&line) {
            if cmd["command"] == "find" {
                let x = cmd["x"].as_f64().unwrap_or(0.0);
                let y = cmd["y"].as_f64().unwrap_or(0.0);
                let max_steps = cmd["maxSteps"].as_u64().unwrap_or(5000) as usize;
                let max_workers = cmd["maxWorkers"].as_i64().unwrap_or(-1);
                let layers_val = cmd["layers"].as_array();

                let mut active_layers = HashSet::new();
                if let Some(layers) = layers_val {
                    for l in layers {
                        if let Some(s) = l.as_str() {
                            let parts: Vec<&str> = s.split('_').collect();
                            if parts.len() == 2 {
                                if let (Ok(l), Ok(d)) = (parts[0].parse::<i16>(), parts[1].parse::<i16>()) {
                                    active_layers.insert((l, d));
                                }
                            }
                        }
                    }
                }

                // Cancel previous search
                let new_cancel_flag = Arc::new(AtomicBool::new(false));
                {
                    let mut cancel_guard = current_search_cancel.lock().unwrap();
                    if let Some(flag) = &*cancel_guard {
                        flag.store(true, Ordering::Relaxed);
                    }
                    *cancel_guard = Some(new_cancel_flag.clone());
                }

                let search_engine = search_engine.clone();
                let cancel_flag = new_cancel_flag;

                thread::spawn(move || {
                    let engine_guard = search_engine.lock().unwrap();
                    if let Some(engine) = &*engine_guard {
                        if cancel_flag.load(Ordering::Relaxed) { return; }

                        let start_time = Instant::now();
                        let run_search = || {
                             engine.find(x, y, &active_layers, max_steps, Some(cancel_flag.clone()))
                        };

                        let (polys, limit_reached) = if max_workers > 0 {
                             if let Ok(pool) = rayon::ThreadPoolBuilder::new().num_threads(max_workers as usize).build() {
                                 pool.install(run_search)
                             } else {
                                 run_search()
                             }
                        } else {
                             run_search()
                        };

                        let duration = start_time.elapsed().as_millis();

                        if !cancel_flag.load(Ordering::Relaxed) {
                            let simple_polys: Vec<Vec<[f64; 2]>> = polys.iter().map(|p| {
                                p.points.iter().map(|pt| [pt.x, pt.y]).collect()
                            }).collect();

                            send_json(&serde_json::json!({
                                "command": "found",
                                "polygons": simple_polys,
                                "limitReached": limit_reached,
                                "duration": duration
                            }));
                        }
                    } else {
                        send_json(&serde_json::json!({
                            "command": "status",
                            "message": "Search engine initializing..."
                        }));
                    }
                });
            } else if cmd["command"] == "stop" {
                let mut cancel_guard = current_search_cancel.lock().unwrap();
                if let Some(flag) = &*cancel_guard {
                    flag.store(true, Ordering::Relaxed);
                }
                send_json(&serde_json::json!({
                    "command": "status",
                    "message": "Search stopped"
                }));
            } else if cmd["command"] == "viewport" {
                if let Some(rt) = viewport_runtime.as_mut() {
                    let req_id = cmd["requestId"].as_u64().unwrap_or(0) as u32;
                    let bbox = &cmd["bbox"];
                    let vminx = bbox["minX"].as_f64().unwrap_or(0.0);
                    let vmaxx = bbox["maxX"].as_f64().unwrap_or(0.0);
                    let vminy = bbox["minY"].as_f64().unwrap_or(0.0);
                    let vmaxy = bbox["maxY"].as_f64().unwrap_or(0.0);

                    let layers_val = cmd["layers"].as_array();
                    let mut active_layers: HashSet<(i16, i16)> = HashSet::new();
                    if let Some(layers) = layers_val {
                        for l in layers {
                            if let Some(s) = l.as_str() {
                                let parts: Vec<&str> = s.split('_').collect();
                                if parts.len() == 2 {
                                    if let (Ok(la), Ok(dt)) = (parts[0].parse::<i16>(), parts[1].parse::<i16>()) {
                                        active_layers.insert((la, dt));
                                    }
                                }
                            }
                        }
                    }

                    let tcp_ref = tcp_stream.as_mut().ok_or_else(|| anyhow::anyhow!("tcp required"))?;
                    // Keep stdin free for JSON commands; avoid consuming them in transport flow control.
                    let mut transport = TcpTransport { stream: tcp_ref, flow_control_step: 0 };
                    stream_viewport_geometry(&library, rt, &args, &mut transport, req_id, (vminx, vmaxx, vminy, vmaxy), &active_layers)?;
                }
            }
        }
    }

    Ok(())
}

fn find_top_level_cells(lib: &Library) -> Vec<String> {
    let mut referenced = HashSet::new();
    for cell in &lib.cells {
        for ref_el in &cell.references {
            referenced.insert(ref_el.cell_name.clone());
        }
    }
    let mut top = Vec::new();
    for cell in &lib.cells {
        if !referenced.contains(&cell.name) {
            top.push(cell.name.clone());
        }
    }
    top.sort();
    top
}

fn sort_layer_keys(keys: &mut Vec<String>) {
    keys.sort_by(|a, b| {
        let parse = |s: &str| -> (i16, i16) {
            let parts: Vec<&str> = s.split('_').collect();
            if parts.len() == 2 {
                (parts[0].parse().unwrap_or(0), parts[1].parse().unwrap_or(0))
            } else {
                (0, 0)
            }
        };
        parse(a).cmp(&parse(b))
    });
}

fn process_flattened(
    lib: &Library,
    main_cell: &Cell,
    args: &Args,
    metadata: &mut serde_json::Value,
    mut tcp: Option<&mut TcpStream>,
) -> Result<()> {
    let mut labels_by_layer: HashMap<String, Vec<serde_json::Value>> = HashMap::new();
    let mut layer_keys_set: HashSet<String> = HashSet::new();
    let mut bbox = (f64::MAX, f64::MIN, f64::MAX, f64::MIN);

    scan_recursive_flat(
        lib,
        main_cell,
        &Matrix3x3::identity(),
        &mut bbox,
        &mut layer_keys_set,
        &mut labels_by_layer,
    );

    if bbox.0 == f64::MAX {
        bbox = (0.0, 0.0, 0.0, 0.0);
    }

    let mut layer_keys: Vec<String> = layer_keys_set.into_iter().collect();
    sort_layer_keys(&mut layer_keys);

    metadata["layers"] = serde_json::json!(layer_keys);
    metadata["bbox"] = serde_json::json!({
        "x_min": bbox.0, "x_max": bbox.1, "y_min": bbox.2, "y_max": bbox.3
    });

    send_json(metadata);

    for (layer_key, lbls) in labels_by_layer {
        send_json(&serde_json::json!({ "layerKey": layer_key, "labels": lbls }));
    }

    match args.geom_mode.as_str() {
        "polygons" => {
            let mut builders: HashMap<String, PolyChunkBuilder> = HashMap::new();
            if let Some(tcp_ref) = tcp.as_deref_mut() {
                // IMPORTANT: When streaming over TCP (--tcp-port), stdin is reserved for JSON commands.
                // The legacy flow-control mechanism reads from stdin inside `send()`, which can
                // accidentally consume those JSON commands. Disable stdin-based flow control.
                let mut transport = TcpTransport { stream: tcp_ref, flow_control_step: 0 };
                stream_recursive_polygons(lib, main_cell, &Matrix3x3::identity(), &mut builders, args, &mut transport, WsChunkKind::FlatPolygons, None)?;
                flush_all_polygon_builders(&mut builders, args, &mut transport, WsChunkKind::FlatPolygons, None)?;
            } else {
                let mut transport = StdoutTransport { flow_control_step: args.flow_control_step };
                stream_recursive_polygons(lib, main_cell, &Matrix3x3::identity(), &mut builders, args, &mut transport, WsChunkKind::FlatPolygons, None)?;
                flush_all_polygon_builders(&mut builders, args, &mut transport, WsChunkKind::FlatPolygons, None)?;
            }
        }
        "triangles" => {
            let mut builders: HashMap<String, TriChunkBuilder> = HashMap::new();
            let tcp_ref = tcp.as_deref_mut().ok_or_else(|| anyhow::anyhow!("tcp required"))?;
            let mut transport = TcpTransport { stream: tcp_ref, flow_control_step: 0 };
            stream_recursive_triangles(lib, main_cell, &Matrix3x3::identity(), &mut builders, args, &mut transport, WsChunkKind::FlatTriangles, None)?;
            flush_all_triangle_builders(&mut builders, args, &mut transport, WsChunkKind::FlatTriangles, None)?;
        }
        other => return Err(anyhow::anyhow!("Unknown geom_mode: {other}")),
    }

    Ok(())
}

fn flatten_recursive(
    lib: &Library,
    cell: &Cell,
    transform: &Matrix3x3,
    out_polys: &mut HashMap<String, Vec<Polygon>>,
    out_labels: &mut HashMap<String, Vec<serde_json::Value>>,
    bbox: &mut (f64, f64, f64, f64)
) {
    for poly in &cell.polygons {
        let key = format!("{}_{}", poly.layer, poly.datatype);
        let mut new_points = Vec::new();
        for p in &poly.points {
            let pt = transform.transform_point(p);
            new_points.push(pt.clone());
            if pt.x < bbox.0 { bbox.0 = pt.x; }
            if pt.x > bbox.1 { bbox.1 = pt.x; }
            if pt.y < bbox.2 { bbox.2 = pt.y; }
            if pt.y > bbox.3 { bbox.3 = pt.y; }
        }
        out_polys.entry(key).or_default().push(Polygon {
            layer: poly.layer, datatype: poly.datatype, points: new_points,
        });
    }

    for label in &cell.labels {
        let key = format!("{}_{}", label.layer, label.texttype);
        let pt = transform.transform_point(&Point { x: label.x, y: label.y });
        out_labels.entry(key).or_default().push(serde_json::json!({
            "text": label.text, "x": pt.x, "y": pt.y, "rotation": label.rotation, "magnification": label.magnification, "anchor": label.anchor
        }));
    }

    for re in &cell.references {
        if let Some(ref_cell) = lib.cells.iter().find(|c| c.name == re.cell_name) {
            for col in 0..re.columns {
                for row in 0..re.rows {
                    let mut origin = re.origin.clone();
                    origin.x += (col as f64 * re.col_spacing.x) + (row as f64 * re.row_spacing.x);
                    origin.y += (col as f64 * re.col_spacing.y) + (row as f64 * re.row_spacing.y);

                    let local_transform = Matrix3x3::from_transform(
                        re.rotation.unwrap_or(0.0), re.magnification.unwrap_or(1.0), re.x_reflection, &origin
                    );
                    let combined = transform.multiply(&local_transform);
                    flatten_recursive(lib, ref_cell, &combined, out_polys, out_labels, bbox);
                }
            }
        }
    }
}

struct PolyChunkBuilder {
    chunk_index: u32,
    poly_count: u32,
    buffer: Vec<u8>,
}

impl PolyChunkBuilder {
    fn new() -> Self {
        Self {
            chunk_index: 0,
            poly_count: 0,
            buffer: Vec::new(),
        }
    }

    fn ensure_chunk_started(&mut self) {
        if self.buffer.is_empty() {
            self.buffer.extend_from_slice(&0u32.to_le_bytes());
            self.poly_count = 0;
        }
    }
}

struct TriChunkBuilder {
    chunk_index: u32,
    poly_count: u32,
    pending_coords: Vec<Vec<f64>>,
}

impl TriChunkBuilder {
    fn new() -> Self {
        Self {
            chunk_index: 0,
            poly_count: 0,
            pending_coords: Vec::new(),
        }
    }
}

#[derive(Clone, Copy, Debug)]
#[repr(u8)]
enum WsChunkKind {
    FlatTriangles = 1,
    DefinitionTriangles = 2,
    Instances = 3,
    FlatPolygons = 4,
    Control = 5,
}

#[derive(Clone, Debug)]
struct ViewportRuntime {
    single_instances: HashMap<String, Vec<Matrix3x3>>,
    multi_instances: HashMap<String, Vec<Matrix3x3>>,
    cell_bbox_local: HashMap<String, (f64, f64, f64, f64)>,
    cell_max_radius: HashMap<String, f64>,
    last_fingerprint: Option<u64>,
}

fn hash_matrix_f32(hasher: &mut DefaultHasher, t: &Matrix3x3) {
    for col in 0..3 {
        for row in 0..3 {
            let v = t.m[row][col] as f32;
            hasher.write_u32(v.to_bits());
        }
    }
}

fn viewport_selection_fingerprint(
    rt: &ViewportRuntime,
    view: (f64, f64, f64, f64),
    active_layers: &HashSet<(i16, i16)>,
) -> u64 {
    // Stable fingerprint for "what would be sent" for this viewport request.
    // Note: HashMap iteration order is nondeterministic, so we sort keys.
    let mut hasher = DefaultHasher::new();

    // Version marker to allow future changes without accidental collisions.
    1u8.hash(&mut hasher);

    // Layer filter affects which triangles we would stream (single-instance path).
    if active_layers.is_empty() {
        0u8.hash(&mut hasher);
    } else {
        1u8.hash(&mut hasher);
        let mut layers: Vec<(i16, i16)> = active_layers.iter().copied().collect();
        layers.sort_unstable();
        layers.hash(&mut hasher);
    }

    // Single-instance selection.
    let mut single_keys: Vec<&String> = rt.single_instances.keys().collect();
    single_keys.sort_unstable();
    for cell_name in single_keys {
        let transforms = match rt.single_instances.get(cell_name) {
            Some(t) => t,
            None => continue,
        };
        let local_bbox = *rt.cell_bbox_local.get(cell_name).unwrap_or(&(0.0, 0.0, 0.0, 0.0));
        for t in transforms {
            let tb = transform_bbox(t, local_bbox);
            if !bbox_intersects(tb, view) {
                continue;
            }
            // Tag + identity + transform.
            1u8.hash(&mut hasher);
            cell_name.hash(&mut hasher);
            hash_matrix_f32(&mut hasher, t);
        }
    }

    // Multi-instance selection.
    let mut multi_keys: Vec<&String> = rt.multi_instances.keys().collect();
    multi_keys.sort_unstable();
    for cell_name in multi_keys {
        let transforms = match rt.multi_instances.get(cell_name) {
            Some(t) => t,
            None => continue,
        };
        let radius = *rt.cell_max_radius.get(cell_name).unwrap_or(&1e9);
        for t in transforms.iter() {
            let tx = t.m[0][2];
            let ty = t.m[1][2];
            if tx + radius < view.0 || tx - radius > view.1 || ty + radius < view.2 || ty - radius > view.3 {
                continue;
            }
            2u8.hash(&mut hasher);
            cell_name.hash(&mut hasher);
            hash_matrix_f32(&mut hasher, t);
        }
    }

    hasher.finish()
}

fn cell_local_bbox(cell: &Cell) -> (f64, f64, f64, f64) {
    let mut bbox = (f64::MAX, f64::MIN, f64::MAX, f64::MIN);
    for poly in &cell.polygons {
        for p in &poly.points {
            if p.x < bbox.0 { bbox.0 = p.x; }
            if p.x > bbox.1 { bbox.1 = p.x; }
            if p.y < bbox.2 { bbox.2 = p.y; }
            if p.y > bbox.3 { bbox.3 = p.y; }
        }
    }
    if bbox.0 == f64::MAX {
        (0.0, 0.0, 0.0, 0.0)
    } else {
        bbox
    }
}

fn bbox_max_radius(b: (f64, f64, f64, f64)) -> f64 {
    let (minx, maxx, miny, maxy) = b;
    let d1 = minx * minx + miny * miny;
    let d2 = maxx * maxx + miny * miny;
    let d3 = maxx * maxx + maxy * maxy;
    let d4 = minx * minx + maxy * maxy;
    (d1.max(d2).max(d3).max(d4)).sqrt()
}

fn bbox_intersects(a: (f64, f64, f64, f64), b: (f64, f64, f64, f64)) -> bool {
    let (aminx, amaxx, aminy, amaxy) = a;
    let (bminx, bmaxx, bminy, bmaxy) = b;
    !(amaxx < bminx || aminx > bmaxx || amaxy < bminy || aminy > bmaxy)
}

fn transform_bbox(t: &Matrix3x3, b: (f64, f64, f64, f64)) -> (f64, f64, f64, f64) {
    let (minx, maxx, miny, maxy) = b;
    let corners = [
        Point { x: minx, y: miny },
        Point { x: maxx, y: miny },
        Point { x: maxx, y: maxy },
        Point { x: minx, y: maxy },
    ];
    let mut out = (f64::MAX, f64::MIN, f64::MAX, f64::MIN);
    for c in corners.iter() {
        let p = t.transform_point(c);
        if p.x < out.0 { out.0 = p.x; }
        if p.x > out.1 { out.1 = p.x; }
        if p.y < out.2 { out.2 = p.y; }
        if p.y > out.3 { out.3 = p.y; }
    }
    if out.0 == f64::MAX { (0.0, 0.0, 0.0, 0.0) } else { out }
}

fn send_control(transport: &mut dyn ChunkTransport, opcode: u8, request_id: u32) -> Result<()> {
    let mut payload = Vec::with_capacity(1 + 4);
    payload.push(opcode);
    payload.extend_from_slice(&request_id.to_le_bytes());
    transport.send(WsChunkKind::Control, "", None, 0, 0, &payload)
}

fn process_instanced_viewport_preamble(
    lib: &Library,
    main_cell: &Cell,
    args: &Args,
    metadata: &mut serde_json::Value,
    instances: HashMap<String, Vec<Matrix3x3>>,
    transport: &mut dyn ChunkTransport,
) -> Result<ViewportRuntime> {
    // Split into multi (instanced) and single (flat)
    let mut multi_instances: HashMap<String, Vec<Matrix3x3>> = HashMap::new();
    let mut single_instances: HashMap<String, Vec<Matrix3x3>> = HashMap::new();

    for (name, trans) in instances.iter() {
        if trans.len() > 1 || *name == main_cell.name {
            multi_instances.insert(name.clone(), trans.clone());
        } else {
            single_instances.insert(name.clone(), trans.clone());
        }
    }

    // Global bbox + layer list + labels are the same as normal instanced mode.
    let mut bbox = (f64::MAX, f64::MIN, f64::MAX, f64::MIN);
    scan_recursive_bbox(lib, main_cell, &Matrix3x3::identity(), &mut bbox);
    if bbox.0 == f64::MAX { bbox = (0.0, 0.0, 0.0, 0.0); }

    let mut all_layers: HashSet<String> = HashSet::new();
    for cell_name in single_instances.keys() {
        if let Some(cell) = lib.cells.iter().find(|c| c.name == *cell_name) {
            for p in &cell.polygons {
                all_layers.insert(format!("{}_{}", p.layer, p.datatype));
            }
        }
    }
    for cell_name in multi_instances.keys() {
        if let Some(cell) = lib.cells.iter().find(|c| c.name == *cell_name) {
            for p in &cell.polygons {
                all_layers.insert(format!("{}_{}", p.layer, p.datatype));
            }
            for l in &cell.labels {
                all_layers.insert(format!("{}_{}", l.layer, l.texttype));
            }
        }
    }
    for cell_name in instances.keys() {
        if let Some(cell) = lib.cells.iter().find(|c| c.name == *cell_name) {
            for l in &cell.labels {
                all_layers.insert(format!("{}_{}", l.layer, l.texttype));
            }
        }
    }

    let mut layer_keys: Vec<String> = all_layers.into_iter().collect();
    sort_layer_keys(&mut layer_keys);

    metadata["layers"] = serde_json::json!(layer_keys);
    metadata["bbox"] = serde_json::json!({
        "x_min": bbox.0, "x_max": bbox.1, "y_min": bbox.2, "y_max": bbox.3
    });
    send_json(metadata);

    // Labels (aggregated by layer)
    let mut labels_by_layer: HashMap<String, Vec<serde_json::Value>> = HashMap::new();
    for (cell_name, cell_instances) in &instances {
        if let Some(cell) = lib.cells.iter().find(|c| c.name == *cell_name) {
            for label in &cell.labels {
                let key = format!("{}_{}", label.layer, label.texttype);
                for t in cell_instances {
                    let pt = t.transform_point(&Point { x: label.x, y: label.y });
                    labels_by_layer.entry(key.clone()).or_default().push(serde_json::json!({
                        "text": label.text, "x": pt.x, "y": pt.y, "rotation": label.rotation, "magnification": label.magnification, "anchor": label.anchor
                    }));
                }
            }
        }
    }
    for (layer_key, lbls) in labels_by_layer {
        send_json(&serde_json::json!({ "layerKey": layer_key, "labels": lbls }));
    }

    // Stream Definitions (multi instances) once.
    match args.geom_mode.as_str() {
        "triangles" => {
            for (cell_name, _transforms) in multi_instances.iter() {
                let mut builders: HashMap<String, TriChunkBuilder> = HashMap::new();
                if let Some(cell) = lib.cells.iter().find(|c| c.name == *cell_name) {
                    for poly in &cell.polygons {
                        let key = format!("{}_{}", poly.layer, poly.datatype);
                        push_triangles_transformed(&key, poly, &Matrix3x3::identity(), &mut builders, args, transport, WsChunkKind::DefinitionTriangles, Some(cell_name.as_str()))?;
                    }
                }
                flush_all_triangle_builders(&mut builders, args, transport, WsChunkKind::DefinitionTriangles, Some(cell_name.as_str()))?;
            }
        }
        other => return Err(anyhow::anyhow!("viewport streaming requires --geom-mode triangles (got {other})")),
    }

    // Precompute local bboxes + radii for instance culling.
    let mut cell_bbox_local: HashMap<String, (f64, f64, f64, f64)> = HashMap::new();
    let mut cell_max_radius: HashMap<String, f64> = HashMap::new();
    for cell_name in instances.keys() {
        if let Some(cell) = lib.cells.iter().find(|c| c.name == *cell_name) {
            let b = cell_local_bbox(cell);
            cell_bbox_local.insert(cell_name.clone(), b);
            cell_max_radius.insert(cell_name.clone(), bbox_max_radius(b));
        }
    }

    Ok(ViewportRuntime { single_instances, multi_instances, cell_bbox_local, cell_max_radius, last_fingerprint: None })
}

fn stream_viewport_geometry(
    lib: &Library,
    rt: &mut ViewportRuntime,
    args: &Args,
    transport: &mut dyn ChunkTransport,
    request_id: u32,
    view: (f64, f64, f64, f64),
    active_layers: &HashSet<(i16, i16)>,
) -> Result<()> {
    // Compute "what would be sent" fingerprint. If unchanged, skip sending anything.
    // This reduces redundant retransmits during small pans/zooms.
    let fp = viewport_selection_fingerprint(rt, view, active_layers);
    if rt.last_fingerprint == Some(fp) {
        return Ok(());
    }
    rt.last_fingerprint = Some(fp);

    // Begin snapshot
    send_control(transport, 1, request_id)?;

    // Single-instance cells: stream flattened triangles only if their transformed bbox intersects view.
    let mut tri_builders: HashMap<String, TriChunkBuilder> = HashMap::new();
    let mut single_keys: Vec<&String> = rt.single_instances.keys().collect();
    single_keys.sort_unstable();
    for cell_name in single_keys {
        let transforms = match rt.single_instances.get(cell_name) {
            Some(t) => t,
            None => continue,
        };
        let cell = match lib.cells.iter().find(|c| c.name == *cell_name) {
            Some(c) => c,
            None => continue,
        };
        let local_bbox = *rt.cell_bbox_local.get(cell_name).unwrap_or(&(0.0, 0.0, 0.0, 0.0));
        for t in transforms {
            let tb = transform_bbox(t, local_bbox);
            if !bbox_intersects(tb, view) {
                continue;
            }
            for poly in &cell.polygons {
                if !active_layers.is_empty() && !active_layers.contains(&(poly.layer, poly.datatype)) {
                    continue;
                }
                let key = format!("{}_{}", poly.layer, poly.datatype);
                push_triangles_transformed(&key, poly, t, &mut tri_builders, args, transport, WsChunkKind::FlatTriangles, None)?;
            }
        }
    }
    flush_all_triangle_builders(&mut tri_builders, args, transport, WsChunkKind::FlatTriangles, None)?;

    // Multi-instance cells: stream only instance transforms that could overlap view (translation +/- radius).
    let mut multi_keys: Vec<&String> = rt.multi_instances.keys().collect();
    multi_keys.sort_unstable();
    for cell_name in multi_keys {
        let transforms = match rt.multi_instances.get(cell_name) {
            Some(t) => t,
            None => continue,
        };
        let radius = *rt.cell_max_radius.get(cell_name).unwrap_or(&1e9);

        let mut filtered: Vec<&Matrix3x3> = Vec::new();
        for t in transforms.iter() {
            let tx = t.m[0][2];
            let ty = t.m[1][2];
            if tx + radius < view.0 || tx - radius > view.1 || ty + radius < view.2 || ty - radius > view.3 {
                continue;
            }
            filtered.push(t);
        }

        if filtered.is_empty() {
            continue;
        }

        let total_chunks = (filtered.len() + args.chunk_size - 1) / args.chunk_size;
        for (i, chunk) in filtered.chunks(args.chunk_size).enumerate() {
            let mut buffer = Vec::new();
            buffer.extend_from_slice(&(chunk.len() as u32).to_le_bytes());
            for t in chunk {
                for col in 0..3 {
                    for row in 0..3 {
                        buffer.extend_from_slice(&(t.m[row][col] as f32).to_le_bytes());
                    }
                }
            }
            transport.send(WsChunkKind::Instances, "", Some(cell_name.as_str()), i as u32, total_chunks as u32, &buffer)?;
        }
    }

    // End snapshot
    send_control(transport, 2, request_id)?;
    Ok(())
}

trait ChunkTransport {
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

struct TcpTransport<'a> {
    stream: &'a mut TcpStream,
    flow_control_step: usize,
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

        // TCP is length-prefixed to allow reassembly in Node.
        let len = frame.len() as u32;
        self.stream.write_all(&len.to_le_bytes())?;
        self.stream.write_all(&frame)?;
        self.stream.flush()?;

        if self.flow_control_step > 0 && ((chunk_index as usize + 1) % self.flow_control_step == 0) {
            let mut input = String::new();
            let _ = std::io::stdin().read_line(&mut input);
        }
        Ok(())
    }
}

struct StdoutTransport {
    flow_control_step: usize,
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
                if cell_name.is_some() { "definition" } else { "flat" }
            }
            WsChunkKind::Instances => "instance",
            WsChunkKind::FlatTriangles | WsChunkKind::DefinitionTriangles => {
                return Err(anyhow::anyhow!("Triangles require WebSocket transport"));
            }
            WsChunkKind::Control => {
                return Err(anyhow::anyhow!("Control frames require WebSocket transport"));
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

fn scan_recursive_bbox(lib: &Library, cell: &Cell, transform: &Matrix3x3, bbox: &mut (f64, f64, f64, f64)) {
    for poly in &cell.polygons {
        for p in &poly.points {
            let pt = transform.transform_point(p);
            if pt.x < bbox.0 { bbox.0 = pt.x; }
            if pt.x > bbox.1 { bbox.1 = pt.x; }
            if pt.y < bbox.2 { bbox.2 = pt.y; }
            if pt.y > bbox.3 { bbox.3 = pt.y; }
        }
    }

    for re in &cell.references {
        if let Some(ref_cell) = lib.cells.iter().find(|c| c.name == re.cell_name) {
            for col in 0..re.columns {
                for row in 0..re.rows {
                    let mut origin = re.origin.clone();
                    origin.x += (col as f64 * re.col_spacing.x) + (row as f64 * re.row_spacing.x);
                    origin.y += (col as f64 * re.col_spacing.y) + (row as f64 * re.row_spacing.y);
                    let local_transform = Matrix3x3::from_transform(
                        re.rotation.unwrap_or(0.0),
                        re.magnification.unwrap_or(1.0),
                        re.x_reflection,
                        &origin,
                    );
                    let combined = transform.multiply(&local_transform);
                    scan_recursive_bbox(lib, ref_cell, &combined, bbox);
                }
            }
        }
    }
}

fn scan_recursive_flat(
    lib: &Library,
    cell: &Cell,
    transform: &Matrix3x3,
    bbox: &mut (f64, f64, f64, f64),
    layer_keys: &mut HashSet<String>,
    labels_by_layer: &mut HashMap<String, Vec<serde_json::Value>>,
) {
    for poly in &cell.polygons {
        let key = format!("{}_{}", poly.layer, poly.datatype);
        layer_keys.insert(key);
        for p in &poly.points {
            let pt = transform.transform_point(p);
            if pt.x < bbox.0 { bbox.0 = pt.x; }
            if pt.x > bbox.1 { bbox.1 = pt.x; }
            if pt.y < bbox.2 { bbox.2 = pt.y; }
            if pt.y > bbox.3 { bbox.3 = pt.y; }
        }
    }

    for label in &cell.labels {
        let key = format!("{}_{}", label.layer, label.texttype);
        layer_keys.insert(key.clone());
        let pt = transform.transform_point(&Point { x: label.x, y: label.y });
        labels_by_layer.entry(key).or_default().push(serde_json::json!({
            "text": label.text,
            "x": pt.x,
            "y": pt.y,
            "rotation": label.rotation,
            "magnification": label.magnification,
            "anchor": label.anchor
        }));
    }

    for re in &cell.references {
        if let Some(ref_cell) = lib.cells.iter().find(|c| c.name == re.cell_name) {
            for col in 0..re.columns {
                for row in 0..re.rows {
                    let mut origin = re.origin.clone();
                    origin.x += (col as f64 * re.col_spacing.x) + (row as f64 * re.row_spacing.x);
                    origin.y += (col as f64 * re.col_spacing.y) + (row as f64 * re.row_spacing.y);
                    let local_transform = Matrix3x3::from_transform(
                        re.rotation.unwrap_or(0.0),
                        re.magnification.unwrap_or(1.0),
                        re.x_reflection,
                        &origin,
                    );
                    let combined = transform.multiply(&local_transform);
                    scan_recursive_flat(lib, ref_cell, &combined, bbox, layer_keys, labels_by_layer);
                }
            }
        }
    }
}

fn stream_recursive_polygons(
    lib: &Library,
    cell: &Cell,
    transform: &Matrix3x3,
    builders: &mut HashMap<String, PolyChunkBuilder>,
    args: &Args,
    transport: &mut dyn ChunkTransport,
    kind: WsChunkKind,
    cell_name: Option<&str>,
) -> Result<()> {
    for poly in &cell.polygons {
        let key = format!("{}_{}", poly.layer, poly.datatype);
        push_polygon_transformed(&key, poly, transform, builders, args, transport, kind, cell_name)?;
    }

    for re in &cell.references {
        if let Some(ref_cell) = lib.cells.iter().find(|c| c.name == re.cell_name) {
            for col in 0..re.columns {
                for row in 0..re.rows {
                    let mut origin = re.origin.clone();
                    origin.x += (col as f64 * re.col_spacing.x) + (row as f64 * re.row_spacing.x);
                    origin.y += (col as f64 * re.col_spacing.y) + (row as f64 * re.row_spacing.y);
                    let local_transform = Matrix3x3::from_transform(
                        re.rotation.unwrap_or(0.0),
                        re.magnification.unwrap_or(1.0),
                        re.x_reflection,
                        &origin,
                    );
                    let combined = transform.multiply(&local_transform);
                    stream_recursive_polygons(lib, ref_cell, &combined, builders, args, transport, kind, cell_name)?;
                }
            }
        }
    }
    Ok(())
}

fn stream_recursive_triangles(
    lib: &Library,
    cell: &Cell,
    transform: &Matrix3x3,
    builders: &mut HashMap<String, TriChunkBuilder>,
    args: &Args,
    transport: &mut dyn ChunkTransport,
    kind: WsChunkKind,
    cell_name: Option<&str>,
) -> Result<()> {
    for poly in &cell.polygons {
        let key = format!("{}_{}", poly.layer, poly.datatype);
        push_triangles_transformed(&key, poly, transform, builders, args, transport, kind, cell_name)?;
    }

    for re in &cell.references {
        if let Some(ref_cell) = lib.cells.iter().find(|c| c.name == re.cell_name) {
            for col in 0..re.columns {
                for row in 0..re.rows {
                    let mut origin = re.origin.clone();
                    origin.x += (col as f64 * re.col_spacing.x) + (row as f64 * re.row_spacing.x);
                    origin.y += (col as f64 * re.col_spacing.y) + (row as f64 * re.row_spacing.y);
                    let local_transform = Matrix3x3::from_transform(
                        re.rotation.unwrap_or(0.0),
                        re.magnification.unwrap_or(1.0),
                        re.x_reflection,
                        &origin,
                    );
                    let combined = transform.multiply(&local_transform);
                    stream_recursive_triangles(lib, ref_cell, &combined, builders, args, transport, kind, cell_name)?;
                }
            }
        }
    }
    Ok(())
}

fn push_polygon_transformed(
    layer_key: &str,
    poly: &Polygon,
    transform: &Matrix3x3,
    builders: &mut HashMap<String, PolyChunkBuilder>,
    args: &Args,
    transport: &mut dyn ChunkTransport,
    kind: WsChunkKind,
    cell_name: Option<&str>,
) -> Result<()> {
    let builder = builders.entry(layer_key.to_string()).or_insert_with(PolyChunkBuilder::new);
    builder.ensure_chunk_started();
    builder.poly_count += 1;

    builder.buffer.extend_from_slice(&(poly.points.len() as u32).to_le_bytes());
    for p in &poly.points {
        let pt = transform.transform_point(p);
        builder.buffer.extend_from_slice(&(pt.x as f32).to_le_bytes());
        builder.buffer.extend_from_slice(&(pt.y as f32).to_le_bytes());
    }

    if args.chunk_size > 0 && (builder.poly_count as usize) >= args.chunk_size {
        flush_polygon_builder(layer_key, builder, args, transport, kind, cell_name)?;
    }
    Ok(())
}

fn flush_polygon_builder(
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

    transport.send(kind, layer_key, cell_name, builder.chunk_index, 0, &builder.buffer)?;

    builder.chunk_index += 1;
    builder.poly_count = 0;
    builder.buffer.clear();
    Ok(())
}

fn flush_all_polygon_builders(
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

fn push_triangles_transformed(
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
    let builder = builders.entry(layer_key.to_string()).or_insert_with(TriChunkBuilder::new);
    builder.poly_count += 1;
    builder.pending_coords.push(coords);

    if args.chunk_size > 0 && (builder.poly_count as usize) >= args.chunk_size {
        flush_triangle_builder(layer_key, builder, args, transport, kind, cell_name)?;
    }
    Ok(())
}

fn triangulate_coords_to_vertices(coords: &[f64]) -> Vec<f32> {
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

fn flush_triangle_builder(
    layer_key: &str,
    builder: &mut TriChunkBuilder,
    args: &Args,
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

fn flush_all_triangle_builders(
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

fn analyze_instances(
    lib: &Library,
    main_cell: &Cell,
    out_instances_map: &mut HashMap<usize, Vec<Matrix3x3>>
) -> HashMap<String, Vec<Matrix3x3>> {
    let mut instances: HashMap<String, Vec<Matrix3x3>> = HashMap::new();
    let mut stack = vec![(main_cell.name.clone(), Matrix3x3::identity())];
    instances.insert(main_cell.name.clone(), vec![Matrix3x3::identity()]);

    while let Some((cell_name, current_transform)) = stack.pop() {
        if let Some(cell) = lib.cells.iter().find(|c| c.name == cell_name) {
            for re in &cell.references {
                for col in 0..re.columns {
                    for row in 0..re.rows {
                        let mut origin = re.origin.clone();
                        origin.x += (col as f64 * re.col_spacing.x) + (row as f64 * re.row_spacing.x);
                        origin.y += (col as f64 * re.col_spacing.y) + (row as f64 * re.row_spacing.y);

                        let local_t = Matrix3x3::from_transform(
                            re.rotation.unwrap_or(0.0), re.magnification.unwrap_or(1.0), re.x_reflection, &origin
                        );
                        let global_t = current_transform.multiply(&local_t);
                        instances.entry(re.cell_name.clone()).or_default().push(global_t.clone());
                        stack.push((re.cell_name.clone(), global_t));
                    }
                }
            }
        }
    }

    // Populate out_instances_map for SearchEngine
    for (name, transforms) in &instances {
        if let Some(idx) = lib.cells.iter().position(|c| c.name == *name) {
            out_instances_map.insert(idx, transforms.clone());
        }
    }

    instances
}

fn process_instanced(
    lib: &Library,
    main_cell: &Cell,
    args: &Args,
    metadata: &mut serde_json::Value,
    instances: HashMap<String, Vec<Matrix3x3>>,
    mut tcp: Option<&mut TcpStream>,
) -> Result<()> {
    // Split into multi (instanced) and single (flat)
    let mut multi_instances: HashMap<String, Vec<Matrix3x3>> = HashMap::new();
    let mut single_instances: HashMap<String, Vec<Matrix3x3>> = HashMap::new();

    for (name, trans) in instances.iter() {
        if trans.len() > 1 || *name == main_cell.name {
            multi_instances.insert(name.clone(), trans.clone());
        } else {
            single_instances.insert(name.clone(), trans.clone());
        }
    }

    // Calculate Global BBox (full recursive scan; no polygon vertex retention)
    let mut bbox = (f64::MAX, f64::MIN, f64::MAX, f64::MIN);
    scan_recursive_bbox(lib, main_cell, &Matrix3x3::identity(), &mut bbox);

    if bbox.0 == f64::MAX { bbox = (0.0, 0.0, 0.0, 0.0); }

    // Collect Layers (polygons + labels)
    let mut all_layers: HashSet<String> = HashSet::new();

    // Single instance polygon layers
    for cell_name in single_instances.keys() {
        if let Some(cell) = lib.cells.iter().find(|c| c.name == *cell_name) {
            for p in &cell.polygons {
                all_layers.insert(format!("{}_{}", p.layer, p.datatype));
            }
        }
    }

    // Multi-instance definition polygon layers
    for cell_name in multi_instances.keys() {
        if let Some(cell) = lib.cells.iter().find(|c| c.name == *cell_name) {
            for p in &cell.polygons {
                all_layers.insert(format!("{}_{}", p.layer, p.datatype));
            }
            for l in &cell.labels {
                all_layers.insert(format!("{}_{}", l.layer, l.texttype));
            }
        }
    }
    // Also include layers from labels in single instances (or all instances)
    for cell_name in instances.keys() {
         if let Some(cell) = lib.cells.iter().find(|c| c.name == *cell_name) {
             for l in &cell.labels {
                 all_layers.insert(format!("{}_{}", l.layer, l.texttype));
             }
         }
    }

    let mut layer_keys: Vec<String> = all_layers.into_iter().collect();
    sort_layer_keys(&mut layer_keys);

    metadata["layers"] = serde_json::json!(layer_keys);
    metadata["bbox"] = serde_json::json!({
        "x_min": bbox.0, "x_max": bbox.1, "y_min": bbox.2, "y_max": bbox.3
    });

    send_json(metadata);

    // Stream Single-Instance geometry (flattened)
    match args.geom_mode.as_str() {
        "polygons" => {
            let mut builders: HashMap<String, PolyChunkBuilder> = HashMap::new();
            if let Some(tcp_ref) = tcp.as_deref_mut() {
                // IMPORTANT: When streaming over TCP (--tcp-port), stdin is reserved for JSON commands.
                // Disable stdin-based flow control to avoid consuming those commands.
                let mut transport = TcpTransport { stream: tcp_ref, flow_control_step: 0 };
                for (cell_name, transforms) in &single_instances {
                    if let Some(cell) = lib.cells.iter().find(|c| c.name == *cell_name) {
                        for t in transforms {
                            for poly in &cell.polygons {
                                let key = format!("{}_{}", poly.layer, poly.datatype);
                                push_polygon_transformed(&key, poly, t, &mut builders, args, &mut transport, WsChunkKind::FlatPolygons, None)?;
                            }
                        }
                    }
                }
                flush_all_polygon_builders(&mut builders, args, &mut transport, WsChunkKind::FlatPolygons, None)?;
            } else {
                let mut transport = StdoutTransport { flow_control_step: args.flow_control_step };
                for (cell_name, transforms) in &single_instances {
                    if let Some(cell) = lib.cells.iter().find(|c| c.name == *cell_name) {
                        for t in transforms {
                            for poly in &cell.polygons {
                                let key = format!("{}_{}", poly.layer, poly.datatype);
                                push_polygon_transformed(&key, poly, t, &mut builders, args, &mut transport, WsChunkKind::FlatPolygons, None)?;
                            }
                        }
                    }
                }
                flush_all_polygon_builders(&mut builders, args, &mut transport, WsChunkKind::FlatPolygons, None)?;
            }
        }
        "triangles" => {
            let tcp_ref = tcp.as_deref_mut().ok_or_else(|| anyhow::anyhow!("tcp required"))?;
            let mut transport = TcpTransport { stream: tcp_ref, flow_control_step: 0 };
            let mut builders: HashMap<String, TriChunkBuilder> = HashMap::new();
            for (cell_name, transforms) in &single_instances {
                if let Some(cell) = lib.cells.iter().find(|c| c.name == *cell_name) {
                    for t in transforms {
                        for poly in &cell.polygons {
                            let key = format!("{}_{}", poly.layer, poly.datatype);
                            push_triangles_transformed(&key, poly, t, &mut builders, args, &mut transport, WsChunkKind::FlatTriangles, None)?;
                        }
                    }
                }
            }
            flush_all_triangle_builders(&mut builders, args, &mut transport, WsChunkKind::FlatTriangles, None)?;
        }
        other => return Err(anyhow::anyhow!("Unknown geom_mode: {other}")),
    }

    // Stream Labels (Aggregated by Layer)
    let mut labels_by_layer: HashMap<String, Vec<serde_json::Value>> = HashMap::new();
    for (cell_name, cell_instances) in &instances {
        if let Some(cell) = lib.cells.iter().find(|c| c.name == *cell_name) {
            for label in &cell.labels {
                let key = format!("{}_{}", label.layer, label.texttype);
                for t in cell_instances {
                    let pt = t.transform_point(&Point { x: label.x, y: label.y });
                    labels_by_layer.entry(key.clone()).or_default().push(serde_json::json!({
                        "text": label.text, "x": pt.x, "y": pt.y, "rotation": label.rotation, "magnification": label.magnification, "anchor": label.anchor
                    }));
                }
            }
        }
    }

    for (layer_key, lbls) in labels_by_layer {
        send_json(&serde_json::json!({
            "layerKey": layer_key,
            "labels": lbls
        }));
    }

    // Stream Definitions (Multi Instances)
    match args.geom_mode.as_str() {
        "polygons" => {
            for (cell_name, _transforms) in multi_instances.iter() {
                let mut builders: HashMap<String, PolyChunkBuilder> = HashMap::new();
                if let Some(tcp_ref) = tcp.as_deref_mut() {
                    let mut transport = TcpTransport { stream: tcp_ref, flow_control_step: 0 };
                    if let Some(cell) = lib.cells.iter().find(|c| c.name == *cell_name) {
                        for poly in &cell.polygons {
                            let key = format!("{}_{}", poly.layer, poly.datatype);
                            push_polygon_transformed(&key, poly, &Matrix3x3::identity(), &mut builders, args, &mut transport, WsChunkKind::FlatPolygons, Some(cell_name.as_str()))?;
                        }
                    }
                    flush_all_polygon_builders(&mut builders, args, &mut transport, WsChunkKind::FlatPolygons, Some(cell_name.as_str()))?;
                } else {
                    let mut transport = StdoutTransport { flow_control_step: args.flow_control_step };
                    if let Some(cell) = lib.cells.iter().find(|c| c.name == *cell_name) {
                        for poly in &cell.polygons {
                            let key = format!("{}_{}", poly.layer, poly.datatype);
                            push_polygon_transformed(&key, poly, &Matrix3x3::identity(), &mut builders, args, &mut transport, WsChunkKind::FlatPolygons, Some(cell_name.as_str()))?;
                        }
                    }
                    flush_all_polygon_builders(&mut builders, args, &mut transport, WsChunkKind::FlatPolygons, Some(cell_name.as_str()))?;
                }
            }
        }
        "triangles" => {
            for (cell_name, _transforms) in multi_instances.iter() {
                let tcp_ref = tcp.as_deref_mut().ok_or_else(|| anyhow::anyhow!("tcp required"))?;
                let mut transport = TcpTransport { stream: tcp_ref, flow_control_step: 0 };
                let mut builders: HashMap<String, TriChunkBuilder> = HashMap::new();
                if let Some(cell) = lib.cells.iter().find(|c| c.name == *cell_name) {
                    for poly in &cell.polygons {
                        let key = format!("{}_{}", poly.layer, poly.datatype);
                        push_triangles_transformed(&key, poly, &Matrix3x3::identity(), &mut builders, args, &mut transport, WsChunkKind::DefinitionTriangles, Some(cell_name.as_str()))?;
                    }
                }
                flush_all_triangle_builders(&mut builders, args, &mut transport, WsChunkKind::DefinitionTriangles, Some(cell_name.as_str()))?;
            }
        }
        _ => {}
    }

    // Stream Instances (Multi Instances)
    for (cell_name, transforms) in multi_instances {
        let total_chunks = (transforms.len() + args.chunk_size - 1) / args.chunk_size;
        for (i, chunk) in transforms.chunks(args.chunk_size).enumerate() {
            let mut buffer = Vec::new();
            buffer.extend_from_slice(&(chunk.len() as u32).to_le_bytes());
            for t in chunk {
                for col in 0..3 {
                    for row in 0..3 {
                        buffer.extend_from_slice(&(t.m[row][col] as f32).to_le_bytes());
                    }
                }
            }

            if let Some(tcp_ref) = tcp.as_deref_mut() {
                let mut transport = TcpTransport { stream: tcp_ref, flow_control_step: 0 };
                transport.send(WsChunkKind::Instances, "", Some(cell_name.as_str()), i as u32, total_chunks as u32, &buffer)?;
            } else {
                let mut transport = StdoutTransport { flow_control_step: args.flow_control_step };
                transport.send(WsChunkKind::Instances, "", Some(cell_name.as_str()), i as u32, total_chunks as u32, &buffer)?;
            }
        }
    }
    Ok(())
}
