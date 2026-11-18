import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const catalog = new URL('https://docs.eraser.io/icons');
const destination = fileURLToPath(new URL('../icons/cloud/', import.meta.url));
const categories = ['aws-icons', 'google-cloud-icons'];

const run = promisify(execFile);

async function fetchText(url) {
  const { stdout } = await run(
    'curl',
    [
      '--fail',
      '--silent',
      '--show-error',
      '--location',
      '--max-time',
      '30',
      '--retry',
      '2',
      url.href,
    ],
    { maxBuffer: 8 * 1024 * 1024 },
  );
  return stdout;
}

async function install() {
  const page = await fetchText(catalog);
  const icons = categories.map((category) => {
    const section =
      page.split(`id="${category}"`)[1]?.split('</section>')[0] ?? '';
    const names = [
      ...new Set(
        Array.from(
          section.matchAll(/data-icon="((?:[a-z0-9_-]|&#38;)+)"/gi),
          ([, name]) => name.replaceAll('&#38;', '&'),
        ),
      ),
    ].sort();
    const count = Number(section.match(/data-total="(\d+)"/)?.[1]);
    if (!names.length || names.length !== count) {
      throw new Error(`Could not read the complete ${category} section`);
    }
    return { category, names };
  });

  await mkdir(destination, { recursive: true });
  const pending = [...new Set(icons.flatMap(({ names }) => names))];
  const failures = [];
  await Promise.all(
    Array.from({ length: 12 }, async () => {
      for (let name = pending.pop(); name; name = pending.pop()) {
        const target = join(destination, `${name}.svg`);
        const temporary = `${target}.${process.pid}.tmp`;
        try {
          const svg = await fetchText(
            new URL(
              `/assets/canvas-icons/${encodeURIComponent(name)}.svg`,
              catalog,
            ),
          );
          if (!/<svg[\s>]/i.test(svg)) throw new Error('Expected an SVG');
          await writeFile(temporary, svg);
          await rename(temporary, target);
        } catch (error) {
          await rm(temporary, { force: true });
          failures.push(`${name}: ${error.message}`);
        }
      }
    }),
  );
  if (failures.length) throw new Error(failures.sort().join('\n'));
  await writeFile(
    join(destination, 'catalog.json'),
    JSON.stringify(
      {
        source: catalog.href,
        categories: icons,
      },
      null,
      2,
    ) + '\n',
  );
  for (const { category, names } of icons)
    console.log(`Installed ${names.length} ${category}`);
}

install().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
