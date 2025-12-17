import sys
import os
import json
import gdstk
import shutil  # For rmtree


class NumpyEncoder(json.JSONEncoder):

    def default(self, obj):
        if hasattr(obj, "tolist"):
            return obj.tolist()
        return json.JSONEncoder.default(self, obj)


def gds_to_geometry(gds_path, output_dir, target_cell_name=None):
    """
    Converts a GDSII file into geometry data (polygons), one for each layer.
    Outputs a JSON object to stdout with the results.
    """
    try:
        if os.path.exists(output_dir):
            shutil.rmtree(output_dir)  # Clean up previous run
        os.makedirs(output_dir)

        lib = gdstk.read_gds(gds_path)

        valid_cells = []
        for c in lib.cells:
            if c.name.startswith("$$$"):
                continue
            bbox = c.bounding_box()
            if bbox is not None and (bbox[1][0] > bbox[0][0] and
                                     bbox[1][1] > bbox[0][1]):
                valid_cells.append(c.name)

        all_cell_names = sorted(valid_cells)

        main_cell = None
        if target_cell_name:
            # Find the cell by name in the list of cells
            for c in lib.cells:
                if c.name == target_cell_name:
                    main_cell = c
                    break

            if not main_cell:
                print(json.dumps(
                    {"error": f"Cell '{target_cell_name}' not found."}),
                      file=sys.stderr)
                sys.exit(1)
        else:
            top_cells = lib.top_level()
            if not top_cells:
                # If no top level cells (e.g. circular references?), just pick the first one or error
                if lib.cells:
                    main_cell = lib.cells[0]
                else:
                    print(json.dumps({"error": "No cells found in GDS file."}),
                          file=sys.stderr)
                    sys.exit(1)
            else:
                # Filter out cells starting with $$$ (KLayout metadata)
                valid_top_cells = [
                    c for c in top_cells if not c.name.startswith("$$$")
                ]
                if valid_top_cells:
                    main_cell = valid_top_cells[0]
                else:
                    main_cell = top_cells[0]

        # A deep copy is needed to avoid modifying the original library cell
        flattened_cell = main_cell.copy(f"{main_cell.name}_flat")
        flattened_cell.flatten()

        # Convert all paths to polygons to handle FlexPath/RobustPath and multi-layer paths correctly
        new_polygons = []
        for path_obj in flattened_cell.paths:
            new_polygons.extend(path_obj.to_polygons())
        flattened_cell.polygons.extend(new_polygons)
        flattened_cell.paths.clear()

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
        # Paths are already converted to polygons, so we don't need to iterate over them
        for label in flattened_cell.labels:
            unique_layers_datatypes.add((label.layer, label.texttype))

        # Sort layers for consistent ordering
        layers_datatypes_list = sorted(list(unique_layers_datatypes),
                                       key=lambda x: (x[0], x[1]))

        # Prepare metadata
        metadata = {
            "cell_name": main_cell.name,
            "all_cells": all_cell_names,
            "layers": [],
            "bbox": {
                "x_min": bbox[0][0],
                "x_max": bbox[1][0],
                "y_min": bbox[0][1],
                "y_max": bbox[1][1]
            }
        }

        # First pass: collect valid layers for metadata
        valid_layers = []
        for layer, datatype in layers_datatypes_list:
            layer_key = f"{layer}_{datatype}"

            # Check if layer has content
            has_polys = any(p.layer == layer and p.datatype == datatype for p in flattened_cell.polygons)
            has_labels = any(l.layer == layer and l.texttype == datatype for l in flattened_cell.labels)

            if has_polys or has_labels:
                metadata["layers"].append(layer_key)
                valid_layers.append((layer, datatype))

        # Print metadata first
        print(json.dumps(metadata, cls=NumpyEncoder))
        sys.stdout.flush()

        # Second pass: stream layer data
        CHUNK_SIZE = 2000  # Number of polygons per chunk

        for layer, datatype in valid_layers:
            layer_key = f"{layer}_{datatype}"

            polygons_for_layer = [
                p for p in flattened_cell.polygons
                if p.layer == layer and p.datatype == datatype
            ]

            labels_for_layer = [
                l for l in flattened_cell.labels
                if l.layer == layer and l.texttype == datatype
            ]

            # Stream labels (usually few, send all at once)
            if labels_for_layer:
                lbls = []
                for l in labels_for_layer:
                    lbls.append({
                        "text": l.text,
                        "x": l.origin[0],
                        "y": l.origin[1],
                        "rotation": l.rotation,
                        "magnification": l.magnification,
                        "anchor": l.anchor
                    })
                print(json.dumps({
                    "layerKey": layer_key,
                    "labels": lbls
                }, cls=NumpyEncoder))
                sys.stdout.flush()

            # Stream polygons in chunks
            total_polys = len(polygons_for_layer)
            for i in range(0, total_polys, CHUNK_SIZE):
                chunk_polys = polygons_for_layer[i:i + CHUNK_SIZE]
                polys_data = [p.points for p in chunk_polys]

                print(json.dumps({
                    "layerKey": layer_key,
                    "polygons": polys_data,
                    "chunkIndex": i // CHUNK_SIZE,
                    "totalChunks": (total_polys + CHUNK_SIZE - 1) // CHUNK_SIZE
                }, cls=NumpyEncoder))
                sys.stdout.flush()

        sys.exit(0)

    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(json.dumps({
            "error":
                "Usage: python gds_to_canvas.py <input_gds_path> <output_dir_path> [cell_name]"
        }),
              file=sys.stderr)
        sys.exit(1)

    gds_input_path = sys.argv[1]
    output_dir_path = sys.argv[2]
    target_cell = sys.argv[3] if len(sys.argv) > 3 else None

    gds_to_geometry(gds_input_path, output_dir_path, target_cell)
