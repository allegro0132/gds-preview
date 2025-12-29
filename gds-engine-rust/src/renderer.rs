use crate::args::Args;
use crate::geometry::{Cell, Library, Matrix3x3, Point, Polygon};
use crate::streamer::{
    flush_all_polygon_builders, flush_all_triangle_builders, push_polygon_transformed,
    push_triangles_transformed, send_json, ChunkTransport, PolyChunkBuilder, StdoutTransport,
    TriChunkBuilder, WsChunkKind,
};
use crate::ws_streamer::TcpTransport;
use anyhow::Result;
use std::collections::{HashMap, HashSet};
use std::net::TcpStream;

pub fn process_flattened(
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

    // Ports are rendered with a layer-based visibility check in the webview.
    // Ensure their layers are present even if the cell has no geometry on that layer.
    for port in &main_cell.ports {
        layer_keys_set.insert(format!("{}_0", port.layer));
    }

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
                let mut transport = TcpTransport {
                    stream: tcp_ref,
                    flow_control_step: 0,
                };
                stream_recursive_polygons(
                    lib,
                    main_cell,
                    &Matrix3x3::identity(),
                    &mut builders,
                    args,
                    &mut transport,
                    WsChunkKind::FlatPolygons,
                    None,
                )?;
                flush_all_polygon_builders(
                    &mut builders,
                    args,
                    &mut transport,
                    WsChunkKind::FlatPolygons,
                    None,
                )?;
            } else {
                let mut transport = StdoutTransport {
                    flow_control_step: args.flow_control_step,
                };
                stream_recursive_polygons(
                    lib,
                    main_cell,
                    &Matrix3x3::identity(),
                    &mut builders,
                    args,
                    &mut transport,
                    WsChunkKind::FlatPolygons,
                    None,
                )?;
                flush_all_polygon_builders(
                    &mut builders,
                    args,
                    &mut transport,
                    WsChunkKind::FlatPolygons,
                    None,
                )?;
            }
        }
        "triangles" => {
            let mut builders: HashMap<String, TriChunkBuilder> = HashMap::new();
            let tcp_ref = tcp
                .as_deref_mut()
                .ok_or_else(|| anyhow::anyhow!("tcp required"))?;
            let mut transport = TcpTransport {
                stream: tcp_ref,
                flow_control_step: 0,
            };
            stream_recursive_triangles(
                lib,
                main_cell,
                &Matrix3x3::identity(),
                &mut builders,
                args,
                &mut transport,
                WsChunkKind::FlatTriangles,
                None,
            )?;
            flush_all_triangle_builders(
                &mut builders,
                args,
                &mut transport,
                WsChunkKind::FlatTriangles,
                None,
            )?;
        }
        other => return Err(anyhow::anyhow!("Unknown geom_mode: {other}")),
    }

    Ok(())
}

pub fn process_instanced(
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

    if bbox.0 == f64::MAX {
        bbox = (0.0, 0.0, 0.0, 0.0);
    }

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

    // Ensure current cell ports are visible in the UI even if their layer is otherwise absent.
    for port in &main_cell.ports {
        all_layers.insert(format!("{}_0", port.layer));
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
                let mut transport = TcpTransport {
                    stream: tcp_ref,
                    flow_control_step: 0,
                };
                for (cell_name, transforms) in &single_instances {
                    if let Some(cell) = lib.cells.iter().find(|c| c.name == *cell_name) {
                        for t in transforms {
                            for poly in &cell.polygons {
                                let key = format!("{}_{}", poly.layer, poly.datatype);
                                push_polygon_transformed(
                                    &key,
                                    poly,
                                    t,
                                    &mut builders,
                                    args,
                                    &mut transport,
                                    WsChunkKind::FlatPolygons,
                                    None,
                                )?;
                            }
                        }
                    }
                }
                flush_all_polygon_builders(
                    &mut builders,
                    args,
                    &mut transport,
                    WsChunkKind::FlatPolygons,
                    None,
                )?;
            } else {
                let mut transport = StdoutTransport {
                    flow_control_step: args.flow_control_step,
                };
                for (cell_name, transforms) in &single_instances {
                    if let Some(cell) = lib.cells.iter().find(|c| c.name == *cell_name) {
                        for t in transforms {
                            for poly in &cell.polygons {
                                let key = format!("{}_{}", poly.layer, poly.datatype);
                                push_polygon_transformed(
                                    &key,
                                    poly,
                                    t,
                                    &mut builders,
                                    args,
                                    &mut transport,
                                    WsChunkKind::FlatPolygons,
                                    None,
                                )?;
                            }
                        }
                    }
                }
                flush_all_polygon_builders(
                    &mut builders,
                    args,
                    &mut transport,
                    WsChunkKind::FlatPolygons,
                    None,
                )?;
            }
        }
        "triangles" => {
            let tcp_ref = tcp
                .as_deref_mut()
                .ok_or_else(|| anyhow::anyhow!("tcp required"))?;
            let mut transport = TcpTransport {
                stream: tcp_ref,
                flow_control_step: 0,
            };
            let mut builders: HashMap<String, TriChunkBuilder> = HashMap::new();
            for (cell_name, transforms) in &single_instances {
                if let Some(cell) = lib.cells.iter().find(|c| c.name == *cell_name) {
                    for t in transforms {
                        for poly in &cell.polygons {
                            let key = format!("{}_{}", poly.layer, poly.datatype);
                            push_triangles_transformed(
                                &key,
                                poly,
                                t,
                                &mut builders,
                                args,
                                &mut transport,
                                WsChunkKind::FlatTriangles,
                                None,
                            )?;
                        }
                    }
                }
            }
            flush_all_triangle_builders(
                &mut builders,
                args,
                &mut transport,
                WsChunkKind::FlatTriangles,
                None,
            )?;
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
                    let pt = t.transform_point(&Point {
                        x: label.x,
                        y: label.y,
                    });
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
                    let mut transport = TcpTransport {
                        stream: tcp_ref,
                        flow_control_step: 0,
                    };
                    if let Some(cell) = lib.cells.iter().find(|c| c.name == *cell_name) {
                        for poly in &cell.polygons {
                            let key = format!("{}_{}", poly.layer, poly.datatype);
                            push_polygon_transformed(
                                &key,
                                poly,
                                &Matrix3x3::identity(),
                                &mut builders,
                                args,
                                &mut transport,
                                WsChunkKind::FlatPolygons,
                                Some(cell_name.as_str()),
                            )?;
                        }
                    }
                    flush_all_polygon_builders(
                        &mut builders,
                        args,
                        &mut transport,
                        WsChunkKind::FlatPolygons,
                        Some(cell_name.as_str()),
                    )?;
                } else {
                    let mut transport = StdoutTransport {
                        flow_control_step: args.flow_control_step,
                    };
                    if let Some(cell) = lib.cells.iter().find(|c| c.name == *cell_name) {
                        for poly in &cell.polygons {
                            let key = format!("{}_{}", poly.layer, poly.datatype);
                            push_polygon_transformed(
                                &key,
                                poly,
                                &Matrix3x3::identity(),
                                &mut builders,
                                args,
                                &mut transport,
                                WsChunkKind::FlatPolygons,
                                Some(cell_name.as_str()),
                            )?;
                        }
                    }
                    flush_all_polygon_builders(
                        &mut builders,
                        args,
                        &mut transport,
                        WsChunkKind::FlatPolygons,
                        Some(cell_name.as_str()),
                    )?;
                }
            }
        }
        "triangles" => {
            for (cell_name, _transforms) in multi_instances.iter() {
                let tcp_ref = tcp
                    .as_deref_mut()
                    .ok_or_else(|| anyhow::anyhow!("tcp required"))?;
                let mut transport = TcpTransport {
                    stream: tcp_ref,
                    flow_control_step: 0,
                };
                let mut builders: HashMap<String, TriChunkBuilder> = HashMap::new();
                if let Some(cell) = lib.cells.iter().find(|c| c.name == *cell_name) {
                    for poly in &cell.polygons {
                        let key = format!("{}_{}", poly.layer, poly.datatype);
                        push_triangles_transformed(
                            &key,
                            poly,
                            &Matrix3x3::identity(),
                            &mut builders,
                            args,
                            &mut transport,
                            WsChunkKind::DefinitionTriangles,
                            Some(cell_name.as_str()),
                        )?;
                    }
                }
                flush_all_triangle_builders(
                    &mut builders,
                    args,
                    &mut transport,
                    WsChunkKind::DefinitionTriangles,
                    Some(cell_name.as_str()),
                )?;
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
                let mut transport = TcpTransport {
                    stream: tcp_ref,
                    flow_control_step: 0,
                };
                transport.send(
                    WsChunkKind::Instances,
                    "",
                    Some(cell_name.as_str()),
                    i as u32,
                    total_chunks as u32,
                    &buffer,
                )?;
            } else {
                let mut transport = StdoutTransport {
                    flow_control_step: args.flow_control_step,
                };
                transport.send(
                    WsChunkKind::Instances,
                    "",
                    Some(cell_name.as_str()),
                    i as u32,
                    total_chunks as u32,
                    &buffer,
                )?;
            }
        }
    }
    Ok(())
}

pub fn analyze_instances(
    lib: &Library,
    main_cell: &Cell,
    out_instances_map: &mut HashMap<usize, Vec<Matrix3x3>>,
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
                        origin.x +=
                            (col as f64 * re.col_spacing.x) + (row as f64 * re.row_spacing.x);
                        origin.y +=
                            (col as f64 * re.col_spacing.y) + (row as f64 * re.row_spacing.y);

                        let local_t = Matrix3x3::from_transform(
                            re.rotation.unwrap_or(0.0),
                            re.magnification.unwrap_or(1.0),
                            re.x_reflection,
                            &origin,
                        );
                        let global_t = current_transform.multiply(&local_t);
                        instances
                            .entry(re.cell_name.clone())
                            .or_default()
                            .push(global_t.clone());
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

pub fn scan_recursive_bbox(
    lib: &Library,
    cell: &Cell,
    transform: &Matrix3x3,
    bbox: &mut (f64, f64, f64, f64),
) {
    for poly in &cell.polygons {
        for p in &poly.points {
            let pt = transform.transform_point(p);
            if pt.x < bbox.0 {
                bbox.0 = pt.x;
            }
            if pt.x > bbox.1 {
                bbox.1 = pt.x;
            }
            if pt.y < bbox.2 {
                bbox.2 = pt.y;
            }
            if pt.y > bbox.3 {
                bbox.3 = pt.y;
            }
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
            if pt.x < bbox.0 {
                bbox.0 = pt.x;
            }
            if pt.x > bbox.1 {
                bbox.1 = pt.x;
            }
            if pt.y < bbox.2 {
                bbox.2 = pt.y;
            }
            if pt.y > bbox.3 {
                bbox.3 = pt.y;
            }
        }
    }

    for label in &cell.labels {
        let key = format!("{}_{}", label.layer, label.texttype);
        layer_keys.insert(key.clone());
        let pt = transform.transform_point(&Point {
            x: label.x,
            y: label.y,
        });
        labels_by_layer
            .entry(key)
            .or_default()
            .push(serde_json::json!({
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
                    scan_recursive_flat(
                        lib,
                        ref_cell,
                        &combined,
                        bbox,
                        layer_keys,
                        labels_by_layer,
                    );
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
        push_polygon_transformed(
            &key, poly, transform, builders, args, transport, kind, cell_name,
        )?;
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
                    stream_recursive_polygons(
                        lib, ref_cell, &combined, builders, args, transport, kind, cell_name,
                    )?;
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
        push_triangles_transformed(
            &key, poly, transform, builders, args, transport, kind, cell_name,
        )?;
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
                    stream_recursive_triangles(
                        lib, ref_cell, &combined, builders, args, transport, kind, cell_name,
                    )?;
                }
            }
        }
    }
    Ok(())
}

#[allow(dead_code)]
pub fn flatten_recursive(
    lib: &Library,
    cell: &Cell,
    transform: &Matrix3x3,
    out_polys: &mut HashMap<String, Vec<Polygon>>,
    out_labels: &mut HashMap<String, Vec<serde_json::Value>>,
    bbox: &mut (f64, f64, f64, f64),
) {
    for poly in &cell.polygons {
        let key = format!("{}_{}", poly.layer, poly.datatype);
        let mut new_points = Vec::new();
        for p in &poly.points {
            let pt = transform.transform_point(p);
            new_points.push(pt.clone());
            if pt.x < bbox.0 {
                bbox.0 = pt.x;
            }
            if pt.x > bbox.1 {
                bbox.1 = pt.x;
            }
            if pt.y < bbox.2 {
                bbox.2 = pt.y;
            }
            if pt.y > bbox.3 {
                bbox.3 = pt.y;
            }
        }
        out_polys.entry(key).or_default().push(Polygon {
            layer: poly.layer,
            datatype: poly.datatype,
            points: new_points,
        });
    }

    for label in &cell.labels {
        let key = format!("{}_{}", label.layer, label.texttype);
        let pt = transform.transform_point(&Point {
            x: label.x,
            y: label.y,
        });
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
                        re.rotation.unwrap_or(0.0),
                        re.magnification.unwrap_or(1.0),
                        re.x_reflection,
                        &origin,
                    );
                    let combined = transform.multiply(&local_transform);
                    flatten_recursive(lib, ref_cell, &combined, out_polys, out_labels, bbox);
                }
            }
        }
    }
}

pub fn sort_layer_keys(keys: &mut Vec<String>) {
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
