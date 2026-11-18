import { App } from '@modelcontextprotocol/ext-apps';

const viewport = document.querySelector('#viewport');
const world = document.querySelector('#world');
const stage = document.querySelector('#stage');
const status = document.querySelector('#status');
const statusText = document.querySelector('#status-text');
const reloadButton = document.querySelector('#reload');
const emptyState = document.querySelector('#empty-state');
const image = document.querySelector('#diagram');
const overlay = document.querySelector('#nodes');
const pngButton = document.querySelector('#png');
const jsonButton = document.querySelector('#json');
const zoomInButton = document.querySelector('#zoom-in');
const zoomOutButton = document.querySelector('#zoom-out');
const zoomLabel = document.querySelector('#zoom-label');
const fitButton = document.querySelector('#fit');
const sampleButton = document.querySelector('#sample');
const themeButton = document.querySelector('#theme');
const labelEditor = document.querySelector('#label-editor');
const codePanel = document.querySelector('#code-panel');
const codeEditor = document.querySelector('#code-editor');
const codeError = document.querySelector('#code-error');
const closeCodeButton = document.querySelector('#close-code');
const formatCodeButton = document.querySelector('#format-code');
const applyCodeButton = document.querySelector('#apply-code');
const downloadJsonButton = document.querySelector('#download-json');
const local = window.parent === window;
const app = local ? null : new App({ name: 'CloudDraft', version: '0.1.0' });
const view = { x: 0, y: 0, scale: 1 };
const minimumScale = 0.2;
const maximumScale = 3.5;
let current;
let busy = false;
let editing;
let manualTheme = false;
let themeSyncing = false;
let mutationTail = Promise.resolve();
let refreshTimer;
let refreshInFlight = false;

function serializeMutation(work) {
  const operation = mutationTail.then(work, work);
  mutationTail = operation.catch(() => {});
  return operation;
}

function setStatus(message, state = 'ready') {
  statusText.textContent = message;
  status.className = state;
}

async function reloadLatest() {
  if (!current?.id) {
    return;
  }
  reloadButton.disabled = true;
  setStatus('Reloading latest revision…', 'busy');
  try {
    const result = await call('get_diagram', { id: current.id });
    show(result);
    if (!codePanel.hidden) {
      codeEditor.value = JSON.stringify(result.structuredContent.document, null, 2);
      codeError.textContent = '';
    }
  } catch (error) {
    setStatus(error.message, 'error');
  } finally {
    reloadButton.disabled = false;
  }
}

reloadButton.onclick = () => void reloadLatest();

async function call(name, args) {
  const result = app
    ? await app.callServerTool({ name, arguments: args })
    : await fetch('/tool', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, args }),
      }).then((response) => response.json());
  if (result.isError) {
    throw new Error(result.content[0]?.text ?? 'Tool failed');
  }
  return result;
}

function scheduleRefresh(delay = 900) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => void refreshDirtyDiagram(), delay);
}

async function refreshDirtyDiagram() {
  if (!current?.dirty || refreshInFlight) {
    if (current?.dirty) scheduleRefresh(500);
    return;
  }
  refreshInFlight = true;
  const requested = { id: current.id, revision: current.revision };
  setStatus(`Revision ${current.revision} saved · Refining routes…`, 'ready');
  try {
    const result = await call('refresh_diagram', requested);
    const data = result.structuredContent;
    if (current?.id !== data?.id) return;
    if (data.dirty) {
      if (data.revision >= current.revision) {
        current = { ...current, ...data };
      }
      scheduleRefresh(400);
      return;
    }
    if (data.revision >= current.revision) show(result);
  } catch (error) {
    setStatus(`${error.message} · Your edit is saved`, 'error');
    scheduleRefresh(1500);
  } finally {
    refreshInFlight = false;
  }
}

function applyView() {
  world.style.transform = `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})`;
  zoomLabel.textContent = `${Math.round(view.scale * 100)}%`;
  const spacing = 24 * view.scale;
  viewport.style.backgroundSize = `${spacing}px ${spacing}px`;
  viewport.style.backgroundPosition = `${view.x % spacing}px ${view.y % spacing}px`;
}

function setScale(nextScale, clientX, clientY) {
  const bounds = viewport.getBoundingClientRect();
  const anchorX = clientX ?? bounds.left + bounds.width / 2;
  const anchorY = clientY ?? bounds.top + bounds.height / 2;
  const localX = anchorX - bounds.left;
  const localY = anchorY - bounds.top;
  const worldX = (localX - view.x) / view.scale;
  const worldY = (localY - view.y) / view.scale;
  view.scale = Math.min(maximumScale, Math.max(minimumScale, nextScale));
  view.x = localX - worldX * view.scale;
  view.y = localY - worldY * view.scale;
  applyView();
}

function fitDiagram(animate = true) {
  if (!current) {
    return;
  }
  const { scene } = current.layout;
  const bounds = viewport.getBoundingClientRect();
  const padding = Math.min(96, Math.max(48, bounds.width * 0.09));
  view.scale = Math.min(
    1.6,
    Math.max(
      minimumScale,
      Math.min(
        (bounds.width - padding * 2) / scene.width,
        (bounds.height - padding * 2) / scene.height,
      ),
    ),
  );
  view.x = (bounds.width - scene.width * view.scale) / 2;
  view.y = (bounds.height - scene.height * view.scale) / 2;
  if (animate) {
    world.style.transition = 'transform 180ms cubic-bezier(.2,.8,.2,1)';
    setTimeout(() => {
      world.style.transition = '';
    }, 200);
  }
  applyView();
}

function show(result) {
  const data = result.structuredContent;
  const png = result._meta?.png;
  if (result.isError) {
    setStatus(result.content[0]?.text ?? 'Could not render diagram.', 'error');
    return;
  }
  if (!data?.layout?.scene || typeof png !== 'string') {
    return;
  }
  if (current?.id === data.id && current.revision > data.revision) {
    return;
  }
  const shouldFit = !current || current.id !== data.id;
  current = { ...data, png };
  const { scene, entities } = data.layout;
  const imageUrl = `data:image/png;base64,${png}`;
  const containerIds = new Set(
    data.document.entities.map(({ containerId }) => containerId).filter(Boolean),
  );
  world.hidden = false;
  emptyState.hidden = true;
  stage.style.width = `${scene.width}px`;
  stage.style.height = `${scene.height}px`;
  image.src = imageUrl;
  pngButton.disabled = Boolean(data.dirty);
  jsonButton.disabled = false;
  reloadButton.disabled = false;
  overlay.replaceChildren();
  const sourceEntities = new Map(
    data.document.entities.map((entity) => [entity.id, entity]),
  );
  for (const entity of entities) {
    if (
      !entity.id ||
      !entity.width ||
      !entity.height ||
      ['Lane', 'Pool', 'Textbox'].includes(entity.tag) ||
      (entity.tag === 'Group' && containerIds.has(entity.id))
    ) {
      continue;
    }
    const source = sourceEntities.get(entity.id);
    const visualX = data.dirty && Number.isFinite(source?.x) ? source.x : entity.x;
    const visualY = data.dirty && Number.isFinite(source?.y) ? source.y : entity.y;
    const left = visualX - scene.x;
    const top = visualY - scene.y;
    const cropLeft = entity.x - scene.x;
    const cropTop = entity.y - scene.y;
    if (left !== cropLeft || top !== cropTop) {
      const cover = document.createElement('div');
      cover.className = 'node-origin pending-origin';
      cover.style.left = `${cropLeft}px`;
      cover.style.top = `${cropTop}px`;
      cover.style.width = `${entity.width}px`;
      cover.style.height = `${entity.height}px`;
      cover.style.background = labelBackground(cover);
      overlay.append(cover);
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'node-control';
    button.setAttribute(
      'aria-label',
      `Move ${entity.texts?.[0]?.text ?? entity.id}`,
    );
    button.dataset.nodeId = entity.id;
    button.style.left = `${left}px`;
    button.style.top = `${top}px`;
    button.style.width = `${entity.width}px`;
    button.style.height = `${entity.height}px`;
    button.style.backgroundImage = `url("${imageUrl}")`;
    button.style.backgroundSize = `${scene.width}px ${scene.height}px`;
    button.style.backgroundPosition = `${-cropLeft}px ${-cropTop}px`;
    button.title = 'Drag to move';
    attachDrag(button, entity);
    overlay.append(button);
  }
  addEditableLabels(data.layout, data.document, scene);
  setStatus(
    data.dirty
      ? `Revision ${data.revision} saved · Refining routes…`
      : `Revision ${data.revision} · Click text to edit`,
    'ready',
  );
  if (shouldFit) {
    requestAnimationFrame(() => fitDiagram(false));
  } else {
    applyView();
  }
  if (app) {
    void app
      .updateModelContext({
        content: [
          {
            type: 'text',
            text: `CloudDraft diagram ${data.id}, revision ${data.revision}. Use get_diagram before editing so manual placement is preserved.`,
          },
        ],
      })
      .catch(() => {});
  }
  void syncDiagramTheme();
  if (data.dirty) scheduleRefresh();
}

function addLabelControl({
  left,
  top,
  width,
  height,
  label,
  onEdit,
  kind,
  pending = false,
  style = {},
}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'label-control';
  button.setAttribute('aria-label', `Edit ${kind} label: ${label}`);
  button.title = `Click to edit “${label}”`;
  button.style.left = `${left}px`;
  button.style.top = `${top}px`;
  button.style.width = `${Math.max(18, width)}px`;
  button.style.height = `${Math.max(16, height)}px`;
  if (pending) {
    button.classList.add(
      'label-override',
      style.textAlign === 'left' ? 'align-left' : 'align-center',
    );
    button.textContent = label;
    button.style.background = labelBackground(button);
    button.style.color =
      document.documentElement.dataset.theme === 'dark' ? '#f5f5f5' : '#202124';
    button.style.fontSize = `${style.fontSize ?? 13}px`;
    button.style.fontWeight = style.fontWeight ?? '400';
  }
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    if (busy || themeSyncing) {
      setStatus('Finishing the current canvas update…', 'busy');
      return;
    }
    onEdit(button);
  });
  overlay.append(button);
}

function entityTextStyle(entity) {
  return {
    fontSize: entity.fontSize ?? (entity.tag === 'Textbox' ? 20 : 13),
    fontWeight: entity.tag === 'Group' ? '500' : '400',
    textAlign:
      entity.tag === 'Group' || entity.tag === 'Textbox' ? 'left' : 'center',
  };
}

function entityLabelBox(entity, scene) {
  const left = entity.x - scene.x;
  const top = entity.y - scene.y;
  if (entity.tag === 'Group') {
    return {
      left: left + 8,
      top: top + 6,
      width: Math.max(
        80,
        Math.min(
          entity.width - 16,
          (editableLabel(entity)?.length ?? 8) * 7.5 + 20,
        ),
      ),
      height: 24,
    };
  }
  if (entity.tag === 'Icon') {
    return {
      left: left - 34,
      top: top + entity.height,
      width: entity.width + 68,
      height: 36,
    };
  }
  return { left, top, width: entity.width, height: entity.height };
}

function addEditableLabels(layout, document, scene) {
  for (const entity of layout.entities) {
    const source = document.entities.find((item) => item.id === entity.id);
    const label = source && editableLabel(source);
    if (!source || typeof label !== 'string' || !entity.width || !entity.height) {
      continue;
    }
    const visualEntity = {
      ...entity,
      x: Number.isFinite(source.x) ? source.x : entity.x,
      y: Number.isFinite(source.y) ? source.y : entity.y,
    };
    const style = entityTextStyle(source);
    addLabelControl({
      ...entityLabelBox(visualEntity, scene),
      label,
      kind: entity.tag === 'Group' ? 'section' : 'service',
      pending: label !== editableLabel(entity),
      style,
      onEdit: (button) => startEntityLabelEdit(button, entity.id),
    });
  }
  for (const [index, connection] of layout.connections.entries()) {
    const source = document.connections[index];
    const placement = connection.labelPlacement;
    if (!source || typeof source.label !== 'string' || !placement) {
      continue;
    }
    addLabelControl({
      left: connection.x + placement.x - scene.x,
      top: connection.y + placement.y - scene.y,
      width: placement.width,
      height: placement.height,
      label: source.label,
      kind: 'connection',
      pending: source.label !== connection.label,
      style: { fontSize: 11, textAlign: 'center' },
      onEdit: (button) => startConnectionLabelEdit(button, index),
    });
  }
}

function diagramIdFrom(result) {
  if (typeof result.structuredContent?.id === 'string') {
    return result.structuredContent.id;
  }
  for (const item of result.content ?? []) {
    if (item.type !== 'text') {
      continue;
    }
    try {
      const parsed = JSON.parse(item.text);
      if (typeof parsed.id === 'string') {
        return parsed.id;
      }
    } catch {}
    const match = item.text.match(
      /CloudDraft diagram ([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/i,
    );
    if (match) {
      return match[1];
    }
  }
}

async function hydrate(result) {
  if (result.structuredContent?.layout?.scene && result._meta?.png) {
    show(result);
    return;
  }
  const id = diagramIdFrom(result);
  if (!id) {
    setStatus(
      result.isError
        ? (result.content?.[0]?.text ?? 'Could not render diagram.')
        : 'Canvas data was not provided by this host.',
      'error',
    );
    return;
  }
  setStatus('Loading canvas…', 'busy');
  try {
    show(await call('get_diagram', { id }));
  } catch (error) {
    setStatus(error.message, 'error');
  }
}

function editableLabel(entity) {
  if (typeof entity.title?.text === 'string') {
    return entity.title.text;
  }
  if (Array.isArray(entity.texts)) {
    return entity.texts.find(({ text }) => typeof text === 'string')?.text;
  }
  if (typeof entity.text === 'string') {
    return entity.text;
  }
  if (typeof entity.label === 'string') {
    return entity.label;
  }
}

function labelUpdate(entity, text) {
  if (typeof entity.title?.text === 'string') {
    return { id: entity.id, title: { ...entity.title, text } };
  }
  if (Array.isArray(entity.texts)) {
    const texts = entity.texts.map((item, index) =>
      index === 0 ? { ...item, text } : item,
    );
    return { id: entity.id, texts };
  }
  if (typeof entity.text === 'string') {
    return { id: entity.id, text };
  }
  return { id: entity.id, label: text };
}

function closeLabelEditor() {
  editing?.button && (editing.button.hidden = false);
  editing = undefined;
  labelEditor.hidden = true;
}

function labelBackground(button) {
  if (!image.complete || !image.naturalWidth) {
    return document.documentElement.dataset.theme === 'dark' ? '#171717' : '#ffffff';
  }
  const sample = document.createElement('canvas');
  sample.width = 1;
  sample.height = 1;
  const context = sample.getContext('2d', { willReadFrequently: true });
  const left = Number.parseFloat(button.style.left);
  const top = Number.parseFloat(button.style.top);
  const width = Number.parseFloat(button.style.width);
  const height = Number.parseFloat(button.style.height);
  const points = [
    [left + 3, top + 3],
    [left + width - 3, top + 3],
    [left + 3, top + height - 3],
    [left + width - 3, top + height - 3],
  ];
  let colors;
  try {
    colors = points.map(([x, y]) => {
      context.clearRect(0, 0, 1, 1);
      context.drawImage(image, x, y, 1, 1, 0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data];
    });
  } catch {
    return document.documentElement.dataset.theme === 'dark' ? '#171717' : '#ffffff';
  }
  const [red, green, blue, alpha] = colors.reduce(
    (best, color) => {
      const score = colors.filter(
        (candidate) =>
          Math.abs(candidate[0] - color[0]) < 8 &&
          Math.abs(candidate[1] - color[1]) < 8 &&
          Math.abs(candidate[2] - color[2]) < 8,
      ).length;
      return score > best.score ? { color, score } : best;
    },
    { color: colors[0], score: 0 },
  ).color;
  return `rgba(${red}, ${green}, ${blue}, ${alpha / 255})`;
}

function resizeLabelEditor() {
  if (!editing) {
    return;
  }
  const fontSize = Number.parseFloat(labelEditor.style.fontSize) || 13;
  const longestLine = labelEditor.value
    .split('\n')
    .reduce((length, line) => Math.max(length, line.length), 0);
  const available = Math.max(40, current.layout.scene.width - editing.left - 4);
  const width = Math.min(
    available,
    Math.max(editing.width, longestLine * fontSize * 0.58 + 10),
  );
  labelEditor.style.width = `${width}px`;
  labelEditor.style.height = 'auto';
  labelEditor.style.height = `${Math.max(editing.height, labelEditor.scrollHeight)}px`;
}

function positionLabelEditor(button, value, style = {}) {
  const left = Number.parseFloat(button.style.left);
  const top = Number.parseFloat(button.style.top);
  const width = Number.parseFloat(button.style.width);
  const height = Number.parseFloat(button.style.height);
  Object.assign(editing, { button, left, top, width, height });
  overlay.append(labelEditor);
  button.hidden = true;
  labelEditor.style.left = `${left}px`;
  labelEditor.style.top = `${top}px`;
  labelEditor.style.fontSize = `${style.fontSize ?? 13}px`;
  labelEditor.style.fontWeight = style.fontWeight ?? '400';
  labelEditor.style.textAlign = style.textAlign ?? 'center';
  labelEditor.style.color =
    document.documentElement.dataset.theme === 'dark' ? '#f5f5f5' : '#202124';
  labelEditor.style.background = labelBackground(button);
  labelEditor.value = value;
  labelEditor.hidden = false;
  resizeLabelEditor();
  labelEditor.focus();
  labelEditor.setSelectionRange(value.length, value.length);
}

function startEntityLabelEdit(button, id) {
  const entity = current?.document.entities.find((item) => item.id === id);
  const value = entity && editableLabel(entity);
  if (typeof value !== 'string') {
    return;
  }
  editing = { kind: 'entity', entity, value };
  positionLabelEditor(button, value, entityTextStyle(entity));
}

function startConnectionLabelEdit(button, index) {
  const connection = current?.document.connections[index];
  const value = connection?.label;
  if (typeof value !== 'string') {
    return;
  }
  editing = { kind: 'connection', index, value };
  positionLabelEditor(button, value, { fontSize: 11, textAlign: 'center' });
}

async function commitLabelEdit() {
  if (!editing) {
    return;
  }
  const edit = editing;
  const { value } = edit;
  const text = labelEditor.value.trim();
  closeLabelEditor();
  if (!text || text === value) {
    setStatus(`Revision ${current.revision} · Click text to edit`, 'ready');
    return;
  }
  setStatus('Updating label…', 'busy');
  try {
    await serializeMutation(async () => {
      const diagram = current;
      const args = { id: diagram.id, revision: diagram.revision };
      if (edit.kind === 'entity') {
        args.upsert = [labelUpdate(edit.entity, text)];
      } else {
        args.connections = diagram.document.connections.map((connection, index) =>
          index === edit.index ? { ...connection, label: text } : connection,
        );
      }
      show(await call('patch_diagram', args));
    });
  } catch (error) {
    setStatus(error.message, 'error');
  }
}

labelEditor.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeLabelEditor();
    setStatus(`Revision ${current.revision} · Click text to edit`, 'ready');
  } else if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    void commitLabelEdit();
  }
});
labelEditor.addEventListener('input', resizeLabelEditor);
labelEditor.addEventListener('blur', () => {
  if (editing) {
    void commitLabelEdit();
  }
});

async function move(entity, dx, dy, button, origin) {
  if (busy || (!dx && !dy)) {
    button.style.transform = '';
    button.classList.remove('dragging');
    origin?.remove();
    return;
  }
  busy = true;
  setStatus('Routing connectors…', 'busy');
  try {
    await serializeMutation(async () => {
      const diagram = current;
      const latest = diagram.document.entities.find(({ id }) => id === entity.id) ?? entity;
      show(await call('patch_diagram', {
        id: diagram.id,
        revision: diagram.revision,
        upsert: [
          {
            id: entity.id,
            x: Math.round(latest.x + dx),
            y: Math.round(latest.y + dy),
          },
        ],
      }));
    });
  } catch (error) {
    button.style.transform = '';
    button.classList.remove('dragging');
    origin?.remove();
    setStatus(error.message, 'error');
  } finally {
    busy = false;
    [...overlay.children]
      .find((item) => item.dataset?.nodeId === entity.id)
      ?.focus();
  }
}

function attachDrag(button, entity) {
  let pointer;
  let start;
  let dx = 0;
  let dy = 0;
  let frame;
  let origin;
  const paint = () => {
    frame = undefined;
    button.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
  };
  button.addEventListener('pointerdown', (event) => {
    if (busy || pointer !== undefined || event.button !== 0) {
      return;
    }
    event.stopPropagation();
    pointer = event.pointerId;
    start = { x: event.clientX, y: event.clientY };
    dx = 0;
    dy = 0;
    origin = document.createElement('div');
    origin.className = 'node-origin';
    origin.style.left = button.style.left;
    origin.style.top = button.style.top;
    origin.style.width = button.style.width;
    origin.style.height = button.style.height;
    overlay.insertBefore(origin, button);
    button.setPointerCapture(pointer);
    button.classList.add('dragging');
  });
  button.addEventListener('pointermove', (event) => {
    if (pointer !== event.pointerId) {
      return;
    }
    dx = (event.clientX - start.x) / view.scale;
    dy = (event.clientY - start.y) / view.scale;
    if (frame === undefined) {
      frame = requestAnimationFrame(paint);
    }
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    button.addEventListener(type, (event) => {
      if (pointer !== event.pointerId) {
        return;
      }
      pointer = undefined;
      if (frame !== undefined) {
        cancelAnimationFrame(frame);
        paint();
      }
      if (type !== 'pointerup') {
        button.style.transform = '';
        button.classList.remove('dragging');
        origin?.remove();
        return;
      }
      void move(entity, dx, dy, button, origin);
    });
  }
  button.addEventListener('keydown', (event) => {
    const distance = event.shiftKey ? 1 : 10;
    const delta = {
      ArrowUp: [0, -distance],
      ArrowDown: [0, distance],
      ArrowLeft: [-distance, 0],
      ArrowRight: [distance, 0],
    }[event.key];
    if (delta) {
      event.preventDefault();
      void move(entity, ...delta, button);
    }
  });
}

let panPointer;
let panStart;
viewport.addEventListener('pointerdown', (event) => {
  if (
    (event.button !== 0 && event.button !== 1) ||
    event.target.closest('button, .floating-panel, #status')
  ) {
    return;
  }
  panPointer = event.pointerId;
  panStart = { x: event.clientX, y: event.clientY, viewX: view.x, viewY: view.y };
  viewport.setPointerCapture(panPointer);
  viewport.classList.add('panning');
});
viewport.addEventListener('pointermove', (event) => {
  if (panPointer !== event.pointerId) {
    return;
  }
  view.x = panStart.viewX + event.clientX - panStart.x;
  view.y = panStart.viewY + event.clientY - panStart.y;
  applyView();
});
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  viewport.addEventListener(type, (event) => {
    if (panPointer !== event.pointerId) {
      return;
    }
    panPointer = undefined;
    viewport.classList.remove('panning');
  });
}
viewport.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      setScale(view.scale * Math.exp(-event.deltaY * 0.008), event.clientX, event.clientY);
      return;
    }
    view.x -= event.deltaX;
    view.y -= event.deltaY;
    applyView();
  },
  { passive: false },
);
viewport.addEventListener('keydown', (event) => {
  if (event.key === '+' || event.key === '=') {
    event.preventDefault();
    setScale(view.scale * 1.2);
  } else if (event.key === '-') {
    event.preventDefault();
    setScale(view.scale / 1.2);
  } else if (event.key === '0') {
    event.preventDefault();
    fitDiagram();
  }
});

zoomInButton.onclick = () => setScale(view.scale * 1.2);
zoomOutButton.onclick = () => setScale(view.scale / 1.2);
fitButton.onclick = () => fitDiagram();

function localDownload(url, name) {
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
}

async function downloadResource(resource) {
  if (app) {
    if (!app.getHostCapabilities()?.downloadFile) {
      setStatus('Downloads are unavailable in this Claude view.', 'error');
      return;
    }
    setStatus('Confirm the download in Claude…', 'busy');
    try {
      const result = await app.downloadFile(
        { contents: [{ type: 'resource', resource }] },
        { timeout: 600_000 },
      );
      setStatus(
        result.isError ? 'Download canceled.' : 'Download started.',
        result.isError ? 'error' : 'ready',
      );
    } catch (error) {
      setStatus(error.message || 'Download could not be started.', 'error');
    }
    return;
  }
  if (resource.blob) {
    const bytes = Uint8Array.from(atob(resource.blob), (character) =>
      character.charCodeAt(0),
    );
    const url = URL.createObjectURL(new Blob([bytes], { type: resource.mimeType }));
    localDownload(url, resource.uri.split('/').at(-1));
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return;
  }
  const url = URL.createObjectURL(
    new Blob([resource.text], { type: resource.mimeType }),
  );
  localDownload(url, resource.uri.split('/').at(-1));
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadJson() {
  return downloadResource({
    uri: 'file:///clouddraft.json',
    mimeType: 'application/json',
    text: JSON.stringify(current.document, null, 2),
  });
}

pngButton.onclick = () =>
  void downloadResource({
    uri: 'file:///clouddraft.png',
    mimeType: 'image/png',
    blob: current.png,
  });

jsonButton.onclick = () => {
  codeEditor.value = JSON.stringify(current.document, null, 2);
  codeError.textContent = '';
  codePanel.hidden = false;
  codeEditor.focus();
};
closeCodeButton.onclick = () => {
  codePanel.hidden = true;
  viewport.focus();
};
formatCodeButton.onclick = () => {
  try {
    codeEditor.value = JSON.stringify(JSON.parse(codeEditor.value), null, 2);
    codeError.textContent = '';
  } catch (error) {
    codeError.textContent = error.message;
  }
};
applyCodeButton.onclick = async () => {
  let document;
  try {
    document = JSON.parse(codeEditor.value);
    if (!Array.isArray(document.entities) || !Array.isArray(document.connections)) {
      throw new Error('JSON needs entities and connections arrays.');
    }
  } catch (error) {
    codeError.textContent = error.message;
    return;
  }
  codeError.textContent = '';
  applyCodeButton.disabled = true;
  setStatus('Applying JSON changes…', 'busy');
  try {
    await serializeMutation(async () => {
      const diagram = current;
      const nextIds = new Set(document.entities.map(({ id }) => id));
      const remove = diagram.document.entities
        .map(({ id }) => id)
        .filter((id) => !nextIds.has(id));
      const result = await call('edit_diagram', {
        id: diagram.id,
        revision: diagram.revision,
        theme: document.theme,
        upsert: document.entities,
        remove,
        connections: document.connections,
      });
      show(result);
      codeEditor.value = JSON.stringify(result.structuredContent.document, null, 2);
    });
  } catch (error) {
    codeError.textContent = error.message;
    setStatus(error.message, 'error');
  } finally {
    applyCodeButton.disabled = false;
  }
};
downloadJsonButton.onclick = () => void downloadJson();

function setTheme(theme, remember = false) {
  const activeTheme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = activeTheme;
  const activeThemeLabel = activeTheme === 'dark' ? 'Dark' : 'Light';
  const nextThemeLabel = activeTheme === 'dark' ? 'light' : 'dark';
  themeButton.setAttribute('aria-label', `${activeThemeLabel} theme. Switch to ${nextThemeLabel} theme`);
  themeButton.title = `${activeThemeLabel} theme · Switch to ${nextThemeLabel}`;
  if (remember) {
    manualTheme = true;
    try {
      localStorage.setItem('clouddraft-theme', theme);
    } catch {}
  }
  void syncDiagramTheme();
}

async function syncDiagramTheme() {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  const renderedTheme = current?.document.theme ?? 'light';
  if (!current || renderedTheme === theme || themeSyncing) {
    return;
  }
  themeSyncing = true;
  busy = true;
  setStatus(`Rendering ${theme} canvas…`, 'busy');
  try {
    await serializeMutation(async () => {
      if ((current.document.theme ?? 'light') === theme) return;
      const diagram = current;
      show(await call('edit_diagram', {
        id: diagram.id,
        revision: diagram.revision,
        theme,
      }));
    });
  } catch (error) {
    setStatus(error.message, 'error');
  } finally {
    themeSyncing = false;
    busy = false;
  }
}

let savedTheme;
try {
  savedTheme = localStorage.getItem('clouddraft-theme');
} catch {}
if (savedTheme === 'light' || savedTheme === 'dark') {
  manualTheme = true;
  setTheme(savedTheme);
} else {
  setTheme(matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}
themeButton.onclick = () => {
  setTheme(
    document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark',
    true,
  );
};

new ResizeObserver(() => {
  if (current && world.hidden === false) {
    applyView();
  }
}).observe(viewport);

if (app) {
  app.ontoolresult = (result) => void hydrate(result);
  app.onhostcontextchanged = (context) => {
    if (!manualTheme && context.theme) {
      setTheme(context.theme);
    }
  };
  app
    .connect()
    .then(() => {
      const hostTheme = app.getHostContext()?.theme;
      if (!manualTheme && hostTheme) {
        setTheme(hostTheme);
      }
    })
    .catch((error) => {
      setStatus(error.message, 'error');
    });
} else {
  sampleButton.hidden = false;
  const openExample = async () => {
    setStatus('Loading example…', 'busy');
    try {
      const example = await call('get_example', {
        name: 'predictive-maintenance.json',
      });
      show(
        await call('open_diagram', {
          document: {
            ...JSON.parse(example.structuredContent.source),
            theme: document.documentElement.dataset.theme,
          },
        }),
      );
    } catch (error) {
      setStatus(error.message, 'error');
    }
  };
  sampleButton.onclick = openExample;
  void openExample();
}
