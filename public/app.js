const state = {
  nodes: [],
  links: [],
  tasks: [],
  packetJourneys: [],
  telemetryRecords: [],
  relayLogs: [],
  cloudInbox: [],
  tsSensingFrames: [],
  summary: {},
  selectedTaskId: null,
  selectedNodeId: null,
  popupNodeId: null,
  popupRenderKey: null,
  originOptionsKey: null,
  situationSourceOptionsKey: null,
  priority: '中',
  paused: false,
  linkRadius: 0.55,
  popupHovered: false,
  editingEdgeCount: false,
  edgeCountTouched: false,
  mouse: { x: 0, y: 0, inside: false },
  sensingMouse: { x: 0, y: 0, inside: false },
  nodeScreen: new Map(),
  topologyViewport: { zoom: 1, cx: 0.5, cy: 0.5 },
  sensingHitNodes: [],
  sensingFlowAnimation: { recordId: null, startedAt: 0 },
  tick: 0,
  lastFrame: 0,
  remoteImage: null,
  remoteImageName: ''
};

const el = {
  clock: document.querySelector('#clock'),
  nodeCount: document.querySelector('#nodeCount'),
  activeLinks: document.querySelector('#activeLinks'),
  selfOrganizedLinks: document.querySelector('#selfOrganizedLinks'),
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
  previewPriority: document.querySelector('#previewPriority'),
  previewCompute: document.querySelector('#previewCompute'),
  previewStorage: document.querySelector('#previewStorage'),
  previewData: document.querySelector('#previewData'),
  previewLoad: document.querySelector('#previewLoad'),
  previewLoadText: document.querySelector('#previewLoadText'),
  nodeCountInput: document.querySelector('#nodeCountInput'),
  edgeCountInput: document.querySelector('#edgeCountInput'),
  linkRadiusInput: document.querySelector('#linkRadiusInput'),
  resetSim: document.querySelector('#resetSim'),
  togglePause: document.querySelector('#togglePause'),
  taskList: document.querySelector('#taskList'),
  linkStats: document.querySelector('#linkStats'),
  linkRows: document.querySelector('#linkRows'),
  fragmentList: document.querySelector('#fragmentList'),
  traceTitle: document.querySelector('#traceTitle'),
  traceStatus: document.querySelector('#traceStatus'),
  dataStats: document.querySelector('#dataStats'),
  dataRows: document.querySelector('#dataRows'),
  dataLog: document.querySelector('#dataLog'),
  remoteImageInput: document.querySelector('#remoteImageInput'),
  situationSourceSelect: document.querySelector('#situationSourceSelect'),
  situationDescriptionInput: document.querySelector('#situationDescriptionInput'),
  situationStatus: document.querySelector('#situationStatus'),
  triggerTsScan: document.querySelector('#triggerTsScan'),
  tsStats: document.querySelector('#tsStats'),
  tsDetectionList: document.querySelector('#tsDetectionList'),
  sensingTitle: document.querySelector('#sensingTitle'),
  sensingBadge: document.querySelector('#sensingBadge'),
  sensingHoverCard: document.querySelector('#sensingHoverCard'),
  hoverTip: document.querySelector('#hoverTip'),
  nodePopup: document.querySelector('#nodePopup'),
  networkCanvas: document.querySelector('#networkCanvas'),
  traceCanvas: document.querySelector('#traceCanvas'),
  dataCanvas: document.querySelector('#dataCanvas'),
  sensingCanvas: document.querySelector('#sensingCanvas')
};

const ctx = el.networkCanvas.getContext('2d');
const traceCtx = el.traceCanvas.getContext('2d');
const dataCtx = el.dataCanvas?.getContext('2d');
const sensingCtx = el.sensingCanvas?.getContext('2d');

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

function timeLabel(ts) {
  return ts ? new Date(ts).toLocaleTimeString('zh-CN', { hour12: false }) : '--';
}

function durationLabel(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '--';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return `${minutes}分${String(seconds).padStart(2, '0')}秒`;
}

function splitLabel(strategy) {
  return strategy === 'resourceWeighted' ? '资源权重' : '默认均分';
}

function linkRoleLabel(role, link = null) {
  if (link) {
    const aType = nodeById(link.a)?.type;
    const bType = nodeById(link.b)?.type;
    if ((aType === 'Terminal' && bType === 'Edge') || (aType === 'Edge' && bType === 'Terminal')) {
      return '端-边协同链路';
    }
    if (aType === 'Edge' && bType === 'Edge') {
      return '边-边互联链路';
    }
    if (aType === 'Terminal' && bType === 'Terminal') {
      return '端-端自组网';
    }
  }

  const labels = {
    'terminal-edge': '端-边主链路',
    'edge-cloud': '边-云主链路',
    'edge-mesh': '边缘互联',
    'terminal-peer': '终端邻近',
    'terminal-cloud-exception': '端-云弹性'
  };
  const base = labels[role] || '灵活链路';
  return link?.selfOrganized ? `自组·${base}` : base;
}

function selectedTask() {
  return state.tasks.find((task) => task.id === state.selectedTaskId) || state.tasks[0] || null;
}

function taskPackets(task) {
  if (!task) return [];
  if (Array.isArray(task.packetJourneys) && task.packetJourneys.length) return task.packetJourneys;
  const ids = new Set(task.packetIds || []);
  return state.packetJourneys.filter((packet) => ids.has(packet.id) || packet.taskId === task.id);
}

function hasTracePackets(task) {
  return taskPackets(task).length > 0;
}

function latestTraceableTask() {
  return state.tasks.find((task) => hasTracePackets(task)) || null;
}

function selectedTraceTask() {
  const explicit = state.selectedTaskId
    ? state.tasks.find((task) => task.id === state.selectedTaskId)
    : null;
  return explicit || latestTraceableTask() || state.tasks[0] || null;
}

function directionLabel(direction) {
  return direction === 'downlink' ? '下行控制' : '上行回传';
}

function directionColor(direction) {
  return direction === 'downlink' ? '#f6c453' : '#41d6a6';
}

function packetStatusLabel(status) {
  const labels = {
    waiting: '等待下发',
    transmitting: '传输中',
    complete: '已送达'
  };
  return labels[status] || status || '--';
}

function traceEmptyReason(task) {
  if (!task) return '等待调度任务生成后，将显示单条数据包的逐跳路径。';
  if (task.status === 'rejected') return task.message || '该任务未通过资源与链路约束校验，因此没有生成上/下行数据包。';
  if (!task.accepted) return '该任务未被调度层接受，没有可追踪的数据包。';
  if (task.packetIds?.length) return '该任务的数据包记录已被滚动缓存清理，请选择较新的运行任务。';
  return '该任务尚未生成上行回传或下行控制数据包。';
}

function nodeById(id) {
  return state.nodes.find((node) => node.id === id);
}

function recentCloudInbox(nodeId, limit = 3) {
  return state.cloudInbox
    .filter((item) => item.cloudNodeId === nodeId)
    .slice(0, limit);
}

function recentRelayLogs(nodeId, limit = 3) {
  return state.relayLogs
    .filter((item) => item.nodeId === nodeId)
    .slice(0, limit);
}

function recentTelemetryFrom(nodeId, limit = 3) {
  return state.telemetryRecords
    .filter((item) => item.source === nodeId)
    .slice(0, limit);
}

function taskUplinkPacket(task) {
  return taskPackets(task).find((packet) => packet.direction === 'uplink') || null;
}

function telemetryForPacket(packet) {
  if (!packet?.telemetryId) return null;
  return state.telemetryRecords.find((record) => record.id === packet.telemetryId) || null;
}

function relayForTelemetry(telemetryId) {
  return state.relayLogs.find((log) => log.telemetryId === telemetryId) || null;
}

function inboxForTelemetry(telemetryId) {
  return state.cloudInbox.find((item) => item.telemetryId === telemetryId) || null;
}

function isSituationRecord(record) {
  return record?.payload?.kind === 'image_situation_description';
}

function latestSituationRecord() {
  return state.telemetryRecords.find(isSituationRecord) || null;
}

function situationDescriptionText(record) {
  return record?.payload?.description || '暂无态势描述';
}

function shortText(text, length = 72) {
  const value = String(text || '').trim();
  return value.length > length ? `${value.slice(0, length)}...` : value || '--';
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

function compactSituationText(text, length = 72) {
  let value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return '暂无态势描述';
  value = value
    .replace(/^.*?拍摄到遥感画面[:：]?\s*/, '')
    .replace(/^.*?采集到态势数据[:：]?\s*/, '')
    .replace(/[；;]\s*请经.*$/, '')
    .replace(/请经.*$/, '');
  const firstSentence = value.match(/^.+?[。！？.!?]/)?.[0] || value;
  return firstSentence.length > length ? `${firstSentence.slice(0, length)}...` : firstSentence;
}

function defaultSituationDescription(source) {
  const id = source?.id || '终端节点';
  return `${id} 采集到态势数据：图中可见海域背景、多条态势航迹线和若干目标标注，疑似存在海面/空中平台协同行动；请经边缘节点回传至云端进行态势融合展示。`;
}

function fillDefaultSituationDescription(force = false) {
  if (!el.situationDescriptionInput) return;
  if (!force && el.situationDescriptionInput.value.trim()) return;
  const source = nodeById(el.situationSourceSelect?.value) || state.nodes.find((node) => node.type === 'Terminal');
  el.situationDescriptionInput.value = defaultSituationDescription(source);
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
  if (el.selfOrganizedLinks) el.selfOrganizedLinks.textContent = `${fmt(s.activeSelfOrganizedLinks)}/${fmt(s.selfOrganizedLinks)}`;
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
  else {
    const preferred = [...state.nodes]
      .filter((node) => node.type === 'Terminal' && node.status === 'online' && node.gatewayEdgeId)
      .sort((left, right) => (right.computeFree + right.storageFree) - (left.computeFree + left.storageFree))[0]
      || state.nodes.find((node) => node.type === 'Edge' && node.status === 'online')
      || interesting[0];
    if (preferred) el.originSelect.value = preferred.id;
  }
}

function renderSituationSourceOptions() {
  if (!el.situationSourceSelect) return;
  const previous = el.situationSourceSelect.value;
  const terminals = state.nodes
    .filter((node) => node.type === 'Terminal' && node.status === 'online')
    .sort((left, right) => {
      const leftMultiHop = left.multiHopRelay ? 1 : 0;
      const rightMultiHop = right.multiHopRelay ? 1 : 0;
      if (leftMultiHop !== rightMultiHop) return rightMultiHop - leftMultiHop;
      return (right.computeFree + right.storageFree) - (left.computeFree + left.storageFree);
    });
  const candidates = terminals.length ? terminals : state.nodes.filter((node) => node.type !== 'Cloud');
  const signature = candidates.map((node) => `${node.id}:${node.gatewayEdgeId || ''}:${node.multiHopRelay?.mode || ''}:${node.status}`).join('|');
  if (signature === state.situationSourceOptionsKey) {
    if (candidates.some((node) => node.id === previous)) el.situationSourceSelect.value = previous;
    return;
  }
  state.situationSourceOptionsKey = signature;
  el.situationSourceSelect.innerHTML = candidates
    .map((node) => {
      const relay = node.multiHopRelay;
      const routeLabel = relay?.mode === 'terminal-terminal-edge-cloud'
        ? `3跳稀有 · 端-端-边-云 · ${node.id} → ${relay.relayTerminalId} → ${relay.gatewayEdgeId} → 云`
        : relay?.mode === 'terminal-edge-edge-cloud'
          ? `3跳稀有 · 端-边-边-云 · ${node.id} → ${relay.gatewayEdgeId} → ${relay.relayEdgeId} → 云`
          : `${node.label}${node.gatewayEdgeId ? ` → ${node.gatewayEdgeId}` : ''}`;
      return `<option value="${node.id}">${node.id} · ${routeLabel}</option>`;
    })
    .join('');
  if (candidates.some((node) => node.id === previous)) el.situationSourceSelect.value = previous;
  else {
    const preferred = candidates.find((node) => node.multiHopRelay) || candidates[0];
    if (preferred) el.situationSourceSelect.value = preferred.id;
  }
  fillDefaultSituationDescription();
}

function renderDemandPreview() {
  if (!el.previewLoad) return;
  const compute = Number(el.computeInput.value) || 0;
  const storage = Number(el.storageInput.value) || 0;
  const data = Number(el.dataInput.value) || 0;
  const weightedLoad = Math.min(100, Math.round((compute / 3000) * 52 + (storage / 1800) * 22 + (data / 1800) * 26));
  el.previewPriority.textContent = `${state.priority}优先级`;
  el.previewCompute.textContent = fmt(compute);
  el.previewStorage.textContent = fmt(storage);
  el.previewData.textContent = fmt(data);
  el.previewLoad.style.width = `${weightedLoad}%`;
  el.previewLoadText.textContent = `${weightedLoad}%`;
}

function recommendedEdgeCount(nodeCount) {
  if (!Number.isFinite(nodeCount)) return 10;
  return Math.min(Math.floor(nodeCount / 3), Math.max(10, Math.floor(nodeCount / 3)));
}

function renderTaskList() {
  if (!state.tasks.length) {
    el.taskList.innerHTML = '<div class="empty-state">等待任务</div>';
    return;
  }
  if (!state.selectedTaskId) state.selectedTaskId = latestTraceableTask()?.id || state.tasks[0].id;
  el.taskList.innerHTML = state.tasks
    .map((task) => {
      const statusClass = task.status === 'rejected' ? 'rejected' : task.status === 'complete' ? 'complete' : '';
      const progress = task.progress || 0;
      const packets = taskPackets(task);
      return `<article class="task-card ${task.id === state.selectedTaskId ? 'active' : ''}" data-task="${task.id}">
        <header><span>${task.id} · ${task.priority}</span><span class="status-pill ${statusClass}">${task.status}</span></header>
        <div class="progress"><i style="width:${Math.round(progress * 100)}%"></i></div>
        <div class="meta-row">
          <span>源 ${task.origin}</span>
          <span>${task.fragments.length} 片</span>
          <span>${packets.length} 条回传</span>
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
  const relay = node.multiHopRelay;
  const routeText = relay?.mode === 'terminal-terminal-edge-cloud'
    ? `${node.id}→${relay.relayTerminalId}→${relay.gatewayEdgeId}→云`
    : relay?.mode === 'terminal-edge-edge-cloud'
      ? `${node.id}→${relay.gatewayEdgeId}→${relay.relayEdgeId}→云`
      : node.type === 'Terminal'
        ? `${node.id}→${node.gatewayEdgeId || '边缘'}→云`
        : node.type === 'Edge'
          ? `${node.id}→云`
          : '云端';
  const cloudItems = node.type === 'Cloud' ? recentCloudInbox(node.id) : [];
  const relayItems = node.type === 'Edge' ? recentRelayLogs(node.id) : [];
  const telemetryItems = node.type === 'Terminal' ? recentTelemetryFrom(node.id) : [];
  // Position popup away from node to avoid blocking canvas mousemove
  const popupW = 316, popupH = 398, gap = 18;
  const nodeRadius = node.type === 'Cloud' ? 14 : node.type === 'Edge' ? 10 : 7;
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
    routeText,
    Math.round(totalLinkBandwidth),
    Math.round(avgCapacity),
    cloudItems.map((item) => `${item.telemetryId}:${item.receivedAt}`).join(','),
    relayItems.map((item) => `${item.telemetryId}:${item.receivedAt}`).join(','),
    telemetryItems.map((item) => `${item.id}:${item.status}`).join(',')
  ].join('|');
  if (state.popupRenderKey === renderKey) {
    el.nodePopup.classList.remove('hidden');
    return;
  }
  state.popupRenderKey = renderKey;
  let telemetryPanel = '';
  if (node.type === 'Cloud') {
    telemetryPanel = `<section class="telemetry-panel">
      <b>云端已接收数据</b>
      ${cloudItems.length ? cloudItems.map((item) => `<div class="telemetry-item">
        <span>${item.telemetryId} · ${item.source} 经 ${item.viaEdge || '--'}</span>
        <em>${isSituationRecord(item) ? `${item.payload.imageName || '遥感图'} · ${shortText(item.payload.description, 36)}` : `信号 ${fmt(item.payload.signalStrength)} · ${fmt(item.payload.sampleSizeMb)} MB`}</em>
      </div>`).join('') : '<div class="telemetry-empty">暂无终端回传数据</div>'}
    </section>`;
  } else if (node.type === 'Edge') {
    telemetryPanel = `<section class="telemetry-panel">
      <b>边缘中转记录</b>
      ${relayItems.length ? relayItems.map((item) => `<div class="telemetry-item">
        <span>${item.telemetryId} · 来自 ${item.source}</span>
        <em>${timeLabel(item.receivedAt)} · 转发至云 · ${fmt(item.bottleneck)} Mbps</em>
      </div>`).join('') : '<div class="telemetry-empty">暂无中转记录</div>'}
    </section>`;
  } else if (node.type === 'Terminal') {
    telemetryPanel = `<section class="telemetry-panel">
      <b>终端采集记录</b>
      ${telemetryItems.length ? telemetryItems.map((item) => `<div class="telemetry-item">
        <span>${item.id} · ${item.status}</span>
        <em>${isSituationRecord(item) ? `${item.payload.imageName || '遥感图'} · ${shortText(item.payload.description, 36)}` : `温度 ${fmt(item.payload.temperature, 1)} · 信号 ${fmt(item.payload.signalStrength)}`}</em>
      </div>`).join('') : '<div class="telemetry-empty">暂无采集记录</div>'}
    </section>`;
  }

  el.nodePopup.innerHTML = `<header>
      <div><b>${node.id}</b><span>${node.label}</span></div>
      <button type="button" data-close-popup aria-label="close">×</button>
    </header>
    <div class="popup-grid">
      <span><b>节点编号</b><em>${node.id}</em></span>
      <span><b>节点类型</b><em>${node.label}</em></span>
      <span><b>单位名称</b><em>${node.unitName || node.name || '--'}</em></span>
      <span><b>兵种</b><em>${node.branch || '--'}</em></span>
      <span><b>经度</b><em>${fmt(node.longitude, 6)}</em></span>
      <span><b>纬度</b><em>${fmt(node.latitude, 6)}</em></span>
      <span><b>剩余算力</b><em>${fmt(node.computeFree)} / ${fmt(node.computeTotal)}</em></span>
      <span><b>剩余存储</b><em>${fmt(node.storageFree)} / ${fmt(node.storageTotal)}</em></span>
      <span><b>通信容量</b><em>${fmt(avgCapacity)} Mbps</em></span>
      <span><b>所在链路容量</b><em>${fmt(totalLinkBandwidth)} Mbps</em></span>
      <span><b>回传路径</b><em>${escapeHtml(routeText)}</em></span>
    </div>
    ${telemetryPanel}`;
  el.nodePopup.classList.remove('hidden');
}

function renderLinksTable() {
  renderLinkStats();
  const rows = [...state.links]
    .sort((a, b) => Number(b.active) - Number(a.active) || b.utilization - a.utilization)
    .slice(0, 160);
  el.linkRows.innerHTML = rows
    .map((link) => {
      const na = nodeById(link.a);
      const nb = nodeById(link.b);
      const ha = na?.hopsToCloud ?? '--';
      const hb = nb?.hopsToCloud ?? '--';
      const hopLabel = ha === 0 || hb === 0 ? '直连' : '多跳';
      return `<tr>
      <td>${link.id}</td>
      <td>${link.a} ⇄ ${link.b}</td>
      <td>${linkRoleLabel(link.role, link)}</td>
      <td><b>${ha}↔${hb}</b> <em>${hopLabel}</em></td>
      <td>${fmt(link.bandwidth)}</td>
      <td>${fmt(link.latency)}</td>
      <td>${fmt(link.loss, 2)}</td>
      <td>${percent(link.utilization)}</td>
      <td>${link.active ? '在线' : '中断'}</td>
    </tr>`;
    })
    .join('');
}

function linkHopLabel(link) {
  const na = nodeById(link.a);
  const nb = nodeById(link.b);
  return (na?.hopsToCloud === 0 || nb?.hopsToCloud === 0) ? 'direct' : 'multiHop';
}

function renderLinkStats() {
  if (!el.linkStats) return;
  const links = state.links || [];
  const total = links.length;
  const active = links.filter((link) => link.active).length;
  const direct = links.filter((link) => linkHopLabel(link) === 'direct').length;
  const multiHop = total - direct;
  const selfOrganized = links.filter((link) => link.selfOrganized).length;
  const wired = links.filter((link) => link.medium === 'wired').length;
  const wireless = links.filter((link) => link.medium === 'wireless').length;
  const cards = [
    ['链路总数', fmt(total), `${fmt(active)} 在线 / ${fmt(total - active)} 中断`],
    ['直连链路', fmt(direct), '包含云端端点的链路'],
    ['多跳链路', fmt(multiHop), '端-边、边-边、端-端链路'],
    ['自组链路', fmt(selfOrganized), `有线 ${fmt(wired)} / 无线 ${fmt(wireless)}`]
  ];
  el.linkStats.innerHTML = cards.map(([label, value, hint]) => `<article class="link-stat-card">
    <b>${value}</b>
    <span>${label}</span>
    <em>${hint}</em>
  </article>`).join('');
}

function renderFragments(task) {
  if (!task) {
    el.fragmentList.innerHTML = '<div class="empty-state compact">暂无可追踪数据包</div>';
    return;
  }
  const packets = taskPackets(task);
  if (!packets.length) {
    el.fragmentList.innerHTML = `<div class="empty-state compact">
      <b>${task.status === 'rejected' ? '任务已拒绝' : '暂无传输包'}</b>
      <span>${traceEmptyReason(task)}</span>
    </div>`;
    return;
  }
  const packetCards = packets
    .map((packet) => {
      const path = packet.path || [];
      const hopCount = Math.max(1, path.length - 1);
      const hop = Math.min(hopCount - 1, Math.max(0, packet.currentHop || 0));
      const nextHop = path[hop + 1] || path[path.length - 1] || '--';
      return `<article class="fragment-card packet-card ${packet.direction}">
      <header>
        <span>${packet.id} · ${packet.label || directionLabel(packet.direction)}</span>
        <span>${packetStatusLabel(packet.status)} · ${Math.round((packet.progress || 0) * 100)}%</span>
      </header>
      <div class="progress packet-progress ${packet.direction}"><i style="width:${Math.round((packet.progress || 0) * 100)}%"></i></div>
      <div class="packet-kv">
        <span><b>当前跳</b><em>${path[hop] || '--'} → ${nextHop}</em></span>
        <span><b>完整路径</b><em>${path.join(' → ')}</em></span>
        <span><b>数据编号</b><em>${packet.telemetryId || '--'}</em></span>
        <span><b>数据量</b><em>${fmt(packet.data)} MB</em></span>
        <span><b>时延</b><em>${fmt(packet.latency)} ms</em></span>
        <span><b>瓶颈带宽</b><em>${fmt(packet.bottleneck)} Mbps</em></span>
        <span><b>丢包率</b><em>${fmt(packet.loss, 2)}%</em></span>
      </div>
    </article>`;
    })
    .join('');
  const graph = task.taskGraph;
  const graphCard = graph?.edges?.length ? `<article class="fragment-card task-graph-card">
      <header>
        <span>首尾相接有向图</span>
        <span>${graph.nodes.length} 点 / ${graph.edges.length} 边</span>
      </header>
      <div class="graph-flow">
        ${graph.edges.slice(0, 14).map((edge) => `<span class="${edge.role}">
          <b>${edge.from} → ${edge.to}</b>
          <em>${edge.role === 'dispatch' ? '下发' : edge.role === 'gather' ? '汇聚' : '接力'} · ${Math.round((edge.ratio || 0) * 100)}%</em>
        </span>`).join('')}
      </div>
    </article>` : '';
  el.fragmentList.innerHTML = packetCards + graphCard;
}

function renderDataStats() {
  if (!el.dataStats) return;
  const transmitting = state.packetJourneys.filter((packet) => packet.direction === 'uplink' && ['waiting', 'transmitting'].includes(packet.status)).length;
  const received = state.cloudInbox.length;
  const relayed = state.relayLogs.length;
  const latest = state.telemetryRecords[0];
  el.dataStats.innerHTML = [
    ['采集记录', fmt(state.telemetryRecords.length), '终端生成样本'],
    ['已到云端', fmt(received), '完成入库数据'],
    ['传输中', fmt(transmitting), '上行回传包'],
    ['最新数据', latest ? timeLabel(latest.createdAt) : '--', latest ? latest.id : '等待采集']
  ].map(([label, value, hint]) => `<article class="data-stat-card">
      <b>${value}</b>
      <span>${label}</span>
      <em>${hint}</em>
    </article>`).join('');
}

function drawDataCollection(time = 0) {
  if (!el.dataCanvas || !dataCtx) return;
  const rect = resizeCanvas(el.dataCanvas, dataCtx);
  dataCtx.clearRect(0, 0, rect.width, rect.height);
  dataCtx.fillStyle = '#071014';
  dataCtx.fillRect(0, 0, rect.width, rect.height);

  const records = state.telemetryRecords.slice(0, 14);
  const rows = Math.max(8, records.length || 8);
  const terminalX = 92;
  const edgeX = rect.width * 0.48;
  const cloudX = rect.width - 120;
  const top = 46;
  const bottom = rect.height - 36;
  const rowGap = (bottom - top) / Math.max(1, rows - 1);
  const edgeGroups = new Map();
  records.forEach((record) => {
    const key = record.viaEdge || 'N---';
    if (!edgeGroups.has(key)) edgeGroups.set(key, []);
    edgeGroups.get(key).push(record);
  });
  const edges = [...edgeGroups.keys()].slice(0, 6);
  const edgePoints = edges.map((edgeId, index) => ({
    id: edgeId,
    x: edgeX,
    y: top + (bottom - top) * (index + 0.5) / Math.max(1, edges.length)
  }));

  dataCtx.save();
  dataCtx.strokeStyle = 'rgba(58, 75, 86, 0.16)';
  dataCtx.lineWidth = 1;
  for (let x = 36; x < rect.width; x += 56) {
    dataCtx.beginPath();
    dataCtx.moveTo(x, 18);
    dataCtx.lineTo(x, rect.height - 18);
    dataCtx.stroke();
  }

  const cloudGradient = dataCtx.createRadialGradient(cloudX, rect.height / 2, 8, cloudX, rect.height / 2, 64);
  cloudGradient.addColorStop(0, 'rgba(246,196,83,0.55)');
  cloudGradient.addColorStop(1, 'rgba(246,196,83,0.04)');
  dataCtx.fillStyle = cloudGradient;
  dataCtx.beginPath();
  dataCtx.arc(cloudX, rect.height / 2, 66, 0, Math.PI * 2);
  dataCtx.fill();

  records.forEach((record, index) => {
    const y = top + rowGap * index;
    const edgePoint = edgePoints.find((point) => point.id === record.viaEdge) || { x: edgeX, y };
    const inbox = inboxForTelemetry(record.id);
    const relay = relayForTelemetry(record.id);
    const packet = state.packetJourneys.find((item) => item.telemetryId === record.id);
    const progress = packet?.progress || (inbox ? 1 : relay ? 0.58 : 0.16);

    dataCtx.strokeStyle = inbox ? 'rgba(65,214,166,0.62)' : 'rgba(112,167,255,0.48)';
    dataCtx.lineWidth = inbox ? 2.2 : 1.3;
    dataCtx.beginPath();
    dataCtx.moveTo(terminalX, y);
    dataCtx.bezierCurveTo(rect.width * 0.26, y, rect.width * 0.34, edgePoint.y, edgePoint.x, edgePoint.y);
    dataCtx.bezierCurveTo(rect.width * 0.62, edgePoint.y, rect.width * 0.72, rect.height / 2, cloudX, rect.height / 2);
    dataCtx.stroke();

    const particleT = (time / 1800 + index * 0.073) % 1;
    const visibleT = Math.min(progress, particleT);
    const px = visibleT < 0.5
      ? terminalX + (edgePoint.x - terminalX) * (visibleT / 0.5)
      : edgePoint.x + (cloudX - edgePoint.x) * ((visibleT - 0.5) / 0.5);
    const py = visibleT < 0.5
      ? y + (edgePoint.y - y) * (visibleT / 0.5)
      : edgePoint.y + (rect.height / 2 - edgePoint.y) * ((visibleT - 0.5) / 0.5);
    dataCtx.fillStyle = inbox ? '#41d6a6' : '#70a7ff';
    dataCtx.shadowColor = dataCtx.fillStyle;
    dataCtx.shadowBlur = 10;
    dataCtx.beginPath();
    dataCtx.arc(px, py, 3.2, 0, Math.PI * 2);
    dataCtx.fill();
    dataCtx.shadowBlur = 0;

    dataCtx.fillStyle = '#70a7ff';
    dataCtx.beginPath();
    dataCtx.arc(terminalX, y, 4.5, 0, Math.PI * 2);
    dataCtx.fill();
    dataCtx.fillStyle = '#aebcbb';
    dataCtx.font = '12px Segoe UI, sans-serif';
    dataCtx.fillText(record.source, 18, y + 4);
  });

  edgePoints.forEach((point) => {
    dataCtx.fillStyle = '#e0555a';
    drawTriangle(dataCtx, point.x, point.y, 9);
    dataCtx.fill();
    dataCtx.fillStyle = '#dce5e4';
    dataCtx.font = '12px Segoe UI, sans-serif';
    dataCtx.fillText(point.id, point.x - 24, point.y - 14);
  });

  dataCtx.fillStyle = '#f6c453';
  dataCtx.shadowColor = '#f6c453';
  dataCtx.shadowBlur = 18;
  drawStar(dataCtx, cloudX, rect.height / 2, 18, 18 * 0.38);
  dataCtx.fill();
  dataCtx.shadowBlur = 0;
  dataCtx.fillStyle = '#dce5e4';
  dataCtx.font = 'bold 14px Segoe UI, sans-serif';
  dataCtx.fillText('N001 云端收件箱', cloudX - 54, rect.height / 2 + 42);
  dataCtx.restore();
}

function drawTraceEmpty(rect, title, detail) {
  const centerX = rect.width / 2;
  const centerY = rect.height / 2;
  traceCtx.save();
  traceCtx.textAlign = 'center';
  traceCtx.fillStyle = '#dce5e4';
  traceCtx.font = '700 18px Segoe UI, sans-serif';
  traceCtx.fillText(title, centerX, centerY - 12);
  traceCtx.fillStyle = '#8fa19f';
  traceCtx.font = '12px Segoe UI, sans-serif';
  const text = detail.length > 52 ? `${detail.slice(0, 52)}...` : detail;
  traceCtx.fillText(text, centerX, centerY + 14);
  traceCtx.restore();
}

function renderDataCollection() {
  renderDataStats();
  if (el.dataRows) {
    const rows = state.telemetryRecords.slice(0, 8);
    el.dataRows.innerHTML = rows.length ? rows.map((record) => {
      const inbox = inboxForTelemetry(record.id);
      const relay = relayForTelemetry(record.id);
      const status = inbox ? '已到云端' : relay ? '边缘中转' : '传输中';
      const situation = isSituationRecord(record);
      return `<article class="data-record-row">
        <b>${record.id}</b>
        <span>${record.source} → ${record.viaEdge || '--'} → ${record.target}</span>
        <span>${situation ? `图像态势 · ${shortText(record.payload.imageName, 16)}` : `${fmt(record.payload.temperature, 1)}°C / 信号 ${fmt(record.payload.signalStrength)}`}</span>
        <span>${situation ? shortText(record.payload.description, 30) : `${fmt(record.payload.computeFree)} 算力 / ${fmt(record.payload.storageFree)} 存储`}</span>
        <em class="${inbox ? 'ok' : ''}">${status}</em>
      </article>`;
    }).join('') : '<div class="empty-state compact">等待终端采集数据</div>';
  }
  if (el.dataLog) {
    const logs = [
      ...state.cloudInbox.slice(0, 5).map((item) => ({ type: 'cloud', item, time: item.receivedAt })),
      ...state.relayLogs.slice(0, 5).map((item) => ({ type: 'relay', item, time: item.receivedAt }))
    ].sort((a, b) => b.time - a.time).slice(0, 8);
    el.dataLog.innerHTML = logs.length ? logs.map(({ type, item }) => {
      if (type === 'cloud') {
        const situation = item.payload?.kind === 'image_situation_description';
        return `<article class="hop-log-item cloud">
          <b>${item.telemetryId} 已到达云端</b>
          <span>${item.source} 经 ${item.viaEdge || '--'} → ${item.cloudNodeId}</span>
          <em>${timeLabel(item.receivedAt)} · ${situation ? shortText(item.payload.description, 42) : `${fmt(item.latency)} ms · 丢包 ${fmt(item.loss, 2)}%`}</em>
        </article>`;
      }
      return `<article class="hop-log-item relay">
        <b>${item.telemetryId} 边缘中转</b>
        <span>${item.source} → ${item.nodeId} → N001</span>
        <em>${timeLabel(item.receivedAt)} · 瓶颈 ${fmt(item.bottleneck)} Mbps</em>
      </article>`;
    }).join('') : '<div class="empty-state compact">暂无逐跳日志</div>';
  }
}

function tsPoint(item, rect) {
  const pad = 28;
  return {
    x: pad + (item.x || 0.5) * (rect.width - pad * 2),
    y: pad + (item.y || 0.5) * (rect.height - pad * 2)
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function sensingRoutePoints(path, rect, nodeMap) {
  const nodes = (path || []).map((nodeId) => nodeMap.get(nodeId)).filter(Boolean);
  const typeTotals = nodes.reduce((acc, node) => {
    acc[node.type] = (acc[node.type] || 0) + 1;
    return acc;
  }, {});
  const typeSeen = {};
  const anchors = {
    Cloud: { x: 0.18, y: 0.24 },
    Edge: { x: 0.52, y: 0.46 },
    Terminal: { x: 0.82, y: 0.66 }
  };
  const spread = clamp(Math.min(rect.width, rect.height) * 0.1, 54, 92);
  const pad = 54;

  return nodes.map((node, index) => {
    const anchor = anchors[node.type] || {
      x: 0.28 + (0.48 * index) / Math.max(1, nodes.length - 1),
      y: 0.3 + (0.34 * index) / Math.max(1, nodes.length - 1)
    };
    const typeIndex = typeSeen[node.type] || 0;
    typeSeen[node.type] = typeIndex + 1;
    const offset = typeIndex - ((typeTotals[node.type] || 1) - 1) / 2;
    const direction = node.type === 'Cloud'
      ? { x: 0.7, y: 0.45 }
      : node.type === 'Terminal'
        ? { x: -0.5, y: 0.62 }
        : { x: 0.62, y: -0.72 };
    return {
      node,
      point: {
        x: clamp(anchor.x * rect.width + offset * spread * direction.x, pad, rect.width - pad),
        y: clamp(anchor.y * rect.height + offset * spread * direction.y, pad, rect.height - pad)
      }
    };
  });
}

function sensingHitRadius(node) {
  if (node.type === 'Cloud') return 22;
  if (node.type === 'Edge') return 18;
  return 16;
}

function hoveredSensingNode() {
  if (!state.sensingMouse.inside) return null;
  let nearest = null;
  let nearestDistance = Infinity;
  for (const item of state.sensingHitNodes) {
    const d = Math.hypot(item.point.x - state.sensingMouse.x, item.point.y - state.sensingMouse.y);
    if (d <= item.radius && d < nearestDistance) {
      nearest = item;
      nearestDistance = d;
    }
  }
  return nearest;
}

function sensingPathStatus(node, situation) {
  if (!situation) return '--';
  const inbox = inboxForTelemetry(situation.id);
  const relayAtNode = state.relayLogs.find((log) => log.telemetryId === situation.id && log.nodeId === node.id);
  if (node.type === 'Cloud') return inbox ? `已入云 ${timeLabel(inbox.receivedAt)}` : '等待云端接收';
  if (node.type === 'Edge') return relayAtNode ? `已中转 ${timeLabel(relayAtNode.receivedAt)}` : '边缘中转待达';
  return '终端拍摄上传';
}

function situationFusionTiming(situation, packet, inbox, relay) {
  if (!situation) {
    return {
      startAt: null,
      relayAt: null,
      cloudAt: null,
      elapsedMs: null,
      transportMs: null,
      status: '等待采集',
      done: false
    };
  }
  const startAt = situation.payload?.capturedAt || situation.createdAt || packet?.createdAt || null;
  const relayAt = relay?.receivedAt || situation.relayedAt || null;
  const cloudAt = inbox?.receivedAt || situation.receivedAt || packet?.completedAt || null;
  const endAt = cloudAt || Date.now();
  const elapsedMs = startAt ? Math.max(0, endAt - startAt) : null;
  const transportStart = packet?.startAt || startAt;
  const transportMs = transportStart && cloudAt ? Math.max(0, cloudAt - transportStart) : packet?.latency || null;
  return {
    startAt,
    relayAt,
    cloudAt,
    elapsedMs,
    transportMs,
    status: cloudAt ? '云端已形成态势图' : relayAt ? '云端融合中' : packet?.status === 'waiting' ? '等待上行' : '上行回传中',
    done: Boolean(cloudAt)
  };
}

function routeModeLabel(path) {
  if (!Array.isArray(path) || path.length < 2) return '--';
  return path.length === 2 ? '直连' : `多跳 ${path.length - 1} 跳`;
}

function drawPathModeLabel(context, rect, label) {
  if (!label || label === '--') return;
  context.save();
  context.font = '800 12px Segoe UI, sans-serif';
  const width = context.measureText(label).width + 22;
  const height = 26;
  const left = Math.max(14, rect.width - width - 18);
  const top = 14;
  context.fillStyle = label === '直连' ? 'rgba(112, 167, 255, 0.95)' : 'rgba(246, 196, 83, 0.95)';
  context.strokeStyle = 'rgba(255, 255, 255, 0.36)';
  context.lineWidth = 1;
  if (typeof context.roundRect === 'function') {
    context.beginPath();
    context.roundRect(left, top, width, height, 13);
    context.fill();
    context.stroke();
  } else {
    context.fillRect(left, top, width, height);
    context.strokeRect(left, top, width, height);
  }
  context.fillStyle = label === '直连' ? '#06100e' : '#10100a';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(label, left + width / 2, top + height / 2 + 0.5);
  context.restore();
}

function wrapCanvasText(context, text, maxWidth, maxLines = 3) {
  const source = String(text || '').replace(/\s+/g, ' ').trim();
  if (!source) return [];
  const chars = [...source];
  const lines = [];
  let line = '';
  for (const char of chars) {
    const next = `${line}${char}`;
    if (context.measureText(next).width <= maxWidth || !line) {
      line = next;
      continue;
    }
    lines.push(line);
    line = char;
    if (lines.length >= maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (lines.length === maxLines && chars.join('').length > lines.join('').length) {
    lines[lines.length - 1] = `${lines[lines.length - 1].slice(0, Math.max(0, lines[lines.length - 1].length - 2))}...`;
  }
  return lines;
}

function clampFlowPopupPosition(x, y, width, height, rect) {
  return {
    x: clamp(x, 16, Math.max(16, rect.width - width - 16)),
    y: clamp(y, 16, Math.max(16, rect.height - height - 16))
  };
}

function popupWindowAlpha(elapsed, start, end, fade = 320) {
  if (elapsed < start) return 0;
  if (Number.isFinite(end) && elapsed > end) return 0;
  const fadeIn = clamp((elapsed - start) / fade, 0, 1);
  const fadeOut = Number.isFinite(end) ? clamp((end - elapsed) / fade, 0, 1) : 1;
  return Math.min(fadeIn, fadeOut);
}

function drawSensingFlowPopup(context, rect, popup) {
  if (popup.alpha <= 0) return;
  context.save();
  context.font = '800 15px Segoe UI, Microsoft YaHei, sans-serif';
  const width = popup.width || 330;
  const lines = wrapCanvasText(context, popup.text, width - 28, popup.maxLines || 4);
  const lineHeight = 23;
  const height = Math.max(58, 24 + lines.length * lineHeight);
  const pos = clampFlowPopupPosition(popup.x, popup.y, width, height, rect);

  context.globalAlpha = popup.alpha;
  context.fillStyle = 'rgba(7, 18, 26, 0.88)';
  context.strokeStyle = 'rgba(112, 167, 255, 0.5)';
  context.lineWidth = 1.2;
  context.shadowColor = 'rgba(67, 185, 255, 0.28)';
  context.shadowBlur = 16;
  if (typeof context.roundRect === 'function') {
    context.beginPath();
    context.roundRect(pos.x, pos.y, width, height, 8);
    context.fill();
    context.stroke();
  } else {
    context.fillRect(pos.x, pos.y, width, height);
    context.strokeRect(pos.x, pos.y, width, height);
  }

  context.shadowBlur = 0;
  context.fillStyle = '#43b9ff';
  context.textAlign = 'left';
  context.textBaseline = 'top';
  lines.forEach((line, index) => {
    context.fillText(line, pos.x + 14, pos.y + 14 + index * lineHeight);
  });
  context.restore();
}

function sensingFlowAnimation(recordId, time) {
  if (state.sensingFlowAnimation.recordId !== recordId) {
    state.sensingFlowAnimation = { recordId, startedAt: time };
  }
  const elapsed = Math.max(0, time - state.sensingFlowAnimation.startedAt);
  return { elapsed };
}

function flowPopupDuration(node, index, isLast) {
  if (isLast || node.type === 'Cloud') return 3000;
  if (node.type === 'Edge') return 3300;
  return index === 0 ? 2600 : 2200;
}

function flowSegmentDuration(from, to) {
  const distancePx = Math.hypot((to.point.x - from.point.x), (to.point.y - from.point.y));
  return clamp(1300 + distancePx * 2.2, 1500, 2300);
}

function sensingFlowTimeline(points) {
  const events = [];
  let cursor = 0;
  points.forEach((item, index) => {
    const isLast = index === points.length - 1;
    const popupDuration = flowPopupDuration(item.node, index, isLast);
    events.push({
      type: 'popup',
      index,
      start: cursor,
      end: cursor + popupDuration
    });
    cursor += popupDuration;
    if (!isLast) {
      const flowDuration = flowSegmentDuration(item, points[index + 1]);
      events.push({
        type: 'flow',
        from: index,
        to: index + 1,
        start: cursor,
        end: cursor + flowDuration
      });
      cursor += flowDuration;
    }
  });
  return { events, duration: cursor };
}

function drawPartialSegment(context, a, b, progress, color, width = 3) {
  if (!a || !b || progress <= 0) return;
  const p = clamp(progress, 0, 1);
  context.save();
  context.globalAlpha = 0.86;
  context.strokeStyle = color;
  context.shadowColor = color;
  context.shadowBlur = 12;
  context.lineWidth = width;
  context.beginPath();
  context.moveTo(a.x, a.y);
  context.lineTo(a.x + (b.x - a.x) * p, a.y + (b.y - a.y) * p);
  context.stroke();
  context.restore();
}

function drawFlowDot(context, a, b, progress) {
  if (!a || !b || progress < 0 || progress > 1) return;
  const px = a.x + (b.x - a.x) * progress;
  const py = a.y + (b.y - a.y) * progress;
  context.save();
  context.fillStyle = '#70a7ff';
  context.shadowColor = '#70a7ff';
  context.shadowBlur = 16;
  context.beginPath();
  context.arc(px, py, 6, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

function drawNodePulse(context, point, color, time, alpha = 0.8) {
  if (!point) return;
  const pulse = 10 + Math.sin(time / 160) * 2;
  context.save();
  context.globalAlpha = alpha;
  context.strokeStyle = color;
  context.lineWidth = 2;
  context.shadowColor = color;
  context.shadowBlur = 14;
  context.beginPath();
  context.arc(point.x, point.y, pulse, 0, Math.PI * 2);
  context.stroke();
  context.restore();
}

function situationPositionText(situation) {
  const latitude = Number(situation.payload?.latitude);
  const longitude = Number(situation.payload?.longitude);
  if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
    return `经度${longitude.toFixed(4)}，纬度${latitude.toFixed(4)}`;
  }
  return '经度X，纬度Y';
}

function sensingFlowPopupText(item, index, points, situation) {
  const positionText = situationPositionText(situation);
  const next = points[index + 1];
  if (index === 0 && item.node.type === 'Terminal') {
    return '采集到态势数据：海上目标图片';
  }
  if (item.node.type === 'Cloud' || index === points.length - 1) {
    return `${positionText}，出现巡逻舰，在侦查台湾以东区域海况。`;
  }
  if (item.node.type === 'Edge') {
    return `收到态势情报，${positionText}附近检测到巡逻舰，携带光电载荷，运动朝向Z，分析其在巡逻海况...`;
  }
  return `中继收到态势数据，准备转发至${next?.node.label || '下一跳节点'}。`;
}

function flowPopupPlacement(item, index, points) {
  const isLast = index === points.length - 1;
  const width = item.node.type === 'Edge' ? 420 : item.node.type === 'Cloud' || isLast ? 330 : 300;
  return {
    x: item.point.x + (item.node.type === 'Terminal' ? 28 : 22),
    y: item.point.y - (item.node.type === 'Edge' ? 120 : 90),
    width,
    maxLines: item.node.type === 'Edge' ? 4 : 3
  };
}

function flowSegmentColor(from, to) {
  const types = [from.node.type, to.node.type];
  if (types.includes('Cloud') && types.includes('Edge')) return '#e0555a';
  if (types.every((type) => type === 'Edge')) return '#f6c453';
  return '#70a7ff';
}

function drawSensingFlowSequence(context, rect, points, situation, time = 0) {
  if (points.length < 2) return;
  const playback = sensingFlowAnimation(situation.id, time);
  const elapsed = playback.elapsed;
  const timeline = sensingFlowTimeline(points);
  const activeFlow = timeline.events.find((event) => event.type === 'flow' && elapsed >= event.start && elapsed <= event.end);
  const activePopup = timeline.events.find((event) => event.type === 'popup' && elapsed >= event.start && elapsed <= event.end);

  for (const event of timeline.events.filter((item) => item.type === 'flow')) {
    if (elapsed < event.start) continue;
    const from = points[event.from];
    const to = points[event.to];
    const progress = elapsed >= event.end ? 1 : clamp((elapsed - event.start) / (event.end - event.start), 0, 1);
    drawPartialSegment(context, from.point, to.point, progress, flowSegmentColor(from, to), to.node.type === 'Cloud' ? 3.2 : 2.8);
  }

  if (activeFlow) {
    const from = points[activeFlow.from];
    const to = points[activeFlow.to];
    const progress = clamp((elapsed - activeFlow.start) / (activeFlow.end - activeFlow.start), 0, 1);
    drawFlowDot(context, from.point, to.point, progress);
  }

  const pulseItem = activePopup ? points[activePopup.index] : activeFlow ? points[activeFlow.from] : points.at(-1);
  drawNodePulse(context, pulseItem.point, '#70a7ff', time);

  for (const event of timeline.events.filter((item) => item.type === 'popup')) {
    const item = points[event.index];
    const placement = flowPopupPlacement(item, event.index, points);
    drawSensingFlowPopup(context, rect, {
      text: sensingFlowPopupText(item, event.index, points, situation),
      ...placement,
      alpha: popupWindowAlpha(elapsed, event.start, event.end)
    });
  }
}

function renderSensingHoverCard() {
  if (!el.sensingHoverCard || !el.sensingCanvas) return;
  const hit = hoveredSensingNode();
  const situation = latestSituationRecord();
  if (!hit || !situation) {
    el.sensingHoverCard.className = 'sensing-hover-card hidden';
    el.sensingCanvas.style.cursor = '';
    return;
  }

  const { node } = hit;
  const description = situationDescriptionText(situation);
  const imageName = situation.payload?.imageName || state.remoteImageName || '态势数据';
  const packet = state.packetJourneys.find((item) => item.telemetryId === situation.id);
  const path = situation.path || packet?.path || [];
  const relayAtNode = state.relayLogs.find((log) => log.telemetryId === situation.id && log.nodeId === node.id);
  const inbox = inboxForTelemetry(situation.id);
  const relay = relayForTelemetry(situation.id);
  const timing = situationFusionTiming(situation, packet, inbox, relay);
  const imageMarkup = state._remoteImageUrl
    ? `<img src="${escapeHtml(state._remoteImageUrl)}" alt="${escapeHtml(imageName)}" />`
    : '<div class="image-empty">当前浏览器暂无已上传图片</div>';

  let className = 'sensing-hover-card';
  if (node.type === 'Terminal') {
    className += ' image-card';
    el.sensingHoverCard.innerHTML = `<header>
      <b>${escapeHtml(node.id)} 终端态势数据采集</b><span>态势数据</span>
    </header>
    ${imageMarkup}
    <div class="hover-kv">
      <span><b>态势数据</b><em>${escapeHtml(imageName)}</em></span>
      <span><b>来源</b><em>${escapeHtml(node.name || node.id)}</em></span>
      <span><b>经度</b><em>${fmt(node.longitude, 6)}</em></span>
      <span><b>纬度</b><em>${fmt(node.latitude, 6)}</em></span>
      <span><b>采集时间</b><em>${escapeHtml(timeLabel(timing.startAt))}</em></span>
      <span><b>协同感知时间</b><em>${escapeHtml(durationLabel(timing.elapsedMs))}</em></span>
    </div>`;
  } else if (node.type === 'Edge') {
    className += ' edge-card';
    el.sensingHoverCard.innerHTML = `<header>
      <b>${escapeHtml(node.id)} 边缘中转态势数据</b><span>详细</span>
    </header>
    <p>${escapeHtml(description)}</p>
    <div class="hover-kv">
      <span><b>中转节点</b><em>${escapeHtml(node.name || node.id)}</em></span>
      <span><b>状态</b><em>${escapeHtml(sensingPathStatus(node, situation))}</em></span>
      <span><b>经度</b><em>${fmt(node.longitude, 6)}</em></span>
      <span><b>纬度</b><em>${fmt(node.latitude, 6)}</em></span>
      <span><b>态势数据</b><em>${escapeHtml(imageName)}</em></span>
      <span><b>数据量</b><em>${fmt(situation.payload?.sampleSizeMb)} MB</em></span>
      <span><b>协同感知时间</b><em>${escapeHtml(durationLabel(timing.elapsedMs))}</em></span>
      <span><b>采集时间</b><em>${escapeHtml(timeLabel(timing.startAt))}</em></span>
      <span><b>瓶颈带宽</b><em>${fmt(relayAtNode?.bottleneck)} Mbps</em></span>
      <span><b>路径</b><em>${escapeHtml(path.join(' → ') || '--')}</em></span>
    </div>`;
  } else {
    className += ' cloud-card';
    el.sensingHoverCard.innerHTML = `<header>
      <b>${escapeHtml(node.id)} 云端凝练态势</b><span>${inbox ? '已接收' : '回传中'}</span>
    </header>
    <p>${escapeHtml(compactSituationText(description))}</p>
    <div class="hover-kv">
      <span><b>来源</b><em>${escapeHtml(situation.source || '--')}</em></span>
      <span><b>状态</b><em>${escapeHtml(sensingPathStatus(node, situation))}</em></span>
      <span><b>经度</b><em>${fmt(node.longitude, 6)}</em></span>
      <span><b>纬度</b><em>${fmt(node.latitude, 6)}</em></span>
      <span><b>协同感知时间</b><em>${escapeHtml(durationLabel(timing.elapsedMs))}</em></span>
      <span><b>云端形成态势</b><em>${escapeHtml(timeLabel(timing.cloudAt))}</em></span>
      <span><b>态势数据</b><em>${escapeHtml(imageName)}</em></span>
      <span><b>入云节点</b><em>${escapeHtml(inbox?.cloudNodeId || node.id)}</em></span>
    </div>`;
  }

  el.sensingHoverCard.className = className;
  el.sensingHoverCard.style.visibility = 'hidden';
  const mapRect = el.sensingHoverCard.parentElement.getBoundingClientRect();
  const canvasRect = el.sensingCanvas.getBoundingClientRect();
  const cardWidth = el.sensingHoverCard.offsetWidth;
  const cardHeight = el.sensingHoverCard.offsetHeight;
  let left = canvasRect.left - mapRect.left + state.sensingMouse.x + 14;
  let top = canvasRect.top - mapRect.top + state.sensingMouse.y + 14;
  left = Math.max(14, Math.min(left, mapRect.width - cardWidth - 14));
  top = Math.max(14, Math.min(top, mapRect.height - cardHeight - 14));
  el.sensingHoverCard.style.left = `${left}px`;
  el.sensingHoverCard.style.top = `${top}px`;
  el.sensingHoverCard.style.visibility = '';
  el.sensingCanvas.style.cursor = 'pointer';
}

function renderTSSensing(time = 0) {
  if (!el.sensingCanvas || !sensingCtx) return;
  const frame = latestTsFrame();
  const rect = resizeCanvas(el.sensingCanvas, sensingCtx);
  drawBackground(sensingCtx, rect);
  const hasImage = drawRemoteImageBackground(sensingCtx, rect, 0.86);
  if (!hasImage) {
    sensingCtx.save();
    sensingCtx.fillStyle = 'rgba(65, 214, 166, 0.05)';
    sensingCtx.fillRect(0, 0, rect.width, rect.height);
    sensingCtx.fillStyle = '#91a4a4';
    sensingCtx.font = '13px Segoe UI, sans-serif';
    sensingCtx.fillText('可在左侧上传态势数据作为感知底图', 24, rect.height - 24);
    sensingCtx.restore();
  }
  const situation = latestSituationRecord();
  if (situation) {
    const inbox = inboxForTelemetry(situation.id);
    const relay = relayForTelemetry(situation.id);
    const packet = state.packetJourneys.find((item) => item.telemetryId === situation.id);
    const timing = situationFusionTiming(situation, packet, inbox, relay);
    const path = situation.path || packet?.path || [];
    const nodeMap = new Map(state.nodes.map((node) => [node.id, node]));
    const points = sensingRoutePoints(path, rect, nodeMap);
    const routeMode = routeModeLabel(path);
    state.sensingHitNodes = points.map((item) => ({ ...item, radius: sensingHitRadius(item.node) }));

    sensingCtx.save();
    if (points.length > 1) {
      points.slice(0, -1).forEach(({ node, point }, index) => {
        const next = points[index + 1];
        const isCloudEdge = [node.type, next.node.type].includes('Cloud') && [node.type, next.node.type].includes('Edge');
        sensingCtx.globalAlpha = 0.28;
        sensingCtx.strokeStyle = isCloudEdge ? 'rgba(224,85,90,0.7)' : 'rgba(112,167,255,0.58)';
        sensingCtx.lineWidth = isCloudEdge ? 2.4 : 2;
        sensingCtx.shadowColor = 'transparent';
        sensingCtx.shadowBlur = 0;
        sensingCtx.beginPath();
        sensingCtx.moveTo(point.x, point.y);
        sensingCtx.lineTo(next.point.x, next.point.y);
        sensingCtx.stroke();
      });
      sensingCtx.globalAlpha = 1;
      sensingCtx.shadowBlur = 0;
      drawPathModeLabel(sensingCtx, rect, routeMode);
    }

    points.forEach(({ node, point }) => {
      const sz = node.type === 'Cloud' ? 13 : node.type === 'Edge' ? 9 : 6;
      sensingCtx.fillStyle = node.color || '#dce5e4';
      if (node.type === 'Cloud') {
        drawStar(sensingCtx, point.x, point.y, sz, sz * 0.38);
      } else if (node.type === 'Edge') {
        drawTriangle(sensingCtx, point.x, point.y, sz);
      } else {
        sensingCtx.beginPath();
        sensingCtx.arc(point.x, point.y, sz, 0, Math.PI * 2);
      }
      sensingCtx.fill();
      sensingCtx.fillStyle = '#eef7f6';
      sensingCtx.font = '700 12px Segoe UI, sans-serif';
      sensingCtx.fillText(node.id, point.x + 12, point.y - 10);
    });
    drawSensingFlowSequence(sensingCtx, rect, points, situation, time);
    sensingCtx.restore();

    if (el.sensingTitle) el.sensingTitle.textContent = `${situation.id} · 态势数据`;
    if (el.sensingBadge) el.sensingBadge.textContent = `云边端协同态势感知时间 ${durationLabel(timing.elapsedMs)} · ${routeMode}`;
    if (el.tsStats) {
      el.tsStats.innerHTML = [
        ['云边端协同态势感知时间', durationLabel(timing.elapsedMs), timing.done ? '端侧采集→云端形成态势' : '端侧采集→当前'],
        ['状态', timing.status, timing.done ? timeLabel(timing.cloudAt) : '融合计时中']
      ].map(([label, value, hint]) => `<article class="data-stat-card${label === '云边端协同态势感知时间' ? ' fusion-time-card' : ''}">
        <b>${value}</b><span>${label}</span><em>${hint}</em>
      </article>`).join('');
    }
    if (el.tsDetectionList) {
      el.tsDetectionList.innerHTML = `<article class="ts-detection-card fused situation-card">
        <header><b>态势感知状态</b><span>${inbox ? '已接收' : '回传中'}</span></header>
        <div class="packet-kv">
          <span><b>采集时间</b><em>${timeLabel(timing.startAt)}</em></span>
          <span><b>边缘中转</b><em>${timeLabel(timing.relayAt)}</em></span>
          <span><b>云端形成态势</b><em>${timeLabel(timing.cloudAt)}</em></span>
          <span><b>协同感知时间</b><em>${durationLabel(timing.elapsedMs)}</em></span>
          <span><b>响应状态</b><em>${escapeHtml(timing.status)}</em></span>
        </div>
      </article>`;
    }
    renderSensingHoverCard();
    return;
  }
  state.sensingHitNodes = [];
  renderSensingHoverCard();
  if (!frame) {
    if (el.sensingTitle) el.sensingTitle.textContent = '等待协同态势感知帧';
    if (el.sensingBadge) el.sensingBadge.textContent = '未感知';
    if (el.tsStats) el.tsStats.innerHTML = '<div class="empty-state compact">暂无态势感知结果</div>';
    if (el.tsDetectionList) el.tsDetectionList.innerHTML = '';
    return;
  }

  if (el.sensingTitle) el.sensingTitle.textContent = `${frame.id} · ${frame.sourceImageName || state.remoteImageName || '态势数据'}`;
  if (el.sensingBadge) el.sensingBadge.textContent = `${fmt(frame.fusedCount)} 融合 / ${fmt(frame.detections.length)} 目标`;

  const detections = frame.detections || [];
  const nodeMap = new Map(state.nodes.map((node) => [node.id, node]));
  sensingCtx.save();
  for (const detection of detections) {
    const target = tsPoint(detection.target, rect);
    for (const sensorRef of detection.sensor_nodes || []) {
      const sensor = nodeMap.get(sensorRef.node_id);
      if (!sensor) continue;
      const sensorPoint = tsPoint(sensor, rect);
      sensingCtx.globalAlpha = 0.18 + sensorRef.confidence * 0.48;
      sensingCtx.strokeStyle = detection.status === 'fused' ? '#41d6a6' : '#f6c453';
      sensingCtx.lineWidth = 1 + sensorRef.confidence * 1.8;
      sensingCtx.setLineDash([8, 7]);
      sensingCtx.beginPath();
      sensingCtx.moveTo(sensorPoint.x, sensorPoint.y);
      sensingCtx.lineTo(target.x, target.y);
      sensingCtx.stroke();
    }
  }
  sensingCtx.setLineDash([]);

  for (const node of state.nodes.filter((item) => item.type !== 'Cloud').slice(0, 120)) {
    const point = tsPoint(node, rect);
    const sz = node.type === 'Edge' ? 5 : 3;
    sensingCtx.globalAlpha = node.type === 'Edge' ? 0.82 : 0.42;
    sensingCtx.fillStyle = node.color;
    if (node.type === 'Edge') {
      drawTriangle(sensingCtx, point.x, point.y, sz);
    } else {
      sensingCtx.beginPath();
      sensingCtx.arc(point.x, point.y, sz, 0, Math.PI * 2);
    }
    sensingCtx.fill();
    sensingCtx.fill();
  }

  detections.forEach((detection, index) => {
    const point = tsPoint(detection.target, rect);
    const color = detection.status === 'fused' ? '#41d6a6' : detection.status === 'tracking' ? '#70a7ff' : '#f6c453';
    const pulse = 8 + Math.sin(time / 260 + index) * 2.5;
    sensingCtx.globalAlpha = 0.18;
    sensingCtx.fillStyle = color;
    sensingCtx.beginPath();
    sensingCtx.arc(point.x, point.y, 18 + pulse, 0, Math.PI * 2);
    sensingCtx.fill();
    sensingCtx.globalAlpha = 0.95;
    sensingCtx.strokeStyle = color;
    sensingCtx.lineWidth = 2;
    sensingCtx.beginPath();
    sensingCtx.arc(point.x, point.y, 9, 0, Math.PI * 2);
    sensingCtx.stroke();
    sensingCtx.fillStyle = color;
    sensingCtx.beginPath();
    sensingCtx.arc(point.x, point.y, 3.4, 0, Math.PI * 2);
    sensingCtx.fill();
    sensingCtx.fillStyle = '#eef7f6';
    sensingCtx.font = '700 11px Segoe UI, sans-serif';
    sensingCtx.fillText(`${detection.target.id} ${Math.round(detection.confidence * 100)}%`, point.x + 12, point.y - 10);
  });
  sensingCtx.restore();

  if (el.tsStats) {
    el.tsStats.innerHTML = [
      ['目标', fmt(detections.length), '态势目标'],
      ['融合', fmt(frame.fusedCount), '高置信'],
      ['弱感知', fmt(frame.weakCount), '需补采'],
      ['态势数据', state.remoteImageName || frame.sourceImageName || '--', '当前底图']
    ].map(([label, value, hint]) => `<article class="data-stat-card">
      <b>${value}</b><span>${label}</span><em>${hint}</em>
    </article>`).join('');
  }
  if (el.tsDetectionList) {
    el.tsDetectionList.innerHTML = detections.map((detection) => `<article class="ts-detection-card ${detection.status}">
      <header><b>${detection.target.id} · ${detection.target.class}</b><span>${Math.round(detection.confidence * 100)}%</span></header>
      <div class="packet-kv">
        <span><b>融合节点</b><em>${detection.fusion_node_id}</em></span>
        <span><b>感知节点</b><em>${detection.sensor_nodes.map((sensor) => sensor.node_id).join(' / ') || '--'}</em></span>
        <span><b>坐标</b><em>${fmt(detection.target.latitude, 4)}, ${fmt(detection.target.longitude, 4)}</em></span>
        <span><b>时延</b><em>${fmt(detection.latency_ms)} ms</em></span>
      </div>
    </article>`).join('');
  }
}

function drawStar(ctx, cx, cy, outerR, innerR) {
  const points = 5;
  ctx.beginPath();
  for (let i = 0; i < points * 2; i += 1) {
    const r = i % 2 === 0 ? outerR : innerR;
    const angle = (i * Math.PI) / points - Math.PI / 2;
    const x = cx + Math.cos(angle) * r;
    const y = cy + Math.sin(angle) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function drawTriangle(ctx, cx, cy, r) {
  ctx.beginPath();
  for (let i = 0; i < 3; i += 1) {
    const angle = (i * 2 * Math.PI) / 3 - Math.PI / 2;
    const x = cx + Math.cos(angle) * r;
    const y = cy + Math.sin(angle) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function nodeHitRadius(node) {
  return node.type === 'Cloud' ? 24 : node.type === 'Edge' ? 18 : 13;
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

function latestTsFrame() {
  return state.tsSensingFrames?.[0] || null;
}

function drawRemoteImageBackground(context, rect, alpha = 0.78) {
  if (!state.remoteImage) return false;
  const image = state.remoteImage;
  const scale = Math.max(rect.width / image.width, rect.height / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  const x = (rect.width - width) / 2;
  const y = (rect.height - height) / 2;
  context.save();
  context.globalAlpha = alpha;
  context.drawImage(image, x, y, width, height);
  context.fillStyle = 'rgba(4, 13, 22, 0.38)';
  context.fillRect(0, 0, rect.width, rect.height);
  context.restore();
  return true;
}

function median(values) {
  if (!values.length) return 0.5;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function topologyVisualView(nodes) {
  const candidates = nodes.filter((node) => node.type !== 'Cloud');
  const visualNodes = candidates.length >= 3 ? candidates : nodes;
  const xs = visualNodes.map((node) => node.x).filter(Number.isFinite);
  const ys = visualNodes.map((node) => node.y).filter(Number.isFinite);
  if (!xs.length || !ys.length) return { cx: 0.5, cy: 0.5, zoom: 1 };

  const spanX = Math.max(0.08, Math.max(...xs) - Math.min(...xs));
  const spanY = Math.max(0.08, Math.max(...ys) - Math.min(...ys));
  const zoom = clamp(Math.min(0.82 / spanX, 0.74 / spanY), 1, 1.72);
  return {
    cx: median(xs),
    cy: median(ys),
    zoom
  };
}

function applyTopologyVisualZoom(x, y, view) {
  const userViewport = state.topologyViewport || { zoom: 1, cx: 0.5, cy: 0.5 };
  const autoX = view.cx + (x - view.cx) * view.zoom;
  const autoY = view.cy + (y - view.cy) * view.zoom;
  return {
    x: clamp(userViewport.cx + (autoX - userViewport.cx) * userViewport.zoom, -1.8, 2.8),
    y: clamp(userViewport.cy + (autoY - userViewport.cy) * userViewport.zoom, -1.8, 2.8)
  };
}

function toScreen(node, rect, visualView) {
  const pad = 28;
  // Interpolate between previous and current position for smooth motion
  const elapsed = performance.now() - (state._lastStateAt || 0);
  const t = Math.min(1, elapsed / 900); // 900ms blend matching server tick
  const sx = node._prevX !== undefined ? node._prevX + (node.x - node._prevX) * t : node.x;
  const sy = node._prevY !== undefined ? node._prevY + (node.y - node._prevY) * t : node.y;
  const visual = applyTopologyVisualZoom(sx, sy, visualView);
  return {
    x: pad + visual.x * (rect.width - pad * 2),
    y: pad + visual.y * (rect.height - pad * 2)
  };
}

function drawTopology(time = 0) {
  const rect = resizeCanvas(el.networkCanvas, ctx);
  drawBackground(ctx, rect);
  const visualView = topologyVisualView(state.nodes);
  state.nodeScreen.clear();
  for (const node of state.nodes) state.nodeScreen.set(node.id, toScreen(node, rect, visualView));

  ctx.save();
  const hoveredNode = state.popupNodeId;
  for (const link of state.links) {
    const a = state.nodeScreen.get(link.a);
    const b = state.nodeScreen.get(link.b);
    if (!a || !b) continue;
    const connected = hoveredNode && (link.a === hoveredNode || link.b === hoveredNode);
    const linkAlpha = hoveredNode ? (connected ? 0.42 : 0.08) : 0.25;
    const baseLinkColor = link.selfOrganized ? '#41d6a6' : '#5e7a8a';
    ctx.globalAlpha = linkAlpha;
    ctx.strokeStyle = baseLinkColor;
    ctx.lineWidth = link.selfOrganized ? 1.15 : 0.9;
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    if (link.selfOrganized) ctx.setLineDash(link.role === 'terminal-peer' ? [5, 7] : [10, 8]);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    if (link.selfOrganized) ctx.setLineDash([]);

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
  const packets = taskPackets(task);
  if (packets.length) {
    ctx.save();
    for (const packet of packets) {
      const path = packet.path || [];
      const hopCount = Math.max(1, path.length - 1);
      const color = directionColor(packet.direction);
      for (let i = 0; i < path.length - 1; i += 1) {
        const a = state.nodeScreen.get(path[i]);
        const b = state.nodeScreen.get(path[i + 1]);
        if (!a || !b) continue;
        ctx.globalAlpha = packet.direction === 'uplink' ? 0.72 : 0.62;
        ctx.strokeStyle = color;
        ctx.shadowColor = color;
        ctx.shadowBlur = packet.status === 'complete' ? 4 : 12;
        ctx.lineWidth = packet.direction === 'uplink' ? 3.2 : 2.5;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      if (path.length > 1 && packet.status !== 'waiting') {
        const scaled = (packet.progress || 0) * hopCount;
        const hop = Math.min(hopCount - 1, Math.floor(scaled));
        const local = Math.min(1, scaled - hop);
        const a = state.nodeScreen.get(path[hop]);
        const b = state.nodeScreen.get(path[hop + 1]);
        if (a && b) {
          const px = a.x + (b.x - a.x) * local;
          const py = a.y + (b.y - a.y) * local;
          ctx.globalAlpha = 0.95;
          ctx.fillStyle = color;
          ctx.shadowColor = color;
          ctx.shadowBlur = 16;
          ctx.beginPath();
          ctx.arc(px, py, packet.direction === 'uplink' ? 4.5 : 3.8, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    ctx.restore();
  }

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
    const size = node.type === 'Cloud' ? 12 : node.type === 'Edge' ? 8 : 4.5;
    const ring = size + (node.txMbps + node.rxMbps > 0 ? Math.sin(time / 180 + node.pulse * 6.28) * 2 + 5 : 0);
    const color = node.status === 'online' ? node.color : '#58656c';
    const strokeColor = node.status === 'online' ? 'rgba(255,255,255,0.7)' : 'rgba(180,190,190,0.32)';
    ctx.save();
    ctx.fillStyle = color;
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = state.selectedNodeId === node.id ? 2.4 : 1;
    // Glow ring when transmitting
    if (ring > size) {
      ctx.fillStyle = `${color}33`;
      ctx.beginPath();
      ctx.arc(point.x, point.y, ring, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = color;
    }
    if (node.type === 'Cloud') {
      drawStar(ctx, point.x, point.y, size, size * 0.38);
    } else if (node.type === 'Edge') {
      drawTriangle(ctx, point.x, point.y, size);
    } else {
      ctx.beginPath();
      ctx.arc(point.x, point.y, size, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
  updateHover(rect);
}

function renderTrace() {
  const task = selectedTraceTask();
  const rect = resizeCanvas(el.traceCanvas, traceCtx);
  drawBackground(traceCtx, rect);
  if (!task) {
    el.traceTitle.textContent = '暂无数据包';
    el.traceStatus.textContent = '等待调度';
    renderFragments(null);
    drawTraceEmpty(rect, '暂无可追踪数据包', traceEmptyReason(null));
    return;
  }
  const packets = taskPackets(task);
  const firstPacket = packets[0];
  el.traceTitle.textContent = firstPacket ? `${firstPacket.id} · ${directionLabel(firstPacket.direction)} · ${task.origin}` : `${task.id} · 单包追踪`;
  el.traceStatus.textContent = task.status;
  renderFragments(task);
  if (!packets.length) {
    drawTraceEmpty(rect, task.status === 'rejected' ? '任务已拒绝' : '暂无传输包', traceEmptyReason(task));
    return;
  }

  const streams = [
    ...packets.map((packet) => ({ type: 'packet', item: packet }))
  ].slice(0, 8);
  const lanes = Math.max(1, streams.length);
  const top = 48;
  const bottom = rect.height - 42;
  const left = 70;
  const right = rect.width - 70;
  traceCtx.lineWidth = 1;
  traceCtx.font = '12px Segoe UI, sans-serif';

  streams.forEach((stream, index) => {
    const item = stream.item;
    const path = item.path || [];
    const y = top + (bottom - top) * (index + 0.5) / lanes;
    const steps = path.length;
    const color = stream.type === 'packet' ? directionColor(item.direction) : 'rgba(112, 167, 255, 0.9)';
    traceCtx.strokeStyle = stream.type === 'packet' ? `${color}aa` : 'rgba(112, 167, 255, 0.35)';
    traceCtx.beginPath();
    traceCtx.moveTo(left, y);
    traceCtx.lineTo(right, y);
    traceCtx.stroke();

    path.forEach((nodeId, hop) => {
      const x = steps === 1 ? left : left + (right - left) * hop / (steps - 1);
      const node = nodeById(nodeId);
      const size = node?.type === 'Cloud' ? 9 : node?.type === 'Edge' ? 7 : 5;
      traceCtx.fillStyle = node?.color || '#cfd9d8';
      if (node?.type === 'Cloud') {
        drawStar(traceCtx, x, y, size, size * 0.38);
      } else if (node?.type === 'Edge') {
        drawTriangle(traceCtx, x, y, size);
      } else {
        traceCtx.beginPath();
        traceCtx.arc(x, y, size, 0, Math.PI * 2);
      }
      traceCtx.fill();
      traceCtx.fillStyle = '#cbd6d5';
      traceCtx.fillText(nodeId, x - 18, y - 14);
    });

    const p = item.progress || 0;
    const packetX = left + (right - left) * p;
    traceCtx.fillStyle = stream.type === 'packet' ? color : '#ffffff';
    traceCtx.shadowColor = stream.type === 'packet' ? color : 'transparent';
    traceCtx.shadowBlur = stream.type === 'packet' ? 10 : 0;
    traceCtx.beginPath();
    traceCtx.arc(packetX, y, stream.type === 'packet' ? 5 : 4, 0, Math.PI * 2);
    traceCtx.fill();
    traceCtx.shadowBlur = 0;
    traceCtx.fillStyle = '#98a7a6';
    const label = stream.type === 'packet' ? `${item.id} ${directionLabel(item.direction)}` : item.id;
    traceCtx.fillText(label, 12, y + 4);
  });
}

function renderAll() {
  updateSummary();
  renderOriginOptions();
  renderSituationSourceOptions();
  renderDemandPreview();
  renderTaskList();
  renderLinksTable();
  renderTrace();
  renderDataCollection();
  renderTSSensing();
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
  state.packetJourneys = payload.packetJourneys || [];
  state.telemetryRecords = payload.telemetryRecords || [];
  state.relayLogs = payload.relayLogs || [];
  state.cloudInbox = payload.cloudInbox || [];
  state.tsSensingFrames = payload.tsSensingFrames || [];
  state.summary = payload.summary || {};
  state.tick = payload.tick || 0;
  state.paused = payload.paused || false;
  el.togglePause.textContent = state.paused ? '▶ 恢复' : '⏸ 暂停';
  el.togglePause.style.background = state.paused ? '#41d6a6' : '#f6c453';
  if (payload.summary) {
    if (!document.activeElement || document.activeElement !== el.nodeCountInput) {
      el.nodeCountInput.value = payload.summary.nodeCount || el.nodeCountInput.value;
    }
    el.edgeCountInput.max = payload.summary.maxEdgeLimit || Math.floor((payload.summary.nodeCount || 200) / 3);
    el.edgeCountInput.min = 1;
    if (!state.editingEdgeCount && !state.edgeCountTouched) {
      el.edgeCountInput.value = payload.summary.edgeLimit || recommendedEdgeCount(payload.summary.nodeCount || 200);
    }
    if (payload.summary.linkRadius !== undefined) {
      state.linkRadius = payload.summary.linkRadius;
    }
  }
  if (!state.selectedTaskId && state.tasks.length) state.selectedTaskId = latestTraceableTask()?.id || state.tasks[0].id;
  if (state.selectedTaskId && !state.tasks.some((task) => task.id === state.selectedTaskId)) {
    state.selectedTaskId = latestTraceableTask()?.id || state.tasks[0]?.id || null;
  }
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
      renderDemandPreview();
    });
  });

  document.querySelectorAll('.tabs button').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.tabs button').forEach((btn) => btn.classList.remove('active'));
      document.querySelectorAll('.view').forEach((view) => view.classList.remove('active'));
      button.classList.add('active');
      byId(`${button.dataset.view}View`).classList.add('active');
      renderTrace();
      renderTSSensing();
    });
  });

  function loadRemoteImage(file) {
    if (!file) return;
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      if (state._remoteImageUrl) URL.revokeObjectURL(state._remoteImageUrl);
      state._remoteImageUrl = url;
      state.remoteImage = image;
      state.remoteImageName = file.name;
      fillDefaultSituationDescription();
      renderTSSensing();
    };
    image.src = url;
  }

  async function triggerTSSensing() {
    if (!el.triggerTsScan) return;
    el.triggerTsScan.disabled = true;
    if (el.situationStatus) {
      el.situationStatus.className = 'inject-status hidden';
      el.situationStatus.textContent = '';
    }
    try {
      const description = el.situationDescriptionInput?.value?.trim() || '';
      const sourceId = el.situationSourceSelect?.value || '';
      const res = await fetch('/api/situation-descriptions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sourceId,
          imageName: state.remoteImageName || '态势数据',
          description
        })
      });
      if (res.ok) {
        const result = await res.json();
        const stateRes = await fetch('/api/state');
        if (stateRes.ok) applyState(await stateRes.json());
        state.sensingFlowAnimation = { recordId: null, startedAt: 0 };
        document.querySelectorAll('.tabs button').forEach((btn) => btn.classList.toggle('active', btn.dataset.view === 'sensing'));
        document.querySelectorAll('.view').forEach((view) => view.classList.remove('active'));
        byId('sensingView')?.classList.add('active');
        if (el.situationStatus) {
          el.situationStatus.className = 'inject-status accepted';
          el.situationStatus.textContent = `已生成 ${result.record.id}，路径 ${result.route.join(' → ')}`;
        }
      } else if (el.situationStatus) {
        const err = await res.json().catch(() => ({}));
        el.situationStatus.className = 'inject-status rejected';
        el.situationStatus.textContent = err.message || '态势描述上传失败';
      }
    } finally {
      el.triggerTsScan.disabled = false;
    }
  }

  function exportDataset(kind) {
    const endpoint = `/api/export/${kind}?format=csv&limit=1000`;
    fetch(endpoint)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      })
      .then((csv) => downloadText(`${kind}.csv`, csv))
      .catch(() => {
        const rows = localExportRows(kind);
        if (!rows.length) {
          alert('当前页面暂无可导出的数据，请刷新或等待仿真状态加载完成。');
          return;
        }
        downloadText(`${kind}.csv`, rowsToCsv(rows));
      });
  }

  function csvValue(value) {
    if (Array.isArray(value) || (value && typeof value === 'object')) value = JSON.stringify(value);
    const text = value === undefined || value === null ? '' : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  }

  function rowsToCsv(rows) {
    if (!rows.length) return '';
    const headers = Object.keys(rows[0]);
    return [
      headers.join(','),
      ...rows.map((row) => headers.map((header) => csvValue(row[header])).join(','))
    ].join('\n');
  }

  function downloadText(filename, text) {
    const blob = new Blob([`\ufeff${text}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function localExportRows(kind) {
    if (kind === 'nodes') {
      return state.nodes.map((node) => ({
        node_id: node.id,
        name: node.name,
        type: node.type,
        unit_name: node.unitName || node.name || '',
        branch: node.branch || '',
        zone: node.zone,
        longitude: node.longitude ?? '',
        latitude: node.latitude ?? '',
        source_columns: node.sourceColumns || '',
        x: Number(node.x?.toFixed?.(4) ?? node.x),
        y: Number(node.y?.toFixed?.(4) ?? node.y),
        compute_total: Math.round(node.computeTotal || 0),
        compute_free: Math.round(node.computeFree || 0),
        storage_total: Math.round(node.storageTotal || 0),
        storage_free: Math.round(node.storageFree || 0),
        tx_mbps: Number((node.txMbps || 0).toFixed(2)),
        rx_mbps: Number((node.rxMbps || 0).toFixed(2)),
        load: Number((node.load || 0).toFixed(3)),
        status: node.status,
        gateway_edge_id: node.gatewayEdgeId || '',
        backup_edge_id: node.backupEdgeId || '',
        uplink_route_mode: node.multiHopRelay?.mode || 'default',
        uplink_hop_count: node.multiHopRelay?.hopCount || (node.type === 'Cloud' ? 0 : node.type === 'Edge' ? 1 : 2),
        relay_terminal_id: node.multiHopRelay?.relayTerminalId || '',
        relay_edge_id: node.multiHopRelay?.relayEdgeId || ''
      }));
    }
    if (kind === 'links') {
      return state.links.map((link) => ({
        link_id: link.id,
        node_a: link.a,
        node_b: link.b,
        role: link.role,
        bandwidth_mbps: Math.round(link.bandwidth || 0),
        latency_ms: Math.round(link.latency || 0),
        loss_rate: Number((link.loss || 0).toFixed(2)),
        utilization: Number((link.utilization || 0).toFixed(3)),
        distance_m: Number((link.distance || 0).toFixed(1)),
        active: Boolean(link.active),
        persistent: Boolean(link.persistent),
        topology_layer: link.topologyLayer || ''
      }));
    }
    if (kind === 'tasks') {
      return state.tasks.map((task) => ({
        task_id: task.id,
        origin_node_id: task.origin,
        demand_compute: Math.round(task.demand?.compute || 0),
        demand_storage: Math.round(task.demand?.storage || 0),
        demand_data: Math.round(task.demand?.data || 0),
        priority: task.priority,
        split_strategy: task.splitStrategy,
        status: task.status,
        accepted: Boolean(task.accepted),
        progress: Number((task.progress || 0).toFixed(3)),
        fragment_count: task.fragments?.length || 0,
        graph_node_count: task.taskGraph?.nodes?.length || 0,
        graph_edge_count: task.taskGraph?.edges?.length || 0,
        message: task.message || ''
      }));
    }
    if (kind === 'telemetry') {
      return state.telemetryRecords.map((record) => ({
        record_id: record.id,
        task_id: record.taskId,
        packet_id: record.packetId,
        payload_kind: record.payload?.kind || 'sensor_sample',
        source_node_id: record.source,
        source_name: record.sourceName,
        via_edge_id: record.viaEdge,
        target_node_id: record.target,
        path: record.path,
        image_name: record.payload?.imageName || '',
        situation_description: record.payload?.description || '',
        latitude: record.payload?.latitude || '',
        longitude: record.payload?.longitude || '',
        signal_strength: record.payload?.signalStrength || '',
        sample_size_mb: record.payload?.sampleSizeMb || '',
        status: record.status,
        created_at: record.createdAt ? new Date(record.createdAt).toISOString() : '',
        received_at: record.receivedAt ? new Date(record.receivedAt).toISOString() : ''
      }));
    }
    return [];
  }

  async function resetSimulation() {
    const nodeCount = Number(el.nodeCountInput.value);
    if (!Number.isFinite(nodeCount) || nodeCount < 3 || nodeCount > 2000) {
      alert('节点数量需在 3-2000 之间');
      return;
    }
    const edgeCount = Number(el.edgeCountInput.value);
    const maxEdge = Math.floor(nodeCount / 3);
    if (!Number.isFinite(edgeCount) || edgeCount < 1 || edgeCount > maxEdge) {
      alert(`边缘节点数量需在 1-${maxEdge} 之间`);
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
        state.edgeCountTouched = false;
        state.editingEdgeCount = false;
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
    el.edgeCountInput.min = 1;
    state.edgeCountTouched = false;
    el.edgeCountInput.value = recommendedEdgeCount(nodeCount);
  });
  el.edgeCountInput.addEventListener('focus', () => {
    state.editingEdgeCount = true;
  });
  el.edgeCountInput.addEventListener('input', () => {
    state.editingEdgeCount = true;
    state.edgeCountTouched = true;
  });
  el.edgeCountInput.addEventListener('blur', () => {
    state.editingEdgeCount = false;
    const nodeCount = Number(el.nodeCountInput.value) || state.summary.nodeCount || 200;
    const maxEdge = Math.floor(nodeCount / 3);
    const value = Number(el.edgeCountInput.value);
    if (Number.isFinite(value)) {
      el.edgeCountInput.value = Math.min(maxEdge, Math.max(1, Math.round(value)));
    }
  });
  [el.computeInput, el.storageInput, el.dataInput].forEach((input) => {
    input.addEventListener('input', renderDemandPreview);
  });
  el.injectTask.addEventListener('click', injectTask);
  el.resetSim.addEventListener('click', resetSimulation);
  el.togglePause.addEventListener('click', togglePause);
  el.remoteImageInput?.addEventListener('change', (event) => loadRemoteImage(event.target.files?.[0]));
  el.situationSourceSelect?.addEventListener('change', () => fillDefaultSituationDescription(true));
  el.triggerTsScan?.addEventListener('click', triggerTSSensing);
  el.sensingCanvas?.addEventListener('mousemove', (event) => {
    const rect = el.sensingCanvas.getBoundingClientRect();
    state.sensingMouse = { x: event.clientX - rect.left, y: event.clientY - rect.top, inside: true };
    renderSensingHoverCard();
  });
  el.sensingCanvas?.addEventListener('mouseleave', () => {
    state.sensingMouse.inside = false;
    if (el.sensingHoverCard) el.sensingHoverCard.className = 'sensing-hover-card hidden';
    if (el.sensingCanvas) el.sensingCanvas.style.cursor = '';
  });
  document.querySelectorAll('.collapsible-panel').forEach((panel) => {
    const trigger = panel.querySelector('.collapsible-trigger');
    const label = trigger?.querySelector('em');
    if (!trigger) return;
    const sync = () => {
      const collapsed = panel.classList.contains('collapsed');
      trigger.setAttribute('aria-expanded', String(!collapsed));
      if (label) label.textContent = collapsed ? '展开' : '收起';
    };
    sync();
    trigger.addEventListener('click', () => {
      panel.classList.toggle('collapsed');
      sync();
    });
  });
  document.querySelectorAll('[data-export]').forEach((button) => {
    button.addEventListener('click', () => exportDataset(button.dataset.export));
  });
  el.networkCanvas.addEventListener('mousemove', (event) => {
    const rect = el.networkCanvas.getBoundingClientRect();
    state.mouse = { x: event.clientX - rect.left, y: event.clientY - rect.top, inside: true };
  });
  el.networkCanvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    const rect = el.networkCanvas.getBoundingClientRect();
    const pad = 28;
    const innerW = Math.max(1, rect.width - pad * 2);
    const innerH = Math.max(1, rect.height - pad * 2);
    const mx = clamp((event.clientX - rect.left - pad) / innerW, 0, 1);
    const my = clamp((event.clientY - rect.top - pad) / innerH, 0, 1);
    const current = state.topologyViewport || { zoom: 1, cx: 0.5, cy: 0.5 };
    const nextZoom = clamp(current.zoom * (event.deltaY < 0 ? 1.18 : 1 / 1.18), 1, 6);
    if (Math.abs(nextZoom - current.zoom) < 0.001) return;
    const ratio = current.zoom / nextZoom;
    state.topologyViewport = {
      zoom: nextZoom,
      cx: clamp(mx - (mx - current.cx) * ratio, 0, 1),
      cy: clamp(my - (my - current.cy) * ratio, 0, 1)
    };
    state.mouse = { x: event.clientX - rect.left, y: event.clientY - rect.top, inside: true };
    el.nodePopup.classList.add('hidden');
    state.popupNodeId = null;
    state._hoveredNodeId = null;
    state.popupRenderKey = null;
  }, { passive: false });
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
    const dataView = byId('dataView');
    if (dataView?.classList.contains('active')) {
      drawDataCollection(renderTime);
      renderDataCollection();
    }
    const sensingView = byId('sensingView');
    if (sensingView?.classList.contains('active')) renderTSSensing(time);
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
