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
#   - This macro expects clipboard text starting with:
#       "# gds-preview: polygons v1"
#   - The clipboard payload defines a variable named `polys` (list[pya.DPolygon]).

import pya


def _call_maybe(obj, attr: str):
    """Call a method or return a property value, handling KLayout's Ruby-ish names."""
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


def _extract_polys_from_clipboard(text: str):
    header = "# gds-preview: polygons v1"
    if not text.strip().startswith(header):
        raise ValueError(
            "Clipboard does not look like gds-preview polygons (missing header)"
        )

    # The payload is a Python snippet defining `polys`.
    # We execute it in a restricted namespace and then retrieve `polys`.
    ns = {"pya": pya}
    exec(text, ns, ns)
    polys = ns.get("polys")
    if not isinstance(polys, list) or len(polys) == 0:
        raise ValueError("No polygons found in clipboard payload")
    return polys


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

    layer_index = _get_target_layer_index(view)
    if layer_index < 0:
        raise RuntimeError(
            "No current layer selected (select a layer in the layer list)")

    text = _get_clipboard_text()
    if not text:
        raise RuntimeError("Clipboard is empty (or not accessible)")

    polys = _extract_polys_from_clipboard(text)

    view.transaction("Paste gds-preview polygons")
    try:
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
