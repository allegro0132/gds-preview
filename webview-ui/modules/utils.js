import { state, elements } from './state.js';

export function updateStatus(msg) {
    if (elements.statusMsg) elements.statusMsg.textContent = msg;
    console.log("Status:", msg);
}

export function checkCompletion() {
    if (state.pythonFinished && state.pendingTasks === 0) {
        const elapsed = (performance.now() - state.startTime).toFixed(0);
        updateStatus(`Loaded successfully in ${elapsed}ms`);
        if (state.enableProfiling) {
            console.log("PROFILE: Total Load Time:", elapsed, "ms");
            console.log("PROFILE: Total Worker Time (Cumulative):", state.perfMetrics.workerTime.toFixed(0), "ms");
            console.log("PROFILE: Main Thread Parse Time:", state.perfMetrics.mainThreadParseTime.toFixed(0), "ms");
        }
    }
}

export function darken(hex, factor) {
    let r = parseInt(hex.slice(1, 3), 16);
    let g = parseInt(hex.slice(3, 5), 16);
    let b = parseInt(hex.slice(5, 7), 16);
    r = Math.floor(r * factor);
    g = Math.floor(g * factor);
    b = Math.floor(b * factor);
    return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}

export function createShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error(gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        return null;
    }
    return shader;
}

export function createProgram(gl, vertexShader, fragmentShader) {
    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.error(gl.getProgramInfoLog(program));
        gl.deleteProgram(program);
        return null;
    }
    return program;
}
