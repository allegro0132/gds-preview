use std::fs::File;

use gds_engine_rust::gds_loader::load_gds;

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
fn singular_1_path_is_polygonized_with_width() {
    let file = File::open("tests/generated/singular_1.gds").expect("open singular_1.gds");
    let lib = load_gds(file).expect("load gds");

    let cell = lib
        .cells
        .iter()
        .find(|c| c.name == "TOP")
        .expect("TOP cell present");

    assert_eq!(cell.polygons.len(), 1, "expected one rendered polygon");

    let poly = &cell.polygons[0];
    assert!(poly.points.len() >= 6, "PATH should be polygonized (got {} pts)", poly.points.len());

    let (min_x, max_x, min_y, max_y) = bbox(&poly.points);
    let x_span = max_x - min_x;
    let y_span = max_y - min_y;

    // Centerline spans 100 x 8 (microns) in this file; polygonized outline must be wider.
    assert!(x_span > 100.0, "expected x-span > 100um, got {x_span}");
    assert!(y_span > 8.0, "expected y-span > 8um, got {y_span}");

    // The file uses pathtype=0 (flush), so the first x should remain unchanged.
    assert!((min_x - (-11214.471)).abs() < 1e-6, "unexpected min_x {min_x}");
    // Width=10um => half-width=5um; first segment is horizontal so top cap should reach y+5.
    assert!((max_y - 12623.087).abs() < 1e-6, "unexpected max_y {max_y}");

    assert!(min_x.is_finite() && max_x.is_finite() && min_y.is_finite() && max_y.is_finite());
}

#[test]
fn p0_box_is_loaded_as_polygon() {
    let file = File::open("tests/generated/p0_box.gds").expect("open p0_box.gds");
    let lib = load_gds(file).expect("load gds");

    let cell = lib
        .cells
        .iter()
        .find(|c| c.name == "TOP")
        .expect("TOP cell present");

    assert!(
        !cell.polygons.is_empty(),
        "expected BOX to produce at least one polygon"
    );
}
