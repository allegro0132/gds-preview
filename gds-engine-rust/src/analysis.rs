use crate::geometry::{Library, Cell, Matrix3x3, Point, Polygon};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
use rayon::prelude::*;

#[derive(Debug, Clone, Copy)]
pub struct BBox {
    pub min_x: f64,
    pub min_y: f64,
    pub max_x: f64,
    pub max_y: f64,
}

impl BBox {
    pub fn empty() -> Self {
        Self {
            min_x: f64::INFINITY,
            min_y: f64::INFINITY,
            max_x: f64::NEG_INFINITY,
            max_y: f64::NEG_INFINITY,
        }
    }

    pub fn from_points(points: &[Point]) -> Self {
        let mut bbox = Self::empty();
        for p in points {
            bbox.add_point(p);
        }
        bbox
    }

    pub fn add_point(&mut self, p: &Point) {
        if p.x < self.min_x { self.min_x = p.x; }
        if p.x > self.max_x { self.max_x = p.x; }
        if p.y < self.min_y { self.min_y = p.y; }
        if p.y > self.max_y { self.max_y = p.y; }
    }

    pub fn merge(&mut self, other: &BBox) {
        if other.min_x < self.min_x { self.min_x = other.min_x; }
        if other.max_x > self.max_x { self.max_x = other.max_x; }
        if other.min_y < self.min_y { self.min_y = other.min_y; }
        if other.max_y > self.max_y { self.max_y = other.max_y; }
    }

    pub fn intersects(&self, other: &BBox) -> bool {
        self.min_x <= other.max_x &&
        self.max_x >= other.min_x &&
        self.min_y <= other.max_y &&
        self.max_y >= other.min_y
    }

    pub fn transform(&self, m: &Matrix3x3) -> BBox {
        let corners = [
            Point { x: self.min_x, y: self.min_y },
            Point { x: self.max_x, y: self.min_y },
            Point { x: self.max_x, y: self.max_y },
            Point { x: self.min_x, y: self.max_y },
        ];
        let mut new_bbox = Self::empty();
        for p in &corners {
            new_bbox.add_point(&m.transform_point(p));
        }
        new_bbox
    }
}

pub fn point_in_polygon(x: f64, y: f64, poly: &Polygon) -> bool {
    let mut inside = false;
    let len = poly.points.len();
    if len < 3 { return false; }

    let mut j = len - 1;
    for i in 0..len {
        let xi = poly.points[i].x;
        let yi = poly.points[i].y;
        let xj = poly.points[j].x;
        let yj = poly.points[j].y;

        let intersect = ((yi > y) != (yj > y)) &&
            (x < (xj - xi) * (y - yi) / (yj - yi) + xi);

        if intersect {
            inside = !inside;
        }
        j = i;
    }
    inside
}

fn ccw(p1: &Point, p2: &Point, p3: &Point) -> bool {
    (p3.y - p1.y) * (p2.x - p1.x) > (p2.y - p1.y) * (p3.x - p1.x)
}

fn segments_intersect(p1: &Point, p2: &Point, p3: &Point, p4: &Point) -> bool {
    (ccw(p1, p3, p4) != ccw(p2, p3, p4)) && (ccw(p1, p2, p3) != ccw(p1, p2, p4))
}

pub fn polygons_intersect(poly1: &Polygon, poly2: &Polygon) -> bool {
    // Check if any point of poly1 is in poly2
    for p in &poly1.points {
        if point_in_polygon(p.x, p.y, poly2) {
            return true;
        }
    }

    // Check if any point of poly2 is in poly1
    for p in &poly2.points {
        if point_in_polygon(p.x, p.y, poly1) {
            return true;
        }
    }

    // Check edge intersections
    let len1 = poly1.points.len();
    let len2 = poly2.points.len();

    for i in 0..len1 {
        let p1 = &poly1.points[i];
        let p2 = &poly1.points[(i + 1) % len1];

        for j in 0..len2 {
            let p3 = &poly2.points[j];
            let p4 = &poly2.points[(j + 1) % len2];

            if segments_intersect(p1, p2, p3, p4) {
                return true;
            }
        }
    }

    false
}

pub fn transform_polygon(poly: &Polygon, m: &Matrix3x3) -> Polygon {
    let mut new_points = Vec::with_capacity(poly.points.len());
    for p in &poly.points {
        new_points.push(m.transform_point(p));
    }
    Polygon {
        layer: poly.layer,
        datatype: poly.datatype,
        points: new_points,
    }
}

pub struct Instance {
    pub cell_idx: usize,
    pub matrix: Matrix3x3,
    pub bbox: BBox,
}

pub struct SearchEngine {
    library: Arc<Library>,
    instances: Vec<Instance>,
    cell_bboxes: Vec<BBox>,
    cell_map: HashMap<String, usize>,
}

impl SearchEngine {
    pub fn new(library: Arc<Library>, instances_map: HashMap<usize, Vec<Matrix3x3>>) -> Self {
        let mut cell_map = HashMap::new();
        let mut cell_bboxes = Vec::with_capacity(library.cells.len());

        for (i, cell) in library.cells.iter().enumerate() {
            cell_map.insert(cell.name.clone(), i);

            let mut bbox = BBox::empty();
            for poly in &cell.polygons {
                let pb = BBox::from_points(&poly.points);
                bbox.merge(&pb);
            }
            cell_bboxes.push(bbox);
        }

        let mut instances = Vec::new();

        for (cell_idx, transforms) in instances_map {
            if cell_idx >= cell_bboxes.len() { continue; }
            let base_bbox = &cell_bboxes[cell_idx];

            for t in transforms {
                let inst_bbox = base_bbox.transform(&t);
                instances.push(Instance {
                    cell_idx,
                    matrix: t,
                    bbox: inst_bbox,
                });
            }
        }

        Self { library, instances, cell_bboxes, cell_map }
    }

    pub fn find(&self, x: f64, y: f64, active_layers: &HashSet<(i16, i16)>, max_steps: usize, cancel_flag: Option<Arc<AtomicBool>>) -> (Vec<Polygon>, bool) {
        let mut start_poly: Option<Polygon> = None;
        let mut start_instance_idx: Option<usize> = None;

        // 1. Find start polygon
        for (i, inst) in self.instances.iter().enumerate() {
            if x < inst.bbox.min_x || x > inst.bbox.max_x || y < inst.bbox.min_y || y > inst.bbox.max_y {
                continue;
            }

            let cell = &self.library.cells[inst.cell_idx];

            let m = &inst.matrix.m;
            let m11 = m[0][0]; let m12 = m[0][1]; let tx = m[0][2];
            let m21 = m[1][0]; let m22 = m[1][1]; let ty = m[1][2];

            let det = m11 * m22 - m12 * m21;
            if det.abs() < 1e-6 { continue; }

            let inv_det = 1.0 / det;
            let dx = x - tx;
            let dy = y - ty;
            let local_x = (m22 * dx - m12 * dy) * inv_det;
            let local_y = (m11 * dy - m21 * dx) * inv_det;

            for poly in &cell.polygons {
                if !active_layers.contains(&(poly.layer, poly.datatype)) { continue; }

                if point_in_polygon(local_x, local_y, poly) {
                    start_poly = Some(transform_polygon(poly, &inst.matrix));
                    start_instance_idx = Some(i);
                    break;
                }
            }
            if start_poly.is_some() { break; }
        }

        if start_poly.is_none() {
            return (Vec::new(), false);
        }

        let start_poly = start_poly.unwrap();
        let mut candidates: Vec<Polygon> = Vec::new();
        let mut candidates_indices: Vec<(usize, usize)> = Vec::new();

        if let Some(idx) = start_instance_idx {
             self.add_instance_to_candidates(idx, active_layers, &mut candidates, &mut candidates_indices);
        }

        let mut visited = HashSet::new();
        let mut current_frontier = Vec::new();

        for (i, poly) in candidates.iter().enumerate() {
             if point_in_polygon(x, y, poly) {
                 visited.insert(i);
                 current_frontier.push(i);
                 break;
             }
        }

        let mut remaining_instances: Vec<usize> = (0..self.instances.len()).collect();
        if let Some(idx) = start_instance_idx {
            if let Some(pos) = remaining_instances.iter().position(|&x| x == idx) {
                remaining_instances.swap_remove(pos);
            }
        }

        let mut steps = 0;

        while !current_frontier.is_empty() {
            if let Some(flag) = &cancel_flag {
                if flag.load(Ordering::Relaxed) {
                    return (Vec::new(), false);
                }
            }

            if steps >= max_steps {
                let res_polys = visited.iter().map(|&i| candidates[i].clone()).collect();
                return (res_polys, true);
            }
            steps += current_frontier.len();

            // 1. Expand Instances (Parallel)
            // Collect BBoxes of current frontier
            let frontier_bboxes: Vec<BBox> = current_frontier.par_iter()
                .map(|&idx| BBox::from_points(&candidates[idx].points))
                .collect();

            // Compute union BBox for quick rejection
            let mut union_bbox = BBox::empty();
            for b in &frontier_bboxes { union_bbox.merge(b); }

            // Find intersecting instances
            let (intersecting_instances, kept_instances): (Vec<_>, Vec<_>) = remaining_instances.par_iter()
                .partition(|&&inst_idx| {
                    let inst = &self.instances[inst_idx];
                    if !union_bbox.intersects(&inst.bbox) { return false; }

                    frontier_bboxes.iter().any(|fb| fb.intersects(&inst.bbox))
                });

            remaining_instances = kept_instances;

            // Add new candidates (Sequential, but fast)
            for &inst_idx in &intersecting_instances {
                self.add_instance_to_candidates(inst_idx, active_layers, &mut candidates, &mut candidates_indices);
            }

            // 2. Find Intersections (Parallel)
            // We need to check current_frontier against all unvisited candidates
            // Optimization: Only check candidates that intersect union_bbox?
            // Or just brute force parallel since candidates count is usually < 10k for connected components

            // Pre-calculate BBoxes for all candidates?
            // Doing it on the fly in parallel is fine.

            let candidates_len = candidates.len();
            let visited_ref = &visited;
            let candidates_ref = &candidates;

            let next_frontier_indices: HashSet<usize> = current_frontier.par_iter().zip(frontier_bboxes.par_iter())
                .map(|(&curr_idx, curr_bbox)| {
                    let mut local_next = Vec::new();
                    // Check against all candidates
                    // Note: This is O(Frontier * Candidates).
                    // If Candidates is large, we might want to optimize this loop.
                    for i in 0..candidates_len {
                        if visited_ref.contains(&i) { continue; }

                        let other = &candidates_ref[i];
                        // Quick BBox check
                        // We need BBox of other.
                        // Optimization: Store BBoxes alongside candidates?
                        let other_bbox = BBox::from_points(&other.points);

                        if !curr_bbox.intersects(&other_bbox) { continue; }

                        if polygons_intersect(&candidates_ref[curr_idx], other) {
                            local_next.push(i);
                        }
                    }
                    local_next
                })
                .flatten()
                .collect();

            current_frontier = next_frontier_indices.into_iter().collect();
            for &idx in &current_frontier {
                visited.insert(idx);
            }
        }

        let res_polys = visited.iter().map(|&i| candidates[i].clone()).collect();
        (res_polys, false)
    }

    fn add_instance_to_candidates(&self, inst_idx: usize, active_layers: &HashSet<(i16, i16)>, candidates: &mut Vec<Polygon>, indices: &mut Vec<(usize, usize)>) {
        let inst = &self.instances[inst_idx];
        let cell = &self.library.cells[inst.cell_idx];
        for (poly_idx, poly) in cell.polygons.iter().enumerate() {
            if active_layers.contains(&(poly.layer, poly.datatype)) {
                candidates.push(transform_polygon(poly, &inst.matrix));
                indices.push((inst_idx, poly_idx));
            }
        }
    }
}
