use anyhow::Result;
use clap::Parser;
use gds_engine_rust::analysis::SearchEngine;
use gds_engine_rust::args::Args;
use gds_engine_rust::geometry::Library;
use gds_engine_rust::renderer::{analyze_instances, process_flattened, process_instanced};
use gds_engine_rust::streamer::{send_json, triangulate_coords_to_vertices, WsChunkKind};
use gds_engine_rust::viewport::{
    process_instanced_viewport_preamble, stream_viewport_geometry, stream_viewport_snap_polygons,
    ViewportRuntime,
};
use gds_engine_rust::ws_streamer::TcpTransport;
use gds_engine_rust::{gds_loader, oasis_loader};
use rayon::prelude::*;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, Read, Seek};
use std::net::TcpStream;
use std::path::Path;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::thread;
use std::time::Instant;

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
    let is_oasis = file
        .read_exact(&mut magic)
        .map(|_| &magic[..11] == b"%SEMI-OASIS")
        .unwrap_or(false);
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
    if let Some(pos) = library
        .cells
        .iter()
        .position(|c| c.name == "$$$CONTEXT_INFO$$$")
    {
        context_ports = library.cells[pos].ports.clone();
    }

    // Filter out metadata cells starting with "$$$" immediately
    library.cells.retain(|c| !c.name.starts_with("$$$"));

    if library.cells.is_empty() {
        return Err(anyhow::anyhow!("No cells found in GDS file"));
    }

    // 1. Find target cell
    let top_level_cells = find_top_level_cells(&library);
    let main_cell_name = if args.cell_name.is_empty() {
        top_level_cells
            .get(0)
            .unwrap_or(&library.cells[0].name)
            .clone()
    } else {
        args.cell_name.clone()
    };

    // Add context ports only when viewing a top-level cell.
    if !context_ports.is_empty() && top_level_cells.iter().any(|c| c == &main_cell_name) {
        if let Some(cell) = library.cells.iter_mut().find(|c| c.name == main_cell_name) {
            cell.ports.extend(context_ports);
        }
    }

    let main_cell = library
        .cells
        .iter()
        .find(|c| c.name == main_cell_name)
        .ok_or_else(|| anyhow::anyhow!("Cell '{}' not found", main_cell_name))?;

    // 2. Metadata
    let mut all_cell_names: Vec<String> = library.cells.iter().map(|c| c.name.clone()).collect();
    all_cell_names.sort();

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
    let main_cell = library
        .cells
        .iter()
        .find(|c| c.name == main_cell_name)
        .ok_or_else(|| anyhow::anyhow!("Cell '{}' not found", main_cell_name))?;

    let mut instances_map = HashMap::new();
    let mut instances_by_name_opt =
        Some(analyze_instances(&library, main_cell, &mut instances_map));

    if args.geom_mode == "triangles" && tcp_stream.is_none() {
        return Err(anyhow::anyhow!("--geom-mode triangles requires --tcp-port"));
    }

    // Optional mode: stream only what the viewport needs (plus cached definitions).
    let mut viewport_runtime: Option<ViewportRuntime> = None;

    if args.viewport_streaming {
        if args.use_instancing == 0 {
            send_json(&serde_json::json!({
                "command": "status",
                "message": "Viewport streaming requires WebGL instancing; falling back to full streaming"
            }));
        } else {
            let tcp_ref = tcp_stream
                .as_mut()
                .ok_or_else(|| anyhow::anyhow!("--viewport-streaming requires --tcp-port"))?;

            let mut transport = TcpTransport {
                stream: tcp_ref,
                flow_control_step: 0,
            };
            let instances_by_name = instances_by_name_opt
                .take()
                .ok_or_else(|| anyhow::anyhow!("instances already consumed"))?;
            let rt = process_instanced_viewport_preamble(
                &library,
                main_cell,
                &args,
                &mut metadata,
                instances_by_name,
                &mut transport,
            )?;
            viewport_runtime = Some(rt);
        }
    }

    if viewport_runtime.is_none() {
        if args.use_instancing != 0 {
            let instances_by_name = instances_by_name_opt
                .take()
                .ok_or_else(|| anyhow::anyhow!("instances already consumed"))?;
            process_instanced(
                &library,
                main_cell,
                &args,
                &mut metadata,
                instances_by_name,
                tcp_stream.as_mut(),
            )?;
        } else {
            process_flattened(
                &library,
                main_cell,
                &args,
                &mut metadata,
                tcp_stream.as_mut(),
            )?;
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

    // Keep instances available for viewport polygon streaming (snapping).
    let instances_map_for_snap = instances_map;
    let instances_map_for_search = instances_map_for_snap.clone();

    // Stable instance_id mapping, shared across:
    // - SearchEngine polyId: [instance_id, poly_index]
    // - viewportSnap polyId: [instance_id, poly_index]
    // - highlightUpdate (webview -> backend)
    let ordered_instances_for_ids =
        gds_engine_rust::instance_order::ordered_instances(&instances_map_for_snap);

    // Backend highlight state (polyId set). Rendering is streamed to webview as __highlight__ triangles.
    let mut highlight_set: HashSet<(u32, u32)> = HashSet::new();

    // Small helper: send a WS control frame (kind=5) with layerKey='__highlight__'.
    fn send_highlight_control(
        transport: &mut dyn gds_engine_rust::streamer::ChunkTransport,
        opcode: u8,
        seq: u32,
    ) -> Result<()> {
        let mut payload = Vec::with_capacity(1 + 4);
        payload.push(opcode);
        payload.extend_from_slice(&seq.to_le_bytes());
        transport.send(WsChunkKind::Control, "__highlight__", None, 0, 0, &payload)
    }

    fn stream_highlight_triangles(
        lib: &Library,
        ordered_instances: &[gds_engine_rust::instance_order::OrderedInstance],
        poly_ids: &[(u32, u32)],
        seq: u32,
        transport: &mut dyn gds_engine_rust::streamer::ChunkTransport,
    ) -> Result<()> {
        // Begin snapshot (webview will stage buffers)
        send_highlight_control(transport, 1, seq)?;

        if poly_ids.is_empty() {
            // Empty snapshot clears overlay.
            send_highlight_control(transport, 2, seq)?;
            return Ok(());
        }

        // Triangulate each polygon in parallel.
        // Note: same limitation as existing triangle streaming: no holes.
        let parts: Vec<Vec<f32>> = poly_ids
            .par_iter()
            .filter_map(|(instance_id, poly_index)| {
                let inst = ordered_instances.get(*instance_id as usize)?;
                let cell = lib.cells.get(inst.cell_idx)?;
                let poly = cell.polygons.get(*poly_index as usize)?;
                if poly.points.len() < 3 {
                    return Some(Vec::new());
                }

                let mut coords: Vec<f64> = Vec::with_capacity(poly.points.len() * 2);
                for p in &poly.points {
                    let pt = inst.matrix.transform_point(p);
                    coords.push(pt.x);
                    coords.push(pt.y);
                }
                Some(triangulate_coords_to_vertices(&coords))
            })
            .collect();

        // Chunk the output to avoid giant WS frames.
        // vertexCount is u32 count of vertices; payload is tightly packed f32 coords.
        const MAX_VERTICES_PER_FRAME: usize = 200_000;
        let mut chunk_index: u32 = 0;

        let mut pending_vertices: Vec<f32> = Vec::new();
        pending_vertices.reserve(MAX_VERTICES_PER_FRAME * 2);

        let flush = |transport: &mut dyn gds_engine_rust::streamer::ChunkTransport,
                     chunk_index: &mut u32,
                     pending: &mut Vec<f32>| -> Result<()> {
            if pending.is_empty() {
                return Ok(());
            }
            let vertex_count: u32 = (pending.len() / 2) as u32;
            let mut payload = Vec::with_capacity(4 + pending.len() * 4);
            payload.extend_from_slice(&vertex_count.to_le_bytes());
            for v in pending.iter() {
                payload.extend_from_slice(&v.to_le_bytes());
            }
            transport.send(
                WsChunkKind::FlatTriangles,
                "__highlight__",
                None,
                *chunk_index,
                0,
                &payload,
            )?;
            *chunk_index += 1;
            pending.clear();
            Ok(())
        };

        for mut v in parts {
            if v.is_empty() {
                continue;
            }
            // Flush if adding would exceed the per-frame limit.
            let incoming_vertices = v.len() / 2;
            let pending_count = pending_vertices.len() / 2;
            if pending_count > 0 && (pending_count + incoming_vertices) > MAX_VERTICES_PER_FRAME {
                flush(transport, &mut chunk_index, &mut pending_vertices)?;
            }
            pending_vertices.append(&mut v);
            let pending_count_after = pending_vertices.len() / 2;
            if pending_count_after >= MAX_VERTICES_PER_FRAME {
                flush(transport, &mut chunk_index, &mut pending_vertices)?;
            }
        }

        flush(transport, &mut chunk_index, &mut pending_vertices)?;
        // End snapshot (webview commits staging -> active)
        send_highlight_control(transport, 2, seq)?;
        Ok(())
    }

    thread::spawn(move || {
        let engine = SearchEngine::new(library_clone, instances_map_for_search);
        *search_engine_clone.lock().unwrap() = Some(engine);
    });

    let current_search_cancel: Arc<Mutex<Option<Arc<AtomicBool>>>> = Arc::new(Mutex::new(None));

    // Start interactive loop for search
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }

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
                                if let (Ok(l), Ok(d)) =
                                    (parts[0].parse::<i16>(), parts[1].parse::<i16>())
                                {
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
                        if cancel_flag.load(Ordering::Relaxed) {
                            return;
                        }

                        let start_time = Instant::now();
                        let run_search = || {
                            engine.find(x, y, &active_layers, max_steps, Some(cancel_flag.clone()))
                        };

                        let (hits, limit_reached) = if max_workers > 0 {
                            if let Ok(pool) = rayon::ThreadPoolBuilder::new()
                                .num_threads(max_workers as usize)
                                .build()
                            {
                                pool.install(run_search)
                            } else {
                                run_search()
                            }
                        } else {
                            run_search()
                        };

                        let duration = start_time.elapsed().as_millis();

                        if !cancel_flag.load(Ordering::Relaxed) {
                            let polys_v2: Vec<serde_json::Value> = hits
                                .iter()
                                .map(|h| {
                                    let p = &h.polygon;
                                    let pts: Vec<[f64; 2]> =
                                        p.points.iter().map(|pt| [pt.x, pt.y]).collect();
                                    serde_json::json!({
                                        "polyId": [h.instance_id, h.poly_index],
                                        "layerKey": format!("{}_{}", p.layer, p.datatype),
                                        "points": pts
                                    })
                                })
                                .collect();

                            send_json(&serde_json::json!({
                                "command": "found",
                                "polygonsV2": polys_v2,
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
            } else if cmd["command"] == "pick" {
                let x = cmd["x"].as_f64().unwrap_or(0.0);
                let y = cmd["y"].as_f64().unwrap_or(0.0);
                let layers_val = cmd["layers"].as_array();

                // IMPORTANT: preserve the incoming order (top -> bottom) for layer-priority picking.
                let mut layer_order: Vec<(i16, i16)> = Vec::new();
                if let Some(layers) = layers_val {
                    for l in layers {
                        if let Some(s) = l.as_str() {
                            let parts: Vec<&str> = s.split('_').collect();
                            if parts.len() == 2 {
                                if let (Ok(la), Ok(dt)) =
                                    (parts[0].parse::<i16>(), parts[1].parse::<i16>())
                                {
                                    layer_order.push((la, dt));
                                }
                            }
                        }
                    }
                }

                let search_engine = search_engine.clone();
                thread::spawn(move || {
                    let engine_guard = search_engine.lock().unwrap();
                    if let Some(engine) = &*engine_guard {
                        let start_time = Instant::now();

                        let poly = engine.pick(x, y, &layer_order);
                        let duration = start_time.elapsed().as_millis();

                        let polys_v2: Vec<serde_json::Value> = poly
                            .iter()
                            .map(|h| {
                                let p = &h.polygon;
                                let pts: Vec<[f64; 2]> =
                                    p.points.iter().map(|pt| [pt.x, pt.y]).collect();
                                serde_json::json!({
                                    "polyId": [h.instance_id, h.poly_index],
                                    "layerKey": format!("{}_{}", p.layer, p.datatype),
                                    "points": pts
                                })
                            })
                            .collect();

                        send_json(&serde_json::json!({
                            "command": "picked",
                            "polygonsV2": polys_v2,
                            "duration": duration
                        }));
                    } else {
                        send_json(&serde_json::json!({
                            "command": "status",
                            "message": "Search engine initializing..."
                        }));
                    }
                });
            } else if cmd["command"] == "stop" {
                let cancel_guard = current_search_cancel.lock().unwrap();
                if let Some(flag) = &*cancel_guard {
                    flag.store(true, Ordering::Relaxed);
                }
                send_json(&serde_json::json!({
                    "command": "status",
                    "message": "Search stopped"
                }));
            } else if cmd["command"] == "viewport" {
                let req_id = cmd["requestId"].as_u64().unwrap_or(0) as u32;
                let bbox = &cmd["bbox"];
                let vminx = bbox["minX"].as_f64().unwrap_or(0.0);
                let vmaxx = bbox["maxX"].as_f64().unwrap_or(0.0);
                let vminy = bbox["minY"].as_f64().unwrap_or(0.0);
                let vmaxy = bbox["maxY"].as_f64().unwrap_or(0.0);

                let snap_token = cmd["snapToken"].as_str();

                let layers_val = cmd["layers"].as_array();
                let mut active_layers: HashSet<(i16, i16)> = HashSet::new();
                if let Some(layers) = layers_val {
                    for l in layers {
                        if let Some(s) = l.as_str() {
                            let parts: Vec<&str> = s.split('_').collect();
                            if parts.len() == 2 {
                                if let (Ok(la), Ok(dt)) =
                                    (parts[0].parse::<i16>(), parts[1].parse::<i16>())
                                {
                                    active_layers.insert((la, dt));
                                }
                            }
                        }
                    }
                }

                // TCP/WebSocket transport is required for viewport responses.
                if let Some(tcp_ref) = tcp_stream.as_mut() {
                    // Keep stdin free for JSON commands; avoid consuming them in transport flow control.
                    let mut transport = TcpTransport {
                        stream: tcp_ref,
                        flow_control_step: 0,
                    };

                    // Rendering viewport streaming (triangles/instances)
                    if let Some(rt) = viewport_runtime.as_mut() {
                        stream_viewport_geometry(
                            &library,
                            rt,
                            &args,
                            &mut transport,
                            req_id,
                            (vminx, vmaxx, vminy, vmaxy),
                            &active_layers,
                        )?;
                    }

                    // Snapping polygons (kind=4), requested by the webview.
                    let want_snap_polys = cmd["snapPolygons"].as_bool().unwrap_or(false);
                    if want_snap_polys {
                        let token_owned = snap_token
                            .filter(|s| !s.trim().is_empty())
                            .map(|s| s.to_string())
                            .unwrap_or_else(|| format!("__snap__:{}", req_id));

                        stream_viewport_snap_polygons(
                            &library,
                            &instances_map_for_snap,
                            &args,
                            &mut transport,
                            req_id,
                            token_owned.as_str(),
                            (vminx, vmaxx, vminy, vmaxy),
                            None,
                            &active_layers,
                        )?;
                    }
                }
            } else if cmd["command"] == "viewportSnap" {
                // Snap polygons only for a bbox. This is used by WebGL box selection.
                // Unlike the 'viewport' command, this MUST NOT trigger render viewport geometry streaming.
                let req_id = cmd["requestId"].as_u64().unwrap_or(0) as u32;
                let bbox = &cmd["bbox"];
                let vminx = bbox["minX"].as_f64().unwrap_or(0.0);
                let vmaxx = bbox["maxX"].as_f64().unwrap_or(0.0);
                let vminy = bbox["minY"].as_f64().unwrap_or(0.0);
                let vmaxy = bbox["maxY"].as_f64().unwrap_or(0.0);

                // Optional: selection quad in world coordinates (screen-aligned rectangle mapped into world).
                // If provided, backend filters polygons fully inside this quad and returns final hits.
                let quad_world = cmd["quadWorld"].as_array().and_then(|arr| {
                    if arr.len() != 4 {
                        return None;
                    }
                    let mut pts: Vec<gds_engine_rust::geometry::Point> = Vec::with_capacity(4);
                    for v in arr {
                        let x = v["x"].as_f64()?;
                        let y = v["y"].as_f64()?;
                        pts.push(gds_engine_rust::geometry::Point { x, y });
                    }
                    Some([
                        pts[0].clone(),
                        pts[1].clone(),
                        pts[2].clone(),
                        pts[3].clone(),
                    ])
                });

                let snap_token = cmd["snapToken"].as_str();

                let layers_val = cmd["layers"].as_array();
                let mut active_layers: HashSet<(i16, i16)> = HashSet::new();
                if let Some(layers) = layers_val {
                    for l in layers {
                        if let Some(s) = l.as_str() {
                            let parts: Vec<&str> = s.split('_').collect();
                            if parts.len() == 2 {
                                if let (Ok(la), Ok(dt)) =
                                    (parts[0].parse::<i16>(), parts[1].parse::<i16>())
                                {
                                    active_layers.insert((la, dt));
                                }
                            }
                        }
                    }
                }

                if let Some(tcp_ref) = tcp_stream.as_mut() {
                    let mut transport = TcpTransport {
                        stream: tcp_ref,
                        flow_control_step: 0,
                    };

                    let want_snap_polys = cmd["snapPolygons"].as_bool().unwrap_or(true);
                    if want_snap_polys {
                        let token_owned = snap_token
                            .filter(|s| !s.trim().is_empty())
                            .map(|s| s.to_string())
                            .unwrap_or_else(|| format!("__snap__:{}", req_id));

                        stream_viewport_snap_polygons(
                            &library,
                            &instances_map_for_snap,
                            &args,
                            &mut transport,
                            req_id,
                            token_owned.as_str(),
                            (vminx, vmaxx, vminy, vmaxy),
                            quad_world,
                            &active_layers,
                        )?;
                    }
                }
            }
            // WebGL highlight overlay update: webview sends the final polyId set.
            else if cmd["command"] == "highlightUpdate" {
                let seq = cmd["clientSeq"].as_u64().unwrap_or(0) as u32;
                let mut incoming: Vec<(u32, u32)> = Vec::new();

                if let Some(arr) = cmd["polyIds"].as_array() {
                    incoming.reserve(arr.len());
                    for v in arr {
                        if let Some(pair) = v.as_array() {
                            if pair.len() != 2 {
                                continue;
                            }
                            let a = pair[0].as_u64().unwrap_or(u64::MAX);
                            let b = pair[1].as_u64().unwrap_or(u64::MAX);
                            if a == u64::MAX || b == u64::MAX {
                                continue;
                            }
                            incoming.push((a as u32, b as u32));
                        }
                    }
                }

                let new_set: HashSet<(u32, u32)> = incoming.iter().copied().collect();
                if new_set == highlight_set {
                    continue;
                }
                highlight_set = new_set;

                // Stream triangles over TCP/WS when available.
                if let Some(tcp_ref) = tcp_stream.as_mut() {
                    let mut transport = TcpTransport {
                        stream: tcp_ref,
                        flow_control_step: 0,
                    };
                    // Preserve the incoming order for deterministic overlay generation.
                    // (Duplicates are harmless; the set is what matters semantically.)
                    stream_highlight_triangles(
                        &library,
                        &ordered_instances_for_ids,
                        &incoming,
                        seq,
                        &mut transport,
                    )?;
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
