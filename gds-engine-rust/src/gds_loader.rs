use crate::gds_parser::{GdsData, GdsReader};
use crate::geometry::{Cell, Label, Library, Point, Polygon, Port, Reference};
use anyhow::Result;
use std::io::Read;

#[derive(Debug, PartialEq)]
enum ElementType {
    None,
    Boundary,
    Path,
    Sref,
    Aref,
    Text,
}

pub fn load_gds<R: Read>(reader: R) -> Result<Library> {
    let mut gds_reader = GdsReader::new(reader);
    let mut library = Library::new();
    let mut current_cell: Option<Cell> = None;

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

    // Property handling
    let mut current_prop_attr: Option<i16> = None;
    let mut current_properties: Vec<(i16, String)> = Vec::new();

    while let Some(record) = gds_reader.next_record()? {
        match record.rectype {
            0x01 => {} // BGNLIB
            0x02 => { // LIBNAME
                if let GdsData::Str(name) = record.data {
                    library.name = name;
                }
            }
            0x03 => { // UNITS
                if let GdsData::Real8(units) = record.data {
                    if units.len() >= 2 {
                        library.units = (units[0], units[1]);
                    }
                }
            }
            0x05 => { // BGNSTR
                current_cell = Some(Cell {
                    name: String::new(),
                    polygons: Vec::new(),
                    references: Vec::new(),
                    labels: Vec::new(),
                    ports: Vec::new(),
                });
                current_properties.clear();
            }
            0x06 => { // STRNAME
                if let (Some(ref mut cell), GdsData::Str(name)) = (&mut current_cell, record.data) {
                    cell.name = name;
                }
            }
                                    0x07 => { // ENDSTR
                                        // Process cell-level properties if any (e.g. at end of cell?)
                                        if let Some(ref mut cell) = current_cell {
                                            process_properties(&current_properties, cell, library.units);
                                        }
                                        current_properties.clear();
                                        if let Some(cell) = current_cell.take() {
                                            library.cells.push(cell);
                                        }
                                    }
                                    0x08 => {
                                        if let Some(ref mut cell) = current_cell { process_properties(&current_properties, cell, library.units); }
                                        current_properties.clear();
                                        el_type = ElementType::Boundary; current_xy.clear(); current_layer = 0; current_datatype = 0;
                                    }
                                    0x09 => {
                                        if let Some(ref mut cell) = current_cell { process_properties(&current_properties, cell, library.units); }
                                        current_properties.clear();
                                        el_type = ElementType::Path; current_xy.clear(); current_layer = 0; current_datatype = 0;
                                    }
                                    0x0A => {
                                        if let Some(ref mut cell) = current_cell { process_properties(&current_properties, cell, library.units); }
                                        current_properties.clear();
                                        el_type = ElementType::Sref; current_xy.clear(); current_sname.clear(); current_angle = None; current_mag = None; current_strans = 0;
                                    }
                                    0x0B => {
                                        if let Some(ref mut cell) = current_cell { process_properties(&current_properties, cell, library.units); }
                                        current_properties.clear();
                                        el_type = ElementType::Aref; current_xy.clear(); current_sname.clear(); current_angle = None; current_mag = None; current_strans = 0; current_colrow = (1, 1);
                                    }
                                    0x0C => {
                                        if let Some(ref mut cell) = current_cell { process_properties(&current_properties, cell, library.units); }
                                        current_properties.clear();
                                        el_type = ElementType::Text; current_xy.clear(); current_layer = 0; current_texttype = 0; current_str.clear(); current_angle = None; current_mag = None; current_strans = 0;
                                    }

                                    0x0D => if let GdsData::Int16(v) = record.data { current_layer = v[0]; }
                                    0x0E => if let GdsData::Int16(v) = record.data { current_datatype = v[0]; }
                                    0x10 => { // XY
                                        if let GdsData::Int32(v) = record.data {
                                            let scale = library.units.1 / 1e-6;
                                            for i in (0..v.len()).step_by(2) {
                                                current_xy.push(Point {
                                                    x: v[i] as f64 * scale,
                                                    y: v[i+1] as f64 * scale
                                                });
                                            }
                                        }
                                    }
                                    0x11 => { // ENDEL
                                        if let Some(ref mut cell) = current_cell {
                                            // Process element properties
                                            process_properties(&current_properties, cell, library.units);
                                            current_properties.clear();

                                            match el_type {

                                    ElementType::Boundary | ElementType::Path => {
                                        cell.polygons.push(Polygon {
                                            layer: current_layer,
                                            datatype: current_datatype,
                                            points: current_xy.clone(),
                                        });
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
                                                    y: (current_xy[1].y - origin.y) / (current_colrow.0 as f64)
                                                }
                                            } else { Point { x: 0.0, y: 0.0 } };

                                            let row_step = if current_colrow.1 > 0 {
                                                Point {
                                                    x: (current_xy[2].x - origin.x) / (current_colrow.1 as f64),
                                                    y: (current_xy[2].y - origin.y) / (current_colrow.1 as f64)
                                                }
                                            } else { Point { x: 0.0, y: 0.0 } };

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
                        0x12 => if let GdsData::Str(name) = record.data { current_sname = name; }
                        0x13 => if let GdsData::Int16(v) = record.data { if v.len() >= 2 { current_colrow = (v[0] as u16, v[1] as u16); } }
                        0x18 => if let GdsData::Int16(v) = record.data { current_texttype = v[0]; }
                        0x19 => if let GdsData::Str(s) = record.data { current_str = s; }
                        0x1A => if let GdsData::BitArray(v) = record.data { current_strans = v; }
                        0x1B => if let GdsData::Real8(v) = record.data { current_mag = Some(v[0]); }
                        0x1C => if let GdsData::Real8(v) = record.data { current_angle = Some(v[0]); }

                        // Property Records
                        0x2B => if let GdsData::Int16(v) = record.data { current_prop_attr = Some(v[0]); }
                        0x2C => if let GdsData::Str(s) = record.data {
                            if let Some(attr) = current_prop_attr {
                                current_properties.push((attr, s));
                            }
                        }
                        _ => {}
                    }
                }

                Ok(library)
            }

            fn process_properties(properties: &[(i16, String)], cell: &mut Cell, units: (f64, f64)) {
                for (_attr, val) in properties {
                    if val.contains("'port_type'") {
                        if let Some(port) = parse_port_string(val, units) {
                            cell.ports.push(port);
                        }
                    }
                }
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
                        let pat_len = if val[idx..].starts_with(&key_pat1) { key_pat1.len() } else { key_pat2.len() };
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
                         let pat_len = if val[idx..].starts_with(&key_pat1) { key_pat1.len() } else { key_pat2.len() };
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
                            if let Ok(vx) = coords[0].parse::<f64>() { x = vx; }
                            if let Ok(vy) = coords[1].parse::<f64>() { y = vy; }
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
