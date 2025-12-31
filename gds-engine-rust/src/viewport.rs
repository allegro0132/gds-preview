use crate::args::Args;
use crate::geometry::{Cell, Library, Matrix3x3, Point, Polygon};
use crate::renderer::{scan_recursive_bbox, sort_layer_keys};
use crate::streamer::{
    flush_all_triangle_builders, push_triangles_transformed, send_json, ChunkTransport,
    TriChunkBuilder, WsChunkKind,
};
use anyhow::Result;
use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::time::Instant;

#[derive(Clone, Debug)]
pub struct ViewportRuntime {
    pub single_instances: HashMap<String, Vec<Matrix3x3>>,
    pub multi_instances: HashMap<String, Vec<Matrix3x3>>,
    pub cell_bbox_local: HashMap<String, (f64, f64, f64, f64)>,
    pub cell_max_radius: HashMap<String, f64>,
    pub last_fingerprint: Option<u64>,
}

pub fn process_instanced_viewport_preamble(
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
    if bbox.0 == f64::MAX {
        bbox = (0.0, 0.0, 0.0, 0.0);
    }

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

    // Labels (aggregated by layer)
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
                        push_triangles_transformed(
                            &key,
                            poly,
                            &Matrix3x3::identity(),
                            &mut builders,
                            args,
                            transport,
                            WsChunkKind::DefinitionTriangles,
                            Some(cell_name.as_str()),
                        )?;
                    }
                }
                flush_all_triangle_builders(
                    &mut builders,
                    args,
                    transport,
                    WsChunkKind::DefinitionTriangles,
                    Some(cell_name.as_str()),
                )?;
            }
        }
        other => {
            return Err(anyhow::anyhow!(
                "viewport streaming requires --geom-mode triangles (got {other})"
            ))
        }
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

    Ok(ViewportRuntime {
        single_instances,
        multi_instances,
        cell_bbox_local,
        cell_max_radius,
        last_fingerprint: None,
    })
}

pub fn stream_viewport_geometry(
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
        let local_bbox = *rt
            .cell_bbox_local
            .get(cell_name)
            .unwrap_or(&(0.0, 0.0, 0.0, 0.0));
        for t in transforms {
            let tb = transform_bbox(t, local_bbox);
            if !bbox_intersects(tb, view) {
                continue;
            }
            for poly in &cell.polygons {
                if !active_layers.is_empty()
                    && !active_layers.contains(&(poly.layer, poly.datatype))
                {
                    continue;
                }
                let key = format!("{}_{}", poly.layer, poly.datatype);
                push_triangles_transformed(
                    &key,
                    poly,
                    t,
                    &mut tri_builders,
                    args,
                    transport,
                    WsChunkKind::FlatTriangles,
                    None,
                )?;
            }
        }
    }
    flush_all_triangle_builders(
        &mut tri_builders,
        args,
        transport,
        WsChunkKind::FlatTriangles,
        None,
    )?;

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
            if tx + radius < view.0
                || tx - radius > view.1
                || ty + radius < view.2
                || ty - radius > view.3
            {
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

    // End snapshot
    send_control(transport, 2, request_id)?;
    Ok(())
}

pub fn stream_viewport_snap_polygons(
    lib: &Library,
    instances_map: &HashMap<usize, Vec<Matrix3x3>>,
    args: &Args,
    transport: &mut dyn ChunkTransport,
    request_id: u32,
    snap_token: &str,
    view: (f64, f64, f64, f64),
    quad_world: Option<[Point; 4]>,
    active_layers: &HashSet<(i16, i16)>,
) -> Result<()> {
    let t0 = Instant::now();
    let mut candidates: u64 = 0;
    let mut accepted: u64 = 0;
    // Begin snapping snapshot (does not affect WebGL render buffers).
    send_control_snap(transport, 1, request_id, snap_token)?;

    // Snap polygon stream format (WS frame version=2, kind=FlatPolygons):
    // payload = u32 polyCount, then per poly:
    //   u32 instance_id
    //   u32 poly_index
    //   u32 nPoints
    //   nPoints * (f32 x, f32 y)
    // NOTE: We intentionally do NOT reuse PolyChunkBuilder / push_polygon_transformed,
    // because those are also used by CHUNK_B64 (canvas) decoding which expects the v1 payload.
    #[derive(Default)]
    struct SnapPolyChunkBuilder {
        chunk_index: u32,
        poly_count: u32,
        buffer: Vec<u8>,
    }

    impl SnapPolyChunkBuilder {
        fn ensure_chunk_started(&mut self) {
            if self.buffer.is_empty() {
                self.buffer.extend_from_slice(&0u32.to_le_bytes());
                self.poly_count = 0;
            }
        }

        fn push(
            &mut self,
            poly: &Polygon,
            transform: &Matrix3x3,
            instance_id: u32,
            poly_index: u32,
        ) {
            self.ensure_chunk_started();
            self.poly_count += 1;

            self.buffer.extend_from_slice(&instance_id.to_le_bytes());
            self.buffer.extend_from_slice(&poly_index.to_le_bytes());
            self.buffer
                .extend_from_slice(&(poly.points.len() as u32).to_le_bytes());
            for p in &poly.points {
                let pt = transform.transform_point(p);
                self.buffer.extend_from_slice(&(pt.x as f32).to_le_bytes());
                self.buffer.extend_from_slice(&(pt.y as f32).to_le_bytes());
            }
        }

        fn flush(
            &mut self,
            layer_key: &str,
            transport: &mut dyn ChunkTransport,
            snap_token: &str,
        ) -> Result<()> {
            if self.poly_count == 0 {
                return Ok(());
            }
            self.buffer[0..4].copy_from_slice(&self.poly_count.to_le_bytes());
            transport.send(
                WsChunkKind::FlatPolygons,
                layer_key,
                Some(snap_token),
                self.chunk_index,
                0,
                &self.buffer,
            )?;

            self.chunk_index += 1;
            self.poly_count = 0;
            self.buffer.clear();
            Ok(())
        }
    }

    let mut builders: HashMap<String, SnapPolyChunkBuilder> = HashMap::new();

    fn cross(ax: f64, ay: f64, bx: f64, by: f64) -> f64 {
        ax * by - ay * bx
    }

    fn order_quad_points(q: &[Point; 4]) -> [Point; 4] {
        // The incoming quadWorld may be provided in a screen-corner order that,
        // after transforms (flip/rotate), is not a proper cyclic order in world.
        // Reorder into a consistent convex cycle by angle-sort around centroid.
        let cx = (q[0].x + q[1].x + q[2].x + q[3].x) * 0.25;
        let cy = (q[0].y + q[1].y + q[2].y + q[3].y) * 0.25;
        let mut pts: Vec<(f64, Point)> = q
            .iter()
            .map(|p| ((p.y - cy).atan2(p.x - cx), p.clone()))
            .collect();
        pts.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
        [
            pts[0].1.clone(),
            pts[1].1.clone(),
            pts[2].1.clone(),
            pts[3].1.clone(),
        ]
    }

    fn quad_cross_epsilon(q: &[Point; 4]) -> f64 {
        // Cross products scale with length^2. Use a scale-aware epsilon so that
        // points extremely close to edges (or numeric noise near axes) don't flip sign.
        let mut min_x = q[0].x;
        let mut max_x = q[0].x;
        let mut min_y = q[0].y;
        let mut max_y = q[0].y;
        for p in q.iter().skip(1) {
            min_x = min_x.min(p.x);
            max_x = max_x.max(p.x);
            min_y = min_y.min(p.y);
            max_y = max_y.max(p.y);
        }
        let dx = (max_x - min_x).abs();
        let dy = (max_y - min_y).abs();
        let l = dx.max(dy).max(1.0);
        // Empirically chosen: permissive on boundaries but still rejects clear outsides.
        1e-10 * l * l
    }

    fn point_in_convex_quad(p: &Point, q: &[Point; 4], eps: f64) -> bool {
        // Accept either winding by checking if all cross products share the same sign.
        let mut has_pos = false;
        let mut has_neg = false;
        for i in 0..4 {
            let a = &q[i];
            let b = &q[(i + 1) % 4];
            let abx = b.x - a.x;
            let aby = b.y - a.y;
            let apx = p.x - a.x;
            let apy = p.y - a.y;
            let c = cross(abx, aby, apx, apy);
            if c > eps {
                has_pos = true;
            } else if c < -eps {
                has_neg = true;
            }
            if has_pos && has_neg {
                return false;
            }
        }
        true
    }

    let quad_ordered: Option<[Point; 4]> = quad_world.as_ref().map(order_quad_points);
    let quad_eps: f64 = quad_ordered
        .as_ref()
        .map(quad_cross_epsilon)
        .unwrap_or(0.0);

    let ordered = crate::instance_order::ordered_instances(instances_map);
    for inst in ordered {
        let cell = match lib.cells.get(inst.cell_idx) {
            Some(c) => c,
            None => continue,
        };
        if cell.polygons.is_empty() {
            continue;
        }

        for (poly_index, poly) in cell.polygons.iter().enumerate() {
            candidates += 1;
            if !active_layers.contains(&(poly.layer, poly.datatype)) {
                continue;
            }

            let bb = transform_bbox(&inst.matrix, polygon_bbox(poly));
            if quad_world.is_some() {
                // For final hits, require the polygon bbox to be fully inside the view bbox.
                // This is a fast reject before the more expensive per-vertex quad test.
                if bb.0 < view.0 || bb.1 > view.1 || bb.2 < view.2 || bb.3 > view.3 {
                    continue;
                }
            } else if !bbox_intersects(bb, view) {
                continue;
            }

            if let Some(q) = &quad_ordered {
                let mut inside = true;
                for p in &poly.points {
                    let pt = inst.matrix.transform_point(p);
                    if !point_in_convex_quad(&pt, q, quad_eps) {
                        inside = false;
                        break;
                    }
                }
                if !inside {
                    continue;
                }
            }

            accepted += 1;

            let key = format!("{}_{}", poly.layer, poly.datatype);
            let builder = builders.entry(key.clone()).or_default();
            builder.push(poly, &inst.matrix, inst.instance_id, poly_index as u32);

            if args.chunk_size > 0 && (builder.poly_count as usize) >= args.chunk_size {
                builder.flush(&key, transport, snap_token)?;
            }
        }
    }

    for (layer_key, builder) in builders.iter_mut() {
        builder.flush(layer_key, transport, snap_token)?;
    }
    send_control_snap(transport, 2, request_id, snap_token)?;

    if quad_world.is_some() {
        eprintln!(
            "[viewportSnap quadWorld] req_id={} token={} candidates={} accepted={} ms={}",
            request_id,
            snap_token,
            candidates,
            accepted,
            t0.elapsed().as_millis()
        );
    }
    Ok(())
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
        let local_bbox = *rt
            .cell_bbox_local
            .get(cell_name)
            .unwrap_or(&(0.0, 0.0, 0.0, 0.0));
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
            if tx + radius < view.0
                || tx - radius > view.1
                || ty + radius < view.2
                || ty - radius > view.3
            {
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
            if p.x < bbox.0 {
                bbox.0 = p.x;
            }
            if p.x > bbox.1 {
                bbox.1 = p.x;
            }
            if p.y < bbox.2 {
                bbox.2 = p.y;
            }
            if p.y > bbox.3 {
                bbox.3 = p.y;
            }
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
        if p.x < out.0 {
            out.0 = p.x;
        }
        if p.x > out.1 {
            out.1 = p.x;
        }
        if p.y < out.2 {
            out.2 = p.y;
        }
        if p.y > out.3 {
            out.3 = p.y;
        }
    }
    if out.0 == f64::MAX {
        (0.0, 0.0, 0.0, 0.0)
    } else {
        out
    }
}

fn send_control(transport: &mut dyn ChunkTransport, opcode: u8, request_id: u32) -> Result<()> {
    let mut payload = Vec::with_capacity(1 + 4);
    payload.push(opcode);
    payload.extend_from_slice(&request_id.to_le_bytes());
    transport.send(WsChunkKind::Control, "", None, 0, 0, &payload)
}

fn send_control_snap(
    transport: &mut dyn ChunkTransport,
    opcode: u8,
    request_id: u32,
    snap_token: &str,
) -> Result<()> {
    let mut payload = Vec::with_capacity(1 + 4);
    payload.push(opcode);
    payload.extend_from_slice(&request_id.to_le_bytes());
    // Use a reserved layer_key so the webview can distinguish this from render viewport snapshots.
    // Encode token in cell_name so the webview can drop stale polygon chunks.
    transport.send(
        WsChunkKind::Control,
        "__snap__",
        Some(snap_token),
        0,
        0,
        &payload,
    )
}

fn polygon_bbox(poly: &Polygon) -> (f64, f64, f64, f64) {
    let mut bbox = (f64::MAX, f64::MIN, f64::MAX, f64::MIN);
    for p in &poly.points {
        if p.x < bbox.0 {
            bbox.0 = p.x;
        }
        if p.x > bbox.1 {
            bbox.1 = p.x;
        }
        if p.y < bbox.2 {
            bbox.2 = p.y;
        }
        if p.y > bbox.3 {
            bbox.3 = p.y;
        }
    }
    if bbox.0 == f64::MAX {
        (0.0, 0.0, 0.0, 0.0)
    } else {
        bbox
    }
}
