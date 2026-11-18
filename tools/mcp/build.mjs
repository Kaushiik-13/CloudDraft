import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('./canvas.mjs', import.meta.url))],
  bundle: true,
  write: false,
  minify: true,
  format: 'iife',
});
const template = await readFile(
  new URL('./canvas.html', import.meta.url),
  'utf8',
);
const script = outputFiles[0].text.replaceAll(/<\/script/gi, '<\\/script');
const directory = new URL('./dist/', import.meta.url);
await mkdir(directory, { recursive: true });
await writeFile(
  new URL('canvas.html', directory),
  template.replace(
    '<!-- canvas script -->',
    () => `<script>${script}</script>`,
  ),
);
