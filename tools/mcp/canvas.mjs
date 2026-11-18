import { App } from '@modelcontextprotocol/ext-apps';

const stage = document.querySelector('#stage');
const status = document.querySelector('#status');
const image = document.querySelector('#diagram');
const overlay = document.querySelector('#nodes');
const pngButton = document.querySelector('#png');
const jsonButton = document.querySelector('#json');
const local = window.parent === window;
const app = local ? null : new App({ name: 'CloudDraft', version: '0.1.0' });
let current;
let busy = false;

async function call(name, args) {
  const result = app
    ? await app.callServerTool({ name, arguments: args })
    : await fetch('/tool', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, args }),
      }).then((response) => response.json());
  if (result.isError) throw new Error(result.content[0]?.text ?? 'Tool failed');
  return result;
}

function show(result) {
  const data = result.structuredContent;
  const png = result._meta?.png;
  if (result.isError) {
    status.textContent = result.content[0]?.text ?? 'Could not render diagram.';
    return;
  }
  if (!data?.layout?.scene || !png) return;
  if (current?.id === data.id && current.revision > data.revision) return;
  current = { ...data, png };
  const { scene, entities } = data.layout;
  stage.hidden = false;
  stage.style.aspectRatio = `${scene.width} / ${scene.height}`;
  image.src = `data:image/png;base64,${png}`;
  pngButton.disabled = jsonButton.disabled = false;
  overlay.replaceChildren();
  for (const entity of entities) {
    if (
      !entity.id ||
      !entity.width ||
      !entity.height ||
      ['Group', 'Lane', 'Pool', 'Textbox'].includes(entity.tag)
    )
      continue;
    const button = document.createElement('button');
    button.type = 'button';
    const label = entity.texts?.[0]?.text ?? entity.id;
    button.setAttribute('aria-label', `Move ${label}`);
    button.dataset.nodeId = entity.id;
    button.style.left = `${((entity.x - scene.x) / scene.width) * 100}%`;
    button.style.top = `${((entity.y - scene.y) / scene.height) * 100}%`;
    button.style.width = `${(entity.width / scene.width) * 100}%`;
    button.style.height = `${(entity.height / scene.height) * 100}%`;
    attachDrag(button, entity);
    overlay.append(button);
  }
  status.textContent = `Revision ${data.revision} · Drag a node or use its arrow keys.`;
  if (app)
    void app
      .updateModelContext({
        content: [
          {
            type: 'text',
            text: `CloudDraft diagram ${data.id}, revision ${data.revision}. Use get_diagram to retrieve its latest source before editing.`,
          },
        ],
      })
      .catch(() => {});
}

async function move(entity, dx, dy) {
  if (busy || (!dx && !dy)) return;
  busy = true;
  const diagram = current;
  const original = diagram.document.entities.find(({ id }) => id === entity.id);
  if (!original) {
    busy = false;
    return;
  }
  status.textContent = 'Routing connectors…';
  try {
    show(
      await call('edit_diagram', {
        id: diagram.id,
        revision: diagram.revision,
        upsert: [
          {
            id: entity.id,
            x: Math.round(entity.x + dx),
            y: Math.round(entity.y + dy),
          },
        ],
      }),
    );
  } catch (error) {
    status.textContent = error.message;
  } finally {
    busy = false;
    [...overlay.children]
      .find((button) => button.dataset.nodeId === entity.id)
      ?.focus();
  }
}

function attachDrag(button, entity) {
  let pointer;
  let start;
  let dx = 0;
  let dy = 0;
  button.addEventListener('pointerdown', (event) => {
    if (busy || pointer !== undefined || event.button !== 0) return;
    pointer = event.pointerId;
    start = { x: event.clientX, y: event.clientY };
    dx = dy = 0;
    button.setPointerCapture(pointer);
    button.classList.add('dragging');
  });
  button.addEventListener('pointermove', (event) => {
    if (pointer !== event.pointerId) return;
    dx = event.clientX - start.x;
    dy = event.clientY - start.y;
    button.style.transform = `translate(${dx}px,${dy}px)`;
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    button.addEventListener(type, (event) => {
      if (pointer !== event.pointerId) return;
      pointer = undefined;
      button.style.transform = '';
      button.classList.remove('dragging');
      if (type !== 'pointerup') return;
      const bounds = stage.getBoundingClientRect();
      const { scene } = current.layout;
      void move(
        entity,
        Math.round((dx * scene.width) / bounds.width),
        Math.round((dy * scene.height) / bounds.height),
      );
    });
  }
  button.addEventListener('keydown', (event) => {
    const delta = {
      ArrowUp: [0, -10],
      ArrowDown: [0, 10],
      ArrowLeft: [-10, 0],
      ArrowRight: [10, 0],
    }[event.key];
    if (delta) {
      event.preventDefault();
      void move(entity, ...delta);
    }
  });
}

function download(url, name) {
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
}
pngButton.onclick = () => download(image.src, 'clouddraft.png');
jsonButton.onclick = () => {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(current.document, null, 2)], {
      type: 'application/json',
    }),
  );
  download(url, 'clouddraft.json');
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

if (app) {
  app.ontoolresult = show;
  app.connect().catch((error) => {
    status.textContent = error.message;
  });
} else {
  document.querySelector('#sample').hidden = false;
  const open = async () => {
    try {
      const example = await call('get_example', {
        name: 'multi-cloud.eraserdiagram',
      });
      show(
        await call('open_diagram', {
          source: example.structuredContent.source,
        }),
      );
    } catch (error) {
      status.textContent = error.message;
    }
  };
  document.querySelector('#sample').onclick = open;
  void open();
}
