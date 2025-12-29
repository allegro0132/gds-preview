use crate::gds_parser::{GdsData, GdsReader};
use crate::geometry::{Cell, Label, Library, Point, Polygon, Port, Reference};
use anyhow::Result;
use std::collections::HashMap;
use std::io::Read;

#[derive(Debug, PartialEq)]
enum ElementType {
    None,
    Boundary,
    Path,
    Box,
    Sref,
    Aref,
    Text,
}

pub fn load_gds<R: Read>(reader: R) -> Result<Library> {
    let mut gds_reader = GdsReader::new(reader);
    let mut library = Library::new();
    let mut current_cell: Option<Cell> = None;

    // In some KLayout/kfactory encodings, per-cell META (including ports) is stored
    // as properties on SREF/AREF elements inside $$$CONTEXT_INFO$$$.
    // We collect those ports and attach them to the referenced cell once that cell exists.
    let mut pending_cell_ports: HashMap<String, Vec<Port>> = HashMap::new();

    let mut el_type = ElementType::None;
    let mut current_layer: i16 = 0;
    let mut current_datatype: i16 = 0;
    let mut current_texttype: i16 = 0;
    let mut current_xy: Vec<Point> = Vec::new();
    let mut current_str: String = String::new();
    let mut current_sname: String = String::new();
    let mut current_angle: Option<f64> = None;
    let mut current_mag: Option<f64> = None;
    let mut current_strans: u16 = 0;
    let mut current_colrow: (u16, u16) = (1, 1);

    // BOX handling (BOXTYPE is distinct from DATATYPE in GDSII)
    let mut current_boxtype: i16 = 0;

    // PATH handling
    let mut current_width: Option<f64> = None; // in output units (microns)
    let mut current_pathtype: i16 = 0;
    let mut current_bgnextn: f64 = 0.0;
    let mut current_endextn: f64 = 0.0;

    // Property handling
    let mut current_prop_attr: Option<i16> = None;
    let mut current_properties: Vec<(i16, String)> = Vec::new();

    while let Some(record) = gds_reader.next_record()? {
        match record.rectype {
            0x01 => {} // BGNLIB
            0x02 => {
                // LIBNAME
                if let GdsData::Str(name) = record.data {
                    library.name = name;
                }
            }
            0x03 => {
                // UNITS
                if let GdsData::Real8(units) = record.data {
                    if units.len() >= 2 {
                        library.units = (units[0], units[1]);
                    }
                }
            }
            0x05 => {
                // BGNSTR
                current_cell = Some(Cell {
                    name: String::new(),
                    polygons: Vec::new(),
                    references: Vec::new(),
                    labels: Vec::new(),
                    ports: Vec::new(),
                });
                current_properties.clear();
            }
            0x06 => {
                // STRNAME
                if let (Some(ref mut cell), GdsData::Str(name)) = (&mut current_cell, record.data) {
                    cell.name = name;

                    if let Some(ports) = pending_cell_ports.remove(&cell.name) {
                        cell.ports.extend(ports);
                    }
                }
            }
            0x07 => {
                // ENDSTR
                // Process cell-level properties if any (e.g. at end of cell?)
                if let Some(ref mut cell) = current_cell {
                    process_properties(&current_properties, cell, library.units);

                    if let Some(ports) = pending_cell_ports.remove(&cell.name) {
                        cell.ports.extend(ports);
                    }
                }
                current_properties.clear();
                if let Some(cell) = current_cell.take() {
                    library.cells.push(cell);
                }
            }
            0x08 => {
                if let Some(ref mut cell) = current_cell {
                    process_properties(&current_properties, cell, library.units);
                }
                current_properties.clear();
                el_type = ElementType::Boundary;
                current_xy.clear();
                current_layer = 0;
                current_datatype = 0;
            }
            0x09 => {
                if let Some(ref mut cell) = current_cell {
                    process_properties(&current_properties, cell, library.units);
                }
                current_properties.clear();
                el_type = ElementType::Path;
                current_xy.clear();
                current_layer = 0;
                current_datatype = 0;
                current_width = None;
                current_pathtype = 0;
                current_bgnextn = 0.0;
                current_endextn = 0.0;
            }
            0x2D => {
                if let Some(ref mut cell) = current_cell {
                    process_properties(&current_properties, cell, library.units);
                }
                current_properties.clear();
                el_type = ElementType::Box;
                current_xy.clear();
                current_layer = 0;
                current_boxtype = 0;
            }
            0x0A => {
                if let Some(ref mut cell) = current_cell {
                    process_properties(&current_properties, cell, library.units);
                }
                current_properties.clear();
                el_type = ElementType::Sref;
                current_xy.clear();
                current_sname.clear();
                current_angle = None;
                current_mag = None;
                current_strans = 0;
            }
            0x0B => {
                if let Some(ref mut cell) = current_cell {
                    process_properties(&current_properties, cell, library.units);
                }
                current_properties.clear();
                el_type = ElementType::Aref;
                current_xy.clear();
                current_sname.clear();
                current_angle = None;
                current_mag = None;
                current_strans = 0;
                current_colrow = (1, 1);
            }
            0x0C => {
                if let Some(ref mut cell) = current_cell {
                    process_properties(&current_properties, cell, library.units);
                }
                current_properties.clear();
                el_type = ElementType::Text;
                current_xy.clear();
                current_layer = 0;
                current_texttype = 0;
                current_str.clear();
                current_angle = None;
                current_mag = None;
                current_strans = 0;
            }

            0x0D => {
                if let GdsData::Int16(v) = record.data {
                    current_layer = v[0];
                }
            }
            0x0E => {
                if let GdsData::Int16(v) = record.data {
                    current_datatype = v[0];
                }
            }
            0x2E => {
                if let GdsData::Int16(v) = record.data {
                    if !v.is_empty() {
                        current_boxtype = v[0];
                    }
                }
            }
            0x0F => {
                // WIDTH
                if let GdsData::Int32(v) = record.data {
                    if !v.is_empty() {
                        let scale = library.units.1 / 1e-6;
                        current_width = Some((v[0].abs() as f64) * scale);
                    }
                } else if let GdsData::Int16(v) = record.data {
                    if !v.is_empty() {
                        let scale = library.units.1 / 1e-6;
                        current_width = Some((v[0].abs() as f64) * scale);
                    }
                }
            }
            0x10 => {
                // XY
                if let GdsData::Int32(v) = record.data {
                    let scale = library.units.1 / 1e-6;
                    for i in (0..v.len()).step_by(2) {
                        current_xy.push(Point {
                            x: v[i] as f64 * scale,
                            y: v[i + 1] as f64 * scale,
                        });
                    }
                }
            }
            0x11 => {
                // ENDEL
                if let Some(ref mut cell) = current_cell {
                    // Process element properties
                    let ports = collect_ports(&current_properties, library.units);
                    if !ports.is_empty()
                        && matches!(el_type, ElementType::Sref | ElementType::Aref)
                        && cell.name == "$$$CONTEXT_INFO$$$"
                        && !current_sname.is_empty()
                    {
                        pending_cell_ports
                            .entry(current_sname.clone())
                            .or_default()
                            .extend(ports);
                    } else {
                        cell.ports.extend(ports);
                    }
                    current_properties.clear();

                    match el_type {
                        ElementType::Boundary => {
                            let mut pts = current_xy.clone();
                            // GDSII boundary is closed: last point often repeats first.
                            if pts.len() >= 2 {
                                if let (Some(first), Some(last)) = (pts.first(), pts.last()) {
                                    if (first.x == last.x) && (first.y == last.y) {
                                        pts.pop();
                                    }
                                }
                            }

                            if pts.len() >= 3 {
                                cell.polygons.push(Polygon {
                                    layer: current_layer,
                                    datatype: current_datatype,
                                    points: pts,
                                });
                            }
                        }
                        ElementType::Path => {
                            let width = current_width.unwrap_or(0.0);
                            if width > 0.0 {
                                if let Some(outline) = stroke_path_to_polygon(
                                    &current_xy,
                                    width,
                                    current_pathtype,
                                    current_bgnextn,
                                    current_endextn,
                                ) {
                                    cell.polygons.push(Polygon {
                                        layer: current_layer,
                                        datatype: current_datatype,
                                        points: outline,
                                    });
                                }
                            }
                        }
                        ElementType::Box => {
                            // BOX uses LAYER + BOXTYPE + XY (usually closed like BOUNDARY).
                            let mut pts = current_xy.clone();
                            if pts.len() >= 2 {
                                if let (Some(first), Some(last)) = (pts.first(), pts.last()) {
                                    if (first.x == last.x) && (first.y == last.y) {
                                        pts.pop();
                                    }
                                }
                            }
                            if pts.len() >= 3 {
                                cell.polygons.push(Polygon {
                                    layer: current_layer,
                                    datatype: current_boxtype,
                                    points: pts,
                                });
                            }
                        }
                        ElementType::Sref => {
                            if !current_xy.is_empty() {
                                cell.references.push(Reference {
                                    cell_name: current_sname.clone(),
                                    origin: current_xy[0].clone(),
                                    rotation: current_angle.map(|a| a.to_radians()),
                                    magnification: current_mag,
                                    x_reflection: (current_strans & 0x8000) != 0,
                                    columns: 1,
                                    rows: 1,
                                    col_spacing: Point { x: 0.0, y: 0.0 },
                                    row_spacing: Point { x: 0.0, y: 0.0 },
                                });
                            }
                        }
                        ElementType::Aref => {
                            if current_xy.len() >= 3 {
                                // GDSII AREF XY: 1: Origin, 2: Col Vector End, 3: Row Vector End
                                let origin = current_xy[0].clone();
                                let col_step = if current_colrow.0 > 0 {
                                    Point {
                                        x: (current_xy[1].x - origin.x) / (current_colrow.0 as f64),
                                        y: (current_xy[1].y - origin.y) / (current_colrow.0 as f64),
                                    }
                                } else {
                                    Point { x: 0.0, y: 0.0 }
                                };

                                let row_step = if current_colrow.1 > 0 {
                                    Point {
                                        x: (current_xy[2].x - origin.x) / (current_colrow.1 as f64),
                                        y: (current_xy[2].y - origin.y) / (current_colrow.1 as f64),
                                    }
                                } else {
                                    Point { x: 0.0, y: 0.0 }
                                };

                                cell.references.push(Reference {
                                    cell_name: current_sname.clone(),
                                    origin: origin.clone(),
                                    rotation: current_angle.map(|a| a.to_radians()),
                                    magnification: current_mag,
                                    x_reflection: (current_strans & 0x8000) != 0,
                                    columns: current_colrow.0,
                                    rows: current_colrow.1,
                                    col_spacing: col_step,
                                    row_spacing: row_step,
                                });
                            }
                        }
                        ElementType::Text => {
                            if !current_xy.is_empty() {
                                cell.labels.push(Label {
                                    layer: current_layer,
                                    texttype: current_texttype,
                                    text: current_str.clone(),
                                    x: current_xy[0].x,
                                    y: current_xy[0].y,
                                    rotation: current_angle.map(|a| a.to_radians()),
                                    magnification: current_mag,
                                    anchor: 0, // Placeholder
                                });
                            }
                        }
                        ElementType::None => {}
                    }
                }
                el_type = ElementType::None;
            }
            0x12 => {
                if let GdsData::Str(name) = record.data {
                    current_sname = name;
                }
            }
            0x13 => {
                if let GdsData::Int16(v) = record.data {
                    if v.len() >= 2 {
                        current_colrow = (v[0] as u16, v[1] as u16);
                    }
                }
            }
            0x18 => {
                if let GdsData::Int16(v) = record.data {
                    current_texttype = v[0];
                }
            }
            0x19 => {
                if let GdsData::Str(s) = record.data {
                    current_str = s;
                }
            }
            0x1A => {
                if let GdsData::BitArray(v) = record.data {
                    current_strans = v;
                }
            }
            0x1B => {
                if let GdsData::Real8(v) = record.data {
                    current_mag = Some(v[0]);
                }
            }
            0x1C => {
                if let GdsData::Real8(v) = record.data {
                    current_angle = Some(v[0]);
                }
            }

            0x21 => {
                if let GdsData::Int16(v) = record.data {
                    if !v.is_empty() {
                        current_pathtype = v[0];
                    }
                }
            }
            0x30 => {
                // BGNEXTN
                if let GdsData::Int32(v) = record.data {
                    if !v.is_empty() {
                        let scale = library.units.1 / 1e-6;
                        current_bgnextn = v[0] as f64 * scale;
                    }
                }
            }
            0x31 => {
                // ENDEXTN
                if let GdsData::Int32(v) = record.data {
                    if !v.is_empty() {
                        let scale = library.units.1 / 1e-6;
                        current_endextn = v[0] as f64 * scale;
                    }
                }
            }

            // Property Records
            0x2B => {
                if let GdsData::Int16(v) = record.data {
                    current_prop_attr = Some(v[0]);
                }
            }
            0x2C => {
                if let GdsData::Str(s) = record.data {
                    if let Some(attr) = current_prop_attr {
                        current_properties.push((attr, s));
                    }
                }
            }
            _ => {}
        }
    }

    Ok(library)
}

fn stroke_path_to_polygon(
    centerline: &[Point],
    width: f64,
    pathtype: i16,
    bgnextn: f64,
    endextn: f64,
) -> Option<Vec<Point>> {
    if centerline.len() < 2 || width <= 0.0 {
        return None;
    }

    let hw = width * 0.5;

    // Copy and optionally extend endpoints along their tangents.
    let mut pts: Vec<Point> = centerline.to_vec();

    let tangent = |a: &Point, b: &Point| -> Option<(f64, f64)> {
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let len = (dx * dx + dy * dy).sqrt();
        if len <= 0.0 {
            None
        } else {
            Some((dx / len, dy / len))
        }
    };

    // pathtype handling: mimic GDSTK mapping (0 Flush, 1 Round, 2 HalfWidth, else Extended).
    // For our polygonization, we only model end extensions (caps). Joins use miter.
    let mut ext_start = bgnextn;
    let mut ext_end = endextn;
    if pathtype == 2 {
        ext_start += hw;
        ext_end += hw;
    }

    // Extend start point backwards
    if ext_start != 0.0 {
        if let Some((tx, ty)) = tangent(&pts[0], &pts[1]) {
            pts[0].x -= tx * ext_start;
            pts[0].y -= ty * ext_start;
        }
    }

    // Extend end point forwards
    if ext_end != 0.0 {
        let n = pts.len();
        if let Some((tx, ty)) = tangent(&pts[n - 2], &pts[n - 1]) {
            pts[n - 1].x += tx * ext_end;
            pts[n - 1].y += ty * ext_end;
        }
    }

    // Precompute segment normals.
    let mut seg_normals: Vec<(f64, f64)> = Vec::with_capacity(pts.len() - 1);
    for i in 0..(pts.len() - 1) {
        if let Some((tx, ty)) = tangent(&pts[i], &pts[i + 1]) {
            // Left normal
            seg_normals.push((-ty, tx));
        } else {
            seg_normals.push((0.0, 0.0));
        }
    }

    // Build left/right offset points with miter joins.
    let mut left: Vec<Point> = Vec::with_capacity(pts.len());
    let mut right: Vec<Point> = Vec::with_capacity(pts.len());

    for i in 0..pts.len() {
        let (nx, ny, miter_len) = if i == 0 {
            let (nx, ny) = seg_normals[0];
            (nx, ny, hw)
        } else if i == pts.len() - 1 {
            let (nx, ny) = seg_normals[seg_normals.len() - 1];
            (nx, ny, hw)
        } else {
            let (n1x, n1y) = seg_normals[i - 1];
            let (n2x, n2y) = seg_normals[i];
            let mx = n1x + n2x;
            let my = n1y + n2y;
            let mlen = (mx * mx + my * my).sqrt();
            if mlen <= 1e-12 {
                (n2x, n2y, hw)
            } else {
                let ux = mx / mlen;
                let uy = my / mlen;
                let dot = ux * n2x + uy * n2y;
                if dot.abs() <= 1e-6 {
                    (n2x, n2y, hw)
                } else {
                    (ux, uy, hw / dot)
                }
            }
        };

        left.push(Point {
            x: pts[i].x + nx * miter_len,
            y: pts[i].y + ny * miter_len,
        });
        right.push(Point {
            x: pts[i].x - nx * miter_len,
            y: pts[i].y - ny * miter_len,
        });
    }

    // Round caps (pathtype == 1) are not implemented (kept as square caps).
    // This keeps implementation minimal while fixing the reported wrong geometry.

    // Combine to a single polygon ring.
    let mut out: Vec<Point> = Vec::with_capacity(left.len() + right.len());
    out.extend_from_slice(&left);
    for p in right.iter().rev() {
        out.push(p.clone());
    }

    // Remove immediate duplicates to keep earcut stable.
    out.dedup_by(|a, b| a.x == b.x && a.y == b.y);
    if out.len() >= 3 {
        Some(out)
    } else {
        None
    }
}

fn collect_ports(properties: &[(i16, String)], units: (f64, f64)) -> Vec<Port> {
    let mut out: Vec<Port> = Vec::new();
    for (_attr, val) in properties {
        // KLayout META strings generally include 'port_type', but key quoting/format
        // can vary slightly across versions and GDS/OAS.
        if val.contains("port_type") {
            if let Some(port) = parse_port_string(val, units) {
                out.push(port);
            }
        }
    }
    out
}

fn process_properties(properties: &[(i16, String)], cell: &mut Cell, units: (f64, f64)) {
    cell.ports.extend(collect_ports(properties, units));
}

pub fn parse_port_string(val: &str, units: (f64, f64)) -> Option<Port> {
    // Format: META('...')={'key'=>'value', ...}
    // or just {'key'=>'value', ...}
    // Keys are quoted. Separator is => or :.

    let extract = |key: &str| -> Option<String> {
        // Try 'key'=>
        let key_pat1 = format!("'{}'=>", key);
        // Try 'key':
        let key_pat2 = format!("'{}':", key);

        let start = val.find(&key_pat1).or(val.find(&key_pat2));

        if let Some(idx) = start {
            // Determine length of matched pattern
            let pat_len = if val[idx..].starts_with(&key_pat1) {
                key_pat1.len()
            } else {
                key_pat2.len()
            };
            let rest = &val[idx + pat_len..].trim();

            if rest.starts_with('\'') {
                if let Some(end) = rest[1..].find('\'') {
                    return Some(rest[1..end + 1].to_string());
                }
            }
        }
        None
    };

    let name = extract("name").unwrap_or_else(|| "unknown".to_string());
    let port_type = extract("port_type").unwrap_or_else(|| "optical".to_string());
    let layer = if port_type == "optical" { 1 } else { 71 };

    // Transform extraction
    // 'dcplx_trans'=>[dcplxtrans:r45 *1 38.75,1238.75]
    // 'trans'=>[trans:r0 -11500,1209500]

    let extract_trans = |key: &str, prefix: &str| -> Option<String> {
        // Try 'key'=>[prefix:
        let key_pat1 = format!("'{}'=>[{}:", key, prefix);
        // Try 'key':[prefix:
        let key_pat2 = format!("'{}':[{}:", key, prefix);

        let start = val.find(&key_pat1).or(val.find(&key_pat2));

        if let Some(idx) = start {
            let pat_len = if val[idx..].starts_with(&key_pat1) {
                key_pat1.len()
            } else {
                key_pat2.len()
            };
            let rest = &val[idx + pat_len..];
            if let Some(end) = rest.find(']') {
                return Some(rest[..end].to_string());
            }
        }
        None
    };

    let dcplx_trans = extract_trans("dcplx_trans", "dcplxtrans");
    let trans = extract_trans("trans", "trans");

    let trans_str = dcplx_trans.clone().or(trans.clone());

    let (rot_rad, _mag, mut x, mut y) = if let Some(ts) = trans_str {
        parse_transform_string(&ts)
    } else {
        (0.0, 1.0, 0.0, 0.0)
    };

    // If we used 'trans' (and not 'dcplx_trans'), we need to scale DBU to microns
    if dcplx_trans.is_none() && trans.is_some() {
        let scale = units.1 / 1e-6;
        x *= scale;
        y *= scale;
    }

    Some(Port {
        name,
        x,
        y,
        rotation: rot_rad,
        layer,
        port_type,
    })
}

fn parse_transform_string(s: &str) -> (f64, f64, f64, f64) {
    // Format: r0 *1 1074,-1462.5
    // or: m135 ...
    // r = rotation (degrees), m = mirror + rotation?
    // In kfactory/klayout:
    // r0, r90, r180, r270 are rotations.
    // m0, m90... are x-reflection + rotation.
    // *1 is magnification.
    // x,y are coordinates.

    let mut rotation = 0.0;
    let mut magnification = 1.0;
    let mut x = 0.0;
    let mut y = 0.0;
    // let mut mirror = false;

    let parts: Vec<&str> = s.split_whitespace().collect();
    for part in parts {
        if part.starts_with('r') {
            if let Ok(val) = part[1..].parse::<f64>() {
                rotation = val;
            }
        } else if part.starts_with('m') {
            // mirror = true;
            if let Ok(val) = part[1..].parse::<f64>() {
                rotation = val;
            }
        } else if part.starts_with('*') {
            if let Ok(val) = part[1..].parse::<f64>() {
                magnification = val;
            }
        } else if part.contains(',') {
            let coords: Vec<&str> = part.split(',').collect();
            if coords.len() >= 2 {
                if let Ok(vx) = coords[0].parse::<f64>() {
                    x = vx;
                }
                if let Ok(vy) = coords[1].parse::<f64>() {
                    y = vy;
                }
            }
        }
    }

    // NOTE: KLayout 'trans' uses DBU (integers), 'dcplx_trans' uses microns (floats).
    // The parser above handles floats. If it was integer, it parse as float too.
    // We assume the caller handles unit conversion if needed, OR we assume GDS usually uses dcplx_trans for this metadata.
    // The python code checks "is_complex". If not, it multiplies by DBU.
    // Here we can't easily access DBU inside this helper.
    // However, the example data showed `dcplx_trans` which is microns.
    // If `trans` is used, it might be large integers.
    // Let's assume microns for now as `dcplx_trans` was present in `inspect_meta` output.

    // Convert rotation to radians
    let rot_rad = rotation.to_radians();
    // If mirror (x-reflection), it effectively flips y-axis before rotation?
    // In GDSII, reflection is about X-axis.
    // klayout 'm' usually means mirrored.

    (rot_rad, magnification, x, y)
}
