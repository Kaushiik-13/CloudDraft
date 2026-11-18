import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import {
  createRenderer,
  eraserFonts,
  normalizeFetchedIcon,
} from './dist/index.js';
import { resolveIconName, suggestIcons } from './icon-names.mjs';

export function architecture(source) {
  const root = { children: [] };
  const stack = [root];
  const nodes = new Map();
  const edges = [];
  let vertical = false;
  const identifier = '(?:"[^"]+"|[\\w][\\w .-]*?)';
  const edgePattern = new RegExp(
    `^(${identifier})\\s*(<>|--|>|<)\\s*(${identifier})(?:\\s*:\\s*(.*))?$`,
  );
  const nodePattern = new RegExp(
    `^(${identifier})(?:\\s*\\[([^\\]]*)\\])?\\s*(\\{)?$`,
  );
  const unquote = (value) => value.replace(/^"|"$/g, '');

  for (const [index, raw] of source.split(/\r?\n/).entries()) {
    const line = raw.trim();
    const fail = (message) => {
      throw new Error(`Line ${index + 1}: ${message}`);
    };
    if (
      !line ||
      line.startsWith('//') ||
      (index === 0 && line === 'cloud-architecture-diagram')
    )
      continue;
    const direction = /^direction (right|down)$/.exec(line);
    if (direction) {
      vertical = direction[1] === 'down';
      continue;
    }
    if (line === '}') {
      if (stack.length === 1) fail('Unexpected closing brace');
      stack.pop();
      continue;
    }
    const edge = edgePattern.exec(line);
    if (edge) {
      edges.push({
        from: unquote(edge[1]),
        to: unquote(edge[3]),
        operator: edge[2],
        label: edge[4],
      });
      continue;
    }
    const match = nodePattern.exec(line);
    if (!match) fail('Unsupported architecture statement');
    const name = unquote(match[1]);
    if (nodes.has(name)) fail(`Duplicate name: ${name}`);
    const props = {};
    for (const entry of match[2]?.split(',') ?? []) {
      const property = /^\s*(label|color|icon)\s*:\s*(.+?)\s*$/.exec(entry);
      if (!property) fail(`Unsupported property: ${entry.trim()}`);
      props[property[1]] = unquote(property[2]);
    }
    const node = {
      id: `node-${nodes.size}`,
      label: name,
      ...props,
      children: match[3] ? [] : undefined,
    };
    nodes.set(name, node);
    stack.at(-1).children.push(node);
    if (node.children) stack.push(node);
  }

  if (stack.length !== 1) throw new Error('Unclosed group');
  if (!nodes.size) throw new Error('Declare at least one node');
  const entities = [];

  function place(node, x, y, containerId) {
    const { id, label, color, icon, children } = node;
    const entity = {
      id,
      x,
      y,
      ...(color && { color }),
      ...(containerId && { containerId }),
    };
    entities.push(entity);
    if (!children) {
      Object.assign(
        entity,
        icon
          ? {
              tag: 'Icon',
              icon,
              width: 56,
              height: 56,
              texts: [{ text: label }],
            }
          : {
              tag: 'Shape',
              shape: 'rectangle',
              width: Math.max(130, label.length * 9 + 24),
              height: 64,
              texts: [{ text: label }],
            },
      );
      return {
        width: Math.max(entity.width, label.length * 9 + 24),
        height: icon ? 86 : 64,
      };
    }

    let width = Math.max(150, label.length * 9 + 60);
    let height = 80;
    let offset = 0;
    for (const child of children) {
      const size = place(
        child,
        x + 28 + (vertical ? 0 : offset),
        y + 56 + (vertical ? offset : 0),
        id,
      );
      width = Math.max(width, size.width + 56 + (vertical ? 0 : offset));
      height = Math.max(height, size.height + 94 + (vertical ? offset : 0));
      offset += (vertical ? size.height : size.width) + 78;
    }
    Object.assign(entity, {
      tag: 'Group',
      title: { text: label, ...(icon && { icon }) },
      width,
      height,
    });
    return { width, height };
  }

  let offset = 24;
  for (const node of root.children) {
    const size = place(node, vertical ? 24 : offset, vertical ? offset : 24);
    offset += (vertical ? size.height : size.width) + 94;
  }

  const connections = edges.map(({ from, to, operator, label }) => {
    if (!nodes.has(from) || !nodes.has(to))
      throw new Error(
        `Declare both ends of the connection ${from} ${operator} ${to}`,
      );
    return {
      from: nodes.get(from).id,
      to: nodes.get(to).id,
      ...(label && { label }),
      ...(operator.includes('<') && { startArrowhead: 'triangle' }),
      ...(operator.includes('>') && { endArrowhead: 'triangle' }),
    };
  });
  return { entities, connections };
}

export function createLocalRenderer() {
  const fonts = eraserFonts();
  fonts.faces = fonts.faces.map((face) => ({ ...face, inline: true }));
  const chromiumPath = process.env.CHROMIUM_PATH || '/usr/bin/chromium';
  const containerBrowser = process.env.CHROMIUM_NO_SANDBOX === '1';
  return createRenderer({
    ...(containerBrowser
      ? {
          browser: () =>
            chromium.launch({
              executablePath: chromiumPath,
              args: [
                '--no-sandbox',
                '--disable-dev-shm-usage',
                '--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests',
              ],
            }),
        }
      : { chromiumPath }),
    fonts,
    onUnknownIcon: 'error',
    iconLoader: async (requested) => {
      if (!/^[\w&-]+$/.test(requested)) throw new Error('Invalid icon name');
      const custom = await readCustomIcon(requested);
      if (custom !== undefined) return custom;
      const name =
        resolveIconName(requested, await catalogNames()) ?? requested;
      const asset = new URL(
        `../../icons/cloud/${encodeURIComponent(name)}.svg`,
        import.meta.url,
      );
      return normalizeFetchedIcon(
        await readFile(asset, 'utf8'),
        name.replaceAll('&', '_amp_'),
      );
    },
  });
}

async function readCustomIcon(name) {
  try {
    return await readFile(
      join(process.env.ARCHITECTURE_ICONS || 'icons', `${name}.svg`),
      'utf8',
    );
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

let catalogPromise;
export function catalogNames() {
  catalogPromise ??= readFile(
    new URL('../../icons/cloud/catalog.json', import.meta.url),
    'utf8',
  )
    .then(
      (text) =>
        new Set(JSON.parse(text).categories.flatMap(({ names }) => names)),
    )
    .catch((error) => {
      catalogPromise = undefined;
      throw error;
    });
  return catalogPromise;
}

/**
 * Rewrites every icon name in a diagram document to its catalog name, so
 * "aws-s3" becomes "aws-simple-storage-service". Throws one error that lists
 * every unknown icon with suggestions instead of letting the render fail.
 */
export async function resolveDocumentIcons(document) {
  const names = await catalogNames();
  const unknown = new Map();
  const visit = async (value) => {
    if (Array.isArray(value)) return Promise.all(value.map(visit));
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'icon' && typeof child === 'string' && child) {
        if (/^https?:|^data:|^blob:/i.test(child)) continue;
        if ((await readCustomIcon(child)) !== undefined) continue;
        const resolved = resolveIconName(child, names);
        if (resolved) value[key] = resolved;
        else unknown.set(child, suggestIcons(child, names));
      } else await visit(child);
    }
  };
  const copy = structuredClone(document);
  await visit(copy);
  if (unknown.size) {
    const lines = [...unknown].map(
      ([name, options]) =>
        `Unknown icon "${name}".${options.length ? ` Did you mean: ${options.join(', ')}?` : ''}`,
    );
    throw new Error(
      `${lines.join(' ')} Use list_icons to find exact icon names.`,
    );
  }
  return copy;
}

async function main() {
  const [input, outputDir = 'exports'] = process.argv.slice(2);
  if (!input)
    throw new Error(
      'Usage: pnpm architecture <file.eraserdiagram> [output-directory]',
    );
  const document = architecture(await readFile(input, 'utf8'));
  const renderer = await createLocalRenderer();
  try {
    const result = await renderer.render({
      ...document,
      outputs: { png: true, html: true },
    });
    if (!result.ok) throw new Error(JSON.stringify(result.errors, null, 2));
    for (const warning of result.warnings) console.error(warning);
    await mkdir(outputDir, { recursive: true });
    const name = basename(input, extname(input));
    await writeFile(join(outputDir, `${name}.png`), result.png);
    await writeFile(join(outputDir, `${name}.html`), result.html);
    console.log(`Wrote ${name}.png and ${name}.html to ${outputDir}`);
  } finally {
    await renderer.close();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
