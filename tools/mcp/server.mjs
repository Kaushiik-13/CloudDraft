import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  catalogNames,
  createLocalRenderer,
  resolveDocumentIcons,
} from '../../packages/diagrams/architecture.mjs';
import { searchIcons } from '../../packages/diagrams/icon-names.mjs';

const canvasUri = 'ui://clouddraft/canvas.html';
const widget = new URL('./dist/canvas.html', import.meta.url);
const examples = new URL('../../examples/', import.meta.url);
const sessionDirectory =
  process.env.CLOUDDRAFT_SESSION_DIR ||
  join(tmpdir(), 'clouddraft-mcp-sessions');
const item = z.record(z.string(), z.unknown());
const documentSchema = z.object({
  theme: z.enum(['light', 'dark']).optional(),
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

async function documentFrom({ source, document }) {
  if ((source === undefined) === (document === undefined)) {
    throw new Error('Provide either source or document.');
  }
  return resolveDocumentIcons(
    documentSchema.parse(
      source === undefined ? document : architecture(source),
    ),
  );
}

function recordPath(id) {
  return join(sessionDirectory, `${id}.json`);
}

async function saveRecord(record) {
  await mkdir(sessionDirectory, { recursive: true });
  await writeFile(
    recordPath(record.id),
    JSON.stringify(record),
    'utf8',
  );
}

async function readRecord(id) {
  try {
    return JSON.parse(await readFile(recordPath(id), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function processIsRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'ESRCH' ? false : true;
  }
}

async function removeStaleLock(lockPath) {
  try {
    const owner = JSON.parse(await readFile(lockPath, 'utf8'));
    const running = processIsRunning(owner.pid);
    if (running === false) {
      await unlink(lockPath).catch(() => {});
      return true;
    }
    if (running === true) return false;
  } catch {}
  try {
    const details = await stat(lockPath);
    if (Date.now() - details.mtimeMs > 120_000) {
      await unlink(lockPath).catch(() => {});
      return true;
    }
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
  return false;
}

async function withRecordLock(id, callback) {
  await mkdir(sessionDirectory, { recursive: true });
  const lockPath = join(sessionDirectory, `${id}.lock`);
  let handle;
  for (let attempt = 0; attempt < 600; attempt += 1) {
    try {
      handle = await open(lockPath, 'wx');
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, createdAt: Date.now() }),
        'utf8',
      );
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (await removeStaleLock(lockPath)) continue;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  if (!handle) throw new Error('Diagram is busy. Try the edit again.');
  try {
    return await callback();
  } finally {
    await handle.close();
    await unlink(lockPath).catch(() => {});
  }
}

async function lookup({ id, revision }) {
  const record = await readRecord(id);
  if (!record) throw new Error('Diagram not found. Open it again.');
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
  const {
    id,
    revision,
    renderedRevision = revision,
    dirty = false,
    document,
    layout,
    warnings,
    png,
  } = record;
  return structured(
    { id, revision, renderedRevision, dirty, document, layout, warnings },
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
    renderedRevision: revision,
    dirty: false,
    document,
    layout: result.json,
    warnings: result.warnings,
    png: result.png.toString('base64'),
  };
}

function applyEdits(current, args) {
  const removed = new Set(args.remove ?? []);
  const nodes = new Map(
    current.document.entities
      .filter(({ id }) => !removed.has(id))
      .map((entity) => [entity.id, entity]),
  );
  for (const entity of args.upsert ?? [])
    nodes.set(entity.id, { ...nodes.get(entity.id), ...entity });
  return editable({
    theme: args.theme ?? current.document.theme,
    entities: [...nodes.values()],
    connections:
      args.connections ??
      current.document.connections.filter(
        ({ from, to }) => !removed.has(from) && !removed.has(to),
      ),
  });
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
    const result = await (await renderer()).validate(await documentFrom(args));
    return structured(result, JSON.stringify(result));
  },
);
define(
  'open_diagram',
  'Open an editable diagram on the CloudDraft canvas. Supply architecture source or split JSON with stable entity IDs. Icon names come from list_icons; common short names such as s3 or sqs are mapped automatically.',
  input,
  async (args) => {
    const record = await renderRecord(
      editable(await documentFrom(args)),
      randomUUID(),
      1,
    );
    await saveRecord(record);
    return canvasResult(record);
  },
  true,
);
define(
  'get_diagram',
  'Read the current diagram document, revision and measured layout before making edits.',
  z.object({ id: reference.shape.id }),
  async ({ id }) => {
    const record = await readRecord(id);
    if (!record) throw new Error('Diagram not found in this server session.');
    const {
      revision,
      renderedRevision = revision,
      dirty = false,
      document,
      layout,
      warnings,
      png,
    } = record;
    return structured(
      { id, revision, renderedRevision, dirty, document, layout, warnings },
      JSON.stringify({ id, revision, document }),
      { png },
    );
  },
);
define(
  'edit_diagram',
  'Edit an existing diagram at a given revision. Entity updates merge by id, preserving existing positions unless explicitly changed. Connections can be replaced in full.',
  reference.extend({
    theme: z.enum(['light', 'dark']).optional(),
    upsert: z.array(item).max(200).optional(),
    remove: z.array(z.string()).max(200).optional(),
    connections: z.array(item).max(400).optional(),
  }),
  async (args) => {
    return withRecordLock(args.id, async () => {
      const current = await lookup(args);
      const document = await resolveDocumentIcons(applyEdits(current, args));
      const next = await renderRecord(
        document,
        current.id,
        current.revision + 1,
      );
      await saveRecord(next);
      return canvasResult(next);
    });
  },
  true,
);
define(
  'patch_diagram',
  'Save a canvas edit immediately and defer expensive layout and connector routing.',
  reference.extend({
    upsert: z.array(item).max(200).optional(),
    remove: z.array(z.string()).max(200).optional(),
    connections: z.array(item).max(400).optional(),
  }),
  async (args) =>
    withRecordLock(args.id, async () => {
      const current = await lookup(args);
      const next = {
        ...current,
        revision: current.revision + 1,
        renderedRevision: current.renderedRevision ?? current.revision,
        dirty: true,
        document: await resolveDocumentIcons(applyEdits(current, args)),
      };
      await saveRecord(next);
      return canvasResult(next);
    }),
);
define(
  'refresh_diagram',
  'Finish layout, connector routing and PNG rendering for a saved canvas revision.',
  reference,
  async (args) => {
    const snapshot = await lookup(args);
    const rendered = await renderRecord(snapshot.document, snapshot.id, snapshot.revision);
    return withRecordLock(args.id, async () => {
      const latest = await readRecord(args.id);
      if (!latest) throw new Error('Diagram not found. Open it again.');
      if (latest.revision !== args.revision) return canvasResult(latest);
      await saveRecord(rendered);
      return canvasResult(rendered);
    });
  },
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
    ).render({
      ...(await documentFrom(args)),
      outputs: { [args.format]: true },
    });
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
  'Search the bundled AWS and Google Cloud icon names. Call this before using an icon: names are long, for example Amazon S3 is aws-simple-storage-service and SQS is aws-simple-queue-service. Short names like s3 or sqs are matched too.',
  z.object({
    query: z.string().default(''),
    provider: z.enum(['aws', 'gcp']).optional(),
    offset: z.number().int().nonnegative().default(0),
  }),
  async ({ query, provider, offset }) => {
    const matches = searchIcons(query, await catalogNames(), provider);
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

function closeRenderer() {
  void rendererPromise?.then((engine) => engine.close()).catch(() => {});
}

function originAllowed(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  return (process.env.CLOUDDRAFT_ALLOWED_ORIGINS ??
    'https://claude.ai,https://claude.com')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .includes(origin);
}

function production() {
  const port = Number.parseInt(process.env.PORT ?? '10000', 10);
  const token = process.env.CLOUDDRAFT_MCP_PATH_TOKEN?.trim();
  if (!token || !/^[A-Za-z0-9_-]{16,128}$/.test(token)) {
    throw new Error(
      'CLOUDDRAFT_MCP_PATH_TOKEN must be 16-128 letters, numbers, underscores or hyphens.',
    );
  }
  const mcpPath = `/mcp/${token}`;
  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      if (request.method === 'GET' && path === '/health') {
        response
          .writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
          .end(JSON.stringify({ ok: true, service: 'clouddraft-mcp' }));
      } else if (path === mcpPath && originAllowed(request)) {
        await mcpRequest(request, response);
      } else {
        response.writeHead(path === mcpPath ? 403 : 404).end();
      }
    } catch (error) {
      console.error(error);
      if (!response.headersSent) response.writeHead(error.status ?? 400);
      response.end();
    }
  });
  server.listen(port, '0.0.0.0', () =>
    console.error(`CloudDraft MCP listening on port ${port}`),
  );
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => server.close(closeRenderer));
  }
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
      closeRenderer();
    }),
  );
}

await (process.argv.includes('--preview')
  ? preview()
  : process.argv.includes('--http')
    ? production()
    : startMcp());
