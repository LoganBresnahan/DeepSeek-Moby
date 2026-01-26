const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const mediaDir = path.join(__dirname, '..', 'media');
const outDir = path.join(__dirname, '..', 'dist', 'media');

// Ensure output directory exists
fs.mkdirSync(outDir, { recursive: true });

// Files to minify
const jsFiles = ['chat.js', 'history.js'];
const cssFiles = ['chat.css', 'history.css'];

// Minify JS files
for (const file of jsFiles) {
  const inputPath = path.join(mediaDir, file);
  const outputPath = path.join(outDir, file);

  esbuild.buildSync({
    entryPoints: [inputPath],
    outfile: outputPath,
    minify: true,
    bundle: false,
  });

  const inputSize = fs.statSync(inputPath).size;
  const outputSize = fs.statSync(outputPath).size;
  console.log(`${file}: ${(inputSize / 1024).toFixed(1)}KB -> ${(outputSize / 1024).toFixed(1)}KB`);
}

// Minify CSS files
for (const file of cssFiles) {
  const inputPath = path.join(mediaDir, file);
  const outputPath = path.join(outDir, file);

  esbuild.buildSync({
    entryPoints: [inputPath],
    outfile: outputPath,
    minify: true,
    bundle: false,
  });

  const inputSize = fs.statSync(inputPath).size;
  const outputSize = fs.statSync(outputPath).size;
  console.log(`${file}: ${(inputSize / 1024).toFixed(1)}KB -> ${(outputSize / 1024).toFixed(1)}KB`);
}

// Copy non-minified assets (images, etc.)
const allMinified = [...jsFiles, ...cssFiles];
const assets = fs.readdirSync(mediaDir).filter(f => !allMinified.includes(f));

for (const asset of assets) {
  const inputPath = path.join(mediaDir, asset);
  const outputPath = path.join(outDir, asset);

  // Skip directories
  if (fs.statSync(inputPath).isDirectory()) continue;

  fs.copyFileSync(inputPath, outputPath);
  console.log(`${asset}: copied`);
}

console.log('\nMedia files built successfully');
