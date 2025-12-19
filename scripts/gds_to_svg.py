import sys
import os
import json
import gdstk
import re
import shutil  # For rmtree


class NumpyEncoder(json.JSONEncoder):

    def default(self, obj):
        if hasattr(obj, "tolist"):
            return obj.tolist()
        return json.JSONEncoder.default(self, obj)


def gds_to_layered_svgs(gds_path,
                        output_dir,
                        target_cell_name=None,
                        is_negative=False):
    """
    Converts a GDSII file into multiple SVG fragments (inner <g> content), one for each layer.
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

        # Build hierarchy
        hierarchy = {}
        for c in lib.cells:
            # Get direct dependencies (child cells)
            deps = c.dependencies(recursive=False)
            # Store names
            hierarchy[c.name] = sorted([d.name for d in deps])

        top_level_cells = sorted([c.name for c in lib.top_level()])

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
            # 1. Filter out invalid cells (starting with $$$)
            valid_cells = [c for c in lib.cells if not c.name.startswith("$$$")]

            if not valid_cells:
                # Fallback if only $$$ cells exist
                if lib.cells:
                    lib.cells.sort(key=lambda x: x.name)
                    main_cell = lib.cells[0]
                    print(
                        f"Warning: Only metadata cells found. Selected: {main_cell.name}",
                        file=sys.stderr)
                else:
                    print(json.dumps({"error": "No cells found in GDS file."}),
                          file=sys.stderr)
                    sys.exit(1)
            else:
                # Use alphabetical order (dictionary sort)
                valid_cells.sort(key=lambda x: x.name)
                main_cell = valid_cells[0]
                print(
                    f"Selected first alphabetical valid cell: {main_cell.name}",
                    file=sys.stderr)

        # Log selected cell for debugging
        print(f"Final selected cell: {main_cell.name}", file=sys.stderr)

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

        # Create BBox polygon for negative view
        bbox_poly = None
        if is_negative:
            bbox_poly = gdstk.rectangle(bbox[0], bbox[1])

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

        # Filter out empty layers if needed, but for now we keep them if they were in the geometry

        layer_svg_fragments = {}
        all_labels = []
        active_layer_keys = set()

        for layer, datatype in layers_datatypes_list:
            layer_key = f"{layer}_{datatype}"

            # Create a new cell for just this layer
            layer_cell = gdstk.Cell(f"LAYER_{layer_key}_fragment")

            # Manually filter polygons, paths, and labels for the current layer
            polygons_for_layer = [
                p for p in flattened_cell.polygons
                if p.layer == layer and p.datatype == datatype
            ]
            # Paths are already converted to polygons
            labels_for_layer = [
                l for l in flattened_cell.labels
                if l.layer == layer and l.texttype == datatype
            ]

            if polygons_for_layer or labels_for_layer:
                active_layer_keys.add(layer_key)

            # Collect labels for separate JSON output (for intelligent scaling in frontend)
            if labels_for_layer:
                for l in labels_for_layer:
                    all_labels.append({
                        "layerKey": layer_key,
                        "text": l.text,
                        "x": l.origin[0],
                        "y": l.origin[1],
                        "rotation": l.rotation,
                        "magnification": l.magnification,
                        "anchor": l.anchor
                    })

            if not polygons_for_layer:
                continue

            # Apply negative view logic if enabled
            if is_negative and bbox_poly:
                # Subtract polygons from bbox
                try:
                    polygons_for_layer = gdstk.boolean([bbox_poly],
                                                       polygons_for_layer,
                                                       'not')
                    # Ensure the new polygons have the correct layer/datatype so the style matches
                    for p in polygons_for_layer:
                        p.layer = layer
                        p.datatype = datatype
                except Exception as e:
                    print(
                        f"Warning: Boolean operation failed for layer {layer_key}: {e}",
                        file=sys.stderr)
                    # Fallback to original polygons or skip?
                    # If boolean fails, we probably shouldn't show anything or show original
                    pass

            # Only add polygons to the SVG, NOT labels
            layer_cell.add(*polygons_for_layer)

            temp_full_svg_path = os.path.join(
                output_dir, f"temp_full_layer_{layer_key}.svg")

            # Write full SVG to a temporary file, then extract inner content
            style_dict = {
                "stroke-width": "0.1",
                "vector-effect": "non-scaling-stroke"
            }
            layer_cell.write_svg(temp_full_svg_path,
                                 scaling=1,
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

        # Sort layers for consistent ordering
        # We need to sort the keys numerically (layer, datatype), not lexicographically ("10" comes before "2")
        def layer_key_sort(key):
            parts = key.split('_')
            return (int(parts[0]), int(parts[1]))

        result = {
            "cell_name": main_cell.name,
            "all_cells": all_cell_names,
            "top_level_cells": top_level_cells,
            "hierarchy": hierarchy,
            "layers": sorted(list(active_layer_keys), key=layer_key_sort),
            "svg_fragments":
                layer_svg_fragments,  # Changed from 'files' to 'svg_fragments'
            "labels": all_labels,
            "bbox": {
                "x_min": bbox[0][0],
                "x_max": bbox[1][0],
                "y_min": bbox[0][1],
                "y_max": bbox[1][1]
            }
        }

        print(json.dumps(result, cls=NumpyEncoder))
        sys.exit(0)

    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(json.dumps({
            "error":
                "Usage: python gds_to_svg.py <input_gds_path> <output_dir_path> [cell_name] [--negative]"
        }),
              file=sys.stderr)
        sys.exit(1)

    gds_input_path = sys.argv[1]
    output_dir_path = sys.argv[2]

    target_cell = None
    is_negative = False

    # Parse remaining arguments
    for arg in sys.argv[3:]:
        if arg == "--negative":
            is_negative = True
        elif not arg.startswith("--"):
            target_cell = arg

    gds_to_layered_svgs(gds_input_path, output_dir_path, target_cell,
                        is_negative)
