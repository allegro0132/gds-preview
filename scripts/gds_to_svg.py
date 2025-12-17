import sys
import os
import json
import gdstk
import re
import shutil  # For rmtree


def gds_to_layered_svgs(gds_path, output_dir):
    """
    Converts a GDSII file into multiple SVG fragments (inner <g> content), one for each layer.
    Outputs a JSON object to stdout with the results.
    """
    try:
        if os.path.exists(output_dir):
            shutil.rmtree(output_dir)  # Clean up previous run
        os.makedirs(output_dir)

        lib = gdstk.read_gds(gds_path)

        top_cells = lib.top_level()
        if not top_cells:
            print(json.dumps({"error": "No top-level cells found in GDS file."
                             }),
                  file=sys.stderr)
            sys.exit(1)

        main_cell = top_cells[0]
        # A deep copy is needed to avoid modifying the original library cell
        flattened_cell = main_cell.copy(f"{main_cell.name}_flat")
        flattened_cell.flatten()

        # Get bounding box of the whole cell to ensure all SVGs have the same viewport
        bbox = flattened_cell.bounding_box()
        if bbox is None or not (bbox[1][0] > bbox[0][0] and
                                bbox[1][1] > bbox[0][1]):
            print(json.dumps({
                "error":
                    "Cell is empty or has an invalid bounding box (zero or negative size)."
            }),
                  file=sys.stderr)
            sys.exit(1)

        # Find all unique layers by iterating through the cell's geometry
        unique_layers_datatypes = set()
        for poly in flattened_cell.polygons:
            unique_layers_datatypes.add((poly.layer, poly.datatype))
        for path_obj in flattened_cell.paths:  # Renamed to path_obj to avoid conflict with path module
            unique_layers_datatypes.add((path_obj.layer, path_obj.datatype))
        for label in flattened_cell.labels:
            unique_layers_datatypes.add((label.layer, label.datatype))

        # Sort layers for consistent ordering
        layers_datatypes_list = sorted(list(unique_layers_datatypes),
                                       key=lambda x: (x[0], x[1]))

        if not layers_datatypes_list:
            print(json.dumps({"error": "No layers with geometry found."}),
                  file=sys.stderr)
            sys.exit(1)

        layer_svg_fragments = {}

        for layer, datatype in layers_datatypes_list:
            layer_key = f"{layer}_{datatype}"

            # Create a new cell for just this layer
            layer_cell = gdstk.Cell(f"LAYER_{layer_key}_fragment")

            # Manually filter polygons, paths, and labels for the current layer
            polygons_for_layer = [
                p for p in flattened_cell.polygons
                if p.layer == layer and p.datatype == datatype
            ]
            paths_for_layer = [
                p for p in flattened_cell.paths
                if p.layer == layer and p.datatype == datatype
            ]
            labels_for_layer = [
                l for l in flattened_cell.labels
                if l.layer == layer and l.datatype == datatype
            ]

            if not polygons_for_layer and not paths_for_layer and not labels_for_layer:
                continue

            layer_cell.add(*polygons_for_layer, *paths_for_layer,
                           *labels_for_layer)

            temp_full_svg_path = os.path.join(
                output_dir, f"temp_full_layer_{layer_key}.svg")

            # Write full SVG to a temporary file, then extract inner content
            style_dict = {
                "stroke-width": "0.1",
                "vector-effect": "non-scaling-stroke"
            }
            layer_cell.write_svg(temp_full_svg_path,
                                 pad=0,
                                 background="none",
                                 shape_style={(layer, datatype): style_dict})

            inner_svg_content = ""
            try:
                with open(temp_full_svg_path, 'r', encoding='utf-8') as f:
                    full_svg_content = f.read()

                # Use regex to extract the content inside the <svg> tag
                match = re.search(r'<svg[^>]*>(.*)</svg>', full_svg_content,
                                  re.DOTALL)
                if match:
                    inner_svg_content = match.group(1).strip()
                else:
                    raise ValueError("Could not extract inner SVG content.")

            except Exception as e:
                print(json.dumps({
                    "error":
                        f"Failed to process temp SVG for layer {layer_key}: {e}"
                }),
                      file=sys.stderr)
                sys.exit(1)
            finally:
                # Clean up temporary full SVG file
                if os.path.exists(temp_full_svg_path):
                    os.remove(temp_full_svg_path)

            if inner_svg_content:
                layer_svg_fragments[layer_key] = inner_svg_content

        # Prepare the JSON output
        result = {
            "layers": [k for k in layer_svg_fragments.keys()],
            "svg_fragments":
                layer_svg_fragments,  # Changed from 'files' to 'svg_fragments'
            "bbox": {
                "x_min": bbox[0][0],
                "x_max": bbox[1][0],
                "y_min": bbox[0][1],
                "y_max": bbox[1][1]
            }
        }

        print(json.dumps(result))
        sys.exit(0)

    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(json.dumps({
            "error":
                "Usage: python gds_to_svg.py <input_gds_path> <output_dir_path>"
        }),
              file=sys.stderr)
        sys.exit(1)

    gds_input_path = sys.argv[1]
    output_dir_path = sys.argv[2]

    gds_to_layered_svgs(gds_input_path, output_dir_path)
