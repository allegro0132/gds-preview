import { state, elements } from './state.js';
import { draw, drawWebGL, drawLabels } from './renderer.js';
import { updateStatus } from './utils.js';

export function updateTransform() {
    if (state.currentEngine === 'canvas') {
        draw();
    } else if (state.currentEngine === 'webgl') {
        drawWebGL();
    } else if (state.currentEngine === 'svg') {
        // Apply transform to the inner group
        const group = document.getElementById('gds-user-transform-group');
        if (group) {
            // SVG rotation is CW by default. WebGL/Canvas logic expects CCW for positive angles.
            // So we negate the angle for SVG to match.
            group.setAttribute('transform', `scale(${state.flipState.x}, ${state.flipState.y}) rotate(${-state.rotationState})`);
        }

        // Remove CSS transform from container if present (cleanup from previous logic)
        if (elements.svgContainer) {
            elements.svgContainer.style.transform = '';
        }
    }
    requestAnimationFrame(drawLabels);
}

export function resizeCanvas() {
    const container = document.getElementById('view-container');
    if (!container) return;
    elements.canvas.width = container.clientWidth;
    elements.canvas.height = container.clientHeight;

    const glCanvas = document.getElementById('gds-webgl-canvas');
    if (glCanvas) {
        glCanvas.width = container.clientWidth;
        glCanvas.height = container.clientHeight;
        if (state.gl) state.gl.viewport(0, 0, glCanvas.width, glCanvas.height);
    }

    const textCanvas = document.getElementById('text-canvas');
    if (textCanvas) {
        textCanvas.width = container.clientWidth;
        textCanvas.height = container.clientHeight;
    }

    if ((!state.isViewFitted || !state.hasUserInteracted) && (state.currentEngine === 'canvas' || state.currentEngine === 'webgl')) {
        fitView();
    } else {
        if (state.currentEngine === 'canvas') draw();
        else if (state.currentEngine === 'webgl') {
            const t0 = performance.now();
            drawWebGL();
            state.perfMetrics.renderTime += (performance.now() - t0);
        }
        drawLabels();
    }
}

export function fitView() {
    if (state.currentEngine === 'svg') {
        if (state.panZoomInstance) {
            state.panZoomInstance.fit();
            state.panZoomInstance.center();
            // Sync state for labels
            const pan = state.panZoomInstance.getPan();
            state.offsetX = pan.x;
            state.offsetY = pan.y;
            state.scale = state.panZoomInstance.getSizes().realZoom;
            requestAnimationFrame(drawLabels);
        }
        return;
    }

    const width = state.bbox.x_max - state.bbox.x_min;
    const height = state.bbox.y_max - state.bbox.y_min;

    if (width === 0 || height === 0) {
        updateStatus("Empty bounding box");
        return;
    }

    const container = document.getElementById('view-container');
    if (!container || container.clientWidth === 0 || container.clientHeight === 0) {
        return;
    }
    const canvasWidth = container.clientWidth;
    const canvasHeight = container.clientHeight;
    const padding = 20;

    const scaleX = (canvasWidth - 2 * padding) / width;
    const scaleY = (canvasHeight - 2 * padding) / height;
    state.scale = Math.min(scaleX, scaleY);

    const gcx = (state.bbox.x_min + state.bbox.x_max) / 2;
    const gcy = (state.bbox.y_min + state.bbox.y_max) / 2;

    state.offsetX = canvasWidth / 2 - gcx * state.scale;
    state.offsetY = canvasHeight / 2 + gcy * state.scale;

    state.isViewFitted = true;

    if (state.currentEngine === 'canvas') draw();
    else if (state.currentEngine === 'webgl') drawWebGL();

    drawLabels();
}

export function applyRotationAndFlip(x, y) {
    const rad = state.rotationState * Math.PI / 180;
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    const rx = x * c - y * s;
    const ry = x * s + y * c;

    let wx = rx * state.flipState.x;
    let wy = ry * state.flipState.y;

    return { x: wx, y: wy };
}

export function worldToScreen(x, y) {
    const p = applyRotationAndFlip(x, y);
    const screenX = p.x * state.scale + state.offsetX;
    const screenY = p.y * -state.scale + state.offsetY;
    return { x: screenX, y: screenY };
}

export function screenToWorld(screenX, screenY) {
    let x = screenX - state.offsetX;
    let y = screenY - state.offsetY;

    x /= state.scale;
    y /= -state.scale;

    x /= state.flipState.x;
    const fy = state.currentEngine === 'svg' ? -state.flipState.y : state.flipState.y;
    y /= fy;

    const rad = -state.rotationState * Math.PI / 180;
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    const wx = x * c - y * s;
    const wy = x * s + y * c;

    return { x: wx, y: wy };
}
export function applyContextTransform(ctx) {
    ctx.translate(state.offsetX, state.offsetY);
    ctx.scale(state.scale, -state.scale);
    const fy = state.currentEngine === 'svg' ? -state.flipState.y : state.flipState.y;
    ctx.scale(state.flipState.x, fy);
    ctx.rotate(state.rotationState * Math.PI / 180);
}