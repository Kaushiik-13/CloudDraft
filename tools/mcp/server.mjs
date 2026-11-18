import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import {
  architecture,
  createLocalRenderer,
} from '../../packages/diagrams/architecture.mjs';

const canvasUri = 'ui://clouddraft/canvas.html';
const widget = new URL('./dist/canvas.html', import.meta.url);
const examples = new URL('../../examples/', import.meta.url);
const records = new Map();
const item = z.record(z.string(), z.unknown());
const documentSchema = z.object({
  entities: z.array(item).max(200),
  connections: z.array(item).max(400).default([]),
});
const input = z.object({
  source: z.string().max(80_000).optional(),
  document: documentSchema.optional(),
});
const reference = z.object({
  id: z.string().uuid(),
  revision: z.number().int().positive(),
});
let rendererPromise;
function renderer() {
  rendererPromise ??= createLocalRenderer().catch((error) => {
    rendererPromise = undefined;
    throw error;
  });
  return rendererPromise;
}

function documentFrom({ source, document }) {
  if ((source === undefined) === (document === undefined)) {
    throw new Error('Provide either source or document.');
  }
  return documentSchema.parse(
    source === undefined ? document : architecture(source),
  );
}

function lookup({ id, revision }) {
  const record = records.get(id);
  if (!record)
    throw new Error(
      'This diagram is no longer in this server session. Open its JSON source again.',
    );
  if (record.revision !== revision)
    throw new Error(
      'Diagram changed. Read get_diagram and retry with the latest revision.',
    );
  return record;
}

function structured(data, summary = 'OK', metadata) {
  return {
    content: [{ type: 'text', text: summary }],
    structuredContent: data,
    ...(metadata && { _meta: metadata }),
  };
}

function canvasResult(record) {
  const { id, revision, document, layout, warnings, png } = record;
  return structured(
    { id, revision, document, layout, warnings },
    `CloudDraft diagram ${id}, revision ${revision}. Use get_diagram before editing if a user has moved nodes.`,
    { png },
  );
}

async function renderRecord(document, id, revision) {
  const result = await (
    await renderer()
  ).render({ ...document, outputs: { png: true, json: true } });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return {
    id,
    revision,
    document,
    layout: result.json,
    warnings: result.warnings,
    png: result.png.toString('base64'),
  };
}

function editable(document) {
  const parsed = documentSchema.parse(document);
  const ids = new Set();
  for (const entity of parsed.entities) {
    if (typeof entity.id !== 'string' || !entity.id || ids.has(entity.id)) {
      throw new Error('Canvas entities require unique, nonempty string IDs.');
    }
    ids.add(entity.id);
  }
  return parsed;
}

const tools = {};
function define(name, description, schema, handler, ui = false) {
  tools[name] = { description, schema, handler, ui };
}
define(
  'validate_diagram',
  'Validate CloudDraft architecture source or a JSON diagram.',
  input,
  async (args) => {
    const result = await (await renderer()).validate(documentFrom(args));
    return structured(result, JSON.stringify(result));
  },
);
define(
  'open_diagram',
  'Open an editable diagram on the CloudDraft canvas. Supply architecture source or split JSON with stable entity IDs.',
  input,
  async (args) => {
    const record = await renderRecord(
      editable(documentFrom(args)),
      randomUUID(),
      1,
    );
    if (records.size >= 24) records.delete(records.keys().next().value);
    records.set(record.id, record);
    return canvasResult(record);
  },
  true,
);
define(
  'get_diagram',
  'Read the current diagram document, revision and measured layout before making edits.',
  z.object({ id: reference.shape.id }),
  ({ id }) => {
    const record = records.get(id);
    if (!record) throw new Error('Diagram not found in this server session.');
    const { revision, document, layout, warnings } = record;
    return structured(
      { id, revision, document, layout, warnings },
      JSON.stringify({ id, revision, document }),
    );
  },
);
define(
  'edit_diagram',
  'Edit an existing diagram at a given revision. Entity updates merge by id, preserving existing positions unless explicitly changed. Connections can be replaced in full.',
  reference.extend({
    upsert: z.array(item).max(200).optional(),
    remove: z.array(z.string()).max(200).optional(),
    connections: z.array(item).max(400).optional(),
  }),
  async (args) => {
    const current = lookup(args);
    const removed = new Set(args.remove ?? []);
    const nodes = new Map(
      current.document.entities
        .filter(({ id }) => !removed.has(id))
        .map((entity) => [entity.id, entity]),
    );
    for (const entity of args.upsert ?? [])
      nodes.set(entity.id, { ...nodes.get(entity.id), ...entity });
    const document = editable({
      entities: [...nodes.values()],
      connections:
        args.connections ??
        current.document.connections.filter(
          ({ from, to }) => !removed.has(from) && !removed.has(to),
        ),
    });
    const next = await renderRecord(document, current.id, current.revision + 1);
    lookup(args);
    records.set(next.id, next);
    return canvasResult(next);
  },
  true,
);
define(
  'render_diagram',
  'Export architecture source or split JSON as PNG or standalone HTML.',
  input.extend({
    format: z.enum(['png', 'html']).default('png'),
  }),
  async (args) => {
    const result = await (
      await renderer()
    ).render({ ...documentFrom(args), outputs: { [args.format]: true } });
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    return args.format === 'png'
      ? {
          content: [
            {
              type: 'image',
              mimeType: 'image/png',
              data: result.png.toString('base64'),
            },
          ],
        }
      : {
          content: [
            {
              type: 'resource',
              resource: {
                uri: 'clouddraft://exports/diagram.html',
                mimeType: 'text/html',
                text: result.html,
              },
            },
          ],
        };
  },
);
define(
  'list_icons',
  'Search the bundled AWS and Google Cloud icon names.',
  z.object({
    query: z.string().default(''),
    provider: z.enum(['aws', 'gcp']).optional(),
    offset: z.number().int().nonnegative().default(0),
  }),
  async ({ query, provider, offset }) => {
    const catalog = JSON.parse(
      await readFile(
        new URL('../../icons/cloud/catalog.json', import.meta.url),
        'utf8',
      ),
    );
    const matches = catalog.categories
      .flatMap(({ names }) => names)
      .filter(
        (name) =>
          (!provider || name.startsWith(`${provider}-`)) &&
          name.toLowerCase().includes(query.toLowerCase()),
      );
    return structured({
      total: matches.length,
      offset,
      icons: matches.slice(offset, offset + 80),
    });
  },
);
define(
  'get_diagram_schema',
  'Get the renderer registry or JSON schema for a specific element tag.',
  z.object({
    tag: z.string().optional(),
  }),
  async ({ tag }) => {
    const engine = await renderer();
    const schema = tag ? engine.tagSchema(tag) : engine.registryInfo();
    if (!schema) throw new Error('Unknown diagram tag.');
    return structured({ schema });
  },
);
async function exampleNames() {
  return (await readdir(examples))
    .filter((name) => /\.(eraserdiagram|json)$/.test(name))
    .sort();
}
define(
  'list_examples',
  'List editable CloudDraft examples.',
  z.object({}),
  async () => structured({ examples: await exampleNames() }),
);
define(
  'get_example',
  'Read a CloudDraft example by its listed filename.',
  z.object({ name: z.string() }),
  async ({ name }) => {
    if (!(await exampleNames()).includes(name))
      throw new Error('Unknown example.');
    const source = await readFile(
      new URL(encodeURIComponent(name), examples),
      'utf8',
    );
    return structured({ name, source }, source);
  },
);

async function invoke(name, args) {
  try {
    if (!Object.hasOwn(tools, name)) throw new Error('Unknown tool.');
    return await tools[name].handler(tools[name].schema.parse(args));
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: error.message }] };
  }
}

function makeServer() {
  const server = new McpServer({ name: 'clouddraft', version: '0.1.0' });
  registerAppResource(
    server,
    'CloudDraft canvas',
    canvasUri,
    { mimeType: RESOURCE_MIME_TYPE },
    async () => ({
      contents: [
        {
          uri: canvasUri,
          mimeType: RESOURCE_MIME_TYPE,
          text: await readFile(widget, 'utf8'),
        },
      ],
    }),
  );
  for (const [name, { description, schema, ui }] of Object.entries(tools)) {
    const config = { description, inputSchema: schema };
    const handler = (args) => invoke(name, args);
    if (ui)
      registerAppTool(
        server,
        name,
        { ...config, _meta: { ui: { resourceUri: canvasUri } } },
        handler,
      );
    else server.registerTool(name, config, handler);
  }
  return server;
}

async function startMcp() {
  const server = makeServer();
  const transport = new StdioServerTransport();
  server.server.onclose = () => {
    void rendererPromise?.then((engine) => engine.close()).catch(() => {});
  };
  await server.connect(transport);
}

async function readBody(request) {
  let body = '';
  for await (const chunk of request.setEncoding('utf8')) {
    body += chunk;
    if (body.length > 200_000)
      throw Object.assign(new Error('Request too large'), { status: 413 });
  }
  return JSON.parse(body);
}

async function mcpRequest(request, response) {
  if (request.method !== 'POST') {
    response.writeHead(405, { Allow: 'POST' }).end();
    return;
  }
  const body = await readBody(request);
  const server = makeServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  response.once('close', () => {
    void server.close().catch(() => {});
  });
  await server.connect(transport);
  await transport.handleRequest(request, response, body);
}

async function preview() {
  const port = 4318;
  const host = `127.0.0.1:${port}`;
  const server = createServer(async (request, response) => {
    try {
      if (
        request.headers.host !== host ||
        (request.headers.origin && request.headers.origin !== `http://${host}`)
      ) {
        response.writeHead(403).end();
      } else if (request.url === '/mcp') {
        await mcpRequest(request, response);
      } else if (request.method === 'GET' && request.url === '/') {
        const page = await readFile(widget, 'utf8');
        response
          .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          .end(page);
      } else if (
        request.method === 'POST' &&
        request.url === '/tool' &&
        request.headers['content-type'] === 'application/json'
      ) {
        const { name, args } = await readBody(request);
        response
          .writeHead(200, { 'Content-Type': 'application/json' })
          .end(JSON.stringify(await invoke(name, args)));
      } else response.writeHead(404).end();
    } catch (error) {
      if (!response.headersSent) response.writeHead(error.status ?? 400);
      response.end();
    }
  });
  server.listen(port, '127.0.0.1', () =>
    console.error(`CloudDraft preview at http://${host}`),
  );
  process.once('SIGTERM', () =>
    server.close(() => {
      void rendererPromise?.then((engine) => engine.close()).catch(() => {});
    }),
  );
}

await (process.argv.includes('--preview') ? preview() : startMcp());
