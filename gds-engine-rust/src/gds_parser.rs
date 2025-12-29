use anyhow::{anyhow, Result};
use byteorder::{BigEndian, ReadBytesExt};
use std::io::{Cursor, Read};

#[derive(Debug, Clone)]
pub enum GdsData {
    None,
    BitArray(u16),
    Int16(Vec<i16>),
    Int32(Vec<i32>),
    // Real4(Vec<f32>), // Rarely used
    Real8(Vec<f64>),
    Str(String),
}

#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct GdsRecord {
    pub rectype: u8,
    pub datatype: u8,
    pub data: GdsData,
}

pub fn gds_real_to_f64(bytes: &[u8]) -> f64 {
    if bytes.len() < 8 {
        return 0.0;
    }
    let sign = (bytes[0] & 0x80) != 0;
    let exponent = (bytes[0] & 0x7F) as i32 - 64;
    let mut mantissa: u64 = 0;
    for i in 1..8 {
        mantissa = (mantissa << 8) | bytes[i] as u64;
    }

    let value = (mantissa as f64) / (2.0f64.powi(56));
    let result = value * 16.0f64.powi(exponent);
    if sign {
        -result
    } else {
        result
    }
}

pub struct GdsReader<R: Read> {
    reader: R,
}

impl<R: Read> GdsReader<R> {
    pub fn new(reader: R) -> Self {
        Self { reader }
    }

    pub fn next_record(&mut self) -> Result<Option<GdsRecord>> {
        let len = match self.reader.read_u16::<BigEndian>() {
            Ok(l) => l,
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
            Err(e) => return Err(e.into()),
        };

        if len < 4 {
            return Err(anyhow!("Invalid GDS record length: {}", len));
        }

        let rectype = self.reader.read_u8()?;
        let datatype = self.reader.read_u8()?;
        let data_len = len - 4;

        let mut buffer = vec![0u8; data_len as usize];
        self.reader.read_exact(&mut buffer)?;

        let data = match datatype {
            0 => GdsData::None,
            1 => GdsData::BitArray(Cursor::new(&buffer).read_u16::<BigEndian>()?),
            2 => {
                let mut v = Vec::new();
                let mut cur = Cursor::new(&buffer);
                while cur.position() < buffer.len() as u64 {
                    v.push(cur.read_i16::<BigEndian>()?);
                }
                GdsData::Int16(v)
            }
            3 => {
                let mut v = Vec::new();
                let mut cur = Cursor::new(&buffer);
                while cur.position() < buffer.len() as u64 {
                    v.push(cur.read_i32::<BigEndian>()?);
                }
                GdsData::Int32(v)
            }
            5 => {
                let mut v = Vec::new();
                for i in (0..buffer.len()).step_by(8) {
                    v.push(gds_real_to_f64(&buffer[i..i + 8]));
                }
                GdsData::Real8(v)
            }
            6 => {
                let s = String::from_utf8_lossy(&buffer)
                    .trim_end_matches('\0')
                    .to_string();
                GdsData::Str(s)
            }
            _ => GdsData::None, // Should handle other types if needed
        };

        Ok(Some(GdsRecord {
            rectype,
            datatype,
            data,
        }))
    }
}
