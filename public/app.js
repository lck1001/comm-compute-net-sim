const state = {
  nodes: [],
  links: [],
  tasks: [],
  summary: {},
  selectedTaskId: null,
  selectedNodeId: null,
  priority: '中',
  mouse: { x: 0, y: 0, inside: false },
  nodeScreen: new Map(),
  tick: 0,
  lastFrame: 0
};

const el = {
  clock: document.querySelector('#clock'),
  nodeCount: document.querySelector('#nodeCount'),
  activeLinks: document.querySelector('#activeLinks'),
  avgUtil: document.querySelector('#avgUtil'),
  runningTasks: document.querySelector('#runningTasks'),
  onlineNodes: document.querySelector('#onlineNodes'),
  completeTasks: document.querySelector('#completeTasks'),
  rejectedTasks: document.querySelector('#rejectedTasks'),
  originSelect: document.querySelector('#originSelect'),
  computeInput: document.querySelector('#computeInput'),
  storageInput: document.querySelector('#storageInput'),
  dataInput: document.querySelector('#dataInput'),
  injectTask: document.querySelector('#injectTask'),
  taskList: document.querySelector('#taskList'),
  nodeDetail: document.querySelector('#nodeDetail'),
  linkRows: document.querySelector('#linkRows'),
  fragmentList: document.querySelector('#fragmentList'),
  traceTitle: document.querySelector('#traceTitle'),
  traceStatus: document.querySelector('#traceStatus'),
  hoverTip: document.querySelector('#hoverTip'),
  networkCanvas: document.querySelector('#networkCanvas'),
  traceCanvas: document.querySelector('#traceCanvas')
};

const ctx = el.networkCanvas.getContext('2d');
const traceCtx = el.traceCanvas.getContext('2d');

function byId(id) {
  return document.getElementById(id);
}

function fmt(value, digits = 0) {
  if (value === undefined || value === null || Number.isNaN(value)) return '--';
  return Number(value).toLocaleString('zh-CN', { maximumFractionDigits: digits });
}

function percent(value) {
  return `${Math.round((value || 0) * 100)}%`;
}

function selectedTask() {
  return state.tasks.find((task) => task.id === state.selectedTaskId) || state.tasks[0] || null;
}

function nodeById(id) {
  return state.nodes.find((node) => node.id === id);
}

function linkColor(link) {
  if (!link.active) return 'rgba(77, 91, 101, 0.22)';
  if (link.utilization > 0.78) return 'rgba(241, 127, 138, 0.62)';
  if (link.utilization > 0.52) return 'rgba(246, 196, 83, 0.52)';
  return 'rgba(112, 167, 255, 0.34)';
}

function resizeCanvas(canvas, context) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.floor(rect.width * dpr));
  const height = Math.max(1, Math.floor(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  return rect;
}

function updateSummary() {
  const s = state.summary || {};
  el.nodeCount.textContent = fmt(s.nodeCount);
  el.activeLinks.textContent = `${fmt(s.activeLinks)}/${fmt(s.totalLinks)}`;
  el.avgUtil.textContent = percent(s.avgUtilization);
  el.runningTasks.textContent = fmt(s.runningTasks);
  el.onlineNodes.textContent = `${fmt(s.onlineNodes)} 在线`;
  el.completeTasks.textContent = `${fmt(s.completeTasks)} 完成`;
  el.rejectedTasks.textContent = `${fmt(s.rejectedTasks)} 拒绝`;
  el.clock.textContent = `Tick ${fmt(state.tick)} · ${new Date().toLocaleTimeString('zh-CN')}`;
}

function renderOriginOptions() {
  const previous = el.originSelect.value;
  const interesting = state.nodes
    .filter((node) => node.status === 'online')
    .sort((a, b) => b.computeFree - a.computeFree)
    .slice(0, 55);
  el.originSelect.innerHTML = interesting
    .map((node) => `<option value="${node.id}">${node.id} · ${node.label}</option>`)
    .join('');
  if (interesting.some((node) => node.id === previous)) el.originSelect.value = previous;
}

function renderTaskList() {
  if (!state.tasks.length) {
    el.taskList.innerHTML = '<div class="empty-state">等待任务</div>';
    return;
  }
  if (!state.selectedTaskId) state.selectedTaskId = state.tasks[0].id;
  el.taskList.innerHTML = state.tasks
    .map((task) => {
      const statusClass = task.status === 'rejected' ? 'rejected' : task.status === 'complete' ? 'complete' : '';
      const progress = task.progress || 0;
      return `<article class="task-card ${task.id === state.selectedTaskId ? 'active' : ''}" data-task="${task.id}">
        <header><span>${task.id} · ${task.priority}</span><span class="status-pill ${statusClass}">${task.status}</span></header>
        <div class="progress"><i style="width:${Math.round(progress * 100)}%"></i></div>
        <div class="meta-row">
          <span>源 ${task.origin}</span>
          <span>${task.fragments.length} 片</span>
          <span>算力 ${fmt(task.demand.compute)}</span>
          <span>数据 ${fmt(task.demand.data)} MB</span>
        </div>
      </article>`;
    })
    .join('');

  el.taskList.querySelectorAll('[data-task]').forEach((card) => {
    card.addEventListener('click', () => {
      state.selectedTaskId = card.dataset.task;
      renderTaskList();
      renderTrace();
    });
  });
}

function renderNodeDetail(node) {
  if (!node) {
    el.nodeDetail.innerHTML = '<div class="empty-state">选择或悬停节点</div>';
    return;
  }
  const active = state.links.filter((link) => link.active && (link.a === node.id || link.b === node.id));
  const avgLatency = active.length ? active.reduce((sum, link) => sum + link.latency, 0) / active.length : 0;
  el.nodeDetail.innerHTML = `<article class="detail-card">
    <h3>${node.id}</h3>
    <div class="detail-list">
      <span><b>类型</b><em>${node.label}</em></span>
      <span><b>区域</b><em>${node.zone}</em></span>
      <span><b>状态</b><em>${node.status}</em></span>
      <span><b>剩余算力</b><em>${fmt(node.computeFree)} / ${fmt(node.computeTotal)}</em></span>
      <span><b>剩余存储</b><em>${fmt(node.storageFree)} / ${fmt(node.storageTotal)}</em></span>
      <span><b>链路数</b><em>${active.length}</em></span>
      <span><b>平均时延</b><em>${fmt(avgLatency)} ms</em></span>
      <span><b>收/发</b><em>${fmt(node.rxMbps)} / ${fmt(node.txMbps)} Mbps</em></span>
    </div>
  </article>`;
}

function renderLinksTable() {
  const rows = [...state.links]
    .sort((a, b) => Number(b.active) - Number(a.active) || b.utilization - a.utilization)
    .slice(0, 160);
  el.linkRows.innerHTML = rows
    .map((link) => `<tr>
      <td>${link.id}</td>
      <td>${link.a} ⇄ ${link.b}</td>
      <td>${fmt(link.bandwidth)}</td>
      <td>${fmt(link.latency)}</td>
      <td>${fmt(link.loss, 2)}</td>
      <td>${percent(link.utilization)}</td>
      <td>${link.active ? '在线' : '中断'}</td>
    </tr>`)
    .join('');
}

function renderFragments(task) {
  if (!task) {
    el.fragmentList.innerHTML = '';
    return;
  }
  el.fragmentList.innerHTML = task.fragments
    .map((fragment) => `<article class="fragment-card">
      <header><span>${fragment.id} → ${fragment.nodeId}</span><span>${Math.round((fragment.progress || 0) * 100)}%</span></header>
      <div class="progress"><i style="width:${Math.round((fragment.progress || 0) * 100)}%"></i></div>
      <div class="meta-row">
        <span>${fragment.stage}</span>
        <span>${fragment.path.join(' → ')}</span>
        <span>${fmt(fragment.compute)} 算力</span>
        <span>${fmt(fragment.latency)} ms</span>
      </div>
    </article>`)
    .join('');
}

function updateHover(rect) {
  if (!state.mouse.inside) {
    el.hoverTip.classList.add('hidden');
    renderNodeDetail(nodeById(state.selectedNodeId));
    return;
  }
  let nearest = null;
  let nearestDistance = Infinity;
  for (const [id, point] of state.nodeScreen.entries()) {
    const d = Math.hypot(point.x - state.mouse.x, point.y - state.mouse.y);
    if (d < nearestDistance) {
      nearest = { id, point };
      nearestDistance = d;
    }
  }
  if (!nearest || nearestDistance > 13) {
    el.hoverTip.classList.add('hidden');
    return;
  }
  const node = nodeById(nearest.id);
  if (!node) return;
  el.hoverTip.classList.remove('hidden');
  el.hoverTip.style.left = `${Math.min(rect.width - 210, nearest.point.x + 14)}px`;
  el.hoverTip.style.top = `${Math.max(8, nearest.point.y - 32)}px`;
  el.hoverTip.innerHTML = `<b>${node.id}</b><br>${node.label} · ${node.status}<br>算力 ${fmt(node.computeFree)}/${fmt(node.computeTotal)}<br>收/发 ${fmt(node.rxMbps)}/${fmt(node.txMbps)} Mbps`;
  renderNodeDetail(node);
}

function drawBackground(context, rect) {
  context.clearRect(0, 0, rect.width, rect.height);
  context.fillStyle = '#081015';
  context.fillRect(0, 0, rect.width, rect.height);
  context.strokeStyle = 'rgba(58, 75, 86, 0.22)';
  context.lineWidth = 1;
  const grid = 48;
  for (let x = 0; x < rect.width; x += grid) {
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, rect.height);
    context.stroke();
  }
  for (let y = 0; y < rect.height; y += grid) {
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(rect.width, y);
    context.stroke();
  }
}

function toScreen(node, rect) {
  const pad = 28;
  return {
    x: pad + node.x * (rect.width - pad * 2),
    y: pad + node.y * (rect.height - pad * 2)
  };
}

function drawTopology(time = 0) {
  const rect = resizeCanvas(el.networkCanvas, ctx);
  drawBackground(ctx, rect);
  state.nodeScreen.clear();
  for (const node of state.nodes) state.nodeScreen.set(node.id, toScreen(node, rect));

  ctx.save();
  for (const link of state.links) {
    const a = state.nodeScreen.get(link.a);
    const b = state.nodeScreen.get(link.b);
    if (!a || !b) continue;
    ctx.globalAlpha = link.active ? 1 : 0.45;
    ctx.strokeStyle = linkColor(link);
    ctx.lineWidth = link.active ? Math.max(0.6, link.utilization * 2.8) : 0.6;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();

    if (link.active && link.utilization > 0.42) {
      const t = (time / 1200 + link.utilization + link.id.charCodeAt(2) * 0.01) % 1;
      const px = a.x + (b.x - a.x) * t;
      const py = a.y + (b.y - a.y) * t;
      ctx.fillStyle = link.utilization > 0.78 ? '#f17f8a' : '#41d6a6';
      ctx.beginPath();
      ctx.arc(px, py, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();

  const task = selectedTask();
  if (task?.fragments?.length) {
    ctx.save();
    for (const fragment of task.fragments) {
      const p = fragment.progress || 0;
      for (let i = 0; i < fragment.path.length - 1; i += 1) {
        const a = state.nodeScreen.get(fragment.path[i]);
        const b = state.nodeScreen.get(fragment.path[i + 1]);
        if (!a || !b) continue;
        ctx.strokeStyle = 'rgba(65, 214, 166, 0.85)';
        ctx.lineWidth = 2.4;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        const hopProgress = Math.min(1, Math.max(0, p * fragment.path.length - i));
        const px = a.x + (b.x - a.x) * hopProgress;
        const py = a.y + (b.y - a.y) * hopProgress;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(px, py, 3.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  for (const node of state.nodes) {
    const point = state.nodeScreen.get(node.id);
    if (!point) continue;
    const base = node.type === 'Core' ? 6.8 : node.type === 'Edge' ? 5.2 : 3.8;
    const ring = base + (node.txMbps + node.rxMbps > 0 ? Math.sin(time / 180 + node.pulse * 6.28) * 2 + 5 : 0);
    ctx.fillStyle = node.status === 'online' ? node.color : '#58656c';
    ctx.strokeStyle = node.status === 'online' ? 'rgba(255,255,255,0.7)' : 'rgba(180,190,190,0.32)';
    ctx.lineWidth = state.selectedNodeId === node.id ? 2.4 : 1;
    if (ring > base) {
      ctx.fillStyle = `${node.color}33`;
      ctx.beginPath();
      ctx.arc(point.x, point.y, ring, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = node.color;
    }
    ctx.beginPath();
    ctx.arc(point.x, point.y, base, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  updateHover(rect);
}

function renderTrace() {
  const task = selectedTask();
  const rect = resizeCanvas(el.traceCanvas, traceCtx);
  drawBackground(traceCtx, rect);
  if (!task) {
    el.traceTitle.textContent = '暂无任务';
    el.traceStatus.textContent = '等待调度';
    renderFragments(null);
    return;
  }
  el.traceTitle.textContent = `${task.id} · ${task.origin} 发起`;
  el.traceStatus.textContent = task.status;
  renderFragments(task);

  const lanes = Math.max(1, Math.min(task.fragments.length, 8));
  const top = 48;
  const bottom = rect.height - 42;
  const left = 70;
  const right = rect.width - 70;
  traceCtx.lineWidth = 1;
  traceCtx.font = '12px Segoe UI, sans-serif';

  task.fragments.slice(0, 8).forEach((fragment, index) => {
    const y = top + (bottom - top) * (index + 0.5) / lanes;
    const steps = fragment.path.length;
    traceCtx.strokeStyle = 'rgba(112, 167, 255, 0.35)';
    traceCtx.beginPath();
    traceCtx.moveTo(left, y);
    traceCtx.lineTo(right, y);
    traceCtx.stroke();

    fragment.path.forEach((nodeId, hop) => {
      const x = steps === 1 ? left : left + (right - left) * hop / (steps - 1);
      const node = nodeById(nodeId);
      traceCtx.fillStyle = node?.color || '#cfd9d8';
      traceCtx.beginPath();
      traceCtx.arc(x, y, hop === 0 ? 7 : 6, 0, Math.PI * 2);
      traceCtx.fill();
      traceCtx.fillStyle = '#cbd6d5';
      traceCtx.fillText(nodeId, x - 18, y - 14);
    });

    const p = fragment.progress || 0;
    const packetX = left + (right - left) * p;
    traceCtx.fillStyle = '#ffffff';
    traceCtx.beginPath();
    traceCtx.arc(packetX, y, 4, 0, Math.PI * 2);
    traceCtx.fill();
    traceCtx.fillStyle = '#98a7a6';
    traceCtx.fillText(fragment.id, 12, y + 4);
  });
}

function renderAll() {
  updateSummary();
  renderOriginOptions();
  renderTaskList();
  renderLinksTable();
  renderTrace();
}

function applyState(payload) {
  state.nodes = payload.nodes || [];
  state.links = payload.links || [];
  state.tasks = payload.tasks || [];
  state.summary = payload.summary || {};
  state.tick = payload.tick || 0;
  if (!state.selectedTaskId && state.tasks.length) state.selectedTaskId = state.tasks[0].id;
  if (state.selectedTaskId && !state.tasks.some((task) => task.id === state.selectedTaskId)) state.selectedTaskId = state.tasks[0]?.id || null;
  renderAll();
}

function connectEvents() {
  const events = new EventSource('/api/events');
  events.addEventListener('state', (event) => applyState(JSON.parse(event.data)));
  events.addEventListener('task', (event) => {
    const task = JSON.parse(event.data);
    state.selectedTaskId = task.id;
  });
  events.onerror = () => {
    el.clock.textContent = '实时连接中断，正在重连';
  };
}

async function injectTask() {
  const payload = {
    origin: el.originSelect.value,
    compute: Number(el.computeInput.value),
    storage: Number(el.storageInput.value),
    data: Number(el.dataInput.value),
    priority: state.priority
  };
  el.injectTask.disabled = true;
  try {
    const res = await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const task = await res.json();
    state.selectedTaskId = task.id;
  } finally {
    el.injectTask.disabled = false;
  }
}

function bindEvents() {
  document.querySelectorAll('.segmented button').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.segmented button').forEach((btn) => btn.classList.remove('active'));
      button.classList.add('active');
      state.priority = button.dataset.priority;
    });
  });

  document.querySelectorAll('.tabs button').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.tabs button').forEach((btn) => btn.classList.remove('active'));
      document.querySelectorAll('.view').forEach((view) => view.classList.remove('active'));
      button.classList.add('active');
      byId(`${button.dataset.view}View`).classList.add('active');
      renderTrace();
    });
  });

  el.injectTask.addEventListener('click', injectTask);
  el.networkCanvas.addEventListener('mousemove', (event) => {
    const rect = el.networkCanvas.getBoundingClientRect();
    state.mouse = { x: event.clientX - rect.left, y: event.clientY - rect.top, inside: true };
  });
  el.networkCanvas.addEventListener('mouseleave', () => {
    state.mouse.inside = false;
    el.hoverTip.classList.add('hidden');
  });
  el.networkCanvas.addEventListener('click', () => {
    let nearest = null;
    let nearestDistance = Infinity;
    for (const [id, point] of state.nodeScreen.entries()) {
      const d = Math.hypot(point.x - state.mouse.x, point.y - state.mouse.y);
      if (d < nearestDistance) {
        nearest = id;
        nearestDistance = d;
      }
    }
    if (nearest && nearestDistance < 14) {
      state.selectedNodeId = nearest;
      renderNodeDetail(nodeById(nearest));
    }
  });

  window.addEventListener('resize', () => {
    renderTrace();
  });
}

function animate(time) {
  if (!state.lastFrame || time - state.lastFrame > 16) {
    drawTopology(time);
    const traceView = byId('traceView');
    if (traceView.classList.contains('active')) renderTrace();
    state.lastFrame = time;
  }
  requestAnimationFrame(animate);
}

async function initialLoad() {
  const res = await fetch('/api/state');
  applyState(await res.json());
}

bindEvents();
initialLoad().then(connectEvents);
requestAnimationFrame(animate);
