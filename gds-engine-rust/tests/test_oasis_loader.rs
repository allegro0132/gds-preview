use std::fs::File;

use gds_engine_rust::oasis_parser::load_oasis;

fn bbox(points: &[gds_engine_rust::geometry::Point]) -> (f64, f64, f64, f64) {
    let mut min_x = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    for p in points {
        min_x = min_x.min(p.x);
        max_x = max_x.max(p.x);
        min_y = min_y.min(p.y);
        max_y = max_y.max(p.y);
    }
    (min_x, max_x, min_y, max_y)
}

#[test]
fn singular_1_oas_path_is_polygonized_with_width() {
    let file = File::open("tests/generated/singular_1.oas").expect("open singular_1.oas");
    let lib = load_oasis(file).expect("load oas");

    let cell = lib
        .cells
        .iter()
        .find(|c| c.name == "TOP")
        .expect("TOP cell present");

    assert_eq!(cell.polygons.len(), 1, "expected one rendered polygon");

    let poly = &cell.polygons[0];
    assert!(
        poly.points.len() >= 6,
        "PATH should be polygonized (got {} pts)",
        poly.points.len()
    );

    let (min_x, max_x, min_y, max_y) = bbox(&poly.points);
    let x_span = max_x - min_x;
    let y_span = max_y - min_y;

    // Centerline spans 100 x 8 (microns) in this file; polygonized outline must be wider.
    assert!(x_span > 100.0, "expected x-span > 100um, got {x_span}");
    assert!(y_span > 8.0, "expected y-span > 8um, got {y_span}");

    assert!(min_x.is_finite() && max_x.is_finite() && min_y.is_finite() && max_y.is_finite());
}
