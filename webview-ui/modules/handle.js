import { state, elements } from './state.js';
import { updateStatus, checkCompletion } from './utils.js';
import { draw, drawWebGL, drawLabels, setupCanvasMode, setupSvgMode, setupWebGLMode } from './renderer.js';
import { updateTransform, resizeCanvas, fitView } from './transform.js';

export function handleSearchWorkerMessage(e) {
    const msg = e.data;
    if (msg.command === 'status') {
        updateStatus(msg.message);
    } else if (msg.command === 'found') {
        state.highlightedPolygons = msg.polygons;

        // Create Path2D for efficient rendering
        const path = new Path2D();
        for (const poly of msg.polygons) {
            if (poly.length < 2) continue;
            path.moveTo(poly[0][0], poly[0][1]);
            for (let i = 1; i < poly.length; i++) {
                path.lineTo(poly[i][0], poly[i][1]);
            }
            path.closePath();
        }
        state.highlightedPath = path;

        const timeStr = msg.duration ? ` in ${msg.duration}ms` : '';
        if (msg.limitReached) {
            updateStatus(`Highlighted ${state.highlightedPolygons.length} objects (Search limit reached)${timeStr}`);
        } else if (state.highlightedPolygons.length === 0) {
            updateStatus(`No object found at clicked location${timeStr}`);
        } else {
            updateStatus(`Highlighted ${state.highlightedPolygons.length} connected objects${timeStr}`);
        }
        requestAnimationFrame(drawLabels);
    }
}

export function handleWorkerMessage(e, workerIndex) {
    if (e.data.type === 'log') {
        return;
    }
    if (e.data.type === 'error') {
        console.error(`Worker ${workerIndex} Error:`, e.data.error);
        updateStatus(`Worker ${workerIndex} error: ${e.data.error}`);
        return;
    }

    const { id, vertices, polygons, duration } = e.data;
    if (duration) state.perfMetrics.workerTime += duration;

    const layerKey = id.layerKey;
    const type = id.type;
    const cellName = id.cellName || "UNKNOWN_CELL";

    if (polygons) {
        if (state.currentEngine === 'canvas' || state.currentEngine === 'webgl') {
            for (const poly of polygons) {
                let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                for (let i = 0; i < poly.length; i += 2) {
                    const x = poly[i];
                    const y = poly[i + 1];
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                }
                poly.bbox = { minX, minY, maxX, maxY };
            }

            if (type === 'definition') {
                if (!state.definitionGeometry[cellName]) state.definitionGeometry[cellName] = {};
                if (!state.definitionGeometry[cellName][layerKey]) state.definitionGeometry[cellName][layerKey] = [];
                state.definitionGeometry[cellName][layerKey].push(...polygons);

                if (!state.definitionBBoxes[cellName]) state.definitionBBoxes[cellName] = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
                const db = state.definitionBBoxes[cellName];
                for (const poly of polygons) {
                    if (poly.bbox.minX < db.minX) db.minX = poly.bbox.minX;
                    if (poly.bbox.minY < db.minY) db.minY = poly.bbox.minY;
                    if (poly.bbox.maxX > db.maxX) db.maxX = poly.bbox.maxX;
                    if (poly.bbox.maxY > db.maxY) db.maxY = poly.bbox.maxY;
                }
            } else {
                if (!state.geometry[layerKey]) state.geometry[layerKey] = [];
                state.geometry[layerKey].push(...polygons);
            }
        }
        if (state.currentEngine === 'canvas') requestAnimationFrame(draw);
    }

    if (vertices && vertices.length > 0 && state.gl) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (let i = 0; i < vertices.length; i += 2) {
            const x = vertices[i];
            const y = vertices[i + 1];
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }
        const bbox = { minX, minY, maxX, maxY };

        const buffer = state.gl.createBuffer();
        state.gl.bindBuffer(state.gl.ARRAY_BUFFER, buffer);
        state.gl.bufferData(state.gl.ARRAY_BUFFER, vertices, state.gl.STATIC_DRAW);

        if (type === 'definition') {
            if (!state.definitions[cellName]) state.definitions[cellName] = {};
            if (!state.definitions[cellName][layerKey]) state.definitions[cellName][layerKey] = [];

            state.definitions[cellName][layerKey].push({
                buffer: buffer,
                count: vertices.length / 2,
                bbox: bbox
            });
        } else {
            if (!state.layerBuffers[layerKey]) state.layerBuffers[layerKey] = [];

            state.layerBuffers[layerKey].push({
                buffer: buffer,
                count: vertices.length / 2,
                bbox: bbox
            });
        }

        requestAnimationFrame(drawWebGL);
    }

    if (id.alsoTriangulate && polygons && !vertices) {
        return;
    }

    state.pendingTasks--;
    checkCompletion();
}

export function handleInstanceData(cellName, buffer) {
    const dataView = new DataView(buffer);
    const count = dataView.getUint32(0, true);

    if (!state.gl) return count;

    const transforms = new Float32Array(buffer, 4, count * 9);

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < count; i++) {
        const tx = transforms[i * 9 + 6];
        const ty = transforms[i * 9 + 7];
        if (tx < minX) minX = tx;
        if (tx > maxX) maxX = tx;
        if (ty < minY) minY = ty;
        if (ty > maxY) maxY = ty;
    }
    const originBBox = { minX, minY, maxX, maxY };

    const key = cellName || "UNKNOWN_CELL";
    if (!state.instanceTransforms[key]) state.instanceTransforms[key] = [];

    state.instanceTransforms[key].push(transforms);

    const glBuffer = state.gl.createBuffer();
    state.gl.bindBuffer(state.gl.ARRAY_BUFFER, glBuffer);
    state.gl.bufferData(state.gl.ARRAY_BUFFER, transforms, state.gl.STATIC_DRAW);

    if (!state.instanceBuffers[key]) state.instanceBuffers[key] = [];

    state.instanceBuffers[key].push({
        buffer: glBuffer,
        count: count,
        originBBox: originBBox
    });

    requestAnimationFrame(drawWebGL);
    return count;
}

export function handleAddLayerChunkB64(layerKey, chunkIndex, totalChunks, b64Data, type, cellName) {
    state.pendingTasks++;

    const binaryString = window.atob(b64Data);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    const buffer = bytes.buffer;

    if (type === 'instance') {
        const count = handleInstanceData(cellName, buffer);
        state.pendingTasks--;

        if (state.flowControlStep !== -1 && (chunkIndex % state.flowControlStep === 0 || chunkIndex === totalChunks - 1)) {
            setTimeout(() => {
                state.vscode.postMessage({ command: 'ready_for_next' });
            }, 0);
        }
        updateStatus(`Loading Instances ${cellName || 'Unknown'} (${chunkIndex + 1}/${totalChunks || '?'}) - ${count} items`);
        return;
    }

    const worker = state.workerPool[state.workerRoundRobin];
    state.workerRoundRobin = (state.workerRoundRobin + 1) % state.workerPool.length;

    worker.postMessage({
        id: { layerKey, chunkIndex, type, cellName, alsoTriangulate: state.currentEngine === 'webgl' },
        buffer: buffer,
        isBinary: true,
        returnPolygons: true,
        alsoTriangulate: state.currentEngine === 'webgl'
    }, [buffer]);

    if (state.flowControlStep !== -1 && (chunkIndex % state.flowControlStep === 0 || chunkIndex === totalChunks - 1)) {
        setTimeout(() => {
            state.vscode.postMessage({ command: 'ready_for_next' });
        }, 0);
    }
    updateStatus(`Loading ${layerKey || 'Unknown'}${cellName ? ' ' + cellName : ''} (${chunkIndex + 1}/${totalChunks || '?'})`);
}

export function handleAddLayerChunk(layerKey, data) {
    const polys = data.polygons;

    if (state.currentEngine === 'canvas' || state.currentEngine === 'webgl') {
        if (polys && polys.length > 0) {
            if (!state.geometry[layerKey]) state.geometry[layerKey] = [];

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
            state.geometry[layerKey].push(...polys);
        }
    }

    if (data.labels && data.labels.length > 0) {
        if (!state.labels[layerKey]) state.labels[layerKey] = [];
        state.labels[layerKey].push(...data.labels);
    }

    if (state.currentEngine === 'webgl' && polys && polys.length > 0) {
        const worker = state.workerPool[state.workerRoundRobin];
        state.workerRoundRobin = (state.workerRoundRobin + 1) % state.workerPool.length;

        worker.postMessage({
            id: { layerKey, chunkIndex: data.chunkIndex },
            polygons: polys
        });
    }

    if (data.chunkIndex !== undefined) {
        updateStatus(`Loading ${layerKey} (${data.chunkIndex + 1}/${data.totalChunks || '?'})`);
    } else {
        updateStatus(`Loading ${layerKey} (Labels)`);
    }

    if (state.currentEngine === 'canvas') requestAnimationFrame(draw);
    requestAnimationFrame(drawLabels);
}

export function handleInitialize(data) {
    state.startTime = performance.now();
    state.pendingTasks = 0;
    state.pythonFinished = false;
    state.isViewFitted = false;
    state.hasUserInteracted = false;
    updateStatus("Initializing...");

    state.geometry = {};
    state.labels = {};
    state.highlightedPolygons = [];
    state.bbox = data.bbox;
    if (data.ports) {
        state.ports = data.ports;
        console.log(`[Webview] Received ${state.ports.length} ports in initialize`);
    } else {
        state.ports = [];
    }
    state.activeLayers.clear();
    state.hasUserInteracted = false;
    state.layerColors = {};
    state.layerOpacities = {};
    state.layerBuffers = {};

    buildTree(data.hierarchy, data.top_level_cells, data.all_cells, data.cell_name);

    state.allLayers = data.layers;

    if (!elements.layersList) return;
    elements.layersList.innerHTML = '';
    state.allLayers.forEach(layerKey => {
        state.activeLayers.add(layerKey);

        let color = "#888888";
        const parts = layerKey.split('_');
        if (parts.length >= 1) {
            const layerNum = parseInt(parts[0]);
            if (!isNaN(layerNum)) {
                color = state.palette[layerNum % state.palette.length];
            } else {
                let hash = 0;
                for (let i = 0; i < layerKey.length; i++) {
                    hash = layerKey.charCodeAt(i) + ((hash << 5) - hash);
                }
                color = state.palette[Math.abs(hash) % state.palette.length];
            }
        }
        state.layerColors[layerKey] = color;
        state.layerOpacities[layerKey] = 0.8;

        const div = document.createElement('div');
        div.className = 'layer-toggle';
        div.setAttribute('draggable', 'true');
        div.addEventListener('dragstart', handleDragStart, false);
        div.addEventListener('dragend', handleDragEnd, false);
        div.addEventListener('dragenter', handleDragEnter, false);
        div.addEventListener('dragover', handleDragOver, false);
        div.addEventListener('dragleave', handleDragLeave, false);
        div.addEventListener('drop', handleDrop, false);

        div.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            state.activeLayers.clear();
            state.activeLayers.add(layerKey);

            const checkboxes = document.querySelectorAll('#layers-list input[type="checkbox"]');
            checkboxes.forEach(cb => {
                cb.checked = (cb.getAttribute('data-layer-id') === layerKey);
            });

            if (state.currentEngine === 'canvas') draw();
            else if (state.currentEngine === 'webgl') requestAnimationFrame(drawWebGL);
            requestAnimationFrame(drawLabels);

            if (state.currentEngine === 'svg') {
                state.allLayers.forEach(key => {
                    const el = document.getElementById('layer-group-' + key);
                    if (el) el.style.display = (key === layerKey) ? 'block' : 'none';
                });
            }
        });

        div.innerHTML = `
            <input type="checkbox" id="toggle-${layerKey}" data-layer-id="${layerKey}" checked>
            <label for="toggle-${layerKey}">Layer ${layerKey.replace('_', ' / ')}</label>
            <input type="color" id="color-${layerKey}" data-layer-id="${layerKey}" value="${color}">
            <input type="range" min="0" max="1" step="0.1" value="0.8" class="opacity-slider" data-layer-id="${layerKey}" style="width: 50px; margin-left: 5px;" title="Opacity">
        `;

        div.querySelectorAll('input').forEach(input => {
            input.addEventListener('mousedown', (e) => {
                e.stopPropagation();
                div.setAttribute('draggable', 'false');
            });
            input.addEventListener('mouseup', () => {
                div.setAttribute('draggable', 'true');
            });
            input.addEventListener('mouseleave', () => {
                div.setAttribute('draggable', 'true');
            });
            input.addEventListener('click', (e) => {
                e.stopPropagation();
            });
        });

        elements.layersList.appendChild(div);
    });

    const dummy = document.createElement('div');
    dummy.className = 'layer-drop-dummy';
    dummy.addEventListener('dragenter', handleDragEnter, false);
    dummy.addEventListener('dragover', handleDragOver, false);
    dummy.addEventListener('dragleave', handleDragLeave, false);
    dummy.addEventListener('drop', handleDrop, false);
    elements.layersList.appendChild(dummy);

    if (state.currentEngine === 'canvas') {
        elements.canvas.style.display = 'block';
        document.getElementById('gds-webgl-canvas').style.display = 'none';
        elements.svgContainer.style.display = 'none';
        elements.svgContainer.innerHTML = '';
        resizeCanvas();
        fitView();
    } else if (state.currentEngine === 'webgl') {
        state.definitions = {};
        state.instanceBuffers = {};
        state.definitionGeometry = {};
        state.instanceTransforms = {};
        state.definitionBBoxes = {};
        setupWebGLMode({ geometry: {}, bbox: data.bbox, layers: [] });
    } else if (state.currentEngine === 'svg') {
        if (data.svg_fragments) {
            state.svgFragments = data.svg_fragments;
        }
        setupSvgMode(data);
        updateTransform();

        if (data.labels && data.labels.length > 0) {
            data.labels.forEach(l => {
                if (!state.labels[l.layerKey]) state.labels[l.layerKey] = [];
                state.labels[l.layerKey].push(l);
            });
            requestAnimationFrame(drawLabels);
        }
    }

    updateStatus("Loading layers...");
}

export function handleDataUpdate(data) {
    updateStatus("Rendering...");

    state.highlightedPolygons = [];
    state.searchWorker.postMessage({ command: 'clear' });

    buildTree(data.hierarchy, data.top_level_cells, data.all_cells, data.cell_name);

    elements.layersList.innerHTML = '';
    state.activeLayers.clear();
    state.layerColors = {};
    state.layerOpacities = {};

    state.allLayers = data.layers;
    if (data.svg_fragments) {
        state.svgFragments = data.svg_fragments;
    } else {
        state.svgFragments = {};
    }

    state.allLayers.forEach(layerKey => {
        state.activeLayers.add(layerKey);

        let color = "#888888";
        const parts = layerKey.split('_');
        if (parts.length >= 1) {
            const layerNum = parseInt(parts[0]);
            if (!isNaN(layerNum)) {
                color = state.palette[layerNum % state.palette.length];
            } else {
                let hash = 0;
                for (let i = 0; i < layerKey.length; i++) {
                    hash = layerKey.charCodeAt(i) + ((hash << 5) - hash);
                }
                color = state.palette[Math.abs(hash) % state.palette.length];
            }
        }
        state.layerColors[layerKey] = color;
        state.layerOpacities[layerKey] = 0.8;

        const div = document.createElement('div');
        div.className = 'layer-toggle';
        div.setAttribute('draggable', 'true');
        div.addEventListener('dragstart', handleDragStart, false);
        div.addEventListener('dragend', handleDragEnd, false);
        div.addEventListener('dragenter', handleDragEnter, false);
        div.addEventListener('dragover', handleDragOver, false);
        div.addEventListener('dragleave', handleDragLeave, false);
        div.addEventListener('drop', handleDrop, false);

        div.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            state.activeLayers.clear();
            state.activeLayers.add(layerKey);

            const checkboxes = document.querySelectorAll('#layers-list input[type="checkbox"]');
            checkboxes.forEach(cb => {
                cb.checked = (cb.getAttribute('data-layer-id') === layerKey);
            });

            if (state.currentEngine === 'canvas') draw();
            else if (state.currentEngine === 'webgl') requestAnimationFrame(drawWebGL);
            requestAnimationFrame(drawLabels);

            if (state.currentEngine === 'svg') {
                state.allLayers.forEach(key => {
                    const el = document.getElementById('layer-group-' + key);
                    if (el) el.style.display = (key === layerKey) ? 'block' : 'none';
                });
            }
        });

        div.innerHTML = `
            <input type="checkbox" id="toggle-${layerKey}" data-layer-id="${layerKey}" checked>
            <label for="toggle-${layerKey}">Layer ${layerKey.replace('_', ' / ')}</label>
            <input type="color" id="color-${layerKey}" data-layer-id="${layerKey}" value="${color}">
            <input type="range" min="0" max="1" step="0.1" value="0.8" class="opacity-slider" data-layer-id="${layerKey}" style="width: 50px; margin-left: 5px;" title="Opacity">
        `;

        div.querySelectorAll('input').forEach(input => {
            input.addEventListener('mousedown', (e) => {
                e.stopPropagation();
                div.setAttribute('draggable', 'false');
            });
            input.addEventListener('mouseup', () => {
                div.setAttribute('draggable', 'true');
            });
            input.addEventListener('mouseleave', () => {
                div.setAttribute('draggable', 'true');
            });
            input.addEventListener('click', (e) => {
                e.stopPropagation();
            });
        });

        elements.layersList.appendChild(div);
    });

    const dummy = document.createElement('div');
    dummy.className = 'layer-drop-dummy';
    dummy.addEventListener('dragenter', handleDragEnter, false);
    dummy.addEventListener('dragover', handleDragOver, false);
    dummy.addEventListener('dragleave', handleDragLeave, false);
    dummy.addEventListener('drop', handleDrop, false);
    elements.layersList.appendChild(dummy);

    if (state.currentEngine === 'canvas') {
        setupCanvasMode(data);
    } else if (state.currentEngine === 'webgl') {
        setupWebGLMode(data);
    } else {
        setupSvgMode(data);
        updateTransform();
    }

    updateStatus("Ready");
}

export function selectCell(cellName) {
    state.vscode.postMessage({
        command: 'changeCell',
        cellName: cellName
    });
}

export function buildTree(hierarchy, topLevelCells, allCells, currentCellName) {
    if (!elements.cellTree) return;
    elements.cellTree.innerHTML = '';

    if (!hierarchy || !topLevelCells || topLevelCells.length === 0) {
        allCells.forEach(cell => {
            const item = document.createElement('div');
            item.className = 'tree-content';
            item.style.paddingLeft = '5px';
            if (cell === currentCellName && item.classList) item.classList.add('selected');
            item.textContent = cell;
            item.onclick = () => selectCell(cell);
            elements.cellTree.appendChild(item);
        });
        return;
    }

    const validCellSet = new Set(allCells);
    let effectiveRoots = [];
    const processRoots = (roots) => {
        roots.forEach(root => {
            if (root.startsWith('$$$') || root.startsWith('TEXT')) {
                const children = hierarchy[root] || [];
                processRoots(children);
            } else {
                if (validCellSet.has(root)) {
                    effectiveRoots.push(root);
                }
            }
        });
    };
    processRoots(topLevelCells);
    effectiveRoots = [...new Set(effectiveRoots)].sort();

    function createNode(cellName, visited) {
        const item = document.createElement('div');
        item.className = 'tree-item';

        if (state.expandedNodes.has(cellName) && item && item.classList) {
            item.classList.add('expanded');
        }

        const content = document.createElement('div');
        content.className = 'tree-content';
        if (cellName === currentCellName && content && content.classList) content.classList.add('selected');

        const children = hierarchy[cellName] || [];
        const validChildren = children.filter(c => validCellSet.has(c));
        const hasChildren = validChildren.length > 0;

        const toggle = document.createElement('span');
        toggle.className = 'tree-toggle' + (hasChildren ? '' : ' empty');
        content.appendChild(toggle);

        const label = document.createElement('span');
        label.className = 'tree-label';
        label.textContent = cellName;
        content.appendChild(label);

        label.onclick = (e) => {
            e.stopPropagation();
            selectCell(cellName);
        };

        if (hasChildren) {
            toggle.onclick = (e) => {
                e.stopPropagation();
                item.classList.toggle('expanded');
                if (item.classList.contains('expanded')) {
                    state.expandedNodes.add(cellName);
                } else {
                    state.expandedNodes.delete(cellName);
                }
            };
        }

        item.appendChild(content);

        if (hasChildren) {
            const childrenContainer = document.createElement('div');
            childrenContainer.className = 'tree-children';

            if (!visited.has(cellName)) {
                const newVisited = new Set(visited);
                newVisited.add(cellName);
                validChildren.forEach(childName => {
                    childrenContainer.appendChild(createNode(childName, newVisited));
                });
            } else {
                const recursiveMsg = document.createElement('div');
                recursiveMsg.textContent = '<recursive>';
                recursiveMsg.style.paddingLeft = '20px';
                recursiveMsg.style.color = '#888';
                childrenContainer.appendChild(recursiveMsg);
            }
            item.appendChild(childrenContainer);
        }

        return item;
    }

    effectiveRoots.forEach(cellName => {
        elements.cellTree.appendChild(createNode(cellName, new Set()));
    });
}

let dragSrcEl = null;

export function handleDragStart(e) {
    if (e.target.tagName === 'INPUT') {
        e.preventDefault();
        return;
    }

    dragSrcEl = this;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', this.getAttribute('data-layer-id'));
    this.classList.add('dragging');
}

export function handleDragEnd(e) {
    if (this && this.classList) this.classList.remove('dragging');
    const list = document.getElementById('layers-list');
    if (list) {
        list.querySelectorAll('.drag-over').forEach(el => {
            if (el && el.classList) el.classList.remove('drag-over');
        });
    }
}

export function handleDragOver(e) {
    if (e.preventDefault) {
        e.preventDefault();
    }
    e.dataTransfer.dropEffect = 'move';
    this.classList.add('drag-over');
    return false;
}

export function handleDragEnter(e) {
    this.classList.add('drag-over');
}

export function handleDragLeave(e) {
    this.classList.remove('drag-over');
}

export function handleDrop(e) {
    if (e.stopPropagation) {
        e.stopPropagation();
    }
    if (this && this.classList) this.classList.remove('drag-over');

    if (dragSrcEl !== this) {
        const list = document.getElementById('layers-list');
        list.insertBefore(dragSrcEl, this);

        const newOrder = [];
        list.querySelectorAll('.layer-toggle').forEach(el => {
            const input = el.querySelector('input[type="checkbox"]');
            if (input) {
                newOrder.push(input.getAttribute('data-layer-id'));
            }
        });
        state.allLayers = newOrder;

        if (state.currentEngine === 'canvas') draw();
        else if (state.currentEngine === 'webgl') drawWebGL();
        else if (state.currentEngine === 'svg') {
            const group = document.getElementById('gds-user-transform-group');
            if (group) {
                const renderOrder = [...state.allLayers].reverse();
                renderOrder.forEach(layerKey => {
                    const layerGroup = document.getElementById('layer-group-' + layerKey);
                    if (layerGroup) {
                        group.appendChild(layerGroup);
                    }
                });
            }
        }
        requestAnimationFrame(drawLabels);
    }
    return false;
}
