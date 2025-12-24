mod gds_parser;
mod geometry;
mod gds_loader;
mod streamer;

use clap::Parser;
use std::fs::File;
use std::collections::{HashMap, HashSet};
use crate::geometry::{Library, Cell, Matrix3x3, Point, Polygon};
use crate::streamer::{ChunkMsg, send_binary_chunk, send_json};
use anyhow::Result;

#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
struct Args {
    #[arg(help = "Input GDS file path")]
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
    
    let file = File::open(&args.input)?;
    let mut library = gds_loader::load_gds(file)?;
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

    if args.use_instancing != 0 {
        process_instanced(&library, main_cell, &args, &mut metadata)?;
    } else {
        process_flattened(&library, main_cell, &args, &mut metadata)?;
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
    metadata["ports"] = serde_json::json!([]);
    
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

fn process_instanced(lib: &Library, main_cell: &Cell, args: &Args, metadata: &mut serde_json::Value) -> Result<()> {
    let mut instances: HashMap<String, Vec<Matrix3x3>> = HashMap::new();
    // Use main_cell as starting point
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
    metadata["ports"] = serde_json::json!([]);
    
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
