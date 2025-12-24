const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const os = require('os');

const isWindows = os.platform() === 'win32';
const rootDir = path.resolve(__dirname, '..', '..');
const rustDir = path.join(rootDir, 'gds-engine-rust');
const resourcesDir = path.join(__dirname, '..', 'resources', 'gds-engine');

// Ensure resources directory exists
if (!fs.existsSync(resourcesDir)) {
    fs.mkdirSync(resourcesDir, { recursive: true });
}

const binName = isWindows ? 'gds-engine-rust.exe' : 'gds-engine-rust';
const targetBinName = isWindows ? 'gds-engine.exe' : 'gds-engine';
const targetPath = path.join(rustDir, 'target', 'release', binName);
const destPath = path.join(resourcesDir, targetBinName);

// Check if we need to build
if (process.env.SKIP_RUST_BUILD) {
    console.log('Skipping Rust build and copy (SKIP_RUST_BUILD is set). Assuming resources are already prepared.');
    process.exit(0);
} else {
    console.log('Building Rust backend for Desktop...');
    const result = spawnSync('cargo', ['build', '--release'], {
        cwd: rustDir,
        stdio: 'inherit',
        shell: false
    });

    if (result.status !== 0) {
        console.error('Rust build failed');
        process.exit(1);
    }
}

// Copy binary
console.log(`Copying binary from ${targetPath} to ${destPath}`);
if (fs.existsSync(targetPath)) {
    fs.copyFileSync(targetPath, destPath);
    // Make executable
    if (!isWindows) {
        fs.chmodSync(destPath, '755');
    }
    console.log('Binary copied successfully.');
} else {
    console.error(`Binary not found at ${targetPath}`);
    process.exit(1);
}
