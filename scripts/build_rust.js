const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

if (process.env.SKIP_RUST_BUILD) {
    console.log('Skipping Rust build (SKIP_RUST_BUILD is set)');
    process.exit(0);
}

const isWindows = os.platform() === 'win32';
const rustDir = path.join(__dirname, '..', 'gds-engine-rust');
const binDir = path.join(__dirname, '..', 'bin');
const binName = isWindows ? 'gds-engine-rust.exe' : 'gds-engine-rust';
const targetPath = path.join(rustDir, 'target', 'release', binName);
const destPath = path.join(binDir, binName);

console.log('Building Rust backend...');

const cargo = spawn('cargo', ['build', '--release'], {
    cwd: rustDir,
    stdio: 'inherit'
});

cargo.on('close', (code) => {
    if (code !== 0) {
        console.error(`Rust build failed with code ${code}`);
        process.exit(code);
    }

    console.log('Rust build complete. Copying binary...');

    if (!fs.existsSync(binDir)) {
        fs.mkdirSync(binDir, { recursive: true });
    }

    try {
        fs.copyFileSync(targetPath, destPath);
        if (!isWindows) {
            fs.chmodSync(destPath, '755');
        }
        console.log(`Binary copied to ${destPath}`);
    } catch (err) {
        console.error('Failed to copy binary:', err);
        process.exit(1);
    }
});
