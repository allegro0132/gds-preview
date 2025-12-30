use crate::geometry::Matrix3x3;
use std::cmp::Ordering;
use std::collections::HashMap;

#[derive(Clone, Debug)]
pub struct OrderedInstance {
    pub instance_id: u32,
    pub cell_idx: usize,
    pub matrix: Matrix3x3,
}

fn matrix_key(m: &Matrix3x3) -> [u64; 9] {
    let mut out = [0u64; 9];
    let mut i = 0;
    for row in 0..3 {
        for col in 0..3 {
            out[i] = m.m[row][col].to_bits();
            i += 1;
        }
    }
    out
}

pub fn ordered_instances(instances_map: &HashMap<usize, Vec<Matrix3x3>>) -> Vec<OrderedInstance> {
    let mut tmp: Vec<(usize, Matrix3x3)> = Vec::new();
    tmp.reserve(
        instances_map
            .values()
            .map(|v| v.len())
            .sum::<usize>(),
    );

    for (cell_idx, transforms) in instances_map {
        for t in transforms {
            tmp.push((*cell_idx, t.clone()));
        }
    }

    tmp.sort_by(|(cell_a, mat_a), (cell_b, mat_b)| {
        match cell_a.cmp(cell_b) {
            Ordering::Equal => matrix_key(mat_a).cmp(&matrix_key(mat_b)),
            other => other,
        }
    });

    tmp.into_iter()
        .enumerate()
        .map(|(i, (cell_idx, matrix))| OrderedInstance {
            instance_id: i as u32,
            cell_idx,
            matrix,
        })
        .collect()
}
