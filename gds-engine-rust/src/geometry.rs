use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Polygon {
    pub layer: i16,
    pub datatype: i16,
    pub points: Vec<Point>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Label {
    pub layer: i16,
    pub texttype: i16,
    pub text: String,
    pub x: f64,
    pub y: f64,
    pub rotation: Option<f64>,
    pub magnification: Option<f64>,
    pub anchor: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Port {
    pub name: String,
    pub x: f64,
    pub y: f64,
    pub rotation: f64,
    pub layer: i16,
    pub port_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Reference {
    pub cell_name: String,
    pub origin: Point,
    pub rotation: Option<f64>,
    pub magnification: Option<f64>,
    pub x_reflection: bool,
    pub columns: u16,
    pub rows: u16,
    pub col_spacing: Point,
    pub row_spacing: Point,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Cell {
    pub name: String,
    pub polygons: Vec<Polygon>,
    pub references: Vec<Reference>,
    pub labels: Vec<Label>,
    pub ports: Vec<Port>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Matrix3x3 {
    pub m: [[f64; 3]; 3],
}

impl Matrix3x3 {
    pub fn identity() -> Self {
        Self {
            m: [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
        }
    }

    pub fn transform_point(&self, p: &Point) -> Point {
        Point {
            x: self.m[0][0] * p.x + self.m[0][1] * p.y + self.m[0][2],
            y: self.m[1][0] * p.x + self.m[1][1] * p.y + self.m[1][2],
        }
    }

    pub fn multiply(&self, other: &Self) -> Self {
        let mut res = [[0.0; 3]; 3];
        for i in 0..3 {
            for j in 0..3 {
                for k in 0..3 {
                    res[i][j] += self.m[i][k] * other.m[k][j];
                }
            }
        }
        Self { m: res }
    }

    pub fn from_transform(
        rotation: f64,
        magnification: f64,
        x_reflection: bool,
        origin: &Point,
    ) -> Self {
        let c = rotation.cos();
        let s = rotation.sin();

        let m11 = magnification * c;
        let mut m12 = -magnification * s;
        let m21 = magnification * s;
        let mut m22 = magnification * c;

        if x_reflection {
            m12 *= -1.0;
            m22 *= -1.0;
        }

        Self {
            m: [[m11, m12, origin.x], [m21, m22, origin.y], [0.0, 0.0, 1.0]],
        }
    }
}

pub struct Library {
    pub name: String,
    pub units: (f64, f64),
    pub cells: Vec<Cell>,
}

impl Library {
    pub fn new() -> Self {
        Self {
            name: String::new(),
            units: (1e-3, 1e-9), // Default GDSII units
            cells: Vec::new(),
        }
    }
}
