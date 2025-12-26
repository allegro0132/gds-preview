use std::collections::HashMap;
use std::f64::consts::PI;
use std::io::{Read, Seek};

use anyhow::{anyhow, Result};
use flate2::read::ZlibDecoder;

use crate::gds_loader::parse_port_string;
use crate::geometry::{Cell, Label, Library, Point, Polygon, Reference};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OasisRecord {
    Pad = 0,
    Start = 1,
    End = 2,
    CellNameImplicit = 3,
    CellName = 4,
    TextStringImplicit = 5,
    TextString = 6,
    PropNameImplicit = 7,
    PropName = 8,
    PropStringImplicit = 9,
    PropString = 10,
    LayerNameData = 11,
    LayerNameText = 12,
    CellRefNum = 13,
    Cell = 14,
    XyAbsolute = 15,
    XyRelative = 16,
    Placement = 17,
    PlacementTransform = 18,
    Text = 19,
    Rectangle = 20,
    Polygon = 21,
    Path = 22,
    TrapezoidAb = 23,
    TrapezoidA = 24,
    TrapezoidB = 25,
    CTrapezoid = 26,
    Circle = 27,
    Property = 28,
    LastProperty = 29,
    XNameImplicit = 30,
    XName = 31,
    XElement = 32,
    XGeometry = 33,
    CBlock = 34,
}

impl From<u8> for OasisRecord {
    fn from(value: u8) -> Self {
        match value {
            1 => Self::Start,
            2 => Self::End,
            3 => Self::CellNameImplicit,
            4 => Self::CellName,
            5 => Self::TextStringImplicit,
            6 => Self::TextString,
            7 => Self::PropNameImplicit,
            8 => Self::PropName,
            9 => Self::PropStringImplicit,
            10 => Self::PropString,
            11 => Self::LayerNameData,
            12 => Self::LayerNameText,
            13 => Self::CellRefNum,
            14 => Self::Cell,
            15 => Self::XyAbsolute,
            16 => Self::XyRelative,
            17 => Self::Placement,
            18 => Self::PlacementTransform,
            19 => Self::Text,
            20 => Self::Rectangle,
            21 => Self::Polygon,
            22 => Self::Path,
            23 => Self::TrapezoidAb,
            24 => Self::TrapezoidA,
            25 => Self::TrapezoidB,
            26 => Self::CTrapezoid,
            27 => Self::Circle,
            28 => Self::Property,
            29 => Self::LastProperty,
            30 => Self::XNameImplicit,
            31 => Self::XName,
            32 => Self::XElement,
            33 => Self::XGeometry,
            34 => Self::CBlock,
            _ => Self::Pad,
        }
    }
}

#[derive(Debug, Clone, Copy)]
enum OasisDataType {
    RealPositiveInteger = 0,
    RealNegativeInteger = 1,
    RealPositiveReciprocal = 2,
    RealNegativeReciprocal = 3,
    RealPositiveRatio = 4,
    RealNegativeRatio = 5,
    RealFloat = 6,
    RealDouble = 7,
    UnsignedInteger = 8,
    SignedInteger = 9,
    AString = 10,
    BString = 11,
    NString = 12,
    ReferenceA = 13,
    ReferenceB = 14,
    ReferenceN = 15,
}


#[derive(Debug, Default, Clone, Copy)]
struct RectRepetition {
    columns: u16,
    rows: u16,
    spacing_x: f64,
    spacing_y: f64,
}

#[derive(Debug, Clone)]
enum Repetition {
    Rect(RectRepetition),
    Offsets(Vec<Point>),
    Regular { columns: u16, rows: u16, v1: Point, v2: Point },
}

#[derive(Debug)]
struct OasisStream<R: Read + Seek> {
    reader: R,
    buffer: Option<Vec<u8>>,
    cursor: usize,
    pushback: Option<u8>,
    pos: u64,
}

impl<R: Read + Seek> OasisStream<R> {
    fn new(reader: R) -> Self {
        Self {
            reader,
            buffer: None,
            cursor: 0,
            pushback: None,
            pos: 0,
        }
    }

    fn read_exact(&mut self, mut target: &mut [u8]) -> Result<()> {
        while !target.is_empty() {
            if let Some(buf) = &self.buffer {
                if self.cursor >= buf.len() {
                    self.buffer = None;
                    self.cursor = 0;
                    continue;
                }
                let available = buf.len() - self.cursor;
                let take = available.min(target.len());
                target[..take].copy_from_slice(&buf[self.cursor..self.cursor + take]);
                self.cursor += take;
                target = &mut target[take..];
                self.pos += take as u64;
                if self.cursor >= buf.len() {
                    self.buffer = None;
                    self.cursor = 0;
                }
            } else {
                self.reader.read_exact(target)?;
                self.pos += target.len() as u64;
                break;
            }
        }
        Ok(())
    }

    fn read_u8(&mut self) -> Result<u8> {
        if let Some(b) = self.pushback.take() {
            return Ok(b);
        }
        let mut b = [0u8; 1];
        self.read_exact(&mut b)?;
        Ok(b[0])
    }

    fn unread_u8(&mut self, byte: u8) {
        self.pushback = Some(byte);
    }

    fn read_var_uint(&mut self) -> Result<u64> {
        let mut result: u64 = 0;
        let mut shift = 0u8;
        loop {
            let byte = self.read_u8()?;
            result |= ((byte & 0x7F) as u64) << shift;
            if byte & 0x80 == 0 {
                break;
            }
            shift += 7;
        }
        Ok(result)
    }

    fn read_var_int(&mut self, skip_bits: u8) -> Result<(i64, u8)> {
        let mut byte = self.read_u8()?;
        let mut value: i64 = ((byte & 0x7F) >> skip_bits) as i64;
        let bits = byte & ((1 << skip_bits) - 1);
        let mut shift = 7 - skip_bits;
        while byte & 0x80 != 0 {
            byte = self.read_u8()?;
            value |= ((byte & 0x7F) as i64) << shift;
            shift += 7;
        }
        Ok((value, bits))
    }

    fn read_integer(&mut self) -> Result<i64> {
        let (v, bits) = self.read_var_int(1)?;
        if bits & 1 == 1 { Ok(-v) } else { Ok(v) }
    }

    fn read_1delta(&mut self) -> Result<i64> {
        // 1-delta encoding: sign in LSB of first byte, magnitude packed in remaining bits.
        self.read_integer()
    }

    fn read_2delta(&mut self) -> Result<(i64, i64)> {
        // 2-delta encoding stores a direction in the low bits of the first byte.
        let (value, dir_bits) = self.read_var_int(2)?;
        let val = value as i64;
        match dir_bits & 0x03 {
            0 => Ok((val, 0)),   // E
            1 => Ok((0, val)),   // N
            2 => Ok((-val, 0)),  // W
            _ => Ok((0, -val)),  // S
        }
    }

    fn read_3delta(&mut self) -> Result<(i64, i64)> {
        // 3-delta encoding supports diagonals (NE,NW,SW,SE) in addition to axial moves.
        let (value, dir_bits) = self.read_var_int(3)?;
        let val = value as i64;
        match dir_bits & 0x07 {
            0 => Ok((val, 0)),    // E
            1 => Ok((0, val)),    // N
            2 => Ok((-val, 0)),   // W
            3 => Ok((0, -val)),   // S
            4 => Ok((val, val)),  // NE
            5 => Ok((-val, val)), // NW
            6 => Ok((-val, -val)),// SW
            _ => Ok((val, -val)), // SE
        }
    }

    fn read_gdelta(&mut self) -> Result<(i64, i64)> {
        // General delta encoding used by point lists (types 4 and 5).
        // Matches gdstk's oasis_read_gdelta implementation.
        let first = self.read_u8()?;

        // Helper to finish a varint when we've already consumed the first byte
        fn finish_var_int<R: Read + Seek>(stream: &mut OasisStream<R>, skip_bits: u8, first: u8) -> Result<(i64, u8)> {
            let mut value: i64 = ((first & 0x7F) >> skip_bits) as i64;
            let bits = first & ((1 << skip_bits) - 1);
            let mut shift = 7 - skip_bits;
            if first & 0x80 != 0 {
                loop {
                    let byte = stream.read_u8()?;
                    value |= ((byte & 0x7F) as i64) << shift;
                    if byte & 0x80 == 0 { break; }
                    shift += 7;
                }
            }
            Ok((value, bits))
        }

        if first & 0x01 == 0 {
            // Direction-coded branch (axis-aligned or diagonal); direction is in bits1-3, magnitude is varint with skip_bits=4
            let (value, bits) = finish_var_int(self, 4, first)?;
            let value = value as i64;
            let dir = (bits >> 1) & 0x07;
            match dir {
                0 => Ok((value, 0)),      // E
                1 => Ok((0, value)),      // N
                2 => Ok((-value, 0)),     // W
                3 => Ok((0, -value)),     // S
                4 => Ok((value, value)),  // NE
                5 => Ok((-value, value)), // NW
                6 => Ok((-value, -value)),// SW
                _ => Ok((value, -value)), // SE
            }
        } else {
            // Two signed magnitudes (x then y), each encoded with sign bit in LSB of first byte
            let (mut x, sign_x) = finish_var_int(self, 2, first)?;
            if sign_x & 0x02 != 0 { x = -x; }
            let (mut y, sign_y) = self.read_var_int(1)?;
            if sign_y & 0x01 != 0 { y = -y; }
            Ok((x as i64, y as i64))
        }
    }

    fn read_real_by_type(&mut self, kind: OasisDataType) -> Result<f64> {
        Ok(match kind {
            OasisDataType::RealPositiveInteger => self.read_var_uint()? as f64,
            OasisDataType::RealNegativeInteger => -(self.read_var_uint()? as f64),
            OasisDataType::RealPositiveReciprocal => 1.0 / (self.read_var_uint()? as f64),
            OasisDataType::RealNegativeReciprocal => -1.0 / (self.read_var_uint()? as f64),
            OasisDataType::RealPositiveRatio => {
                let num = self.read_var_uint()? as f64;
                let den = self.read_var_uint()? as f64;
                num / den
            }
            OasisDataType::RealNegativeRatio => {
                let num = self.read_var_uint()? as f64;
                let den = self.read_var_uint()? as f64;
                -num / den
            }
            OasisDataType::RealFloat => {
                let mut bytes = [0u8; 4];
                self.read_exact(&mut bytes)?;
                f32::from_le_bytes(bytes) as f64
            }
            OasisDataType::RealDouble => {
                let mut bytes = [0u8; 8];
                self.read_exact(&mut bytes)?;
                f64::from_le_bytes(bytes)
            }
            _ => return Err(anyhow!("Unsupported real type")),
        })
    }

    fn read_real(&mut self) -> Result<f64> {
        let t = self.read_u8()?;
        let kind = match t {
            0 => OasisDataType::RealPositiveInteger,
            1 => OasisDataType::RealNegativeInteger,
            2 => OasisDataType::RealPositiveReciprocal,
            3 => OasisDataType::RealNegativeReciprocal,
            4 => OasisDataType::RealPositiveRatio,
            5 => OasisDataType::RealNegativeRatio,
            6 => OasisDataType::RealFloat,
            7 => OasisDataType::RealDouble,
            _ => return Err(anyhow!("Invalid real type {}", t)),
        };
        self.read_real_by_type(kind)
    }

    fn read_string(&mut self, append_null: bool) -> Result<Vec<u8>> {
        let count = self.read_var_uint()? as usize;
        let mut buf = vec![0u8; count];
        if count > 0 {
            self.read_exact(&mut buf)?;
        }
        if append_null {
            buf.push(0);
        }
        Ok(buf)
    }

    fn read_point_list(&mut self, scale: f64, closed: bool, current: &mut Vec<Point>) -> Result<u8> {
        let list_type = self.read_u8()?;
        let count = self.read_var_uint()? as usize;
        let start_pos = self.pos;

        // Flags encoded in the point-list type byte
        let base_type = list_type & 0x07; // low 3 bits
        let explicit_start = list_type & 0x08 != 0;
        let grid_flag = list_type & 0x80 != 0;

        // Optional grid factor (applies to deltas only). Defaults to 1.0.
        let mut grid: f64 = 1.0;

        // Start from modal points so callers can reuse the decoded list, unless explicit start overrides it.
        let mut pts = current.clone();
        if explicit_start {
            let x0 = self.read_integer()? as f64 * scale;
            let y0 = self.read_integer()? as f64 * scale;
            pts.clear();
            pts.push(Point { x: x0, y: y0 });
        }
        if grid_flag {
            grid = self.read_var_uint()? as f64;
            if grid == 0.0 {
                grid = 1.0;
            }
        }
        if pts.is_empty() {
            pts.push(Point { x: 0.0, y: 0.0 });
        }

        // Lightweight debug to trace early point lists; helps diagnose stream alignment issues.
        const DEBUG_LIMIT: usize = 5;
        static mut PL_DEBUG_COUNT: usize = 0;
        unsafe {
            if PL_DEBUG_COUNT < DEBUG_LIMIT {
                eprintln!(
                    "[oasis] point_list type=0x{:02x} base={} start={} grid={} count={}",
                    list_type,
                    base_type,
                    explicit_start,
                    grid,
                    count
                );
                PL_DEBUG_COUNT += 1;
            }
        }

        match base_type {
            0 | 1 => {
                // Manhattan horizontal-first / vertical-first
                let mut horizontal = base_type == 0;
                let mut last = pts.last().cloned().unwrap_or(Point { x: 0.0, y: 0.0 });
                for _ in 0..count {
                    let delta = self.read_integer()? as f64 * scale * grid;
                    if horizontal {
                        last.x += delta;
                    } else {
                        last.y += delta;
                    }
                    pts.push(last.clone());
                    horizontal = !horizontal;
                }
                if closed {
                    if horizontal {
                        pts.push(Point { x: pts.first().unwrap().x, y: last.y });
                    } else {
                        pts.push(Point { x: last.x, y: pts.first().unwrap().y });
                    }
                }
            }
            2 => {
                // Manhattan (2-delta)
                let mut last = pts.last().cloned().unwrap_or(Point { x: 0.0, y: 0.0 });
                for _ in 0..count {
                    let (dx, dy) = self.read_2delta()?;
                    last.x += dx as f64 * scale * grid;
                    last.y += dy as f64 * scale * grid;
                    pts.push(last.clone());
                }
            }
            3 => {
                // Octangular (3-delta)
                let mut last = pts.last().cloned().unwrap_or(Point { x: 0.0, y: 0.0 });
                let num_pairs = if explicit_start && count > 0 { count - 1 } else { count };
                for _ in 0..num_pairs {
                    let (dx, dy) = self.read_3delta()?;
                    last.x += dx as f64 * scale * grid;
                    last.y += dy as f64 * scale * grid;
                    pts.push(last.clone());
                }
            }
            4 | 5 => {
                // General / Relative (g-delta)
                let mut delta = Point { x: 0.0, y: 0.0 };
                let mut last = pts.last().cloned().unwrap_or(Point { x: 0.0, y: 0.0 });
                for _ in 0..count {
                    let (dx, dy) = self.read_gdelta()?;
                    let dx = dx as f64 * scale * grid;
                    let dy = dy as f64 * scale * grid;
                    if base_type == 5 {
                        delta.x += dx;
                        delta.y += dy;
                        pts.push(Point { x: last.x + delta.x, y: last.y + delta.y });
                    } else {
                        last.x += dx;
                        last.y += dy;
                        pts.push(last.clone());
                    }
                }
            }
            _ => {}
        }

        *current = pts;

        unsafe {
            if PL_DEBUG_COUNT <= DEBUG_LIMIT {
                eprintln!(
                    "[oasis] point_list consumed {} bytes (pos {}->{}), final points={}",
                    self.pos.saturating_sub(start_pos),
                    start_pos,
                    self.pos,
                    current.len()
                );
            }
        }
        Ok(list_type)
    }

    fn read_repetition(&mut self, scale: f64) -> Result<Option<Repetition>> {
        let rtype = self.read_u8()?;
        if rtype == 0 {
            return Ok(None);
        }
        match rtype {
            1 => {
                let cols = 2 + self.read_var_uint()? as u16;
                let rows = 2 + self.read_var_uint()? as u16;
                let spacing_x = self.read_var_uint()? as f64 * scale;
                let spacing_y = self.read_var_uint()? as f64 * scale;
                Ok(Some(Repetition::Rect(RectRepetition { columns: cols, rows, spacing_x, spacing_y })))
            }
            2 => {
                let cols = 2 + self.read_var_uint()? as u16;
                let spacing_x = self.read_var_uint()? as f64 * scale;
                Ok(Some(Repetition::Rect(RectRepetition { columns: cols, rows: 1, spacing_x, spacing_y: 0.0 })))
            }
            3 => {
                let rows = 2 + self.read_var_uint()? as u16;
                let spacing_y = self.read_var_uint()? as f64 * scale;
                Ok(Some(Repetition::Rect(RectRepetition { columns: 1, rows, spacing_x: 0.0, spacing_y })))
            }
            4 | 5 => {
                // Explicit X coordinates
                let mut offsets = Vec::new();
                let mut count = self.read_var_uint()?;
                let mut grid = scale;
                if rtype == 5 {
                    grid *= self.read_var_uint()? as f64;
                }
                let mut x = 0.0;
                while count > 0 {
                    x += self.read_var_uint()? as f64 * grid;
                    offsets.push(Point { x, y: 0.0 });
                    count -= 1;
                }
                Ok(Some(Repetition::Offsets(offsets)))
            }
            6 | 7 => {
                // Explicit Y coordinates
                let mut offsets = Vec::new();
                let mut count = 1 + self.read_var_uint()?;
                let mut grid = scale;
                if rtype == 7 {
                    grid *= self.read_var_uint()? as f64;
                }
                let mut y = 0.0;
                while count > 0 {
                    y += self.read_var_uint()? as f64 * grid;
                    offsets.push(Point { x: 0.0, y });
                    count -= 1;
                }
                Ok(Some(Repetition::Offsets(offsets)))
            }
            8 => {
                // Regular with two vectors
                let cols = 2 + self.read_var_uint()? as u16;
                let rows = 2 + self.read_var_uint()? as u16;
                let (dx1, dy1) = self.read_gdelta()?;
                let (dx2, dy2) = self.read_gdelta()?;
                Ok(Some(Repetition::Regular {
                    columns: cols,
                    rows,
                    v1: Point { x: dx1 as f64 * scale, y: dy1 as f64 * scale },
                    v2: Point { x: dx2 as f64 * scale, y: dy2 as f64 * scale },
                }))
            }
            9 => {
                // Regular with perpendicular vector
                let cols = 2 + self.read_var_uint()? as u16;
                let (dx1, dy1) = self.read_gdelta()?;
                let v1 = Point { x: dx1 as f64 * scale, y: dy1 as f64 * scale };
                let v2 = Point { x: -v1.y, y: v1.x };
                Ok(Some(Repetition::Regular { columns: cols, rows: 1, v1, v2 }))
            }
            10 | 11 => {
                // Explicit offset list
                let mut offsets = Vec::new();
                let count = self.read_var_uint()?; // number of delta entries
                let mut grid = scale;
                if rtype == 11 {
                    grid *= self.read_var_uint()? as f64;
                }
                // First offset is always the origin; the remaining entries are deltas.
                offsets.push(Point { x: 0.0, y: 0.0 });
                let mut v = Point { x: 0.0, y: 0.0 };
                for _ in 0..count {
                    let (dx, dy) = self.read_gdelta()?;
                    v.x += dx as f64 * grid;
                    v.y += dy as f64 * grid;
                    offsets.push(v.clone());
                }
                Ok(Some(Repetition::Offsets(offsets)))
            }
            _ => Ok(None),
        }
    }

    fn enter_cblock(&mut self) -> Result<()> {
        let method = self.read_var_uint()?;
        let uncompressed = self.read_var_uint()?;
        let compressed = self.read_var_uint()?;
        if method != 0 {
            return Err(anyhow!("Unsupported CBLOCK compression method {}", method));
        }
        let mut data = vec![0u8; compressed as usize];
        self.reader.read_exact(&mut data)?;
        let mut decoder = ZlibDecoder::new(&data[..]);
        let mut output = Vec::with_capacity(uncompressed as usize);
        decoder.read_to_end(&mut output)?;
        self.buffer = Some(output);
        self.cursor = 0;
        Ok(())
    }
}

fn push_polygon_with_repetition(
    polys: &mut Vec<Polygon>,
    layer: i16,
    datatype: i16,
    base_points: &[Point],
    repetition: Option<Repetition>,
) {
    // Always push the base geometry
    polys.push(Polygon { layer, datatype, points: base_points.to_vec() });

    match repetition {
        Some(Repetition::Rect(rep)) => {
            for row in 0..rep.rows {
                for col in 0..rep.columns {
                    if row == 0 && col == 0 {
                        continue;
                    }
                    let dx = col as f64 * rep.spacing_x;
                    let dy = row as f64 * rep.spacing_y;
                    let mut pts = Vec::with_capacity(base_points.len());
                    for p in base_points {
                        pts.push(Point { x: p.x + dx, y: p.y + dy });
                    }
                    polys.push(Polygon { layer, datatype, points: pts });
                }
            }
        }
        Some(Repetition::Regular { columns, rows, v1, v2 }) => {
            for row in 0..rows {
                for col in 0..columns {
                    if row == 0 && col == 0 {
                        continue;
                    }
                    let dx = v1.x * col as f64 + v2.x * row as f64;
                    let dy = v1.y * col as f64 + v2.y * row as f64;
                    let mut pts = Vec::with_capacity(base_points.len());
                    for p in base_points {
                        pts.push(Point { x: p.x + dx, y: p.y + dy });
                    }
                    polys.push(Polygon { layer, datatype, points: pts });
                }
            }
        }
        Some(Repetition::Offsets(offsets)) => {
            for off in offsets {
                if off.x == 0.0 && off.y == 0.0 {
                    continue; // base already added
                }
                let mut pts = Vec::with_capacity(base_points.len());
                for p in base_points {
                    pts.push(Point { x: p.x + off.x, y: p.y + off.y });
                }
                polys.push(Polygon { layer, datatype, points: pts });
            }
        }
        None => {}
    }
}

fn trapezoid_points(kind: OasisRecord, pos: Point, dim: Point, delta_a: f64, delta_b: f64) -> Vec<Point> {
    // Very small helper to approximate trapezoids; this follows the gdstk rectangle orientation.
    let mut pts = vec![
        Point { x: pos.x, y: pos.y },
        Point { x: pos.x + dim.x, y: pos.y },
        Point { x: pos.x + dim.x, y: pos.y + dim.y },
        Point { x: pos.x, y: pos.y + dim.y },
    ];
    match kind {
        OasisRecord::TrapezoidAb => {
            pts[0].x += delta_a;
            pts[3].x += delta_a;
            pts[1].x += delta_b;
            pts[2].x += delta_b;
        }
        OasisRecord::TrapezoidA => {
            pts[0].x += delta_a;
            pts[3].x += delta_a;
        }
        OasisRecord::TrapezoidB => {
            pts[1].x += delta_b;
            pts[2].x += delta_b;
        }
        _ => {}
    }
    pts
}

fn circle_points(center: Point, radius: f64, segments: usize) -> Vec<Point> {
    let mut pts = Vec::with_capacity(segments);
    for i in 0..segments {
        let theta = 2.0 * PI * (i as f64) / (segments as f64);
        pts.push(Point {
            x: center.x + radius * theta.cos(),
            y: center.y + radius * theta.sin(),
        });
    }
    pts
}

/// Parse an OASIS file into the internal `Library` representation. This is a pragmatic
/// reader that covers the record types we rely on in the viewer (cells, placements, polygons,
/// rectangles, paths, text, and the most common repetitions). It intentionally omits rarely
/// used records and will silently ignore unsupported constructs.
pub fn load_oasis<R: Read + Seek>(mut reader: R) -> Result<Library> {
    // OASIS header is 14 bytes: "%SEMI-OASIS\r\n" + START record marker 0x01
    let mut header = [0u8; 14];
    reader.read_exact(&mut header)?;
    if &header != b"%SEMI-OASIS\r\n\x01" {
        return Err(anyhow!("Not an OASIS file (missing magic header)"));
    }

    let mut stream = OasisStream::new(reader);

    // START record fields
    let _version = stream.read_string(false)?;
    // if version != b"1.0" {
    //     return Err(anyhow!("Unsupported OASIS version: {:?}", String::from_utf8_lossy(&version)));
    // }

    // Database unit is encoded as a real. The common pattern is "1 / grid_in_microns",
    // so we keep the historical interpretation: scale = 1 / value (DBU to microns).
    let factor = 1.0 / stream.read_real()?;
    let precision = 1e-6 * factor; // DBU size in meters
    let scale = precision / 1e-6; // DBU to microns

    // Offset table: a flag byte followed by 12 varuint offsets when flag == 0.
    // Our inputs set the flag to 0 and all offsets to 0; we consume them to keep alignment.
    let offset_table_flag = stream.read_var_uint()?;
    if offset_table_flag == 0 {
        for _ in 0..12 {
            let _ = stream.read_var_uint()?;
        }
    }

    let mut library = Library::new();
    library.units = (1e-6, precision);

    // Modal state
    let mut modal_absolute_pos = true;
    let mut modal_layer: i16 = 0;
    let mut modal_datatype: i16 = 0;
    let mut modal_textlayer: i16 = 0;
    let mut modal_texttype: i16 = 0;
    let mut modal_geom_pos = Point { x: 0.0, y: 0.0 };
    let mut modal_geom_dim = Point { x: 0.0, y: 0.0 };
    let mut modal_polygon_points: Vec<Point> = vec![Point { x: 0.0, y: 0.0 }];
    let mut modal_path_points: Vec<Point> = vec![Point { x: 0.0, y: 0.0 }];
    let mut modal_path_halfwidth: f64 = 0.0;
    let mut modal_circle_radius: f64 = 0.0;
    let mut modal_ctrapezoid_type: u8 = 0;
    let mut modal_geom_repetition: Option<Repetition> = None;
    let mut modal_place_repetition: Option<Repetition> = None;
    let mut modal_text_string: Option<(Option<String>, Option<u64>)> = None;
    let mut modal_placement_cell: Option<(Option<String>, Option<u64>)> = None;
    let mut _modal_property_name: Option<String> = None;
    let mut modal_property_values: Vec<String> = Vec::new();

    // Tables
    let mut cell_name_table: Vec<String> = Vec::new();
    let mut label_text_table: Vec<String> = Vec::new();
    let mut property_name_table: Vec<String> = Vec::new();
    let mut property_value_table: Vec<String> = Vec::new();

    // Geometry accumulators
    let mut current_cell: Option<usize> = None;
    let mut pending_cell_names: HashMap<usize, u64> = HashMap::new();
    let mut pending_ref_ids: Vec<(usize, usize, u64)> = Vec::new();
    let mut pending_label_ids: Vec<(usize, usize, u64)> = Vec::new();

    // Property collection for the active cell
    let mut current_properties: Vec<String> = Vec::new();

    let mut record_idx: usize = 0;
    let mut record_trace: Vec<u8> = Vec::new();
    const DEBUG_RECORD_LIMIT: usize = 20;
    loop {
        let mut record_start = stream.pos;
        let mut record_byte = stream.read_u8()?;
        record_trace.push(record_byte);

        // Best-effort resync: if we encounter an invalid record id, skip forward until the next
        // plausible id (<= 34) or give up after a small window. This avoids bailing out on
        // stray bytes (e.g., unexpected padding) and keeps parsing the remainder of the file.
        if record_byte > 34 {
            let mut skipped: usize = 0;
            while record_byte > 34 && skipped < 1024 {
                record_byte = stream.read_u8()?;
                record_trace.push(record_byte);
                skipped += 1;
            }
            if record_byte > 34 {
                return Err(anyhow!(
                    "Unsupported OASIS record id {} at record {} (offset {}), skipped {} bytes while trying to resync",
                    record_byte, record_idx, stream.pos, skipped
                ));
            }
            record_start = stream.pos - 1; // adjust to the position of the recovered record id
            if record_idx < DEBUG_RECORD_LIMIT {
                eprintln!("[oasis] resync skipped {} bytes to id 0x{:02x} at pos {}", skipped, record_byte, record_start);
            }
        }

        let record = OasisRecord::from(record_byte);
        if record_idx < DEBUG_RECORD_LIMIT {
            eprintln!(
                "[oasis] record {} id=0x{:02x} ({:?}) at pos {}",
                record_idx, record_byte, record, record_start
            );
        }
        record_idx += 1;
        match record {
            OasisRecord::Pad => {}
            OasisRecord::Start => {}
            OasisRecord::End => {
                break;
            }
            OasisRecord::CellNameImplicit => {
                let name = stream.read_string(true)?;
                cell_name_table.push(String::from_utf8_lossy(&name[..name.len().saturating_sub(1)]).to_string());
            }
            OasisRecord::CellName => {
                let name = stream.read_string(true)?;
                let idx = stream.read_var_uint()? as usize;
                if cell_name_table.len() <= idx {
                    cell_name_table.resize(idx + 1, String::new());
                }
                cell_name_table[idx] = String::from_utf8_lossy(&name[..name.len().saturating_sub(1)]).to_string();
            }
            OasisRecord::TextStringImplicit => {
                let txt = stream.read_string(true)?;
                label_text_table.push(String::from_utf8_lossy(&txt[..txt.len().saturating_sub(1)]).to_string());
            }
            OasisRecord::TextString => {
                let txt = stream.read_string(true)?;
                let idx = stream.read_var_uint()? as usize;
                if label_text_table.len() <= idx {
                    label_text_table.resize(idx + 1, String::new());
                }
                label_text_table[idx] = String::from_utf8_lossy(&txt[..txt.len().saturating_sub(1)]).to_string();
            }
            OasisRecord::LayerNameData | OasisRecord::LayerNameText => {
                // Layer name tables are not used by the viewer; consume and discard payload.
                let _ = stream.read_string(false);
                let _ = stream.read_var_uint();
                let _ = stream.read_var_uint();
                let _ = stream.read_var_uint();
                let _ = stream.read_var_uint();
            }
            OasisRecord::PropNameImplicit => {
                let v = stream.read_string(true)?;
                property_name_table.push(String::from_utf8_lossy(&v[..v.len().saturating_sub(1)]).to_string());
            }
            OasisRecord::PropName => {
                let v = stream.read_string(true)?;
                let idx = stream.read_var_uint()? as usize;
                if property_name_table.len() <= idx {
                    property_name_table.resize(idx + 1, String::new());
                }
                property_name_table[idx] = String::from_utf8_lossy(&v[..v.len().saturating_sub(1)]).to_string();
            }
            OasisRecord::PropStringImplicit => {
                let v = stream.read_string(false)?;
                property_value_table.push(String::from_utf8_lossy(&v).to_string());
            }
            OasisRecord::PropString => {
                let v = stream.read_string(false)?;
                let idx = stream.read_var_uint()? as usize;
                if property_value_table.len() <= idx {
                    property_value_table.resize(idx + 1, String::new());
                }
                property_value_table[idx] = String::from_utf8_lossy(&v).to_string();
            }
            OasisRecord::CellRefNum | OasisRecord::Cell => {
                // Flush properties collected for previous cell
                current_properties.clear();

                let mut cell = Cell {
                    name: String::new(),
                    polygons: Vec::new(),
                    references: Vec::new(),
                    labels: Vec::new(),
                    ports: Vec::new(),
                };

                if record == OasisRecord::Cell {
                    let name = stream.read_string(true)?;
                    cell.name = String::from_utf8_lossy(&name[..name.len().saturating_sub(1)]).to_string();
                } else {
                    let idx = stream.read_var_uint()? as usize;
                    pending_cell_names.insert(library.cells.len(), idx as u64);
                }

                library.cells.push(cell);
                current_cell = Some(library.cells.len() - 1);

                // Reset modal state for new cell
                modal_absolute_pos = true;
                modal_layer = 0;
                modal_datatype = 0;
                modal_textlayer = 0;
                modal_texttype = 0;
                modal_geom_pos = Point { x: 0.0, y: 0.0 };
                modal_geom_dim = Point { x: 0.0, y: 0.0 };
                modal_polygon_points.clear();
                modal_polygon_points.push(Point { x: 0.0, y: 0.0 });
                modal_path_points.clear();
                modal_path_points.push(Point { x: 0.0, y: 0.0 });
                modal_path_halfwidth = 0.0;
                modal_circle_radius = 0.0;
                modal_ctrapezoid_type = 0;
                modal_geom_repetition = None;
                modal_place_repetition = None;
                modal_text_string = None;
                modal_placement_cell = None;
            }
            OasisRecord::XyAbsolute => modal_absolute_pos = true,
            OasisRecord::XyRelative => modal_absolute_pos = false,
            OasisRecord::Placement | OasisRecord::PlacementTransform => {
                if current_cell.is_none() {
                    return Err(anyhow!("PLACEMENT outside of CELL"));
                }
                let cell_idx = current_cell.unwrap();
                let info = stream.read_u8()?;

                // Target cell
                let target = if info & 0x80 != 0 {
                    // explicit
                    if info & 0x40 != 0 {
                        let idx = stream.read_var_uint()?;
                        modal_placement_cell = Some((None, Some(idx)));
                        (None, Some(idx))
                    } else {
                        let name = stream.read_string(true)?;
                        let s = String::from_utf8_lossy(&name[..name.len().saturating_sub(1)]).to_string();
                        modal_placement_cell = Some((Some(s.clone()), None));
                        (Some(s), None)
                    }
                } else if let Some(prev) = &modal_placement_cell {
                    prev.clone()
                } else {
                    return Err(anyhow!("PLACEMENT without modal target"));
                };

                // Transform
                let mut rotation = 0.0;
                let mut magnification = 1.0;
                let x_reflection = info & 0x01 != 0;
                if record == OasisRecord::Placement {
                    match info & 0x06 {
                        0x02 => rotation = PI * 0.5,
                        0x04 => rotation = PI,
                        0x06 => rotation = PI * 1.5,
                        _ => rotation = 0.0,
                    }
                } else {
                    if info & 0x04 != 0 {
                        magnification = stream.read_real()?;
                    }
                    if info & 0x02 != 0 {
                        rotation = stream.read_real()? * (PI / 180.0);
                    }
                }

                // Position
                if info & 0x20 != 0 {
                    let x = stream.read_integer()? as f64 * scale;
                    if modal_absolute_pos {
                        modal_geom_pos.x = x;
                    } else {
                        modal_geom_pos.x += x;
                    }
                }
                if info & 0x10 != 0 {
                    let y = stream.read_integer()? as f64 * scale;
                    if modal_absolute_pos {
                        modal_geom_pos.y = y;
                    } else {
                        modal_geom_pos.y += y;
                    }
                }

                let mut reference = Reference {
                    cell_name: String::new(),
                    origin: modal_geom_pos.clone(),
                    rotation: if rotation == 0.0 { None } else { Some(rotation) },
                    magnification: if magnification == 1.0 { None } else { Some(magnification) },
                    x_reflection,
                    columns: 1,
                    rows: 1,
                    col_spacing: Point { x: 0.0, y: 0.0 },
                    row_spacing: Point { x: 0.0, y: 0.0 },
                };

                let placement_rep = if info & 0x08 != 0 {
                    let rep = stream.read_repetition(scale)?;
                    modal_place_repetition = rep.clone();
                    rep
                } else {
                    modal_place_repetition.clone()
                };

                if let Some(Repetition::Rect(rep)) = placement_rep {
                    reference.columns = rep.columns.max(1);
                    reference.rows = rep.rows.max(1);
                    reference.col_spacing = Point { x: rep.spacing_x, y: 0.0 };
                    reference.row_spacing = Point { x: 0.0, y: rep.spacing_y };
                }

                if let Some(name) = target.0 {
                    reference.cell_name = name;
                } else if let Some(idx) = target.1 {
                    pending_ref_ids.push((cell_idx, library.cells[cell_idx].references.len(), idx as u64));
                }

                library.cells[cell_idx].references.push(reference);
            }
            OasisRecord::Text => {
                if current_cell.is_none() {
                    return Err(anyhow!("TEXT outside of CELL"));
                }
                let cell_idx = current_cell.unwrap();
                let info = stream.read_u8()?;
                let mut label = Label {
                    layer: modal_textlayer,
                    texttype: modal_texttype,
                    text: String::new(),
                    x: 0.0,
                    y: 0.0,
                    rotation: None,
                    magnification: None,
                    anchor: 0,
                };

                if info & 0x40 != 0 {
                    if info & 0x20 != 0 {
                        let idx = stream.read_var_uint()? as usize;
                        if idx < label_text_table.len() {
                            label.text = label_text_table[idx].clone();
                        } else {
                            pending_label_ids.push((cell_idx, library.cells[cell_idx].labels.len(), idx as u64));
                        }
                        modal_text_string = Some((None, Some(idx as u64)));
                    } else {
                        let s = stream.read_string(true)?;
                        let txt = String::from_utf8_lossy(&s[..s.len().saturating_sub(1)]).to_string();
                        label.text = txt.clone();
                        modal_text_string = Some((Some(txt), None));
                    }
                } else if let Some(t) = &modal_text_string {
                    if let Some(txt) = &t.0 {
                        label.text = txt.clone();
                    } else if let Some(idx) = t.1 {
                        if (idx as usize) < label_text_table.len() {
                            label.text = label_text_table[idx as usize].clone();
                        }
                    }
                }

                if info & 0x01 != 0 {
                    modal_textlayer = stream.read_var_uint()? as i16;
                }
                label.layer = modal_textlayer;

                if info & 0x02 != 0 {
                    modal_texttype = stream.read_var_uint()? as i16;
                }
                label.texttype = modal_texttype;

                if info & 0x10 != 0 {
                    let x = stream.read_integer()? as f64 * scale;
                    if modal_absolute_pos { modal_geom_pos.x = x; } else { modal_geom_pos.x += x; }
                }
                if info & 0x08 != 0 {
                    let y = stream.read_integer()? as f64 * scale;
                    if modal_absolute_pos { modal_geom_pos.y = y; } else { modal_geom_pos.y += y; }
                }
                label.x = modal_geom_pos.x;
                label.y = modal_geom_pos.y;

                if info & 0x04 != 0 {
                    modal_geom_repetition = stream.read_repetition(scale)?;
                }

                library.cells[cell_idx].labels.push(label);
            }
            OasisRecord::Rectangle => {
                if current_cell.is_none() {
                    return Err(anyhow!("RECTANGLE outside of CELL"));
                }
                let cell_idx = current_cell.unwrap();
                let info = stream.read_u8()?;

                if info & 0x01 != 0 { modal_layer = stream.read_var_uint()? as i16; }
                if info & 0x02 != 0 { modal_datatype = stream.read_var_uint()? as i16; }
                if info & 0x40 != 0 { modal_geom_dim.x = stream.read_var_uint()? as f64 * scale; }
                if info & 0x20 != 0 {
                    modal_geom_dim.y = stream.read_var_uint()? as f64 * scale;
                } else if info & 0x80 != 0 {
                    modal_geom_dim.y = modal_geom_dim.x;
                }
                if info & 0x10 != 0 {
                    let x = stream.read_integer()? as f64 * scale;
                    if modal_absolute_pos { modal_geom_pos.x = x; } else { modal_geom_pos.x += x; }
                }
                if info & 0x08 != 0 {
                    let y = stream.read_integer()? as f64 * scale;
                    if modal_absolute_pos { modal_geom_pos.y = y; } else { modal_geom_pos.y += y; }
                }

                let pts = vec![
                    Point { x: modal_geom_pos.x, y: modal_geom_pos.y },
                    Point { x: modal_geom_pos.x + modal_geom_dim.x, y: modal_geom_pos.y },
                    Point { x: modal_geom_pos.x + modal_geom_dim.x, y: modal_geom_pos.y + modal_geom_dim.y },
                    Point { x: modal_geom_pos.x, y: modal_geom_pos.y + modal_geom_dim.y },
                ];
                let repetition = if info & 0x04 != 0 {
                    let rep = stream.read_repetition(scale)?;
                    modal_geom_repetition = rep.clone();
                    rep
                } else {
                    modal_geom_repetition = None;
                    None
                };
                push_polygon_with_repetition(
                    &mut library.cells[cell_idx].polygons,
                    modal_layer,
                    modal_datatype,
                    &pts,
                    repetition,
                );
            }
            OasisRecord::Polygon => {
                if current_cell.is_none() {
                    return Err(anyhow!("POLYGON outside of CELL"));
                }
                let cell_idx = current_cell.unwrap();
                let info = stream.read_u8()?;
                if record_idx < DEBUG_RECORD_LIMIT {
                    eprintln!("[oasis] polygon info=0x{:02x} pos={}", info, stream.pos - 1);
                }

                if info & 0x01 != 0 { modal_layer = stream.read_var_uint()? as i16; }
                if info & 0x02 != 0 { modal_datatype = stream.read_var_uint()? as i16; }
                if info & 0x20 != 0 {
                    modal_polygon_points.clear();
                    modal_polygon_points.push(Point { x: 0.0, y: 0.0 });
                    let _ = stream.read_point_list(scale, true, &mut modal_polygon_points)?;
                }
                if info & 0x10 != 0 {
                    let x = stream.read_integer()? as f64 * scale;
                    if modal_absolute_pos { modal_geom_pos.x = x; } else { modal_geom_pos.x += x; }
                }
                if info & 0x08 != 0 {
                    let y = stream.read_integer()? as f64 * scale;
                    if modal_absolute_pos { modal_geom_pos.y = y; } else { modal_geom_pos.y += y; }
                }

                let points: Vec<Point> = modal_polygon_points
                    .iter()
                    .map(|p| Point { x: p.x + modal_geom_pos.x, y: p.y + modal_geom_pos.y })
                    .collect();
                let repetition = if info & 0x04 != 0 {
                    let rep = stream.read_repetition(scale)?;
                    modal_geom_repetition = rep.clone();
                    rep
                } else {
                    modal_geom_repetition = None;
                    None
                };
                push_polygon_with_repetition(
                    &mut library.cells[cell_idx].polygons,
                    modal_layer,
                    modal_datatype,
                    &points,
                    repetition,
                );
            }
            OasisRecord::Path => {
                if current_cell.is_none() {
                    return Err(anyhow!("PATH outside of CELL"));
                }
                let cell_idx = current_cell.unwrap();
                let info = stream.read_u8()?;

                if info & 0x01 != 0 { modal_layer = stream.read_var_uint()? as i16; }
                if info & 0x02 != 0 { modal_datatype = stream.read_var_uint()? as i16; }
                if info & 0x40 != 0 { modal_path_halfwidth = stream.read_var_uint()? as f64 * scale; }
                if info & 0x20 != 0 {
                    modal_path_points.clear();
                    modal_path_points.push(Point { x: 0.0, y: 0.0 });
                    let _ = stream.read_point_list(scale, false, &mut modal_path_points)?;
                }
                if info & 0x10 != 0 {
                    let x = stream.read_integer()? as f64 * scale;
                    if modal_absolute_pos { modal_geom_pos.x = x; } else { modal_geom_pos.x += x; }
                }
                if info & 0x08 != 0 {
                    let y = stream.read_integer()? as f64 * scale;
                    if modal_absolute_pos { modal_geom_pos.y = y; } else { modal_geom_pos.y += y; }
                }

                // Simplified: store spine as polygon without width
                let mut pts = Vec::new();
                for p in modal_path_points.iter() {
                    pts.push(Point { x: p.x + modal_geom_pos.x, y: p.y + modal_geom_pos.y });
                }
                let repetition = if info & 0x04 != 0 {
                    let rep = stream.read_repetition(scale)?;
                    modal_geom_repetition = rep.clone();
                    rep
                } else {
                    modal_geom_repetition = None;
                    None
                };
                push_polygon_with_repetition(
                    &mut library.cells[cell_idx].polygons,
                    modal_layer,
                    modal_datatype,
                    &pts,
                    repetition,
                );
                let _ = modal_path_halfwidth; // kept for completeness
            }
            OasisRecord::TrapezoidAb | OasisRecord::TrapezoidA | OasisRecord::TrapezoidB => {
                if current_cell.is_none() { return Err(anyhow!("TRAPEZOID outside of CELL")); }
                let cell_idx = current_cell.unwrap();
                let info = stream.read_u8()?;
                if info & 0x01 != 0 { modal_layer = stream.read_var_uint()? as i16; }
                if info & 0x02 != 0 { modal_datatype = stream.read_var_uint()? as i16; }
                if info & 0x40 != 0 { modal_geom_dim.x = stream.read_var_uint()? as f64 * scale; }
                if info & 0x20 != 0 { modal_geom_dim.y = stream.read_var_uint()? as f64 * scale; }
                let delta_a = if record == OasisRecord::TrapezoidAb || record == OasisRecord::TrapezoidA { stream.read_integer()? as f64 * scale } else { 0.0 };
                let delta_b = if record == OasisRecord::TrapezoidAb || record == OasisRecord::TrapezoidB { stream.read_integer()? as f64 * scale } else { 0.0 };
                if info & 0x10 != 0 {
                    let x = stream.read_integer()? as f64 * scale;
                    if modal_absolute_pos { modal_geom_pos.x = x; } else { modal_geom_pos.x += x; }
                }
                if info & 0x08 != 0 {
                    let y = stream.read_integer()? as f64 * scale;
                    if modal_absolute_pos { modal_geom_pos.y = y; } else { modal_geom_pos.y += y; }
                }
                let pts = trapezoid_points(
                    record,
                    modal_geom_pos.clone(),
                    modal_geom_dim.clone(),
                    delta_a,
                    delta_b,
                );
                let repetition = if info & 0x04 != 0 {
                    let rep = stream.read_repetition(scale)?;
                    modal_geom_repetition = rep.clone();
                    rep
                } else {
                    modal_geom_repetition = None;
                    None
                };
                push_polygon_with_repetition(
                    &mut library.cells[cell_idx].polygons,
                    modal_layer,
                    modal_datatype,
                    &pts,
                    repetition,
                );
            }
            OasisRecord::CTrapezoid => {
                // Simplify ctrapezoid as bounding rectangle
                if current_cell.is_none() { return Err(anyhow!("CTRAPEZOID outside of CELL")); }
                let cell_idx = current_cell.unwrap();
                let info = stream.read_u8()?;
                if info & 0x01 != 0 { modal_layer = stream.read_var_uint()? as i16; }
                if info & 0x02 != 0 { modal_datatype = stream.read_var_uint()? as i16; }
                if info & 0x80 != 0 { modal_ctrapezoid_type = stream.read_u8()?; }
                if info & 0x40 != 0 { modal_geom_dim.x = stream.read_var_uint()? as f64 * scale; }
                if info & 0x20 != 0 { modal_geom_dim.y = stream.read_var_uint()? as f64 * scale; }
                if info & 0x10 != 0 {
                    let x = stream.read_integer()? as f64 * scale;
                    if modal_absolute_pos { modal_geom_pos.x = x; } else { modal_geom_pos.x += x; }
                }
                if info & 0x08 != 0 {
                    let y = stream.read_integer()? as f64 * scale;
                    if modal_absolute_pos { modal_geom_pos.y = y; } else { modal_geom_pos.y += y; }
                }
                let pts = vec![
                    Point { x: modal_geom_pos.x, y: modal_geom_pos.y },
                    Point { x: modal_geom_pos.x + modal_geom_dim.x, y: modal_geom_pos.y },
                    Point { x: modal_geom_pos.x + modal_geom_dim.x, y: modal_geom_pos.y + modal_geom_dim.y },
                    Point { x: modal_geom_pos.x, y: modal_geom_pos.y + modal_geom_dim.y },
                ];
                let _ = modal_ctrapezoid_type;
                let repetition = if info & 0x04 != 0 {
                    let rep = stream.read_repetition(scale)?;
                    modal_geom_repetition = rep.clone();
                    rep
                } else {
                    modal_geom_repetition = None;
                    None
                };
                push_polygon_with_repetition(
                    &mut library.cells[cell_idx].polygons,
                    modal_layer,
                    modal_datatype,
                    &pts,
                    repetition,
                );
            }
            OasisRecord::Circle => {
                if current_cell.is_none() { return Err(anyhow!("CIRCLE outside of CELL")); }
                let cell_idx = current_cell.unwrap();
                let info = stream.read_u8()?;
                if info & 0x01 != 0 { modal_layer = stream.read_var_uint()? as i16; }
                if info & 0x02 != 0 { modal_datatype = stream.read_var_uint()? as i16; }
                if info & 0x20 != 0 { modal_circle_radius = stream.read_var_uint()? as f64 * scale; }
                if info & 0x10 != 0 {
                    let x = stream.read_integer()? as f64 * scale;
                    if modal_absolute_pos { modal_geom_pos.x = x; } else { modal_geom_pos.x += x; }
                }
                if info & 0x08 != 0 {
                    let y = stream.read_integer()? as f64 * scale;
                    if modal_absolute_pos { modal_geom_pos.y = y; } else { modal_geom_pos.y += y; }
                }
                let pts = circle_points(modal_geom_pos.clone(), modal_circle_radius, 48);
                let repetition = if info & 0x04 != 0 {
                    let rep = stream.read_repetition(scale)?;
                    modal_geom_repetition = rep.clone();
                    rep
                } else {
                    modal_geom_repetition = None;
                    None
                };
                push_polygon_with_repetition(
                    &mut library.cells[cell_idx].polygons,
                    modal_layer,
                    modal_datatype,
                    &pts,
                    repetition,
                );
            }
            OasisRecord::Property | OasisRecord::LastProperty => {
                let info = if record == OasisRecord::LastProperty { 0x08 } else { stream.read_u8()? };

                // Property name
                if info & 0x04 != 0 {
                    // explicit name
                    if info & 0x02 != 0 {
                        let idx = stream.read_var_uint()? as usize;
                        if idx < property_name_table.len() {
                            _modal_property_name = Some(property_name_table[idx].clone());
                        }
                    } else {
                        let bytes = stream.read_string(true)?;
                        _modal_property_name = Some(String::from_utf8_lossy(&bytes[..bytes.len().saturating_sub(1)]).to_string());
                    }
                }

                let mut values: Vec<String> = Vec::new();
                if info & 0x08 != 0 {
                    values = modal_property_values.clone();
                } else {
                    let mut num_values = info >> 4;
                    if num_values == 15 {
                        num_values = stream.read_var_uint()? as u8;
                    }
                    for _ in 0..num_values {
                        let dtype = stream.read_u8()?;
                        let val = match dtype {
                            0..=7 => {
                                let kind = match dtype {
                                    0 => OasisDataType::RealPositiveInteger,
                                    1 => OasisDataType::RealNegativeInteger,
                                    2 => OasisDataType::RealPositiveReciprocal,
                                    3 => OasisDataType::RealNegativeReciprocal,
                                    4 => OasisDataType::RealPositiveRatio,
                                    5 => OasisDataType::RealNegativeRatio,
                                    6 => OasisDataType::RealFloat,
                                    _ => OasisDataType::RealDouble,
                                };
                                format!("{}", stream.read_real_by_type(kind)?)
                            }
                            8 => format!("{}", stream.read_var_uint()?),
                            9 => format!("{}", stream.read_integer()?),
                            10 | 11 | 12 => {
                                let s = stream.read_string(false)?;
                                String::from_utf8_lossy(&s).to_string()
                            }
                            13 | 14 | 15 => {
                                let idx = stream.read_var_uint()? as usize;
                                if idx < property_value_table.len() {
                                    property_value_table[idx].clone()
                                } else {
                                    String::new()
                                }
                            }
                            _ => String::new(),
                        };
                        if !val.is_empty() {
                            values.push(val);
                        }
                    }
                    modal_property_values = values.clone();
                }

                current_properties.extend(values);
                if record == OasisRecord::LastProperty {
                    // Treat as delimiter: attach to current cell if relevant
                    if let Some(idx) = current_cell {
                        if !current_properties.is_empty() {
                            let unit_pair = library.units;
                            for val in current_properties.drain(..) {
                                if val.contains("port_type") {
                                    if let Some(port) = parse_port_string(&val, unit_pair) {
                                        library.cells[idx].ports.push(port);
                                    }
                                }
                            }
                        }
                    }
                }
            }
            OasisRecord::XNameImplicit | OasisRecord::XName | OasisRecord::XElement | OasisRecord::XGeometry => {
                // Unsupported extension records; consume minimal payload
                // Following spec, these have variable fields. We best-effort consume known pieces.
                // For now, skip by reading a string (ignored) and optional ints when flags are set.
                let _ = stream.read_var_uint();
                let _ = stream.read_string(false);
            }
            OasisRecord::CBlock => {
                stream.enter_cblock()?;
            }
        }
    }

    // Resolve pending names
    for (cell_idx, name_idx) in pending_cell_names {
        if let Some(name) = cell_name_table.get(name_idx as usize) {
            library.cells[cell_idx].name = name.clone();
        }
    }
    for (cell_idx, ref_idx, name_idx) in pending_ref_ids {
        if let Some(name) = cell_name_table.get(name_idx as usize) {
            if let Some(r) = library.cells.get_mut(cell_idx).and_then(|c| c.references.get_mut(ref_idx)) {
                r.cell_name = name.clone();
            }
        }
    }
    for (cell_idx, label_idx, text_idx) in pending_label_ids {
        if let Some(text) = label_text_table.get(text_idx as usize) {
            if let Some(l) = library.cells.get_mut(cell_idx).and_then(|c| c.labels.get_mut(label_idx)) {
                l.text = text.clone();
            }
        }
    }

    // Final pass: attach any remaining properties to ports
    for cell in &mut library.cells {
        for val in current_properties.drain(..) {
            if let Some(port) = parse_port_string(&val, library.units) {
                cell.ports.push(port);
            }
        }
    }

    Ok(library)
}
