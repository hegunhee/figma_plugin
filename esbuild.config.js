const esbuild = require('esbuild');
const isWatch = process.argv.includes('--watch');

const buildOptions = {
  bundle: true,
  platform: 'browser',
  target: 'es6',
  logLevel: 'info',
};

async function build() {
  if (isWatch) {
    // Main thread
    const mainCtx = await esbuild.context({
      ...buildOptions,
      entryPoints: ['src/code.ts'],
      outfile: 'code.js',
    });
    // UI thread
    const uiCtx = await esbuild.context({
      ...buildOptions,
      entryPoints: ['src/ui.ts'],
      outfile: 'ui.js',
    });
    await Promise.all([mainCtx.watch(), uiCtx.watch()]);
    console.log('Watching for changes...');
  } else {
    esbuild.buildSync({ ...buildOptions, entryPoints: ['src/code.ts'], outfile: 'code.js' });
    esbuild.buildSync({ ...buildOptions, entryPoints: ['src/ui.ts'], outfile: 'ui.js' });
    console.log('Build complete.');
  }
}

build().catch(console.error);
