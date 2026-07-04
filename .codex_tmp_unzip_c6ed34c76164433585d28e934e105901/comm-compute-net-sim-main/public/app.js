const state = {
  nodes: [],
  links: [],
  tasks: [],
  summary: {},
  selectedTaskId: null,
  selectedNodeId: null,
  popupNodeId: null,
  popupRenderKey: null,
  originOptionsKey: null,
  priority: '中',
  paused: false,
  linkRadius: 0.55,
  popupHovered: false,
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
  nodeTypeBreakdown: document.querySelector('#nodeTypeBreakdown'),
  onlineNodes: document.querySelector('#onlineNodes'),
  completeTasks: document.querySelector('#completeTasks'),
  rejectedTasks: document.querySelector('#rejectedTasks'),
  originSelect: document.querySelector('#originSelect'),
  computeInput: document.querySelector('#computeInput'),
  storageInput: document.querySelector('#storageInput'),
  dataInput: document.querySelector('#dataInput'),
  splitStrategy: document.querySelector('#splitStrategy'),
  injectTask: document.querySelector('#injectTask'),
  injectStatus: document.querySelector('#injectStatus'),
  nodeCountInput: document.querySelector('#nodeCountInput'),
  edgeCountInput: document.querySelector('#edgeCountInput'),
  linkRadiusInput: document.querySelector('#linkRadiusInput'),
  resetSim: document.querySelector('#resetSim'),
  togglePause: document.querySelector('#togglePause'),
  taskList: document.querySelector('#taskList'),
  linkRows: document.querySelector('#linkRows'),
  fragmentList: document.querySelector('#fragmentList'),
  traceTitle: document.querySelector('#traceTitle'),
  traceStatus: document.querySelector('#traceStatus'),
  hoverTip: document.querySelector('#hoverTip'),
  nodePopup: document.querySelector('#nodePopup'),
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

function splitLabel(strategy) {
  return strategy === 'resourceWeighted' ? '资源权重' : '默认均分';
}

function linkRoleLabel(role) {
  const labels = {
    'terminal-edge': '端-边主链路',
    'edge-cloud': '边-云主链路',
    'edge-mesh': '边缘互联',
    'terminal-peer': '终端邻近',
    'terminal-cloud-exception': '端-云弹性'
  };
  return labels[role] || '灵活链路';
}

function selectedTask() {
  return state.tasks.find((task) => task.id === state.selectedTaskId) || state.tasks[0] || null;
}

function nodeById(id) {
  return state.nodes.find((node) => node.id === id);
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
  const types = s.nodeTypes || {};
  el.nodeTypeBreakdown.textContent = `云 ${fmt(types.Cloud || 0)} · 边 ${fmt(types.Edge || 0)}/${fmt(s.edgeLimit || 0)} · 端 ${fmt(types.Terminal || 0)}`;
  el.onlineNodes.textContent = `${fmt(s.onlineNodes)} 在线`;
  el.completeTasks.textContent = `${fmt(s.completeTasks)} 完成`;
  el.rejectedTasks.textContent = `${fmt(s.rejectedTasks)} 拒绝`;
  el.clock.textContent = `Tick ${fmt(state.tick)} · ${new Date().toLocaleTimeString('zh-CN')}`;
}

function renderOriginOptions() {
  const previous = el.originSelect.value;
  const signature = state.nodes.map((node) => `${node.id}:${node.type}:${node.label}`).join('|');
  if (signature === state.originOptionsKey) {
    if (state.nodes.some((node) => node.id === previous)) el.originSelect.value = previous;
    return;
  }
  state.originOptionsKey = signature;
  const interesting = [...state.nodes]
    .sort((a, b) => a.type.localeCompare(b.type) || a.id.localeCompare(b.id));
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
          <span>${splitLabel(task.splitStrategy)}</span>
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

function renderNodePopup(node, point, rect) {
  if (!node || !point) {
    el.nodePopup.classList.add('hidden');
    state.popupRenderKey = null;
    return;
  }
  const active = state.links.filter((link) => link.active && (link.a === node.id || link.b === node.id));
  const totalLinkBandwidth = active.reduce((sum, link) => sum + link.bandwidth, 0);
  const avgCapacity = active.length ? active.reduce((sum, link) => sum + link.bandwidth * (1 - link.utilization), 0) / active.length : 0;
  // Position popup away from node to avoid blocking canvas mousemove
  const popupW = 276, popupH = 244, gap = 18;
  const nodeRadius = node.type === 'Cloud' ? 10 : node.type === 'Edge' ? 8 : 6;
  const flipX = point.x > rect.width * 0.5;
  const flipY = point.y > rect.height * 0.55;
  const left = flipX
    ? Math.max(8, point.x - popupW - nodeRadius - gap)
    : Math.min(rect.width - popupW - 8, point.x + nodeRadius + gap);
  const top = flipY
    ? Math.max(8, point.y - popupH - nodeRadius - gap)
    : Math.min(rect.height - popupH - 8, point.y + nodeRadius + gap);
  el.nodePopup.style.left = `${left}px`;
  el.nodePopup.style.top = `${top}px`;
  const renderKey = [
    node.id,
    node.status,
    node.computeFree,
    node.storageFree,
    Math.round(totalLinkBandwidth),
    Math.round(avgCapacity)
  ].join('|');
  if (state.popupRenderKey === renderKey) {
    el.nodePopup.classList.remove('hidden');
    return;
  }
  state.popupRenderKey = renderKey;
  el.nodePopup.innerHTML = `<header>
      <div><b>${node.id}</b><span>${node.label}</span></div>
      <button type="button" data-close-popup aria-label="close">×</button>
    </header>
    <div class="popup-grid">
      <span><b>节点编号</b><em>${node.id}</em></span>
      <span><b>节点类型</b><em>${node.label}</em></span>
      <span><b>剩余算力</b><em>${fmt(node.computeFree)} / ${fmt(node.computeTotal)}</em></span>
      <span><b>剩余存储</b><em>${fmt(node.storageFree)} / ${fmt(node.storageTotal)}</em></span>
      <span><b>通信容量</b><em>${fmt(avgCapacity)} Mbps</em></span>
      <span><b>所在链路容量</b><em>${fmt(totalLinkBandwidth)} Mbps</em></span>
    </div>`;
  el.nodePopup.classList.remove('hidden');
}

function renderLinksTable() {
  const rows = [...state.links]
    .sort((a, b) => Number(b.active) - Number(a.active) || b.utilization - a.utilization)
    .slice(0, 160);
  el.linkRows.innerHTML = rows
    .map((link) => `<tr>
      <td>${link.id}</td>
      <td>${link.a} ⇄ ${link.b}</td>
      <td>${linkRoleLabel(link.role)}</td>
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

function nodeHitRadius(node) {
  return node.type === 'Cloud' ? 22 : node.type === 'Edge' ? 18 : 15;
}

function updateHover(rect) {
  if (!state.mouse.inside) {
    el.hoverTip.classList.add('hidden');
    el.nodePopup.classList.add('hidden');
    state.popupNodeId = null;
    state.popupRenderKey = null;
    state._hoveredNodeId = null;

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
  // Hysteresis: easier to stay on current node than to leave it
  const currentRadius = state._hoveredNodeId ? nodeHitRadius(nodeById(state._hoveredNodeId)) + 6 : 0;
  const enterThreshold = nearest ? nodeHitRadius(nodeById(nearest.id)) : 15;
  const effectiveThreshold = (state._hoveredNodeId && nearest?.id === state._hoveredNodeId) ? currentRadius : enterThreshold;

  if (!nearest || nearestDistance > effectiveThreshold) {
    el.hoverTip.classList.add('hidden');
    if (!state.popupHovered) {
      el.nodePopup.classList.add('hidden');
      state.popupNodeId = null;
      state.popupRenderKey = null;
      state._hoveredNodeId = null;
    }

    return;
  }
  const node = nodeById(nearest.id);
  if (!node) return;
  el.hoverTip.classList.add('hidden');
  state._hoveredNodeId = nearest.id;
  state.popupNodeId = nearest.id;
  renderNodePopup(node, nearest.point, rect);
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
  // Interpolate between previous and current position for smooth motion
  const elapsed = performance.now() - (state._lastStateAt || 0);
  const t = Math.min(1, elapsed / 900); // 900ms blend matching server tick
  const sx = node._prevX !== undefined ? node._prevX + (node.x - node._prevX) * t : node.x;
  const sy = node._prevY !== undefined ? node._prevY + (node.y - node._prevY) * t : node.y;
  return {
    x: pad + sx * (rect.width - pad * 2),
    y: pad + sy * (rect.height - pad * 2)
  };
}

function drawTopology(time = 0) {
  const rect = resizeCanvas(el.networkCanvas, ctx);
  drawBackground(ctx, rect);
  state.nodeScreen.clear();
  for (const node of state.nodes) state.nodeScreen.set(node.id, toScreen(node, rect));

  ctx.save();
  const hoveredNode = state.popupNodeId;
  for (const link of state.links) {
    const a = state.nodeScreen.get(link.a);
    const b = state.nodeScreen.get(link.b);
    if (!a || !b) continue;
    const connected = hoveredNode && (link.a === hoveredNode || link.b === hoveredNode);
    const linkAlpha = hoveredNode ? (connected ? 0.55 : 0.08) : 0.25;
    ctx.globalAlpha = linkAlpha;
    ctx.strokeStyle = connected ? '#ffffff' : '#5e7a8a';
    ctx.lineWidth = connected ? 1.6 : 0.9;
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();

    // Flow particles colored by sending node type
    if (link.active && (!hoveredNode || connected)) {
      const sender = nodeById(link.a);
      const particleColor = sender?.color || '#70a7ff';
      const t = (time / 1400 + link.id.charCodeAt(2) * 0.013) % 1;
      const px = a.x + (b.x - a.x) * t;
      const py = a.y + (b.y - a.y) * t;
      ctx.globalAlpha = connected ? 0.9 : 0.55;
      ctx.fillStyle = particleColor;
      ctx.shadowColor = particleColor;
      ctx.shadowBlur = connected ? 8 : 5;
      ctx.beginPath();
      ctx.arc(px, py, connected ? 2.6 : 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.shadowBlur = 0;
  ctx.restore();

  // Draw potential connections for hovered node (within linkRadius, no materialized link)
  if (hoveredNode) {
    const hovered = state.nodes.find((n) => n.id === hoveredNode);
    if (hovered) {
      const materialized = new Set();
      for (const link of state.links) {
        if (link.a === hoveredNode) materialized.add(link.b);
        if (link.b === hoveredNode) materialized.add(link.a);
      }
      ctx.save();
      for (const node of state.nodes) {
        if (node.id === hoveredNode || materialized.has(node.id)) continue;
        const dx = node.x - hovered.x;
        const dy = node.y - hovered.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > state.linkRadius) continue;
        const a = state.nodeScreen.get(hoveredNode);
        const b = state.nodeScreen.get(node.id);
        if (!a || !b) continue;
        ctx.globalAlpha = 0.28;
        ctx.strokeStyle = '#70a7ff';
        ctx.lineWidth = 1;
        ctx.setLineDash([5, 8]);
        ctx.shadowColor = 'rgba(112, 167, 255, 0.25)';
        ctx.shadowBlur = 6;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.shadowBlur = 0;
      ctx.restore();
    }
  }

  const task = selectedTask();
  if (task?.fragments?.length) {
    ctx.save();
    for (const fragment of task.fragments) {
      const p = fragment.progress || 0;
      for (let i = 0; i < fragment.path.length - 1; i += 1) {
        const a = state.nodeScreen.get(fragment.path[i]);
        const b = state.nodeScreen.get(fragment.path[i + 1]);
        if (!a || !b) continue;
        const sender = nodeById(fragment.path[i]);
        const hopColor = sender?.color || '#70a7ff';
        ctx.globalAlpha = 0.55;
        ctx.strokeStyle = hopColor;
        ctx.shadowColor = hopColor;
        ctx.shadowBlur = 8;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        const hopProgress = Math.min(1, Math.max(0, p * fragment.path.length - i));
        const px = a.x + (b.x - a.x) * hopProgress;
        const py = a.y + (b.y - a.y) * hopProgress;
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = hopColor;
        ctx.shadowColor = hopColor;
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.arc(px, py, 3.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  for (const node of state.nodes) {
    const point = state.nodeScreen.get(node.id);
    if (!point) continue;
    const base = node.type === 'Cloud' ? 7.6 : node.type === 'Edge' ? 5.5 : 3.8;
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
  // Position interpolation: save previous coords for smooth transition
  const now = performance.now();
  const prevNodes = state.nodes;
  const newNodes = payload.nodes || [];
  if (prevNodes.length && newNodes.length) {
    const prevMap = new Map(prevNodes.map((n) => [n.id, n]));
    for (const node of newNodes) {
      const prev = prevMap.get(node.id);
      if (prev) {
        node._prevX = prev.x;
        node._prevY = prev.y;
      } else {
        node._prevX = node.x;
        node._prevY = node.y;
      }
    }
  } else {
    for (const node of newNodes) {
      node._prevX = node.x;
      node._prevY = node.y;
    }
  }
  state._lastStateAt = now;

  state.nodes = newNodes;
  state.links = payload.links || [];
  state.tasks = payload.tasks || [];
  state.summary = payload.summary || {};
  state.tick = payload.tick || 0;
  state.paused = payload.paused || false;
  el.togglePause.textContent = state.paused ? '▶ 恢复' : '⏸ 暂停';
  el.togglePause.style.background = state.paused ? '#41d6a6' : '#f6c453';
  if (payload.summary) {
    el.edgeCountInput.max = payload.summary.maxEdgeLimit || Math.floor((payload.summary.nodeCount || 200) / 3);
    if (!el.edgeCountInput.value || Number(el.edgeCountInput.value) > Number(el.edgeCountInput.max)) {
      el.edgeCountInput.value = payload.summary.edgeLimit || Math.min(66, el.edgeCountInput.max);
    }
    if (payload.summary.linkRadius !== undefined) {
      state.linkRadius = payload.summary.linkRadius;
    }
  }
  if (!state.selectedTaskId && state.tasks.length) state.selectedTaskId = state.tasks[0].id;
  if (state.selectedTaskId && !state.tasks.some((task) => task.id === state.selectedTaskId)) state.selectedTaskId = state.tasks[0]?.id || null;
  if (state.popupNodeId && !state.nodes.some((node) => node.id === state.popupNodeId)) state.popupNodeId = null;
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
    priority: state.priority,
    splitStrategy: el.splitStrategy?.value || 'equal'
  };
  el.injectTask.disabled = true;
  el.injectStatus.classList.add('hidden');
  try {
    const res = await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const task = await res.json();
    state.selectedTaskId = task.id;
    // Show result feedback
    el.injectStatus.classList.remove('hidden');
    if (task.accepted) {
      el.injectStatus.className = 'inject-status accepted';
      el.injectStatus.textContent = `✓ 任务 ${task.id} 已接受 · ${task.fragments.length} 个分片 · ${task.splitStrategy === 'resourceWeighted' ? '资源权重' : '默认均分'}`;
      // Auto-switch to topology view to see task paths
      const topoTab = document.querySelector('[data-view="topology"]');
      const traceTab = document.querySelector('[data-view="trace"]');
      if (topoTab && traceTab) {
        document.querySelectorAll('.tabs button').forEach((btn) => btn.classList.remove('active'));
        document.querySelectorAll('.view').forEach((view) => view.classList.remove('active'));
        topoTab.classList.add('active');
        document.querySelector('#topologyView').classList.add('active');
      }
    } else {
      el.injectStatus.className = 'inject-status rejected';
      el.injectStatus.textContent = `✗ 任务 ${task.id} 被拒绝 · ${task.message}`;
    }
    // Auto-hide after 6s
    clearTimeout(state._injectTimeout);
    state._injectTimeout = setTimeout(() => el.injectStatus.classList.add('hidden'), 6000);
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

  async function resetSimulation() {
    const nodeCount = Number(el.nodeCountInput.value);
    if (!Number.isFinite(nodeCount) || nodeCount < 3 || nodeCount > 2000) {
      alert('节点数量需在 3-2000 之间');
      return;
    }
    const edgeCount = Number(el.edgeCountInput.value);
    const maxEdge = Math.floor(nodeCount / 3);
    if (!Number.isFinite(edgeCount) || edgeCount < 3 || edgeCount > maxEdge) {
      alert(`边缘节点数量需在 3-${maxEdge} 之间`);
      return;
    }
    const linkRadius = Number(el.linkRadiusInput.value);
    if (!Number.isFinite(linkRadius) || linkRadius < 0.1 || linkRadius > 1.5) {
      alert('链路半径需在 0.1-1.5 之间');
      return;
    }
    el.resetSim.disabled = true;
    try {
      const res = await fetch('/api/reset', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nodeCount, edgeCount, linkRadius })
      });
      if (res.ok) {
        const payload = await res.json();
        applyState(payload);
      } else {
        const err = await res.json();
        alert(err.message || '重置失败');
      }
    } finally {
      el.resetSim.disabled = false;
    }
  }

  async function togglePause() {
    el.togglePause.disabled = true;
    try {
      const res = await fetch('/api/pause', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paused: !state.paused })
      });
      if (res.ok) {
        const data = await res.json();
        state.paused = data.paused;
        el.togglePause.textContent = state.paused ? '▶ 恢复' : '⏸ 暂停';
        el.togglePause.style.background = state.paused ? '#41d6a6' : '#f6c453';
      }
    } finally {
      el.togglePause.disabled = false;
    }
  }

  el.nodeCountInput.addEventListener('input', () => {
    const nodeCount = Number(el.nodeCountInput.value) || 200;
    const maxEdge = Math.floor(nodeCount / 3);
    el.edgeCountInput.max = maxEdge;
    if (Number(el.edgeCountInput.value) > maxEdge) el.edgeCountInput.value = maxEdge;
  });
  el.injectTask.addEventListener('click', injectTask);
  el.resetSim.addEventListener('click', resetSimulation);
  el.togglePause.addEventListener('click', togglePause);
  el.networkCanvas.addEventListener('mousemove', (event) => {
    const rect = el.networkCanvas.getBoundingClientRect();
    state.mouse = { x: event.clientX - rect.left, y: event.clientY - rect.top, inside: true };
  });
  el.networkCanvas.addEventListener('mouseleave', () => {
    state.mouse.inside = false;
    el.hoverTip.classList.add('hidden');
    el.nodePopup.classList.add('hidden');
    state.popupNodeId = null;
    state._hoveredNodeId = null;
    state.popupRenderKey = null;
  });
  el.networkCanvas.addEventListener('click', (event) => {
    const rect = el.networkCanvas.getBoundingClientRect();
    state.mouse = { x: event.clientX - rect.left, y: event.clientY - rect.top, inside: true };
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
      el.originSelect.value = nearest;
    }
  });

  el.nodePopup.addEventListener('mouseenter', () => {
    state.popupHovered = true;
  });
  el.nodePopup.addEventListener('mouseleave', () => {
    state.popupHovered = false;
    el.nodePopup.classList.add('hidden');
    state.popupNodeId = null;
    state._hoveredNodeId = null;
    state.popupRenderKey = null;
  });

  el.nodePopup.addEventListener('pointerdown', (event) => {
    if (event.target.closest('[data-close-popup]')) {
      event.preventDefault();
      event.stopPropagation();
      state.popupNodeId = null;
      state._hoveredNodeId = null;
      state.popupRenderKey = null;
      state.popupHovered = false;
      el.nodePopup.classList.add('hidden');
    }
  });


  window.addEventListener('resize', () => {
    renderTrace();
  });
}

function animate(time) {
  if (!state.lastFrame || time - state.lastFrame > 16) {
    if (state.paused) {
      if (!state._pauseTime) state._pauseTime = time;
      state._frozenTime = state._pauseTime;
    } else {
      state._pauseTime = null;
      state._frozenTime = null;
    }
    const renderTime = state._frozenTime || time;
    drawTopology(renderTime);
    const traceView = byId('traceView');
    if (traceView.classList.contains('active')) renderTrace();
    state.lastFrame = time;
  }
  requestAnimationFrame(animate);
}

async function initialLoad() {
  const res = await fetch('/api/state');
  const payload = await res.json();
  applyState(payload);
  if (payload.summary?.linkRadius !== undefined) {
    el.linkRadiusInput.value = payload.summary.linkRadius;
  }
}

bindEvents();
initialLoad().then(connectEvents);
requestAnimationFrame(animate);
