use clap::Parser;

#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
pub struct Args {
    #[arg(help = "Input layout file path (GDSII or OASIS)")]
    pub input: String,

    #[arg(help = "Output directory (for compatibility)")]
    pub output_dir: String,

    #[arg(default_value = "", help = "Target cell name")]
    pub cell_name: String,

    #[arg(default_value = "2000", help = "Chunk size")]
    pub chunk_size: usize,

    #[arg(default_value = "5", help = "Flow control step")]
    pub flow_control_step: usize,

    #[arg(default_value = "0", help = "Use instancing (1 for true)")]
    pub use_instancing: i32,

    #[arg(long, help = "Negative mode (for SVG)")]
    pub negative: bool,

    #[arg(
        long,
        help = "TCP port (127.0.0.1) for binary geometry streaming to the VS Code extension. If set, binary chunks are streamed over TCP instead of stdout base64"
    )]
    pub tcp_port: Option<u16>,

    #[arg(long, default_value = "polygons", value_parser = ["polygons", "triangles"], help = "Geometry payload mode for non-instance polygons")]
    pub geom_mode: String,

    #[arg(
        long,
        default_value_t = false,
        help = "(WebGL+Rust+Instancing) Enable viewport-driven streaming. The engine will stream definitions once, then only send instances/flat geometry for the current viewport on request."
    )]
    pub viewport_streaming: bool,
}
