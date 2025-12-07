use wasm_bindgen::prelude::*;

const ASCII_GRADIENT_70: &str = " .'`^\",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$";
const ASCII_GRADIENT_10: &str = " .:-=+*#%@";
const ASCII_GRADIENT_16: &str = " .,:;!|+*%#&@$MW";
const BLOCK_GRADIENT: &str = " ░▒▓█";

#[wasm_bindgen]
#[derive(Clone, Copy)]
pub struct Vector3 {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

#[wasm_bindgen]
pub struct Model3D {
    vertices: Vec<f64>, // flattened x, y, z
    edges: Vec<usize>,  // flattened p1_idx, p2_idx
}

#[wasm_bindgen]
impl Model3D {
    #[wasm_bindgen(constructor)]
    pub fn new(vertices: &[f64], edges: &[usize]) -> Model3D {
        Model3D {
            vertices: vertices.to_vec(),
            edges: edges.to_vec(),
        }
    }
}

#[derive(Clone, Copy)]
struct Point2D {
    x: f64,
    y: f64,
    z: f64,
}

#[derive(Clone, Copy)]
struct ZBufferCell {
    z: f64,
    brightness: f64,
}

/// Renders a 3D model to an ASCII string.
///
/// # Arguments
/// * `model` - The 3D model to render (vertices and edges).
/// * `rx` - Rotation around X axis (radians).
/// * `ry` - Rotation around Y axis (radians).
/// * `rz` - Rotation around Z axis (radians).
/// * `width` - Target width of the ASCII canvas in characters.
/// * `height` - Target height of the ASCII canvas in characters.
/// * `quality` - Rendering quality/style ("low", "medium", "high", "ultra", "blocks").
#[wasm_bindgen]
pub fn render_ascii_model(
    model: &Model3D,
    rx: f64,
    ry: f64,
    rz: f64,
    width: usize,
    height: usize,
    quality: &str
) -> String {
    let chars: Vec<char> = match quality {
        "low" => ASCII_GRADIENT_10.chars().collect(),
        "high" => ASCII_GRADIENT_70.chars().collect(),
        "ultra" => ASCII_GRADIENT_70.chars().collect(),
        "blocks" => BLOCK_GRADIENT.chars().collect(),
        _ => ASCII_GRADIENT_16.chars().collect(),
    };

    let mut z_buffer: Vec<Option<ZBufferCell>> = vec![None; width * height];

    // Precompute rotation matrices
    let (sx, cx) = rx.sin_cos();
    let (sy, cy) = ry.sin_cos();
    let (sz, cz) = rz.sin_cos();

    // Transform and project vertices
    let mut projected_vertices: Vec<Point2D> = Vec::with_capacity(model.vertices.len() / 3);

    for i in (0..model.vertices.len()).step_by(3) {
        let x = model.vertices[i];
        let y = model.vertices[i+1];
        let z = model.vertices[i+2];

        // Rotate
        // Ry * Rx * Rz (order matters, matching original typically)
        // Let's do standard Rotation matrix mult.
        
        // Rotate X
        let y1 = y * cx - z * sx;
        let z1 = y * sx + z * cx;
        
        // Rotate Y
        let x2 = x * cy + z1 * sy;
        let z2 = -x * sy + z1 * cy;
        
        // Rotate Z
        let x3 = x2 * cz - y1 * sz;
        let y3 = x2 * sz + y1 * cz;

        // Project
        // Simple perspective projection
        // camera_dist = 3.0, scale = 1.5 usually
        let scale = 1.5;
        let camera_dist = 3.0;
        let factor = scale / (z2 + camera_dist);
        
        // Map to screen coordinates
        let px = (x3 * factor + 0.5) * width as f64;
        let py = (y3 * factor * 0.5 + 0.5) * height as f64; // Aspect ratio adjustment approx 0.5 for char height

        projected_vertices.push(Point2D { x: px, y: py, z: z2 + camera_dist });
    }

    // Draw edges
    for i in (0..model.edges.len()).step_by(2) {
        let idx1 = model.edges[i];
        let idx2 = model.edges[i+1];

        if idx1 >= projected_vertices.len() || idx2 >= projected_vertices.len() { continue; }

        let p1 = projected_vertices[idx1];
        let p2 = projected_vertices[idx2];

        draw_line(
            p1.x.round() as isize, p1.y.round() as isize, p1.z,
            p2.x.round() as isize, p2.y.round() as isize, p2.z,
            &mut z_buffer, width, height
        );
    }

    // Draw vertices (points)
    for p in &projected_vertices {
        let x = p.x.round() as isize;
        let y = p.y.round() as isize;

        if x >= 0 && x < width as isize && y >= 0 && y < height as isize {
            let x = x as usize;
            let y = y as usize;
            let idx = y * width + x;
            
            // Normalize z for brightness (1.5 to 4.5 approx range)
            let depth_factor = (4.5 - p.z).clamp(0.0, 3.0) / 3.0;
            let brightness = 0.5 + depth_factor * 0.5;

            let update = match z_buffer[idx] {
                Some(ref cell) => p.z < cell.z,
                None => true,
            };

            if update {
                z_buffer[idx] = Some(ZBufferCell { z: p.z, brightness });
            }
        }
    }

    // Convert to string
    let mut result = String::with_capacity(width * height + height);
    for y in 0..height {
        for x in 0..width {
            let cell = z_buffer[y * width + x];
            if let Some(c) = cell {
                let idx = ((c.brightness * (chars.len() - 1) as f64).floor() as usize).min(chars.len() - 1);
                result.push(chars[idx]);
            } else {
                result.push(' ');
            }
        }
        result.push('\n');
    }

    result
}

fn draw_line(
    mut x0: isize, mut y0: isize, z0: f64,
    x1: isize, y1: isize, z1: f64,
    z_buffer: &mut Vec<Option<ZBufferCell>>,
    width: usize, height: usize
) {
    let dx = (x1 - x0).abs();
    let dy = (y1 - y0).abs();
    let sx = if x0 < x1 { 1 } else { -1 };
    let sy = if y0 < y1 { 1 } else { -1 };
    let mut err = dx - dy;

    let steps = dx.max(dy);
    let dz = if steps > 0 { (z1 - z0) / steps as f64 } else { 0.0 };
    let mut z = z0;

    loop {
        if x0 >= 0 && x0 < width as isize && y0 >= 0 && y0 < height as isize {
            let ux = x0 as usize;
            let uy = y0 as usize;
            let idx = uy * width + ux;
            
            let depth_factor = (4.5 - z).clamp(0.0, 3.0) / 3.0;
            let brightness = 0.2 + depth_factor * 0.5;

            let update = match z_buffer[idx] {
                Some(ref cell) => z < cell.z,
                None => true,
            };

            if update {
                z_buffer[idx] = Some(ZBufferCell { z, brightness });
            }
        }

        if x0 == x1 && y0 == y1 { break; }

        let e2 = 2 * err;
        if e2 > -dy {
            err -= dy;
            x0 += sx;
        }
        if e2 < dx {
            err += dx;
            y0 += sy;
        }
        z += dz;
    }
}
