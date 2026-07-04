import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 4173);
const NODE_COUNT = 200;
const TICK_MS = 900;
const TASK_INTERVAL_MS = 6800;
const MAX_TASKS = 36;

const nodeTypes = [
  { type: 'Core', label: '核心算力', compute: [760, 1080], storage: [850, 1350], color: '#f6c453' },
  { type: 'Edge', label: '边缘节点', compute: [320, 680], storage: [360, 920], color: '#41d6a6' },
  { type: 'Access', label: '接入节点', compute: [120, 360], storage: [180, 520], color: '#70a7ff' },
  { type: 'Relay', label: '中继节点', compute: [160, 440], storage: [220, 620], color: '#f17f8a' }
];

const mime = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg']
]);

let seed = Number(process.env.SIM_SEED || 20260704);
const clients = new Set();
const nodes = [];
const links = [];
const tasks = [];
let nextTaskId = 1;
let lastAutoTaskAt = 0;
let tickCount = 0;

function random() {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
}

function between(min, max) {
  return min + random() * (max - min);
}

function choose(items) {
  return items[Math.floor(random() * items.length)];
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function createNodes() {
  const zones = [
    { id: 'A', cx: 0.23, cy: 0.28 },
    { id: 'B', cx: 0.73, cy: 0.24 },
    { id: 'C', cx: 0.31, cy: 0.72 },
    { id: 'D', cx: 0.72, cy: 0.68 },
    { id: 'E', cx: 0.51, cy: 0.48 }
  ];

  for (let i = 0; i < NODE_COUNT; i += 1) {
    const typeInfo = i < 12 ? nodeTypes[0] : i < 74 ? nodeTypes[1] : i < 156 ? nodeTypes[2] : nodeTypes[3];
    const zone = choose(zones);
    const radius = typeInfo.type === 'Core' ? 0.08 : 0.16;
    const angle = between(0, Math.PI * 2);
    const spread = Math.sqrt(random()) * radius;
    const computeTotal = Math.round(between(typeInfo.compute[0], typeInfo.compute[1]));
    const storageTotal = Math.round(between(typeInfo.storage[0], typeInfo.storage[1]));

    nodes.push({
      id: `N${String(i + 1).padStart(3, '0')}`,
      name: `${typeInfo.label}-${String(i + 1).padStart(3, '0')}`,
      type: typeInfo.type,
      label: typeInfo.label,
      zone: zone.id,
      x: clamp(zone.cx + Math.cos(angle) * spread + between(-0.018, 0.018), 0.04, 0.96),
      y: clamp(zone.cy + Math.sin(angle) * spread + between(-0.018, 0.018), 0.06, 0.94),
      computeTotal,
      storageTotal,
      computeFree: Math.round(computeTotal * between(0.58, 0.96)),
      storageFree: Math.round(storageTotal * between(0.52, 0.95)),
      txMbps: 0,
      rxMbps: 0,
      load: between(0.08, 0.42),
      status: 'online',
      color: typeInfo.color,
      pulse: random()
    });
  }
}

function distance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function linkKey(a, b) {
  return [a.id, b.id].sort().join('-');
}

function createLinks() {
  const existing = new Set();
  const addLink = (a, b, qualityBias = 1) => {
    if (a.id === b.id) return;
    const key = linkKey(a, b);
    if (existing.has(key)) return;
    existing.add(key);
    const d = distance(a, b);
    links.push({
      id: `L${String(links.length + 1).padStart(4, '0')}`,
      a: a.id,
      b: b.id,
      distance: Number((d * 1000).toFixed(1)),
      bandwidth: Math.round(between(160, 900) * qualityBias),
      latency: Math.round(between(4, 38) / qualityBias + d * 70),
      loss: Number(between(0.1, 2.8 / qualityBias).toFixed(2)),
      utilization: Number(between(0.06, 0.52).toFixed(2)),
      active: random() > 0.045,
      changedAt: Date.now()
    });
  };

  for (const node of nodes) {
    const neighbors = nodes
      .filter((candidate) => candidate.id !== node.id)
      .map((candidate) => ({ candidate, d: distance(node, candidate) }))
      .sort((left, right) => left.d - right.d)
      .slice(0, node.type === 'Core' ? 8 : 5);

    for (const neighbor of neighbors) addLink(node, neighbor.candidate, node.type === 'Core' || neighbor.candidate.type === 'Core' ? 1.22 : 1);
  }

  for (let i = 0; i < 42; i += 1) {
    const coreOrEdge = nodes.filter((node) => node.type === 'Core' || node.type === 'Edge');
    addLink(choose(coreOrEdge), choose(coreOrEdge), 1.36);
  }
}

function getNode(id) {
  return nodes.find((node) => node.id === id);
}

function activeLinksFor(nodeId) {
  return links.filter((link) => link.active && (link.a === nodeId || link.b === nodeId));
}

function neighborMap() {
  const map = new Map(nodes.map((node) => [node.id, new Set()]));
  for (const link of links) {
    if (!link.active) continue;
    map.get(link.a).add(link.b);
    map.get(link.b).add(link.a);
  }
  return map;
}

function findPathWithinTwoHops(originId, targetId) {
  if (originId === targetId) return [originId];
  const map = neighborMap();
  if (map.get(originId)?.has(targetId)) return [originId, targetId];
  for (const mid of map.get(originId) || []) {
    if (map.get(mid)?.has(targetId)) return [originId, mid, targetId];
  }
  return null;
}

function linkBetween(a, b) {
  return links.find((link) => link.active && ((link.a === a && link.b === b) || (link.a === b && link.b === a)));
}

function pathMetrics(pathIds) {
  if (!pathIds || pathIds.length < 2) {
    return { bottleneck: 0, latency: 0, loss: 0, utilization: 0, score: 0 };
  }
  const pathLinks = [];
  for (let i = 0; i < pathIds.length - 1; i += 1) {
    const link = linkBetween(pathIds[i], pathIds[i + 1]);
    if (!link) return null;
    pathLinks.push(link);
  }
  const bottleneck = Math.min(...pathLinks.map((link) => link.bandwidth * (1 - link.utilization)));
  const latency = pathLinks.reduce((sum, link) => sum + link.latency, 0);
  const loss = pathLinks.reduce((sum, link) => sum + link.loss, 0);
  const utilization = pathLinks.reduce((sum, link) => sum + link.utilization, 0) / pathLinks.length;
  const score = bottleneck / 900 - latency / 180 - loss / 12 - utilization * 0.5;
  return { bottleneck, latency, loss, utilization, score };
}

function twoHopCandidates(originId, demand) {
  return nodes
    .map((node) => {
      const path = findPathWithinTwoHops(originId, node.id);
      if (!path || node.status !== 'online') return null;
      const metrics = pathMetrics(path);
      if (!metrics) return null;
      const resourceScore = node.computeFree / Math.max(1, node.computeTotal) + node.storageFree / Math.max(1, node.storageTotal);
      const canHold = node.computeFree >= demand.compute * 0.08 && node.storageFree >= demand.storage * 0.06;
      return {
        node,
        path,
        metrics,
        score: resourceScore * 1.7 + metrics.score + (node.type === 'Core' ? 0.22 : 0),
        canHold
      };
    })
    .filter(Boolean)
    .filter((candidate) => candidate.canHold)
    .sort((left, right) => right.score - left.score);
}

function createTask(payload = {}) {
  const online = nodes.filter((node) => node.status === 'online');
  const origin = payload.origin && getNode(payload.origin) ? getNode(payload.origin) : choose(online);
  const demand = {
    compute: Number(payload.compute || Math.round(between(520, 1680))),
    storage: Number(payload.storage || Math.round(between(220, 820))),
    data: Number(payload.data || Math.round(between(180, 920)))
  };
  const priority = payload.priority || choose(['低', '中', '高', '紧急']);
  const candidates = twoHopCandidates(origin.id, demand).slice(0, 12);
  let remainingCompute = demand.compute;
  let remainingStorage = demand.storage;
  const fragments = [];

  for (const candidate of candidates) {
    if (remainingCompute <= 0 || remainingStorage <= 0) break;
    const computeSlice = Math.min(Math.round(demand.compute * between(0.14, 0.34)), candidate.node.computeFree, remainingCompute);
    const storageSlice = Math.min(Math.round(demand.storage * between(0.12, 0.31)), candidate.node.storageFree, remainingStorage);
    if (computeSlice < 24 || storageSlice < 10) continue;
    candidate.node.computeFree -= computeSlice;
    candidate.node.storageFree -= storageSlice;
    remainingCompute -= computeSlice;
    remainingStorage -= storageSlice;
    fragments.push({
      id: `${nextTaskId}-${fragments.length + 1}`,
      nodeId: candidate.node.id,
      path: candidate.path,
      compute: computeSlice,
      storage: storageSlice,
      data: Math.max(12, Math.round(demand.data * computeSlice / demand.compute)),
      progress: 0,
      stage: 'queued',
      latency: Math.round(candidate.metrics.latency),
      bottleneck: Math.round(candidate.metrics.bottleneck),
      score: Number(candidate.score.toFixed(2))
    });
  }

  const accepted = remainingCompute <= demand.compute * 0.22 && fragments.length > 0;
  const task = {
    id: `T${String(nextTaskId++).padStart(4, '0')}`,
    createdAt: Date.now(),
    origin: origin.id,
    demand,
    priority,
    status: accepted ? 'dispatching' : 'rejected',
    accepted,
    remaining: { compute: Math.max(0, remainingCompute), storage: Math.max(0, remainingStorage) },
    fragments,
    trace: fragments.flatMap((fragment) => fragment.path.map((nodeId, order) => ({ nodeId, order, fragmentId: fragment.id }))).slice(0, 80),
    message: accepted ? '2-hop elastic scheduling accepted' : 'insufficient resource/link quality within 2 hops'
  };

  tasks.unshift(task);
  while (tasks.length > MAX_TASKS) tasks.pop();
  return task;
}

function releaseTaskResources(task) {
  if (task.released) return;
  for (const fragment of task.fragments) {
    const node = getNode(fragment.nodeId);
    if (!node) continue;
    node.computeFree = Math.min(node.computeTotal, node.computeFree + fragment.compute);
    node.storageFree = Math.min(node.storageTotal, node.storageFree + fragment.storage);
  }
  task.released = true;
}

function simulateLinks() {
  for (const link of links) {
    const drift = between(-0.055, 0.065);
    link.utilization = Number(clamp(link.utilization + drift, 0.02, 0.94).toFixed(2));
    link.latency = Math.round(clamp(link.latency + between(-3, 4), 3, 110));
    link.loss = Number(clamp(link.loss + between(-0.18, 0.2), 0.02, 8.5).toFixed(2));
    if (random() < 0.012) {
      link.active = !link.active;
      link.changedAt = Date.now();
    }
  }
}

function simulateNodes() {
  for (const node of nodes) {
    node.txMbps = 0;
    node.rxMbps = 0;
    node.pulse = (node.pulse + between(0.025, 0.075)) % 1;
    node.load = clamp(1 - node.computeFree / node.computeTotal + between(-0.015, 0.02), 0.02, 0.98);
    if (random() < 0.004 && node.type !== 'Core') node.status = node.status === 'online' ? 'degraded' : 'online';
    if (node.status === 'degraded' && random() < 0.12) node.status = 'online';
    const idleRecover = node.status === 'online' ? between(1, 7) : between(0, 2);
    node.computeFree = Math.min(node.computeTotal, Math.round(node.computeFree + idleRecover));
    node.storageFree = Math.min(node.storageTotal, Math.round(node.storageFree + between(0, 2)));
  }
}

function simulateTasks() {
  const now = Date.now();
  for (const task of tasks) {
    if (!task.accepted || task.status === 'complete' || task.status === 'rejected') continue;
    let total = 0;
    for (const fragment of task.fragments) {
      if (fragment.progress >= 1) continue;
      fragment.stage = fragment.progress < 0.22 ? 'transmitting' : fragment.progress < 0.82 ? 'executing' : 'returning';
      const speed = fragment.bottleneck / Math.max(120, fragment.data * 2.8);
      fragment.progress = clamp(fragment.progress + speed * between(0.035, 0.08), 0, 1);
      for (let i = 0; i < fragment.path.length - 1; i += 1) {
        const a = getNode(fragment.path[i]);
        const b = getNode(fragment.path[i + 1]);
        const link = linkBetween(fragment.path[i], fragment.path[i + 1]);
        if (a) a.txMbps += Math.round(fragment.data * 0.035);
        if (b) b.rxMbps += Math.round(fragment.data * 0.032);
        if (link) link.utilization = Number(clamp(link.utilization + 0.012, 0.02, 0.98).toFixed(2));
      }
      total += fragment.progress;
    }
    const progress = total / Math.max(1, task.fragments.length);
    task.progress = Number(progress.toFixed(3));
    task.status = progress >= 0.98 ? 'complete' : progress > 0.08 ? 'running' : 'dispatching';
    task.elapsedMs = now - task.createdAt;
    if (task.status === 'complete') releaseTaskResources(task);
  }
}

function snapshot() {
  const onlineNodes = nodes.filter((node) => node.status === 'online').length;
  const activeLinks = links.filter((link) => link.active).length;
  const avgUtil = links.reduce((sum, link) => sum + link.utilization, 0) / links.length;
  const runningTasks = tasks.filter((task) => ['dispatching', 'running'].includes(task.status)).length;

  return {
    tick: tickCount,
    generatedAt: Date.now(),
    summary: {
      nodeCount: nodes.length,
      onlineNodes,
      activeLinks,
      totalLinks: links.length,
      avgUtilization: Number(avgUtil.toFixed(2)),
      runningTasks,
      completeTasks: tasks.filter((task) => task.status === 'complete').length,
      rejectedTasks: tasks.filter((task) => task.status === 'rejected').length
    },
    nodes,
    links,
    tasks: tasks.slice(0, 18)
  };
}

function broadcast(event, data) {
  const encoded = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(encoded);
}

function step() {
  tickCount += 1;
  simulateLinks();
  simulateNodes();
  simulateTasks();
  const now = Date.now();
  if (now - lastAutoTaskAt > TASK_INTERVAL_MS) {
    lastAutoTaskAt = now;
    const task = createTask();
    broadcast('task', task);
  }
  broadcast('state', snapshot());
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const filePath = path.normalize(path.join(publicDir, pathname));
  if (!filePath.startsWith(publicDir) || !existsSync(filePath)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  const data = await readFile(filePath);
  res.writeHead(200, {
    'content-type': mime.get(path.extname(filePath)) || 'application/octet-stream',
    'cache-control': 'no-cache'
  });
  res.end(data);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/api/state' && req.method === 'GET') return json(res, 200, snapshot());
    if (url.pathname === '/api/tasks' && req.method === 'GET') return json(res, 200, tasks.slice(0, 30));
    if (url.pathname === '/api/tasks' && req.method === 'POST') {
      const body = await readBody(req);
      const task = createTask(body);
      broadcast('task', task);
      broadcast('state', snapshot());
      return json(res, task.accepted ? 201 : 409, task);
    }
    if (url.pathname === '/api/events' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no'
      });
      res.write(`event: state\ndata: ${JSON.stringify(snapshot())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    await serveStatic(req, res);
  } catch (error) {
    console.error(error);
    json(res, 500, { error: 'internal_error', message: error.message });
  }
});

createNodes();
createLinks();
createTask({ priority: '高' });
setInterval(step, TICK_MS);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Comm-compute network simulator running at http://127.0.0.1:${PORT}`);
  console.log(`Nodes: ${nodes.length}, links: ${links.length}`);
});
