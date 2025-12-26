mod gds_parser;
mod geometry;
mod gds_loader;
mod oasis_parser;
mod streamer;
mod analysis;

use clap::Parser;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, Read, Seek};
use std::path::Path;
use std::sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}};
use std::thread;
use std::time::Instant;
use crate::geometry::{Library, Cell, Matrix3x3, Point, Polygon};
use crate::streamer::{ChunkMsg, send_binary_chunk, send_json};
use crate::analysis::SearchEngine;
use anyhow::Result;

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
}

fn main() -> Result<()> {
    let args = Args::parse();

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
        oasis_parser::load_oasis(file)?
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
    let instances_by_name = analyze_instances(&library, main_cell, &mut instances_map);

    if args.use_instancing != 0 {
        process_instanced(&library, main_cell, &args, &mut metadata, instances_by_name)?;
    } else {
        process_flattened(&library, main_cell, &args, &mut metadata)?;
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

fn process_flattened(lib: &Library, main_cell: &Cell, args: &Args, metadata: &mut serde_json::Value) -> Result<()> {
    let mut flat_polygons: HashMap<String, Vec<Polygon>> = HashMap::new();
    let mut flat_labels: HashMap<String, Vec<serde_json::Value>> = HashMap::new();
    let mut bbox = (f64::MAX, f64::MIN, f64::MAX, f64::MIN);

    flatten_recursive(lib, main_cell, &Matrix3x3::identity(), &mut flat_polygons, &mut flat_labels, &mut bbox);

    if bbox.0 == f64::MAX { bbox = (0.0, 0.0, 0.0, 0.0); }

    let mut layer_keys: Vec<String> = flat_polygons.keys().cloned().collect();
    for k in flat_labels.keys() {
        if !flat_polygons.contains_key(k) {
            layer_keys.push(k.clone());
        }
    }
    sort_layer_keys(&mut layer_keys);

    metadata["layers"] = serde_json::json!(layer_keys);
    metadata["bbox"] = serde_json::json!({
        "x_min": bbox.0, "x_max": bbox.1, "y_min": bbox.2, "y_max": bbox.3
    });

    send_json(metadata);

    for (layer_key, lbls) in flat_labels {
        send_json(&serde_json::json!({ "layerKey": layer_key, "labels": lbls }));
    }

    for (layer_key, polys) in flat_polygons {
        let total_chunks = (polys.len() + args.chunk_size - 1) / args.chunk_size;
        for (i, chunk) in polys.chunks(args.chunk_size).enumerate() {
            let mut buffer = Vec::new();
            buffer.extend_from_slice(&(chunk.len() as u32).to_le_bytes());
            for poly in chunk {
                buffer.extend_from_slice(&(poly.points.len() as u32).to_le_bytes());
                for p in &poly.points {
                    buffer.extend_from_slice(&(p.x as f32).to_le_bytes());
                    buffer.extend_from_slice(&(p.y as f32).to_le_bytes());
                }
            }
            let msg = ChunkMsg {
                r#type: Some("flat".to_string()),
                layer_key: layer_key.clone(),
                chunk_index: i,
                total_chunks,
                cell_name: None,
            };
            send_binary_chunk(&msg, &buffer, i, args.flow_control_step);
        }
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
    instances: HashMap<String, Vec<Matrix3x3>>
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

    // Flatten Single Instances
    let mut flat_polygons: HashMap<String, Vec<Polygon>> = HashMap::new();
    for (cell_name, transforms) in &single_instances {
        if let Some(cell) = lib.cells.iter().find(|c| c.name == *cell_name) {
            for t in transforms {
                for poly in &cell.polygons {
                    let key = format!("{}_{}", poly.layer, poly.datatype);
                    let mut new_points = Vec::new();
                    for p in &poly.points {
                        new_points.push(t.transform_point(p));
                    }
                    flat_polygons.entry(key).or_default().push(Polygon {
                        layer: poly.layer, datatype: poly.datatype, points: new_points,
                    });
                }
            }
        }
    }

    // Calculate Global BBox (using full recursive flattening for safety)
    let mut bbox = (f64::MAX, f64::MIN, f64::MAX, f64::MIN);
    let mut dummy_polys = HashMap::new();
    let mut dummy_labels = HashMap::new();
    flatten_recursive(lib, main_cell, &Matrix3x3::identity(), &mut dummy_polys, &mut dummy_labels, &mut bbox);

    if bbox.0 == f64::MAX { bbox = (0.0, 0.0, 0.0, 0.0); }

    // Collect Layers
    let mut all_layers = HashSet::new();
    for k in flat_polygons.keys() { all_layers.insert(k.clone()); }
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

    // Stream Flat Polygons (Single Instances)
    for (layer_key, polys) in flat_polygons {
        let total_chunks = (polys.len() + args.chunk_size - 1) / args.chunk_size;
        for (i, chunk) in polys.chunks(args.chunk_size).enumerate() {
            let mut buffer = Vec::new();
            buffer.extend_from_slice(&(chunk.len() as u32).to_le_bytes());
            for poly in chunk {
                buffer.extend_from_slice(&(poly.points.len() as u32).to_le_bytes());
                for p in &poly.points {
                    buffer.extend_from_slice(&(p.x as f32).to_le_bytes());
                    buffer.extend_from_slice(&(p.y as f32).to_le_bytes());
                }
            }
            let msg = ChunkMsg {
                r#type: Some("flat".to_string()),
                layer_key: layer_key.clone(),
                chunk_index: i,
                total_chunks,
                cell_name: None,
            };
            send_binary_chunk(&msg, &buffer, i, args.flow_control_step);
        }
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
    for cell_name in multi_instances.keys() {
        if let Some(cell) = lib.cells.iter().find(|c| c.name == *cell_name) {
            let mut layer_polys: HashMap<String, Vec<&Polygon>> = HashMap::new();
            for p in &cell.polygons {
                layer_polys.entry(format!("{}_{}", p.layer, p.datatype)).or_default().push(p);
            }
            for (layer_key, polys) in layer_polys {
                let total_chunks = (polys.len() + args.chunk_size - 1) / args.chunk_size;
                for (i, chunk) in polys.chunks(args.chunk_size).enumerate() {
                    let mut buffer = Vec::new();
                    buffer.extend_from_slice(&(chunk.len() as u32).to_le_bytes());
                    for p in chunk {
                        buffer.extend_from_slice(&(p.points.len() as u32).to_le_bytes());
                        for pt in &p.points {
                            buffer.extend_from_slice(&(pt.x as f32).to_le_bytes());
                            buffer.extend_from_slice(&(pt.y as f32).to_le_bytes());
                        }
                    }
                    let msg = ChunkMsg {
                        r#type: Some("definition".to_string()),
                        layer_key: layer_key.clone(),
                        chunk_index: i,
                        total_chunks,
                        cell_name: Some(cell_name.clone()),
                    };
                    send_binary_chunk(&msg, &buffer, i, args.flow_control_step);
                }
            }
        }
    }

    // Stream Instances (Multi Instances)
    for (cell_name, transforms) in multi_instances {
        let total_chunks = (transforms.len() + args.chunk_size - 1) / args.chunk_size;
        for (i, chunk) in transforms.chunks(args.chunk_size).enumerate() {
            let mut buffer = Vec::new();
            buffer.extend_from_slice(&(chunk.len() as u32).to_le_bytes());
            for t in chunk {
                // Transpose to Column-Major for GLSL
                // Rust Matrix3x3 is row-major: [[m11, m12, tx], [m21, m22, ty], [0, 0, 1]]
                // GLSL expects column-major.
                // Transpose: [m11, m21, 0, m12, m22, 0, tx, ty, 1]
                for col in 0..3 {
                    for row in 0..3 {
                        buffer.extend_from_slice(&(t.m[row][col] as f32).to_le_bytes());
                    }
                }
            }
            let msg = ChunkMsg {
                r#type: Some("instance".to_string()),
                layer_key: "".to_string(),
                chunk_index: i,
                total_chunks,
                cell_name: Some(cell_name.clone()),
            };
            send_binary_chunk(&msg, &buffer, i, args.flow_control_step);
        }
    }
    Ok(())
}
