const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const mediaDir = path.join(__dirname, '..', 'media');
const outDir = path.join(__dirname, '..', 'dist', 'media');
const isProduction = process.env.NODE_ENV === 'production';

// Ensure output directory exists
fs.mkdirSync(outDir, { recursive: true });

// ============================================
// TypeScript Actor System Build
// ============================================

// Check if chat.ts exists (new actor system)
const chatTsPath = path.join(mediaDir, 'chat.ts');
const usesActorSystem = fs.existsSync(chatTsPath);

if (usesActorSystem) {
  console.log('Building TypeScript actor system...\n');

  try {
    esbuild.buildSync({
      entryPoints: [chatTsPath],
      outfile: path.join(outDir, 'chat.js'),
      bundle: true,
      platform: 'browser',
      target: 'es2020',
      sourcemap: !isProduction,
      minify: isProduction,
      loader: {
        '.css': 'text'  // Import CSS as strings for actor injection
      },
      define: {
        'process.env.NODE_ENV': JSON.stringify(isProduction ? 'production' : 'development')
      }
    });

    const outputPath = path.join(outDir, 'chat.js');
    const outputSize = fs.statSync(outputPath).size;
    console.log(`chat.ts -> chat.js: ${(outputSize / 1024).toFixed(1)}KB (bundled)`);
  } catch (error) {
    console.error('Failed to build chat.ts:', error.message);
    // Fall through to legacy build
  }
}

// ============================================
// Legacy JS/CSS Minification
// ============================================

// Files to minify (legacy - will be removed after migration)
const jsFiles = usesActorSystem ? ['history.js'] : ['chat.js', 'history.js'];
const cssFiles = ['chat.css', 'history.css'];

// Minify JS files
for (const file of jsFiles) {
  const inputPath = path.join(mediaDir, file);
  const outputPath = path.join(outDir, file);

  // Skip if file doesn't exist
  if (!fs.existsSync(inputPath)) {
    console.log(`${file}: skipped (not found)`);
    continue;
  }

  esbuild.buildSync({
    entryPoints: [inputPath],
    outfile: outputPath,
    minify: isProduction,
    bundle: false,
  });

  const inputSize = fs.statSync(inputPath).size;
  const outputSize = fs.statSync(outputPath).size;
  console.log(`${file}: ${(inputSize / 1024).toFixed(1)}KB -> ${(outputSize / 1024).toFixed(1)}KB`);
}

// Minify CSS files (global CSS only after migration)
for (const file of cssFiles) {
  const inputPath = path.join(mediaDir, file);
  const outputPath = path.join(outDir, file);

  // Skip if file doesn't exist
  if (!fs.existsSync(inputPath)) {
    console.log(`${file}: skipped (not found)`);
    continue;
  }

  esbuild.buildSync({
    entryPoints: [inputPath],
    outfile: outputPath,
    minify: isProduction,
    bundle: false,
  });

  const inputSize = fs.statSync(inputPath).size;
  const outputSize = fs.statSync(outputPath).size;
  console.log(`${file}: ${(inputSize / 1024).toFixed(1)}KB -> ${(outputSize / 1024).toFixed(1)}KB`);
}

// ============================================
// Copy Non-Minified Assets
// ============================================

const allMinified = [...jsFiles, ...cssFiles, 'chat.ts', usesActorSystem ? 'chat.js' : null].filter(Boolean);
const assets = fs.readdirSync(mediaDir).filter(f => {
  // Skip minified files and directories
  if (allMinified.includes(f)) return false;
  const fullPath = path.join(mediaDir, f);
  if (fs.statSync(fullPath).isDirectory()) return false;
  // Skip TypeScript files (they get bundled)
  if (f.endsWith('.ts')) return false;
  return true;
});

for (const asset of assets) {
  const inputPath = path.join(mediaDir, asset);
  const outputPath = path.join(outDir, asset);

  fs.copyFileSync(inputPath, outputPath);
  console.log(`${asset}: copied`);
}

console.log('\nMedia files built successfully');
