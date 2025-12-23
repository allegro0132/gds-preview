import sys
import re

import numpy as np
import klayout.db as pya


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


def parse_kfactory_transform(trans_str):
    # Format examples:
    # r0 1290000,-1110000
    # r45 *1 -92.4901153702,-1093.36774901

    rotation = 0
    magnification = 1
    x = 0
    y = 0

    parts = trans_str.split()
    for part in parts:
        if part.startswith('r'):
            try:
                rotation = float(part[1:])
            except:
                pass
        elif part.startswith('*'):
            try:
                magnification = float(part[1:])
            except:
                pass
        elif ',' in part:
            try:
                coords = part.split(',')
                x = float(coords[0])
                y = float(coords[1])
            except:
                pass

    return rotation, magnification, x, y


def extract_ports(cell, gds_path):
    ports = []

    # 1. Try KLayout for MetaInfo (kfactory ports)
    try:
        layout = pya.Layout()
        layout.read(gds_path)
        k_cell = layout.cell(cell.name)
        if k_cell:
            for meta in k_cell.each_meta_info():
                if meta.name.startswith("kfactory:ports"):
                    port_data = str(meta.value)

                    # Extract name
                    name_match = re.search(r"'name':\s*'([^']*)'", port_data)
                    name = name_match.group(1) if name_match else "unknown"

                    # Extract port_type
                    type_match = re.search(r"'port_type':\s*'([^']*)'",
                                           port_data)
                    port_type = type_match.group(1) if type_match else "optical"

                    # Extract transform
                    # Prefer dcplx_trans (microns/float) over trans (DBU/int)
                    trans_match = re.search(
                        r"'dcplx_trans':\s*([^,}]*(?:,[^,}]*)?)", port_data)
                    is_complex = True
                    if not trans_match:
                        trans_match = re.search(
                            r"'trans':\s*([^,}]*(?:,[^,}]*)?)", port_data)
                        is_complex = False

                    if trans_match:
                        trans_str = trans_match.group(1).strip()
                        rot_deg, mag, x, y = parse_kfactory_transform(trans_str)

                        if not is_complex:
                            # Convert DBU to microns
                            dbu = layout.dbu
                            x *= dbu
                            y *= dbu

                        ports.append({
                            "name": name,
                            "x": x,
                            "y": y,
                            "rotation":
                                rot_deg *
                                (np.pi / 180.0),  # Convert degrees to radians
                            "layer": 1 if port_type == "optical" else 71,
                            "port_type": port_type
                        })
    except ImportError:
        pass
    except Exception as e:
        print(f"KLayout extraction failed: {e}", file=sys.stderr)

    if ports:
        return ports

    # 2. Fallback to gdstk properties (JSON)
    if cell.properties:
        for prop in cell.properties:
            try:
                # gdsfactory stores ports in a 'ports' key in JSON properties
                # But properties are list of lists/tuples?
                # gdstk properties are usually list of [key, value] or similar?
                # Actually gdstk.Cell.properties is a list of lists of values?
                # Let's assume it might be a JSON string in one of the properties
                pass
            except:
                pass

    # 3. Fallback to Labels on specific layers
    # Layers: 1/0 (optical), 71/0 (electrical?), 66/0 (labels?)
    target_layers = [(1, 0), (71, 0), (66, 0), (1, 10)]

    for label in cell.labels:
        if (label.layer, label.texttype) in target_layers:
            ports.append({
                "name": label.text,
                "x": label.origin[0],
                "y": label.origin[1],
                "rotation": label.rotation,  # gdstk uses radians
                "layer": label.layer,
                "port_type": "optical" if label.layer == 1 else "electrical"
            })

    return ports
