import { state, elements } from './state.js';
import { updateStatus, darken, createShader, createProgram } from './utils.js';
import { updateTransform, resizeCanvas, fitView, worldToScreen, screenToWorld, applyRotationAndFlip, applyContextTransform } from './transform.js';

function parseCssColorToRgb(s) {
    if (!s) return null;
    const str = String(s).trim();
    if (!str) return null;

    if (str[0] === '#') {
        const hex = str.slice(1);
        if (hex.length === 3) {
            const r = parseInt(hex[0] + hex[0], 16);
            const g = parseInt(hex[1] + hex[1], 16);
            const b = parseInt(hex[2] + hex[2], 16);
            if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) return { r, g, b };
        }
        if (hex.length === 6) {
            const r = parseInt(hex.slice(0, 2), 16);
            const g = parseInt(hex.slice(2, 4), 16);
            const b = parseInt(hex.slice(4, 6), 16);
            if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) return { r, g, b };
        }
        return null;
    }

    const m = str.match(/rgba?\(([^)]+)\)/i);
    if (m) {
        const parts = m[1].split(',').map(p => p.trim());
        if (parts.length >= 3) {
            const r = Number(parts[0]);
            const g = Number(parts[1]);
            const b = Number(parts[2]);
            if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
                return { r: Math.max(0, Math.min(255, r)), g: Math.max(0, Math.min(255, g)), b: Math.max(0, Math.min(255, b)) };
            }
        }
    }

    return null;
}

function isDarkVscodeTheme() {
    const bg = (getComputedStyle(document.body).getPropertyValue('--vscode-editor-background') || '').trim();
    const rgb = parseCssColorToRgb(bg);
    if (!rgb) {
        return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    }
    const lum = (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
    return lum < 0.5;
}

function getHighlightStyle() {
    const dark = isDarkVscodeTheme();
    // User request: dark theme => white, light theme => black.
    // Keep alpha modest to avoid completely hiding geometry.
    const strokeCss = dark ? '#ffffff' : '#000000';
    const fillCss = dark ? 'rgba(255, 255, 255, 0.3)' : 'rgba(0, 0, 0, 0.3)';
    const gl = dark ? { r: 1.0, g: 1.0, b: 1.0, a: 0.3 } : { r: 0.0, g: 0.0, b: 0.0, a: 0.3 };
    return { strokeCss, fillCss, gl };
}

function rebuildHighlightEdgeBufferIfNeeded() {
    if (!state.gl) return;
    if (!state.highlightEdgesDirty) return;

    state.highlightEdgesDirty = false;

    const items = Array.isArray(state.highlightedPolygons) ? state.highlightedPolygons : [];
    if (items.length === 0) {
        if (state.highlightEdgeBuffer) {
            try { state.gl.deleteBuffer(state.highlightEdgeBuffer); } catch (_) { }
        }
        state.highlightEdgeBuffer = null;
        state.highlightEdgeCount = 0;
        return;
    }

    let totalFloats = 0;
    for (const item of items) {
        const poly = (item && item.points) ? item.points : item;
        if (!poly) continue;
        const isFlat = poly instanceof Float32Array;
        const n = isFlat ? (poly.length / 2) : poly.length;
        if (n < 2) continue;
        // Each edge contributes 2 vertices => 4 floats.
        totalFloats += n * 4;
    }

    if (totalFloats <= 0) {
        if (state.highlightEdgeBuffer) {
            try { state.gl.deleteBuffer(state.highlightEdgeBuffer); } catch (_) { }
        }
        state.highlightEdgeBuffer = null;
        state.highlightEdgeCount = 0;
        return;
    }

    const data = new Float32Array(totalFloats);
    let k = 0;
    for (const item of items) {
        const poly = (item && item.points) ? item.points : item;
        if (!poly) continue;
        const isFlat = poly instanceof Float32Array;
        const n = isFlat ? (poly.length / 2) : poly.length;
        if (n < 2) continue;

        for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            const x0 = isFlat ? poly[i * 2] : poly[i][0];
            const y0 = isFlat ? poly[i * 2 + 1] : poly[i][1];
            const x1 = isFlat ? poly[j * 2] : poly[j][0];
            const y1 = isFlat ? poly[j * 2 + 1] : poly[j][1];

            data[k++] = x0;
            data[k++] = y0;
            data[k++] = x1;
            data[k++] = y1;
        }
    }

    if (!state.highlightEdgeBuffer) {
        state.highlightEdgeBuffer = state.gl.createBuffer();
    }
    state.gl.bindBuffer(state.gl.ARRAY_BUFFER, state.highlightEdgeBuffer);
    state.gl.bufferData(state.gl.ARRAY_BUFFER, data, state.gl.STATIC_DRAW);
    state.highlightEdgeCount = data.length / 2;
}

function drawMeasurementOverlay(ctx) {
    if (!ctx) return;
    if (!state.measureEnabled) return;

    const fg = (getComputedStyle(document.body).getPropertyValue('--vscode-editor-foreground') || '').trim() || '#ffffff';
    const stroke = fg;

    const records = state.measureRecords || [];
    const pts = state.measurePoints || [];
    const hover = state.measureHover;

    function drawDistanceLabel(a, b) {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy);
        const sa = worldToScreen(a.x, a.y);
        const sb = worldToScreen(b.x, b.y);
        const mx = (sa.x + sb.x) / 2;
        const my = (sa.y + sb.y) / 2;

        const label = `d=${dist.toPrecision(6)}`;

        ctx.save();
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';

        const bg = (getComputedStyle(document.body).getPropertyValue('--vscode-editor-background') || '').trim() || '#000000';
        ctx.fillStyle = bg;
        ctx.globalAlpha = 0.8;
        const pad = 4;
        const w = ctx.measureText(label).width;
        const x0 = mx - w / 2 - pad;
        const y0 = my - 14;
        ctx.fillRect(x0, y0, w + pad * 2, 16);

        ctx.globalAlpha = 0.95;
        ctx.fillStyle = stroke;
        ctx.fillText(label, mx, my - 2);
        ctx.restore();
    }

    function drawSegment(a, b, drawEndMarkers) {
        const sa = worldToScreen(a.x, a.y);
        const sb = worldToScreen(b.x, b.y);

        // Start marker
        ctx.save();
        ctx.fillStyle = stroke;
        ctx.globalAlpha = 0.9;
        ctx.beginPath();
        ctx.arc(sa.x, sa.y, 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        // Line
        ctx.save();
        ctx.strokeStyle = stroke;
        ctx.globalAlpha = 0.9;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(sa.x, sa.y);
        ctx.lineTo(sb.x, sb.y);
        ctx.stroke();
        ctx.restore();

        if (drawEndMarkers) {
            ctx.save();
            ctx.fillStyle = stroke;
            ctx.globalAlpha = 0.9;
            ctx.beginPath();
            ctx.arc(sb.x, sb.y, 3.5, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        }

        drawDistanceLabel(a, b);
    }

    // Hover marker (snapped point)
    if (hover && typeof hover.x === 'number' && typeof hover.y === 'number') {
        const p = worldToScreen(hover.x, hover.y);
        ctx.save();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = stroke;
        ctx.globalAlpha = hover.snapped ? 0.9 : 0.5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, hover.snapped ? 5 : 3, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
    }

    // Draw completed records first.
    for (const r of records) {
        if (!r || !r.a || !r.b) continue;
        if (typeof r.a.x !== 'number' || typeof r.a.y !== 'number') continue;
        if (typeof r.b.x !== 'number' || typeof r.b.y !== 'number') continue;
        drawSegment(r.a, r.b, true);
    }

    // Draw current in-progress record (start + hover).
    if (!pts || pts.length === 0) return;
    if (!pts[0] || typeof pts[0].x !== 'number' || typeof pts[0].y !== 'number') return;

    const p1w = (hover && typeof hover.x === 'number' && typeof hover.y === 'number')
        ? { x: hover.x, y: hover.y }
        : null;
    if (!p1w) return;
    drawSegment(pts[0], p1w, false);
}

export function draw() {
    if (state.currentEngine !== 'canvas') return;

    try {
        elements.ctx.clearRect(0, 0, elements.canvas.width, elements.canvas.height);
        elements.ctx.save();
        applyContextTransform(elements.ctx);

        // Viewport culling
        // Calculate the 4 corners of the viewport in world space to handle rotation and flip correctly
        const p1 = screenToWorld(0, 0);
        const p2 = screenToWorld(elements.canvas.width, 0);
        const p3 = screenToWorld(elements.canvas.width, elements.canvas.height);
        const p4 = screenToWorld(0, elements.canvas.height);

        const vMinX = Math.min(p1.x, p2.x, p3.x, p4.x);
        const vMaxX = Math.max(p1.x, p2.x, p3.x, p4.x);
        const vMinY = Math.min(p1.y, p2.y, p3.y, p4.y);
        const vMaxY = Math.max(p1.y, p2.y, p3.y, p4.y);

        let polyCount = 0;
        let culledCount = 0;

        const lodThreshold = state.isInteracting ? state.fastModeThreshold : 0.5;
        const renderOrder = [...state.allLayers].reverse();

        if (state.isNegative) {
            if (elements.scratchCanvas.width !== elements.canvas.width || elements.scratchCanvas.height !== elements.canvas.height) {
                elements.scratchCanvas.width = elements.canvas.width;
                elements.scratchCanvas.height = elements.canvas.height;
            }
        }

        for (const layerKey of renderOrder) {
            if (!state.activeLayers.has(layerKey)) continue;

            const polys = state.geometry[layerKey];
            if (!polys) continue;

            const layerColor = state.layerColors[layerKey] || '#888';
            const layerOpacity = state.layerOpacities[layerKey] !== undefined ? state.layerOpacities[layerKey] : 0.8;

            let targetCtx = elements.ctx;

            if (state.isNegative) {
                targetCtx = elements.scratchCtx;
                targetCtx.clearRect(0, 0, targetCtx.canvas.width, targetCtx.canvas.height);
                targetCtx.save();

                applyContextTransform(targetCtx);

                targetCtx.fillStyle = layerColor;
                targetCtx.globalAlpha = layerOpacity;
                targetCtx.beginPath();
                targetCtx.rect(state.bbox.x_min, state.bbox.y_min, state.bbox.x_max - state.bbox.x_min, state.bbox.y_max - state.bbox.y_min);
                targetCtx.fill();

                targetCtx.globalCompositeOperation = 'destination-out';
                targetCtx.globalAlpha = 1.0;
                targetCtx.fillStyle = '#000000';
            } else {
                elements.ctx.fillStyle = layerColor;
                elements.ctx.strokeStyle = layerColor;
            }

            targetCtx.beginPath();
            for (const poly of polys) {
                if (poly.bbox) {
                    if (poly.bbox.maxX < vMinX || poly.bbox.minX > vMaxX ||
                        poly.bbox.maxY < vMinY || poly.bbox.minY > vMaxY) {
                        culledCount++;
                        continue;
                    }

                    const screenW = (poly.bbox.maxX - poly.bbox.minX) * state.scale;
                    const screenH = (poly.bbox.maxY - poly.bbox.minY) * state.scale;
                    if (screenW < lodThreshold && screenH < lodThreshold) {
                        culledCount++;
                        continue;
                    }
                }

                const isFlat = poly instanceof Float32Array;
                const len = isFlat ? poly.length / 2 : poly.length;

                if (len < 2) continue;

                if (isFlat) {
                    targetCtx.moveTo(poly[0], poly[1]);
                    for (let i = 1; i < len; i++) {
                        targetCtx.lineTo(poly[i * 2], poly[i * 2 + 1]);
                    }
                } else {
                    targetCtx.moveTo(poly[0][0], poly[0][1]);
                    for (let i = 1; i < poly.length; i++) {
                        targetCtx.lineTo(poly[i][0], poly[i][1]);
                    }
                }
                targetCtx.closePath();
                polyCount++;
            }

            if (state.isNegative) {
                targetCtx.fill();
                targetCtx.restore();

                elements.ctx.save();
                elements.ctx.setTransform(1, 0, 0, 1, 0, 0);
                elements.ctx.drawImage(elements.scratchCanvas, 0, 0);
                elements.ctx.restore();
            } else {
                elements.ctx.globalAlpha = layerOpacity;
                elements.ctx.fill();
            }
        }

        elements.ctx.restore();

        elements.ctx.save();
        elements.ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--vscode-editor-foreground');
        elements.ctx.font = "12px sans-serif";
        elements.ctx.fillText(`Scale: ${state.scale.toExponential(2)} | Offset: ${state.offsetX.toFixed(0)}, ${state.offsetY.toFixed(0)}`, 10, 20);
        elements.ctx.fillText(`Polygons: ${polyCount} (Culled: ${culledCount}) | Layers: ${state.activeLayers.size} | Mode: ${state.isInteracting ? 'Fast' : 'Quality'}`, 10, 35);
    } catch (e) {
        console.error("Draw error:", e);
        updateStatus("Draw error: " + e.message);
    }
}

export function drawWebGL() {
    if (!state.gl || !state.glProgram) return;

    state.gl.viewport(0, 0, state.gl.canvas.width, state.gl.canvas.height);
    state.gl.clearColor(0, 0, 0, 0);

    if (state.isNegative) {
        state.gl.clear(state.gl.COLOR_BUFFER_BIT | state.gl.STENCIL_BUFFER_BIT);
        state.gl.enable(state.gl.STENCIL_TEST);
    } else {
        state.gl.clear(state.gl.COLOR_BUFFER_BIT);
        state.gl.disable(state.gl.STENCIL_TEST);
    }

    state.gl.useProgram(state.glProgram);

    const resolutionLocation = state.gl.getUniformLocation(state.glProgram, "u_resolution");
    const offsetLocation = state.gl.getUniformLocation(state.glProgram, "u_offset");
    const scaleLocation = state.gl.getUniformLocation(state.glProgram, "u_scale");
    const flipLocation = state.gl.getUniformLocation(state.glProgram, "u_flip");
    const rotationLocation = state.gl.getUniformLocation(state.glProgram, "u_rotation");
    const colorLocation = state.gl.getUniformLocation(state.glProgram, "u_color");
    const isInstancedLocation = state.gl.getUniformLocation(state.glProgram, "u_isInstanced");

    const positionLocation = state.gl.getAttribLocation(state.glProgram, "a_position");
    const instanceMatrixCol1Loc = state.gl.getAttribLocation(state.glProgram, "a_instanceMatrixCol1");
    const instanceMatrixCol2Loc = state.gl.getAttribLocation(state.glProgram, "a_instanceMatrixCol2");
    const instanceMatrixCol3Loc = state.gl.getAttribLocation(state.glProgram, "a_instanceMatrixCol3");

    state.gl.uniform2f(resolutionLocation, state.gl.canvas.width, state.gl.canvas.height);
    state.gl.uniform2f(offsetLocation, state.offsetX, state.offsetY);
    state.gl.uniform1f(scaleLocation, state.scale);
    state.gl.uniform2f(flipLocation, state.flipState.x, state.flipState.y);
    state.gl.uniform1f(rotationLocation, state.rotationState * Math.PI / 180);

    state.gl.enableVertexAttribArray(positionLocation);

    // Viewport culling
    // Calculate the 4 corners of the viewport in world space to handle rotation and flip correctly
    const p1 = screenToWorld(0, 0);
    const p2 = screenToWorld(state.gl.canvas.width, 0);
    const p3 = screenToWorld(state.gl.canvas.width, state.gl.canvas.height);
    const p4 = screenToWorld(0, state.gl.canvas.height);

    const vMinX = Math.min(p1.x, p2.x, p3.x, p4.x);
    const vMaxX = Math.max(p1.x, p2.x, p3.x, p4.x);
    const vMinY = Math.min(p1.y, p2.y, p3.y, p4.y);
    const vMaxY = Math.max(p1.y, p2.y, p3.y, p4.y);

    const renderOrder = [...state.allLayers].reverse();

    for (const layerKey of renderOrder) {
        if (!state.activeLayers.has(layerKey)) continue;

        const hex = state.layerColors[layerKey] || '#888888';
        const r = parseInt(hex.slice(1, 3), 16) / 255;
        const g = parseInt(hex.slice(3, 5), 16) / 255;
        const b = parseInt(hex.slice(5, 7), 16) / 255;
        const a = state.layerOpacities[layerKey] !== undefined ? state.layerOpacities[layerKey] : 0.8;

        state.gl.uniform4f(colorLocation, r, g, b, a);

        if (state.isNegative) {
            state.gl.clear(state.gl.STENCIL_BUFFER_BIT);
            state.gl.colorMask(false, false, false, false);
            state.gl.stencilFunc(state.gl.ALWAYS, 1, 0xFF);
            state.gl.stencilOp(state.gl.KEEP, state.gl.KEEP, state.gl.REPLACE);
        }

        const buffers = state.layerBuffers[layerKey];
        if (buffers) {
            state.gl.uniform1i(isInstancedLocation, 0);
            const bufferList = Array.isArray(buffers) ? buffers : [buffers];

            for (const layerData of bufferList) {
                if (layerData.bbox) {
                    if (layerData.bbox.maxX < vMinX || layerData.bbox.minX > vMaxX ||
                        layerData.bbox.maxY < vMinY || layerData.bbox.minY > vMaxY) {
                        continue;
                    }
                }
                state.gl.bindBuffer(state.gl.ARRAY_BUFFER, layerData.buffer);
                state.gl.vertexAttribPointer(positionLocation, 2, state.gl.FLOAT, false, 0, 0);
                state.gl.drawArrays(state.gl.TRIANGLES, 0, layerData.count);
            }
        }

        if (state.instancedArraysExt) {
            state.gl.uniform1i(isInstancedLocation, 1);

            for (const cellName in state.definitions) {
                const defLayers = state.definitions[cellName];
                if (!defLayers || !defLayers[layerKey]) continue;

                const instances = state.instanceBuffers[cellName];
                if (!instances) continue;

                // Calculate max radius for culling
                let maxDist = 0;
                const cellBBox = state.definitionBBoxes[cellName];
                if (cellBBox) {
                    const d1 = cellBBox.minX * cellBBox.minX + cellBBox.minY * cellBBox.minY;
                    const d2 = cellBBox.maxX * cellBBox.maxX + cellBBox.minY * cellBBox.minY;
                    const d3 = cellBBox.maxX * cellBBox.maxX + cellBBox.maxY * cellBBox.maxY;
                    const d4 = cellBBox.minX * cellBBox.minX + cellBBox.maxY * cellBBox.maxY;
                    maxDist = Math.sqrt(Math.max(d1, d2, d3, d4));
                } else {
                    maxDist = 1e9; // No culling if bbox unknown
                }

                const geomChunks = defLayers[layerKey];

                for (const geom of geomChunks) {
                    state.gl.bindBuffer(state.gl.ARRAY_BUFFER, geom.buffer);
                    state.gl.vertexAttribPointer(positionLocation, 2, state.gl.FLOAT, false, 0, 0);

                    for (const inst of instances) {
                        if (inst.originBBox) {
                            if (inst.originBBox.maxX + maxDist < vMinX || inst.originBBox.minX - maxDist > vMaxX ||
                                inst.originBBox.maxY + maxDist < vMinY || inst.originBBox.minY - maxDist > vMaxY) {
                                continue;
                            }
                        }

                        state.gl.bindBuffer(state.gl.ARRAY_BUFFER, inst.buffer);
                        const stride = 36;

                        state.gl.enableVertexAttribArray(instanceMatrixCol1Loc);
                        state.gl.vertexAttribPointer(instanceMatrixCol1Loc, 3, state.gl.FLOAT, false, stride, 0);
                        state.instancedArraysExt.vertexAttribDivisorANGLE(instanceMatrixCol1Loc, 1);

                        state.gl.enableVertexAttribArray(instanceMatrixCol2Loc);
                        state.gl.vertexAttribPointer(instanceMatrixCol2Loc, 3, state.gl.FLOAT, false, stride, 12);
                        state.instancedArraysExt.vertexAttribDivisorANGLE(instanceMatrixCol2Loc, 1);

                        state.gl.enableVertexAttribArray(instanceMatrixCol3Loc);
                        state.gl.vertexAttribPointer(instanceMatrixCol3Loc, 3, state.gl.FLOAT, false, stride, 24);
                        state.instancedArraysExt.vertexAttribDivisorANGLE(instanceMatrixCol3Loc, 1);

                        state.instancedArraysExt.drawArraysInstancedANGLE(state.gl.TRIANGLES, 0, geom.count, inst.count);

                        state.instancedArraysExt.vertexAttribDivisorANGLE(instanceMatrixCol1Loc, 0);
                        state.instancedArraysExt.vertexAttribDivisorANGLE(instanceMatrixCol2Loc, 0);
                        state.instancedArraysExt.vertexAttribDivisorANGLE(instanceMatrixCol3Loc, 0);
                    }
                }
            }

            state.gl.disableVertexAttribArray(instanceMatrixCol1Loc);
            state.gl.disableVertexAttribArray(instanceMatrixCol2Loc);
            state.gl.disableVertexAttribArray(instanceMatrixCol3Loc);
        }

        if (state.isNegative) {
            state.gl.colorMask(true, true, true, true);
            state.gl.stencilFunc(state.gl.NOTEQUAL, 1, 0xFF);
            state.gl.stencilOp(state.gl.KEEP, state.gl.KEEP, state.gl.KEEP);

            state.gl.uniform1i(isInstancedLocation, 0);

            if (state.bboxBuffer) {
                state.gl.bindBuffer(state.gl.ARRAY_BUFFER, state.bboxBuffer);
                state.gl.vertexAttribPointer(positionLocation, 2, state.gl.FLOAT, false, 0, 0);
                state.gl.drawArrays(state.gl.TRIANGLES, 0, 6);
            }
        }
    }

    if (state.isNegative) {
        state.gl.disable(state.gl.STENCIL_TEST);
    }

    // Highlight overlay (Rust-generated triangles)
    // Draw AFTER negative/stencil to ensure highlight is visible.
    if (state.currentEngine === 'webgl' && state.config && state.config.engineType === 'rust') {
        const buffers = state.highlightBuffers;
        if (buffers && Array.isArray(buffers) && buffers.length > 0) {
            const resolutionLocation = state.gl.getUniformLocation(state.glProgram, "u_resolution");
            const offsetLocation = state.gl.getUniformLocation(state.glProgram, "u_offset");
            const scaleLocation = state.gl.getUniformLocation(state.glProgram, "u_scale");
            const flipLocation = state.gl.getUniformLocation(state.glProgram, "u_flip");
            const rotationLocation = state.gl.getUniformLocation(state.glProgram, "u_rotation");
            const colorLocation = state.gl.getUniformLocation(state.glProgram, "u_color");
            const isInstancedLocation = state.gl.getUniformLocation(state.glProgram, "u_isInstanced");
            const positionLocation = state.gl.getAttribLocation(state.glProgram, "a_position");

            state.gl.useProgram(state.glProgram);
            state.gl.uniform2f(resolutionLocation, state.gl.canvas.width, state.gl.canvas.height);
            state.gl.uniform2f(offsetLocation, state.offsetX, state.offsetY);
            state.gl.uniform1f(scaleLocation, state.scale);
            state.gl.uniform2f(flipLocation, state.flipState.x, state.flipState.y);
            state.gl.uniform1f(rotationLocation, state.rotationState * Math.PI / 180);
            state.gl.uniform1i(isInstancedLocation, 0);

            const h = getHighlightStyle();
            state.gl.uniform4f(colorLocation, h.gl.r, h.gl.g, h.gl.b, h.gl.a);
            state.gl.enableVertexAttribArray(positionLocation);

            for (const chunk of buffers) {
                if (!chunk || !chunk.buffer || !chunk.count) continue;
                state.gl.bindBuffer(state.gl.ARRAY_BUFFER, chunk.buffer);
                state.gl.vertexAttribPointer(positionLocation, 2, state.gl.FLOAT, false, 0, 0);
                state.gl.drawArrays(state.gl.TRIANGLES, 0, chunk.count);
            }
        }
    }

    // Highlight edge outlines (gl.LINES)
    // Buffer rebuild is triggered only when highlights change.
    rebuildHighlightEdgeBufferIfNeeded();
    if (state.currentEngine === 'webgl' && state.highlightEdgeBuffer && state.highlightEdgeCount > 0) {
        const resolutionLocation = state.gl.getUniformLocation(state.glProgram, "u_resolution");
        const offsetLocation = state.gl.getUniformLocation(state.glProgram, "u_offset");
        const scaleLocation = state.gl.getUniformLocation(state.glProgram, "u_scale");
        const flipLocation = state.gl.getUniformLocation(state.glProgram, "u_flip");
        const rotationLocation = state.gl.getUniformLocation(state.glProgram, "u_rotation");
        const colorLocation = state.gl.getUniformLocation(state.glProgram, "u_color");
        const isInstancedLocation = state.gl.getUniformLocation(state.glProgram, "u_isInstanced");
        const positionLocation = state.gl.getAttribLocation(state.glProgram, "a_position");

        const h = getHighlightStyle();

        state.gl.useProgram(state.glProgram);
        state.gl.uniform2f(resolutionLocation, state.gl.canvas.width, state.gl.canvas.height);
        state.gl.uniform2f(offsetLocation, state.offsetX, state.offsetY);
        state.gl.uniform1f(scaleLocation, state.scale);
        state.gl.uniform2f(flipLocation, state.flipState.x, state.flipState.y);
        state.gl.uniform1f(rotationLocation, state.rotationState * Math.PI / 180);
        state.gl.uniform1i(isInstancedLocation, 0);

        // Slightly higher alpha than fill so the outline reads clearly.
        state.gl.uniform4f(colorLocation, h.gl.r, h.gl.g, h.gl.b, 0.85);

        state.gl.bindBuffer(state.gl.ARRAY_BUFFER, state.highlightEdgeBuffer);
        state.gl.enableVertexAttribArray(positionLocation);
        state.gl.vertexAttribPointer(positionLocation, 2, state.gl.FLOAT, false, 0, 0);
        try { state.gl.lineWidth(1); } catch (_) { }
        state.gl.drawArrays(state.gl.LINES, 0, state.highlightEdgeCount);
    }
}

export function drawLabels() {
    const textCanvas = document.getElementById('text-canvas');
    if (!textCanvas) return;
    const ctx = textCanvas.getContext('2d');
    ctx.clearRect(0, 0, textCanvas.width, textCanvas.height);

    // For WebGL+Rust, highlights are rendered as a WebGL overlay (triangles) to avoid
    // expensive Path2D work on large selections.
    const drawHighlightOnCanvas = !(state.currentEngine === 'webgl' && state.config && state.config.engineType === 'rust');
    if (drawHighlightOnCanvas && state.highlightedPolygons.length > 0) {
        drawHighlights(ctx);
    }

    if (state.showLabels) {
        const viewMinX = (0 - state.offsetX) / state.scale;
        const viewMaxX = (textCanvas.width - state.offsetX) / state.scale;
        const viewMaxY = (0 - state.offsetY) / -state.scale;
        const viewMinY = (textCanvas.height - state.offsetY) / -state.scale;

        ctx.font = `${state.labelFontSize}px sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";

        for (const layerKey in state.labels) {
            if (!state.activeLayers.has(layerKey)) continue;

            const layerLabels = state.labels[layerKey];

            if (state.globalLabelColor) {
                ctx.fillStyle = darken(state.globalLabelColor, state.labelBrightness);
            } else {
                const baseColor = state.layerColors[layerKey] || '#ffffff';
                ctx.fillStyle = darken(baseColor, state.labelBrightness);
            }

            for (const label of layerLabels) {
                const x = label.x;
                const y = label.y;
                const text = label.text;

                const rad = state.rotationState * Math.PI / 180;
                const c = Math.cos(rad);
                const s = Math.sin(rad);
                const rx = x * c - y * s;
                const ry = x * s + y * c;

                let wx = rx * state.flipState.x;
                let wy = ry * state.flipState.y;

                const screenX = wx * state.scale + state.offsetX;
                const screenY = wy * -state.scale + state.offsetY;

                ctx.fillText(text, screenX, screenY);
            }
        }
    }

    if (state.showPorts && state.ports && state.ports.length > 0) {
        ctx.lineWidth = 2;
        ctx.font = `${state.portFontSize}px sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";

        for (const port of state.ports) {
            const layerPrefix = port.layer + '_';
            const isVisible = Array.from(state.activeLayers).some(k => k.startsWith(layerPrefix));
            if (!isVisible) continue;

            let color;
            if (state.globalPortColor) {
                color = darken(state.globalPortColor, state.portBrightness);
            } else {
                let baseColor = '#FFFFFF';
                if (state.layerColors[layerPrefix + '0']) {
                    baseColor = state.layerColors[layerPrefix + '0'];
                } else {
                    const match = Object.keys(state.layerColors).find(k => k.startsWith(layerPrefix));
                    if (match) {
                        baseColor = state.layerColors[match];
                    }
                }
                color = darken(baseColor, state.portBrightness);
            }

            ctx.strokeStyle = color;
            ctx.fillStyle = color;

            const x = port.x;
            const y = port.y;
            const rot = port.rotation;

            const { x: screenX, y: screenY } = worldToScreen(x, y);

            if (screenX < 0 || screenX > textCanvas.width || screenY < 0 || screenY > textCanvas.height) {
                continue;
            }

            const arrowLen = 20 * state.portArrowScale;
            const pdx = Math.cos(rot);
            const pdy = Math.sin(rot);

            const { x: wdx, y: wdy } = applyRotationAndFlip(pdx, pdy);

            const sdx = wdx;
            const sdy = -wdy;

            const len = Math.sqrt(sdx * sdx + sdy * sdy);
            const ndx = sdx / len;
            const ndy = sdy / len;

            const endX = screenX + ndx * arrowLen;
            const endY = screenY + ndy * arrowLen;

            ctx.beginPath();
            ctx.moveTo(screenX, screenY);
            ctx.lineTo(endX, endY);

            const headLen = 5 * state.portArrowScale;
            const angle = Math.atan2(ndy, ndx);
            ctx.lineTo(endX - headLen * Math.cos(angle - Math.PI / 6), endY - headLen * Math.sin(angle - Math.PI / 6));
            ctx.moveTo(endX, endY);
            ctx.lineTo(endX - headLen * Math.cos(angle + Math.PI / 6), endY - headLen * Math.sin(angle + Math.PI / 6));

            ctx.stroke();

            ctx.fillText(port.name, screenX, screenY - 5);
        }
    }

    // Tool overlays (measure, etc.) on top of labels/ports
    drawMeasurementOverlay(ctx);

    // Box selection overlay (right mouse drag)
    if (state.boxSelect && state.boxSelect.active) {
        const x0 = state.boxSelect.x0;
        const y0 = state.boxSelect.y0;
        const x1 = state.boxSelect.x1;
        const y1 = state.boxSelect.y1;
        const left = Math.min(x0, x1);
        const top = Math.min(y0, y1);
        const w = Math.abs(x1 - x0);
        const h = Math.abs(y1 - y0);

        ctx.save();
        ctx.strokeStyle = '#00FFFF';
        ctx.globalAlpha = 0.9;
        ctx.lineWidth = 1;
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(left + 0.5, top + 0.5, w, h);
        ctx.restore();
    }
}

export function drawHighlights(targetCtx) {
    const ctxToUse = targetCtx || elements.ctx;
    if (!ctxToUse) return;

    ctxToUse.save();
    applyContextTransform(ctxToUse);

    const h = getHighlightStyle();
    ctxToUse.strokeStyle = h.strokeCss;
    ctxToUse.lineWidth = 2 / state.scale;
    ctxToUse.fillStyle = h.fillCss;

    const pathToDraw = state.highlightedPath
        ? state.highlightedPath
        : (state.highlightedPathBuild && state.highlightedPathBuild.path ? state.highlightedPathBuild.path : null);

    if (pathToDraw) {
        ctxToUse.fill(pathToDraw);
        // During WebGL pan/zoom (drag), outline is rendered in WebGL as gl.LINES.
        if (!(state.currentEngine === 'webgl' && state.isInteracting)) {
            ctxToUse.stroke(pathToDraw);
        }
    } else {
        // Fallback for legacy or non-path data (though we should always have path now)
        ctxToUse.beginPath();
        for (const item of state.highlightedPolygons) {
            const poly = item && item.points ? item.points : item;
            const isFlat = poly instanceof Float32Array;
            const len = isFlat ? poly.length / 2 : poly.length;
            if (len < 2) continue;

            if (isFlat) {
                ctxToUse.moveTo(poly[0], poly[1]);
                for (let i = 1; i < len; i++) {
                    ctxToUse.lineTo(poly[i * 2], poly[i * 2 + 1]);
                }
            } else {
                ctxToUse.moveTo(poly[0][0], poly[0][1]);
                for (let i = 1; i < poly.length; i++) {
                    ctxToUse.lineTo(poly[i][0], poly[i][1]);
                }
            }
            ctxToUse.closePath();
        }
        ctxToUse.fill();
        if (!(state.currentEngine === 'webgl' && state.isInteracting)) {
            ctxToUse.stroke();
        }
    }
    ctxToUse.restore();
}

export function setupCanvasMode(data) {
    elements.canvas.style.display = 'block';
    document.getElementById('gds-webgl-canvas').style.display = 'none';
    elements.svgContainer.style.display = 'none';
    elements.svgContainer.innerHTML = '';

    state.geometry = data.geometry;
    state.bbox = data.bbox;

    for (const layerKey in state.geometry) {
        const polys = state.geometry[layerKey];
        for (const poly of polys) {
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const p of poly) {
                if (p[0] < minX) minX = p[0];
                if (p[0] > maxX) maxX = p[0];
                if (p[1] < minY) minY = p[1];
                if (p[1] > maxY) maxY = p[1];
            }
            poly.bbox = { minX, minY, maxX, maxY };
        }
    }

    resizeCanvas();
    fitView();
}

export function setupSvgMode(data) {
    elements.canvas.style.display = 'none';
    const glCanvas = document.getElementById('gds-webgl-canvas');
    if (glCanvas) {
        glCanvas.style.display = 'none';
    }
    const textCanvas = document.getElementById('text-canvas');
    if (textCanvas) {
        const ctx = textCanvas.getContext('2d');
        ctx.clearRect(0, 0, textCanvas.width, textCanvas.height);
    }
    resizeCanvas();
    elements.svgContainer.style.display = 'block';

    state.geometry = data.geometry || {};

    for (const layerKey in state.geometry) {
        const polys = state.geometry[layerKey];
        for (const poly of polys) {
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const p of poly) {
                if (p[0] < minX) minX = p[0];
                if (p[0] > maxX) maxX = p[0];
                if (p[1] < minY) minY = p[1];
                if (p[1] > maxY) maxY = p[1];
            }
            poly.bbox = { minX, minY, maxX, maxY };
        }
    }

    state.bbox = data.bbox;

    let svgContent = `<svg id="root-svg-for-panzoom" width="100%" height="100%">`;
    svgContent += `<g id="svg-pan-zoom-viewport">`;
    svgContent += `<g id="gds-base-flip-group" transform="scale(1, -1)">`;
    svgContent += `<g id="gds-user-transform-group">`;

    const renderOrder = [...state.allLayers].reverse();

    for (const layerKey of renderOrder) {
        const fragment = state.svgFragments[layerKey] || "";
        const opacity = state.layerOpacities[layerKey] !== undefined ? state.layerOpacities[layerKey] : 0.8;
        const color = state.layerColors[layerKey] || '#888888';

        svgContent += `<g id="layer-group-${layerKey}" class="gds-layer" style="color: ${color}; opacity: ${opacity}; display: inline;">
            ${fragment}
        </g>`;
    }
    svgContent += `</g>`;
    svgContent += `</g>`;
    svgContent += `</g>`;
    svgContent += '</svg>';

    elements.svgContainer.innerHTML = svgContent;

    if (state.panZoomInstance) {
        state.panZoomInstance.destroy();
    }
    state.panZoomInstance = svgPanZoom('#root-svg-for-panzoom', {
        viewportSelector: '#svg-pan-zoom-viewport',
        panEnabled: true,
        zoomEnabled: true,
        dblClickZoomEnabled: false,
        controlIconsEnabled: false,
        fit: true,
        center: true,
        minZoom: 0.1,
        maxZoom: 100,
        onZoom: function (newZoom) {
            const instance = this;
            setTimeout(() => {
                const pan = instance.getPan();
                state.offsetX = pan.x;
                state.offsetY = pan.y;
                state.scale = instance.getSizes().realZoom;
                requestAnimationFrame(drawLabels);
            }, 0);
        },
        onPan: function (newPan) {
            const pan = this.getPan();
            state.offsetX = pan.x;
            state.offsetY = pan.y;
            state.scale = this.getSizes().realZoom;
            requestAnimationFrame(drawLabels);
        }
    });

    const pan = state.panZoomInstance.getPan();
    const sizes = state.panZoomInstance.getSizes();
    state.offsetX = pan.x;
    state.offsetY = pan.y;
    state.scale = sizes.realZoom;
}

export function setupWebGLMode(data) {
    elements.canvas.style.display = 'none';
    elements.svgContainer.style.display = 'none';
    const glCanvas = document.getElementById('gds-webgl-canvas');
    glCanvas.style.display = 'block';

    state.geometry = data.geometry;
    state.bbox = data.bbox;

    if (state.geometry) {
        for (const layerKey in state.geometry) {
            /*
            state.searchWorker.postMessage({
                command: 'addGeometry',
                layerKey,
                polygons: state.geometry[layerKey],
                type: 'flat',
                cellName: null
            });
            */
        }
    }

    state.gl = glCanvas.getContext('webgl', { stencil: true });
    if (!state.gl) {
        updateStatus("WebGL not supported");
        return;
    }

    state.instancedArraysExt = state.gl.getExtension('ANGLE_instanced_arrays');
    if (!state.instancedArraysExt) {
        console.warn("ANGLE_instanced_arrays not supported");
    }

    state.gl.enable(state.gl.BLEND);
    state.gl.blendFunc(state.gl.SRC_ALPHA, state.gl.ONE_MINUS_SRC_ALPHA);

    const vsSource = `
        attribute vec2 a_position;
        attribute vec3 a_instanceMatrixCol1;
        attribute vec3 a_instanceMatrixCol2;
        attribute vec3 a_instanceMatrixCol3;

        uniform vec2 u_resolution;
        uniform vec2 u_offset;
        uniform float u_scale;
        uniform vec2 u_flip;
        uniform float u_rotation;
        uniform bool u_isInstanced;

        void main() {
            vec2 pos = a_position;

            if (u_isInstanced) {
                mat3 instanceMat = mat3(
                    a_instanceMatrixCol1,
                    a_instanceMatrixCol2,
                    a_instanceMatrixCol3
                );
                vec3 transformedPos = instanceMat * vec3(pos, 1.0);
                pos = transformedPos.xy;
            }

            float c = cos(u_rotation);
            float s = sin(u_rotation);
            vec2 rotated = vec2(pos.x * c - pos.y * s, pos.x * s + pos.y * c);

            vec2 flipped = rotated * u_flip;
            vec2 position = (flipped * vec2(1, -1) * u_scale) + u_offset;
            vec2 zeroToOne = position / u_resolution;
            vec2 zeroToTwo = zeroToOne * 2.0;
            vec2 clipSpace = zeroToTwo - 1.0;

            gl_Position = vec4(clipSpace * vec2(1, -1), 0, 1);
        }
    `;

    const fsSource = `
        precision mediump float;
        uniform vec4 u_color;
        void main() {
            gl_FragColor = u_color;
        }
    `;

    const vertexShader = createShader(state.gl, state.gl.VERTEX_SHADER, vsSource);
    const fragmentShader = createShader(state.gl, state.gl.FRAGMENT_SHADER, fsSource);
    state.glProgram = createProgram(state.gl, vertexShader, fragmentShader);

    state.layerBuffers = {};

    if (state.bbox) {
        const bboxVertices = [
            state.bbox.x_min, state.bbox.y_min,
            state.bbox.x_max, state.bbox.y_min,
            state.bbox.x_min, state.bbox.y_max,
            state.bbox.x_min, state.bbox.y_max,
            state.bbox.x_max, state.bbox.y_min,
            state.bbox.x_max, state.bbox.y_max
        ];
        state.bboxBuffer = state.gl.createBuffer();
        state.gl.bindBuffer(state.gl.ARRAY_BUFFER, state.bboxBuffer);
        state.gl.bufferData(state.gl.ARRAY_BUFFER, new Float32Array(bboxVertices), state.gl.STATIC_DRAW);
    }

    for (const layerKey in state.geometry) {
        const polys = state.geometry[layerKey];
        if (!polys) continue;

        const vertices = [];

        for (const poly of polys) {
            const flat = [];
            for (const p of poly) {
                flat.push(p[0], p[1]);
            }

            const triangles = earcut(flat);

            for (let i = 0; i < triangles.length; i++) {
                const index = triangles[i];
                vertices.push(flat[index * 2], flat[index * 2 + 1]);
            }
        }

        if (vertices.length > 0) {
            const buffer = state.gl.createBuffer();
            state.gl.bindBuffer(state.gl.ARRAY_BUFFER, buffer);
            state.gl.bufferData(state.gl.ARRAY_BUFFER, new Float32Array(vertices), state.gl.STATIC_DRAW);

            if (!state.layerBuffers[layerKey]) state.layerBuffers[layerKey] = [];
            state.layerBuffers[layerKey].push({
                buffer: buffer,
                count: vertices.length / 2
            });
        }
    }

    resizeCanvas();
    fitView();
}
