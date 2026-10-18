// Builds the Obsidian plugin into plugin/dist.
//   node scripts/plugin.mjs                  build once
//   node scripts/plugin.mjs --vault <dir>    also install into <dir>/.obsidian/plugins/duet
//   node scripts/plugin.mjs --watch          rebuild and reinstall on every change
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { context } from 'esbuild';
import { copyStyles, pluginBuild } from 'yami/esbuild';

const { values } = parseArgs({ options: { vault: { type: 'string' }, watch: { type: 'boolean' } } });
const DIST = 'plugin/dist';
const targets = [DIST, ...(values.vault ? [path.join(values.vault, '.obsidian/plugins/duet')] : [])];

async function install() {
  for (const target of targets) {
    await mkdir(target, { recursive: true });
    if (target !== DIST) await copyFile(path.join(DIST, 'main.js'), path.join(target, 'main.js'));
    await copyFile('manifest.json', path.join(target, 'manifest.json'));
  }
  await copyStyles(targets.map((target) => path.join(target, 'styles.css')), ['plugin/styles.css']);
  console.log(`Plugin built${values.vault ? ` and installed in ${values.vault}` : ''}.`);
}

const installPlugin = { name: 'install', setup: (build) => build.onEnd((result) => (result.errors.length ? undefined : install())) };
const ctx = await context({
  ...pluginBuild({ production: !values.watch, plugins: [installPlugin] }),
  entryPoints: ['plugin/src/main.ts'],
  outfile: path.join(DIST, 'main.js'),
  logLevel: 'warning',
});

if (values.watch) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
