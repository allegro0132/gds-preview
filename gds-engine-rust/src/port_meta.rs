use crate::geometry::Port;

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

    let parts: Vec<&str> = s.split_whitespace().collect();
    for part in parts {
        if part.starts_with('r') {
            if let Ok(val) = part[1..].parse::<f64>() {
                rotation = val;
            }
        } else if part.starts_with('m') {
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

    (rotation.to_radians(), magnification, x, y)
}
