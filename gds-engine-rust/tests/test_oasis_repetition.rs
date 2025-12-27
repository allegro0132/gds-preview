use std::fs::File;

use gds_engine_rust::oasis_loader::load_oasis;

fn find_cell<'a>(lib: &'a gds_engine_rust::geometry::Library, name: &str) -> &'a gds_engine_rust::geometry::Cell {
    lib.cells.iter().find(|c| c.name == name).expect("cell present")
}

#[test]
fn placement_repetition_rectangular_expands_to_reference_array() {
    let file = File::open("tests/generated/rep_ref_rect.oas").expect("open fixture");
    let lib = load_oasis(file).expect("load oas");
    let top = find_cell(&lib, "TOP");

    assert_eq!(top.references.len(), 1, "expected one reference with repetition");
    let r = &top.references[0];
    assert_eq!(r.cell_name, "CHILD");
    assert_eq!(r.columns, 3);
    assert_eq!(r.rows, 2);
    assert!((r.col_spacing.x - 10.0).abs() < 1e-9);
    assert!((r.row_spacing.y - 20.0).abs() < 1e-9);
}

#[test]
fn placement_repetition_regular_vectors_expands_to_reference_array() {
    let file = File::open("tests/generated/rep_ref_regular.oas").expect("open fixture");
    let lib = load_oasis(file).expect("load oas");
    let top = find_cell(&lib, "TOP");

    assert_eq!(top.references.len(), 1, "expected one reference with repetition");
    let r = &top.references[0];
    assert_eq!(r.cell_name, "CHILD");
    assert_eq!(r.columns, 3);
    assert_eq!(r.rows, 2);
    assert!((r.origin.x - 5.0).abs() < 1e-9);
    assert!((r.origin.y - 5.0).abs() < 1e-9);
    assert!((r.col_spacing.x - 10.0).abs() < 1e-9);
    assert!((r.col_spacing.y - 0.0).abs() < 1e-9);
    assert!((r.row_spacing.x - 0.0).abs() < 1e-9);
    assert!((r.row_spacing.y - 20.0).abs() < 1e-9);
}

#[test]
fn placement_repetition_explicit_offsets_expands_to_multiple_references() {
    let file = File::open("tests/generated/rep_ref_offsets.oas").expect("open fixture");
    let lib = load_oasis(file).expect("load oas");
    let top = find_cell(&lib, "TOP");

    // Base + 3 offsets => 4 references.
    assert_eq!(top.references.len(), 4);
    for r in &top.references {
        assert_eq!(r.cell_name, "CHILD");
        assert_eq!(r.columns, 1);
        assert_eq!(r.rows, 1);
    }

    // Origins are expected to include (0,0) and the offsets used in the generator.
    let mut origins: Vec<(i64, i64)> = top
        .references
        .iter()
        .map(|r| ((r.origin.x * 1000.0).round() as i64, (r.origin.y * 1000.0).round() as i64))
        .collect();
    origins.sort_unstable();

    let mut expected = vec![(0, 0), (10_000, 0), (0, 10_000), (10_000, 10_000)];
    expected.sort_unstable();
    assert_eq!(origins, expected);
}

#[test]
fn placement_repetition_x_explicit_expands_to_multiple_references() {
    let file = File::open("tests/generated/rep_ref_xexp.oas").expect("open fixture");
    let lib = load_oasis(file).expect("load oas");
    let top = find_cell(&lib, "TOP");

    // Base + 3 x offsets => 4 references.
    assert_eq!(top.references.len(), 4);
    for r in &top.references {
        assert_eq!(r.cell_name, "CHILD");
        assert_eq!(r.columns, 1);
        assert_eq!(r.rows, 1);
    }

    let mut origins: Vec<(i64, i64)> = top
        .references
        .iter()
        .map(|r| ((r.origin.x * 1000.0).round() as i64, (r.origin.y * 1000.0).round() as i64))
        .collect();
    origins.sort_unstable();

    // x_offsets in generator: [5, 12, 20] (and 0 implicit)
    let mut expected = vec![(0, 0), (5_000, 0), (12_000, 0), (20_000, 0)];
    expected.sort_unstable();
    assert_eq!(origins, expected);
}

#[test]
fn placement_repetition_y_explicit_expands_to_multiple_references() {
    let file = File::open("tests/generated/rep_ref_yexp.oas").expect("open fixture");
    let lib = load_oasis(file).expect("load oas");
    let top = find_cell(&lib, "TOP");

    // Base + 2 y offsets => 3 references.
    assert_eq!(top.references.len(), 3);
    for r in &top.references {
        assert_eq!(r.cell_name, "CHILD");
        assert_eq!(r.columns, 1);
        assert_eq!(r.rows, 1);
    }

    let mut origins: Vec<(i64, i64)> = top
        .references
        .iter()
        .map(|r| ((r.origin.x * 1000.0).round() as i64, (r.origin.y * 1000.0).round() as i64))
        .collect();
    origins.sort_unstable();

    // y_offsets in generator: [7, 9] (and 0 implicit)
    let mut expected = vec![(0, 0), (0, 7_000), (0, 9_000)];
    expected.sort_unstable();
    assert_eq!(origins, expected);
}

#[test]
fn geometry_repetition_offsets_expands_to_multiple_polygons() {
    let file = File::open("tests/generated/rep_poly_offsets.oas").expect("open fixture");
    let lib = load_oasis(file).expect("load oas");
    let top = find_cell(&lib, "TOP");

    // Base polygon + 2 offsets => 3 polygons.
    assert_eq!(top.polygons.len(), 3);
    for p in &top.polygons {
        assert_eq!(p.layer, 2);
        assert_eq!(p.datatype, 0);
        assert_eq!(p.points.len(), 4);
    }
}
