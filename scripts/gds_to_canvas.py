import sys
import os
import json
import time
import gdstk
import shutil
import struct
import numpy as np
import base64


class NumpyEncoder(json.JSONEncoder):

    def default(self, obj):
        if hasattr(obj, "tolist"):
            return obj.tolist()
        return json.JSONEncoder.default(self, obj)


def get_transform_matrix(rotation, magnification, x_reflection, origin):
    c = np.cos(rotation)
    s = np.sin(rotation)

    m11 = magnification * c
    m12 = -magnification * s
    m21 = magnification * s
    m22 = magnification * c

    if x_reflection:
        m12 *= -1
        m22 *= -1

    return np.array([[m11, m12, origin[0]], [m21, m22, origin[1]], [0, 0, 1]])


def gds_to_instanced_geometry(gds_path, output_dir, target_cell_name,
                              chunk_size, flow_control_step):
    try:
        t_start = time.time()
        if os.path.exists(output_dir):
            shutil.rmtree(output_dir)
        os.makedirs(output_dir)

        lib = gdstk.read_gds(gds_path)
        t_read = time.time()
        print(f"PROFILE: GDS Read: {t_read - t_start:.4f}s", file=sys.stderr)

        # ... (Cell selection logic same as gds_to_geometry) ...
        valid_cells = [c for c in lib.cells if not c.name.startswith("$$$")]
        all_cell_names = sorted([c.name for c in valid_cells])

        hierarchy = {}
        for c in lib.cells:
            deps = c.dependencies(recursive=False)
            hierarchy[c.name] = sorted([d.name for d in deps])
        top_level_cells = sorted([c.name for c in lib.top_level()])

        main_cell = None
        if target_cell_name:
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
            if not valid_cells:
                if lib.cells:
                    lib.cells.sort(key=lambda x: x.name)
                    main_cell = lib.cells[0]
                else:
                    print(json.dumps({"error": "No cells found."}),
                          file=sys.stderr)
                    sys.exit(1)
            else:
                valid_cells.sort(key=lambda x: x.name)
                main_cell = valid_cells[0]

        print(f"Selected cell: {main_cell.name}", file=sys.stderr)

        # 1. Traverse and collect instances
        # instances: { cell_name: [ matrices (3x3 flat list or similar) ] }
        instances = {}
        # definitions: set of cell names we need to send geometry for
        needed_definitions = set()

        # Stack: (cell, transform_matrix)
        stack = [(main_cell, np.identity(3))]

        # We need to handle the main cell itself as an instance at identity
        instances[main_cell.name] = [np.identity(3)]
        needed_definitions.add(main_cell.name)

        count = 0
        while stack:
            current_cell, current_transform = stack.pop()
            count += 1

            # For each reference in this cell
            for ref in current_cell.references:
                # ref can be Reference or CellArray

                # Use apply_repetition if available to handle all array types correctly
                sub_refs = []
                if hasattr(ref, 'apply_repetition'):
                    sub_refs = ref.apply_repetition()
                else:
                    # Fallback for older gdstk or if apply_repetition is missing
                    if isinstance(ref, gdstk.Reference):
                        cols = getattr(ref, 'columns', 1)
                        rows = getattr(ref, 'rows', 1)
                        if cols is None:
                            cols = 1
                        if rows is None:
                            rows = 1

                        if cols == 1 and rows == 1:
                            sub_refs = [ref]
                        else:
                            # Manual expansion for simple grid
                            spacing = getattr(ref, 'spacing', (0, 0))
                            if spacing is None:
                                spacing = (0, 0)
                            s1, s2 = spacing

                            # We create temporary objects or just calculate matrices
                            # To keep logic unified, let's just calculate matrices here
                            pass

                    elif isinstance(ref, gdstk.CellArray):
                        # Manual expansion for CellArray
                        pass

                # If we got sub_refs from apply_repetition, use them
                if sub_refs:
                    for sub_ref in sub_refs:
                        if not isinstance(sub_ref.cell, gdstk.Cell):
                            continue

                        origin = sub_ref.origin
                        rotation = sub_ref.rotation if sub_ref.rotation else 0
                        magnification = sub_ref.magnification if sub_ref.magnification else 1
                        x_reflection = sub_ref.x_reflection if sub_ref.x_reflection else False

                        t_local = get_transform_matrix(rotation, magnification,
                                                       x_reflection, origin)
                        t_global = current_transform @ t_local

                        if sub_ref.cell.name not in instances:
                            instances[sub_ref.cell.name] = []
                        instances[sub_ref.cell.name].append(t_global)

                        needed_definitions.add(sub_ref.cell.name)
                        stack.append((sub_ref.cell, t_global))
                    continue

                # Fallback Manual Logic (if apply_repetition failed or not available)
                ref_cells = []
                transforms = []

                if isinstance(ref, gdstk.Reference):
                    if isinstance(ref.cell, gdstk.Cell):
                        ref_cells = [ref.cell]
                    else:
                        continue

                    cols = getattr(ref, 'columns', 1)
                    rows = getattr(ref, 'rows', 1)
                    if cols is None:
                        cols = 1
                    if rows is None:
                        rows = 1

                    spacing = getattr(ref, 'spacing', (0, 0))
                    if spacing is None:
                        spacing = (0, 0)

                    origin = ref.origin
                    rotation = ref.rotation if ref.rotation else 0
                    magnification = ref.magnification if ref.magnification else 1
                    x_reflection = ref.x_reflection if ref.x_reflection else False

                    base_matrix = get_transform_matrix(rotation, magnification,
                                                       x_reflection, origin)

                    if cols == 1 and rows == 1:
                        transforms.append(base_matrix)
                    else:
                        s1, s2 = spacing
                        for i in range(cols):
                            for j in range(rows):
                                offset_matrix = np.identity(3)
                                offset_matrix[0, 2] = i * s1
                                offset_matrix[1, 2] = j * s2
                                transforms.append(base_matrix @ offset_matrix)

                elif isinstance(ref, gdstk.CellArray):
                    if isinstance(ref.cell, gdstk.Cell):
                        ref_cells = [ref.cell]
                    else:
                        continue

                    cols = ref.columns
                    rows = ref.rows
                    s1, s2 = ref.spacing
                    origin = ref.origin
                    rotation = ref.rotation
                    magnification = ref.magnification
                    x_reflection = ref.x_reflection

                    base_matrix = get_transform_matrix(rotation, magnification,
                                                       x_reflection, origin)

                    for i in range(cols):
                        for j in range(rows):
                            offset_matrix = np.identity(3)
                            offset_matrix[0, 2] = i * s1
                            offset_matrix[1, 2] = j * s2
                            transforms.append(base_matrix @ offset_matrix)

                # Now process these transforms
                for cell_to_ref in ref_cells:
                    for t_local in transforms:
                        # T_global = T_parent * T_local
                        t_global = current_transform @ t_local

                        if cell_to_ref.name not in instances:
                            instances[cell_to_ref.name] = []
                        instances[cell_to_ref.name].append(t_global)

                        needed_definitions.add(cell_to_ref.name)
                        stack.append((cell_to_ref, t_global))

        # 2. Send Metadata
        bbox = main_cell.bounding_box()
        if bbox is None:
            bbox = [[0, 0], [0, 0]]

        metadata = {
            "cell_name": main_cell.name,
            "all_cells": all_cell_names,
            "top_level_cells": top_level_cells,
            "hierarchy": hierarchy,
            "layers": [],
            "bbox": {
                "x_min": bbox[0][0],
                "x_max": bbox[1][0],
                "y_min": bbox[0][1],
                "y_max": bbox[1][1]
            },
            "isInstanced": True
        }

        all_layers = set()
        cell_map = {c.name: c for c in lib.cells}

        for cell_name in needed_definitions:
            c = cell_map.get(cell_name)
            if not c:
                continue
            for p in c.polygons:
                all_layers.add(f"{p.layer}_{p.datatype}")
            for l in c.labels:
                all_layers.add(f"{l.layer}_{l.texttype}")

        def layer_key_sort(key):
            parts = key.split('_')
            return (int(parts[0]), int(parts[1]))

        metadata["layers"] = sorted(list(all_layers), key=layer_key_sort)

        print(json.dumps(metadata, cls=NumpyEncoder))
        sys.stdout.flush()

        # 3. Stream Definitions (Geometry)
        for cell_name in needed_definitions:
            c = cell_map.get(cell_name)
            if not c:
                continue

            layer_polys = {}
            polys = list(c.polygons)
            for path in c.paths:
                polys.extend(path.to_polygons())

            for p in polys:
                key = f"{p.layer}_{p.datatype}"
                if key not in layer_polys:
                    layer_polys[key] = []
                layer_polys[key].append(p)

            for layer_key, polygons in layer_polys.items():
                total_polys = len(polygons)
                for i in range(0, total_polys, chunk_size):
                    chunk = polygons[i:i + chunk_size]

                    buffer_parts = []

                    # Filter valid polygons first
                    valid_chunk = []
                    for p in chunk:
                        if p.points is not None and len(p.points) > 0:
                            valid_chunk.append(p)

                    buffer_parts.append(struct.pack('<I', len(valid_chunk)))
                    for p in valid_chunk:
                        points = p.points
                        buffer_parts.append(struct.pack('<I', len(points)))
                        buffer_parts.append(points.astype(np.float32).tobytes())

                    full_binary = b''.join(buffer_parts)
                    b64_data = base64.b64encode(full_binary).decode('ascii')

                    msg = {
                        "type":
                            "definition",
                        "cellName":
                            cell_name,
                        "layerKey":
                            layer_key,
                        "chunkIndex":
                            i // chunk_size,
                        "totalChunks":
                            (total_polys + chunk_size - 1) // chunk_size,
                        "data":
                            b64_data
                    }
                    print("CHUNK_B64|" + json.dumps(msg, separators=(',', ':')))
                    sys.stdout.flush()

                    if flow_control_step != -1 and (
                            i // chunk_size) % flow_control_step == 0:
                        sys.stdin.readline()

        # 4. Stream Instances
        instance_chunk_size = chunk_size

        for cell_name, transforms in instances.items():
            if not transforms:
                continue

            # Ensure cell_name is a string
            if cell_name is None:
                print(f"Warning: Found instance with None cell_name, skipping.",
                      file=sys.stderr)
                continue

            total_instances = len(transforms)

            for i in range(0, total_instances, instance_chunk_size):
                chunk = transforms[i:i + instance_chunk_size]

                buffer_parts = []
                buffer_parts.append(struct.pack('<I', len(chunk)))

                # Transpose matrices from Row-Major (Python/Math) to Column-Major (GLSL)
                # chunk is list of (3,3) arrays.
                # We want to transpose each 3x3 matrix.
                chunk_array = np.array(chunk,
                                       dtype=np.float32)  # Shape (N, 3, 3)
                chunk_transposed = chunk_array.transpose(
                    0, 2, 1)  # Swap last two axes (rows <-> cols)
                flat_transforms = chunk_transposed.reshape(-1, 9)

                buffer_parts.append(flat_transforms.tobytes())

                full_binary = b''.join(buffer_parts)
                b64_data = base64.b64encode(full_binary).decode('ascii')

                msg = {
                    "type":
                        "instance",
                    "cellName":
                        cell_name,
                    "chunkIndex":
                        i // instance_chunk_size,
                    "totalChunks":
                        (total_instances + instance_chunk_size - 1) //
                        instance_chunk_size,
                    "data":
                        b64_data
                }
                print("CHUNK_B64|" + json.dumps(msg, separators=(',', ':')))
                sys.stdout.flush()

                if flow_control_step != -1 and (
                        i // instance_chunk_size) % flow_control_step == 0:
                    sys.stdin.readline()

        t_end = time.time()
        print(f"PROFILE: Instanced Streaming: {t_end - t_read:.4f}s",
              file=sys.stderr)
        sys.exit(0)

    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)


def gds_to_geometry(gds_path,
                    output_dir,
                    target_cell_name=None,
                    chunk_size=2000,
                    flow_control_step=5):
    """
    Converts a GDSII file into geometry data (polygons), one for each layer.
    Outputs a JSON object to stdout with the results.
    """
    try:
        t_start = time.time()
        if os.path.exists(output_dir):
            shutil.rmtree(output_dir)  # Clean up previous run
        os.makedirs(output_dir)

        lib = gdstk.read_gds(gds_path)
        t_read = time.time()
        print(f"PROFILE: GDS Read: {t_read - t_start:.4f}s", file=sys.stderr)

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

        t_select = time.time()

        # A deep copy is needed to avoid modifying the original library cell
        flattened_cell = main_cell.copy(f"{main_cell.name}_flat")
        flattened_cell.flatten()

        # Convert all paths to polygons to handle FlexPath/RobustPath and multi-layer paths correctly
        new_polygons = []
        for path_obj in flattened_cell.paths:
            new_polygons.extend(path_obj.to_polygons())
        flattened_cell.polygons.extend(new_polygons)
        flattened_cell.paths.clear()

        t_flatten = time.time()
        print(f"PROFILE: Flatten & Path Conv: {t_flatten - t_select:.4f}s",
              file=sys.stderr)

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
            "top_level_cells": top_level_cells,
            "hierarchy": hierarchy,
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
            has_polys = any(p.layer == layer and p.datatype == datatype
                            for p in flattened_cell.polygons)
            has_labels = any(l.layer == layer and l.texttype == datatype
                             for l in flattened_cell.labels)

            if has_polys or has_labels:
                metadata["layers"].append(layer_key)
                valid_layers.append((layer, datatype))

        # Print metadata first
        print(json.dumps(metadata, cls=NumpyEncoder))
        sys.stdout.flush()

        t_meta = time.time()
        print(f"PROFILE: Metadata Prep: {t_meta - t_flatten:.4f}s",
              file=sys.stderr)

        # Second pass: stream layer data

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
                print(
                    json.dumps({
                        "layerKey": layer_key,
                        "labels": lbls
                    },
                               cls=NumpyEncoder))
                sys.stdout.flush()

            # Stream polygons in chunks
            total_polys = len(polygons_for_layer)
            print(f"PROFILE: Layer {layer_key} has {total_polys} polygons",
                  file=sys.stderr)

            for i in range(0, total_polys, chunk_size):
                chunk_polys = polygons_for_layer[i:i + chunk_size]

                # In-Memory Binary Buffer Construction
                # We build the byte array in memory
                buffer_parts = []

                # 1. Number of polygons (uint32)
                buffer_parts.append(struct.pack('<I', len(chunk_polys)))

                for p in chunk_polys:
                    points = p.points  # Nx2 numpy array
                    n_points = len(points)
                    # 2. Point count (uint32)
                    buffer_parts.append(struct.pack('<I', n_points))
                    # 3. Points (float32)
                    buffer_parts.append(points.astype(np.float32).tobytes())

                full_binary = b''.join(buffer_parts)
                b64_data = base64.b64encode(full_binary).decode('ascii')

                # Send Base64 Data Line
                # Format: CHUNK_B64|{"layerKey":..., "data": "..."}
                print("CHUNK_B64|" + json.dumps(
                    {
                        "layerKey":
                            layer_key,
                        "chunkIndex":
                            i // chunk_size,
                        "totalChunks": (total_polys + chunk_size - 1) //
                                       chunk_size,
                        "data":
                            b64_data
                    },
                    separators=(',', ':')))
                sys.stdout.flush()
                # flow control
                if flow_control_step != -1 and (
                        i // chunk_size) % flow_control_step == 0:
                    sys.stdin.readline()

        t_end = time.time()
        print(f"PROFILE: Streaming: {t_end - t_meta:.4f}s", file=sys.stderr)
        print(f"PROFILE: Total Python Time: {t_end - t_start:.4f}s",
              file=sys.stderr)

        sys.exit(0)

    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(json.dumps({
            "error":
                "Usage: python gds_to_canvas.py <input_gds_path> <output_dir_path> [cell_name] [chunk_size]"
        }),
              file=sys.stderr)
        sys.exit(1)

    gds_input_path = sys.argv[1]
    output_dir_path = sys.argv[2]
    target_cell = sys.argv[3] if len(sys.argv) > 3 else None
    if target_cell == "":
        target_cell = None

    chunk_size = int(sys.argv[4]) if len(sys.argv) > 4 else 2000
    flow_control_step = int(sys.argv[5]) if len(sys.argv) > 5 else 5
    use_instancing = int(sys.argv[6]) if len(sys.argv) > 6 else 0

    if use_instancing:
        gds_to_instanced_geometry(gds_input_path, output_dir_path, target_cell,
                                  chunk_size, flow_control_step)
    else:
        gds_to_geometry(gds_input_path, output_dir_path, target_cell,
                        chunk_size, flow_control_step)
