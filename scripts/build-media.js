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
      },
      // Strip verbose console calls in production (keeps warn/error)
      pure: isProduction ? ['console.debug', 'console.log', 'console.info'] : []
    });

    const outputPath = path.join(outDir, 'chat.js');
    const outputSize = fs.statSync(outputPath).size;
    console.log(`chat.ts -> chat.js: ${(outputSize / 1024).toFixed(1)}KB (bundled)`);
  } catch (error) {
    console.error('Failed to build chat.ts:', error.message);
    // Exit nonzero so `npm run compile` (and CI) stops here instead of
    // letting webpack succeed for the extension while the webview bundle
    // is stale. The previous "fall through to legacy build" comment was
    // from before the legacy bundle was retired — there's nothing to fall
    // through to anymore, and silent failures bit us once already.
    process.exit(1);
  }
}

// ============================================
// Legacy JS/CSS Minification
// ============================================

// Files to minify (legacy JS removed after actor system migration)
const jsFiles = usesActorSystem ? [] : ['chat.js'];
const cssFiles = ['chat.css'];

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
  // Skip large preview/demo media — README references them via raw.githubusercontent
  // URLs, so they don't need to ship in the VSIX.
  if (f.endsWith('.gif')) return false;
  if (f.endsWith('.mp4')) return false;
  return true;
});

for (const asset of assets) {
  const inputPath = path.join(mediaDir, asset);
  const outputPath = path.join(outDir, asset);

  fs.copyFileSync(inputPath, outputPath);
  console.log(`${asset}: copied`);
}

// ============================================
// Dev Tools (separate bundle - NOT in production chat.js)
// ============================================

// Build dev.ts as a separate bundle that's only loaded when devMode is enabled
const devTsPath = path.join(mediaDir, 'dev.ts');
if (fs.existsSync(devTsPath)) {
  try {
    esbuild.buildSync({
      entryPoints: [devTsPath],
      outfile: path.join(outDir, 'dev.js'),
      bundle: true,
      platform: 'browser',
      target: 'es2020',
      sourcemap: !isProduction,
      minify: isProduction,
      loader: {
        '.css': 'text'
      },
      // Strip verbose console calls in production (keeps warn/error)
      pure: isProduction ? ['console.debug', 'console.log', 'console.info'] : []
    });

    const devOutputPath = path.join(outDir, 'dev.js');
    const devOutputSize = fs.statSync(devOutputPath).size;
    console.log(`dev.ts -> dev.js: ${(devOutputSize / 1024).toFixed(1)}KB (separate bundle, loaded only in dev mode)`);
  } catch (error) {
    console.error('Failed to build dev.ts:', error.message);
  }
}

console.log('\nMedia files built successfully');
