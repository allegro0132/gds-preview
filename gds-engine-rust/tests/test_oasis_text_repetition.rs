use std::fs::File;

use gds_engine_rust::oasis_loader::load_oasis;

fn find_cell<'a>(
    lib: &'a gds_engine_rust::geometry::Library,
    name: &str,
) -> &'a gds_engine_rust::geometry::Cell {
    lib.cells
        .iter()
        .find(|c| c.name == name)
        .expect("cell present")
}

#[test]
fn text_repetition_rectangular_expands_to_multiple_labels() {
    let file = File::open("tests/generated/rep_text_rect.oas").expect("open fixture");
    let lib = load_oasis(file).expect("load oas");
    let top = find_cell(&lib, "TOP");

    // 3 columns x 2 rows => 6 labels.
    assert_eq!(top.labels.len(), 6);

    for l in &top.labels {
        assert_eq!(l.layer, 7);
        assert_eq!(l.texttype, 1);
        assert_eq!(l.text, "HELLO");
    }

    let mut origins: Vec<(i64, i64)> = top
        .labels
        .iter()
        .map(|l| ((l.x * 1000.0).round() as i64, (l.y * 1000.0).round() as i64))
        .collect();
    origins.sort_unstable();

    let mut expected = vec![
        (0, 0),
        (10_000, 0),
        (20_000, 0),
        (0, 20_000),
        (10_000, 20_000),
        (20_000, 20_000),
    ];
    expected.sort_unstable();

    assert_eq!(origins, expected);
}
