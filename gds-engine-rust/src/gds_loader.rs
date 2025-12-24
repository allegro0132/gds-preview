use crate::gds_parser::{GdsReader, GdsData};
use crate::geometry::{Library, Cell, Polygon, Reference, Label, Point};
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
                });
            }
            0x06 => { // STRNAME
                if let (Some(ref mut cell), GdsData::Str(name)) = (&mut current_cell, record.data) {
                    cell.name = name;
                }
            }
            0x07 => { // ENDSTR
                if let Some(cell) = current_cell.take() {
                    library.cells.push(cell);
                }
            }
            0x08 => { el_type = ElementType::Boundary; current_xy.clear(); current_layer = 0; current_datatype = 0; }
            0x09 => { el_type = ElementType::Path; current_xy.clear(); current_layer = 0; current_datatype = 0; }
            0x0A => { el_type = ElementType::Sref; current_xy.clear(); current_sname.clear(); current_angle = None; current_mag = None; current_strans = 0; }
            0x0B => { el_type = ElementType::Aref; current_xy.clear(); current_sname.clear(); current_angle = None; current_mag = None; current_strans = 0; current_colrow = (1, 1); }
            0x0C => { el_type = ElementType::Text; current_xy.clear(); current_layer = 0; current_texttype = 0; current_str.clear(); current_angle = None; current_mag = None; current_strans = 0; }
            
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
            _ => {}
        }
    }
    
    Ok(library)
}