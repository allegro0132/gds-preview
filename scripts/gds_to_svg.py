import gdstk
import sys
import os

def gds_to_svg(gds_path, svg_path):
    """
    Converts a GDSII file to an SVG file.
    """
    try:
        # Load the GDS file. gdstk automatically reads the entire library.
        lib = gdstk.read_gds(gds_path)

        # GDSII files can contain multiple cells. We'll try to render the top-level cells.
        # If there are no top-level cells, we render all of them.
        top_cells = lib.top_level()
        if not top_cells:
            top_cells = lib.cells

        if not top_cells:
            print("Error: No cells found in the GDS file.", file=sys.stderr)
            sys.exit(1)

        # For simplicity, we'll render the first top-level cell found.
        # A more advanced implementation might let the user choose.
        main_cell = top_cells[0]

        # Write the cell to an SVG file.
        # The style argument can be used to set colors for layers.
        # The pad argument adds padding around the layout.
        main_cell.write_svg(svg_path, pad=0.1,                             background="#1e1e1e")
        
        print(f"Successfully converted {os.path.basename(gds_path)} to {os.path.basename(svg_path)}")
        sys.exit(0)

    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: python gds_to_svg.py <input_gds_path> <output_svg_path>", file=sys.stderr)
        sys.exit(1)
    
    gds_input_path = sys.argv[1]
    svg_output_path = sys.argv[2]
    
    gds_to_svg(gds_input_path, svg_output_path)
