# $show-in-menu
# KLayout macro (Python)
#
# Purpose:
#   Reads the gds-preview clipboard payload (copied from the VS Code webview)
#   and inserts polygons into the active cell on the currently selected layer.
#
# Setup:
#   1) In KLayout: Tools -> Macro Development
#   2) Create a new Python macro and paste this file's content
#   3) (Optional) Assign a shortcut (e.g. Cmd+V) to the macro
#
# Notes:
#   - v2 (recommended): clipboard starts with "# gds-preview: polygons v2" and contains JSON.
#       The macro will create/lookup the referenced layers and paste polygons into those layers.
#   - v1 (legacy): clipboard starts with "# gds-preview: polygons v1" and contains a Python snippet
#       defining `polys` (list[pya.DPolygon]) pasted into the currently selected layer.

import pya
import json


def _call_maybe(obj, attr: str):
    """Call a method or return a property value, handling Ruby-ish names."""
    if obj is None:
        return None
    try:
        v = getattr(obj, attr)
    except Exception:
        return None
    try:
        return v() if callable(v) else v
    except Exception:
        return None


def _call_predicate(obj, base: str) -> bool:
    """Try common predicate name variants (e.g. 'at_end?', 'at_end')."""
    for name in (base, f"{base}?", base.rstrip("?")):
        try:
            v = getattr(obj, name)
        except Exception:
            continue
        try:
            return bool(v() if callable(v) else v)
        except Exception:
            continue
    return False


def _call_method(obj, name: str, *args):
    if obj is None:
        return None
    try:
        fn = getattr(obj, name)
    except Exception:
        return None
    try:
        return fn(*args) if callable(fn) else None
    except Exception:
        return None


def _get_clipboard_text() -> str:
    # Prefer Qt clipboard if available.
    try:
        if hasattr(pya, "QApplication"):
            cb = pya.QApplication.clipboard()
            if cb is not None:
                return cb.text() or ""
    except Exception:
        pass

    # No reliable clipboard API available.
    return ""


def _get_active_view() -> "pya.LayoutView":
    try:
        v = pya.LayoutView.current()
        return v
    except Exception:
        return None


def _get_target_layer_index(view: "pya.LayoutView") -> int:
    # Use the currently selected layer in the layer list.
    try:
        it = _call_maybe(view, "current_layer")
        if it is None:
            return -1
        # Some versions return a "null" iterator when nothing is selected.
        if _call_predicate(it, "is_null"):
            return -1
        if _call_predicate(it, "at_end"):
            return -1
        node = _call_maybe(it, "current")
        if node is None:
            return -1
        li = _call_maybe(node, "layer_index")
        return int(li) if li is not None else -1
    except Exception:
        return -1


def _extract_payload_from_clipboard(text: str):
    s = text.strip()
    if s.startswith("# gds-preview: polygons v2"):
        # v2 format: header line(s) + JSON as the remaining non-comment lines.
        lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
        # Drop comment lines
        data_lines = [ln for ln in lines if not ln.startswith('#')]
        if not data_lines:
            raise ValueError("No JSON payload found for v2")
        raw = "\n".join(data_lines)
        payload = json.loads(raw)
        polys = payload.get("polygons")
        if not isinstance(polys, list) or len(polys) == 0:
            raise ValueError("No polygons found in v2 payload")
        return {"version": 2, "polygons": polys}

    if s.startswith("# gds-preview: polygons v1"):
        # v1 format: Python snippet defining `polys` (list[pya.DPolygon]).
        ns = {"pya": pya}
        exec(text, ns, ns)
        polys = ns.get("polys")
        if not isinstance(polys, list) or len(polys) == 0:
            raise ValueError("No polygons found in clipboard payload")
        return {"version": 1, "polys": polys}

    raise ValueError(
        "Clipboard does not look like gds-preview polygons (missing header)"
    )


def _parse_layer_key(layer_key: str):
    if not isinstance(layer_key, str) or '_' not in layer_key:
        return None
    parts = layer_key.split('_', 1)
    try:
        return int(parts[0]), int(parts[1])
    except Exception:
        return None


def paste_gds_preview_polygons():
    view = _get_active_view()
    if view is None:
        raise RuntimeError("No active layout view")

    cv = _call_maybe(view, "active_cellview")
    if cv is None or not (_call_predicate(cv, "is_valid") or
                          bool(_call_maybe(cv, "is_valid"))):
        raise RuntimeError("No active cellview")

    cell = _call_maybe(cv, "cell")
    if cell is None:
        raise RuntimeError("No target cell")

    text = _get_clipboard_text()
    if not text:
        raise RuntimeError("Clipboard is empty (or not accessible)")

    payload = _extract_payload_from_clipboard(text)

    view.transaction("Paste gds-preview polygons")
    try:
        if payload.get("version") == 2:
            layout = _call_maybe(cv, "layout")
            if layout is None:
                raise RuntimeError("No layout available")

            for item in payload.get("polygons", []):
                layer_key = item.get("layerKey")
                pts = item.get("points")
                if not isinstance(pts, list) or len(pts) < 3:
                    continue

                # Create/lookup layer
                parsed = _parse_layer_key(layer_key) if layer_key is not None else None
                if parsed is None:
                    # Fall back to currently selected layer
                    layer_index = _get_target_layer_index(view)
                    if layer_index < 0:
                        raise RuntimeError(
                            "No current layer selected (select a layer in the layer list)"
                        )
                else:
                    la, dt = parsed
                    li = _call_method(layout, "layer", la, dt)
                    if li is None:
                        # Some versions expose layout.layer as a normal method
                        li = layout.layer(la, dt)
                    layer_index = int(li)

                dpts = []
                for p in pts:
                    if not isinstance(p, list) or len(p) < 2:
                        continue
                    dpts.append(pya.DPoint(float(p[0]), float(p[1])))
                if len(dpts) < 3:
                    continue

                dpoly = pya.DPolygon(dpts)
                cell.shapes(layer_index).insert(dpoly)

        else:
            layer_index = _get_target_layer_index(view)
            if layer_index < 0:
                raise RuntimeError(
                    "No current layer selected (select a layer in the layer list)"
                )

            polys = payload.get("polys") or []
            shapes = cell.shapes(layer_index)
            for poly in polys:
                shapes.insert(poly)
    finally:
        view.commit()

    # Ensure layer list contains any newly-created layers etc.
    try:
        view.add_missing_layers()
        view.update_content()
    except Exception:
        pass


# Run when executed
paste_gds_preview_polygons()
