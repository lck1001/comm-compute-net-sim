import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 4173);
let NODE_COUNT = Number(process.env.NODE_COUNT || 200);
const TICK_MS = 900;
const TASK_INTERVAL_MS = 6800;
const MAX_TASKS = 36;
const MAX_PACKET_JOURNEYS = 96;

function defaultEdgeCount(total) {
  return Math.min(total - 1, Math.max(10, Math.ceil(total / 3)));
}
const MAX_EDGE_RATIO = 1 / 3;
let EDGE_COUNT = process.env.EDGE_COUNT
  ? Math.min(Math.floor(NODE_COUNT * MAX_EDGE_RATIO), Math.max(3, Number(process.env.EDGE_COUNT)))
  : defaultEdgeCount(NODE_COUNT);
let LINK_RADIUS = Number(process.env.LINK_RADIUS || 0.55);

const nodeTypes = [
  { type: 'Cloud', label: '云节点', compute: [1800, 2400], storage: [2200, 3200], color: '#f6c453' },
  { type: 'Edge', label: '边缘节点', compute: [520, 980], storage: [640, 1280], color: '#41d6a6' },
  { type: 'Terminal', label: '终端节点', compute: [100, 360], storage: [120, 520], color: '#70a7ff' }
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
const packetJourneys = [];
let nextTaskId = 1;
let nextLinkId = 1;
let nextPacketId = 1;
let lastAutoTaskAt = 0;
let tickCount = 0;
let paused = false;

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
    const typeInfo = i === 0 ? nodeTypes[0] : i <= EDGE_COUNT ? nodeTypes[1] : nodeTypes[2];
    const zone = typeInfo.type === 'Cloud' ? zones[4] : choose(zones);
    const radius = typeInfo.type === 'Cloud' ? 0.02 : typeInfo.type === 'Edge' ? 0.1 : 0.17;
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
      x: typeInfo.type === 'Cloud' ? 0.51 : clamp(zone.cx + Math.cos(angle) * spread + between(-0.018, 0.018), 0.04, 0.96),
      y: typeInfo.type === 'Cloud' ? 0.48 : clamp(zone.cy + Math.sin(angle) * spread + between(-0.018, 0.018), 0.06, 0.94),
      computeTotal,
      storageTotal,
      computeFree: computeTotal,
      storageFree: storageTotal,
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

function typeRank(type) {
  return type === 'Cloud' ? 3 : type === 'Edge' ? 2 : 1;
}

function linkRole(a, b, fallback = 'flex') {
  const types = [a.type, b.type].sort().join('-');
  if (types === 'Cloud-Edge') return 'edge-cloud';
  if (types === 'Edge-Terminal') return 'terminal-edge';
  if (types === 'Edge-Edge') return 'edge-mesh';
  if (types === 'Terminal-Terminal') return 'terminal-peer';
  if (types === 'Cloud-Terminal') return 'terminal-cloud-exception';
  return fallback;
}

function linkProfile(role, d) {
  const profiles = {
    'edge-cloud': {
      bandwidth: [1300, 2400],
      latency: [8, 22],
      loss: [0.02, 0.32],
      utilization: [0.06, 0.24],
      distanceFactor: 28
    },
    'terminal-edge': {
      bandwidth: [320, 980],
      latency: [5, 28],
      loss: [0.05, 1.4],
      utilization: [0.08, 0.36],
      distanceFactor: 46
    },
    'edge-mesh': {
      bandwidth: [650, 1600],
      latency: [6, 26],
      loss: [0.04, 0.8],
      utilization: [0.06, 0.3],
      distanceFactor: 34
    },
    'terminal-peer': {
      bandwidth: [120, 420],
      latency: [8, 44],
      loss: [0.2, 2.8],
      utilization: [0.06, 0.42],
      distanceFactor: 58
    },
    flex: {
      bandwidth: [160, 900],
      latency: [4, 38],
      loss: [0.1, 2.8],
      utilization: [0.06, 0.52],
      distanceFactor: 70
    }
  };
  const profile = profiles[role] || profiles.flex;
  return {
    bandwidth: Math.round(between(profile.bandwidth[0], profile.bandwidth[1])),
    latency: Math.round(between(profile.latency[0], profile.latency[1]) + d * profile.distanceFactor),
    loss: Number(between(profile.loss[0], profile.loss[1]).toFixed(2)),
    utilization: Number(between(profile.utilization[0], profile.utilization[1]).toFixed(2))
  };
}

function createPhysicalLink(aId, bId, options = {}) {
  const key = linkKey({ id: aId }, { id: bId });
  let link = links.find((l) => linkKey({ id: l.a }, { id: l.b }) === key);
  if (link) {
    if (options.persistent) link.persistent = true;
    if (options.role) link.role = options.role;
    if (options.active !== false && !link.active) link.changedAt = Date.now();
    if (options.active !== false) link.active = true;
    link.lastUsedAt = Date.now();
    return link;
  }
  const nodeA = getNode(aId);
  const nodeB = getNode(bId);
  if (!nodeA || !nodeB) return null;
  const d = distance(nodeA, nodeB);
  if (!options.force && d > LINK_RADIUS) return null;
  const role = options.role || linkRole(nodeA, nodeB);
  const metrics = linkProfile(role, d);
  link = {
    id: `L${String(nextLinkId++).padStart(4, '0')}`,
    a: aId,
    b: bId,
    distance: Number((d * 1000).toFixed(1)),
    ...metrics,
    role,
    active: options.active !== false,
    persistent: Boolean(options.persistent),
    lastUsedAt: Date.now(),
    changedAt: Date.now()
  };
  links.push(link);
  return link;
}

// Dynamic link creation. Non-persistent links are only materialized when data flows.
function ensureLink(aId, bId) {
  return createPhysicalLink(aId, bId, { active: true });
}

function nearestNodes(source, candidates, limit, options = {}) {
  return [...candidates]
    .filter((node) => node.id !== source.id)
    .map((node) => {
      const sameZoneBonus = options.sameZoneBonus && node.zone === source.zone ? options.sameZoneBonus : 1;
      const typeBias = options.typeBias?.[node.type] || 1;
      return { node, score: distance(source, node) * sameZoneBonus * typeBias };
    })
    .sort((left, right) => left.score - right.score)
    .slice(0, limit)
    .map((item) => item.node);
}

function createStableTopology() {
  const cloud = nodes.find((node) => node.type === 'Cloud');
  const edges = nodes.filter((node) => node.type === 'Edge');
  const terminals = nodes.filter((node) => node.type === 'Terminal');
  if (!cloud || !edges.length) return;

  for (const edge of edges) {
    createPhysicalLink(edge.id, cloud.id, {
      role: 'edge-cloud',
      persistent: true,
      active: true,
      force: true
    });
    const meshPeers = nearestNodes(edge, edges, edges.length <= 20 ? 3 : 2, { sameZoneBonus: 0.62 });
    for (const peer of meshPeers) {
      createPhysicalLink(edge.id, peer.id, {
        role: 'edge-mesh',
        persistent: true,
        active: true,
        force: true
      });
    }
  }

  for (const terminal of terminals) {
    const gateways = nearestNodes(terminal, edges, 2, { sameZoneBonus: 0.42 });
    terminal.gatewayEdgeId = gateways[0]?.id || edges[0].id;
    terminal.backupEdgeId = gateways[1]?.id || terminal.gatewayEdgeId;
    for (const gateway of gateways) {
      createPhysicalLink(terminal.id, gateway.id, {
        role: 'terminal-edge',
        persistent: true,
        active: true,
        force: true
      });
    }

    const peers = nearestNodes(terminal, terminals.filter((node) => node.zone === terminal.zone), 1);
    for (const peer of peers) {
      createPhysicalLink(terminal.id, peer.id, {
        role: 'terminal-peer',
        persistent: false,
        active: false,
        force: true
      });
    }
  }
}

function applyForceLayout() {
  // Scale iterations to keep perf reasonable: fewer iters for larger networks
  const iterations = nodes.length <= 200 ? 80 : nodes.length <= 500 ? 50 : nodes.length <= 1000 ? 30 : 18;
  // Use potential connections (within LINK_RADIUS) as the attract/repel basis
  const potentialPairs = new Set();
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      if (distance(nodes[i], nodes[j]) <= LINK_RADIUS) {
        potentialPairs.add(linkKey(nodes[i], nodes[j]));
      }
    }
  }
  const forces = nodes.map(() => ({ fx: 0, fy: 0 }));
  const dt = 0.12;
  const attractStrength = 0.018;
  const repelStrength = 0.0008;
  let damping = 0.82;

  for (let iter = 0; iter < iterations; iter += 1) {
    // Reset forces
    for (let i = 0; i < nodes.length; i += 1) forces[i].fx = forces[i].fy = 0;

    // Compute forces between all pairs
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const dx = nodes[j].x - nodes[i].x;
        const dy = nodes[j].y - nodes[i].y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 0.001;
        const linked = potentialPairs.has(linkKey(nodes[i], nodes[j]));
        if (linked) {
          // Attraction: pull connected nodes toward each other, target = linkRadius * 0.7
          const target = LINK_RADIUS * 0.7;
          const force = (dist - target) * attractStrength;
          const fx = dx / dist * force;
          const fy = dy / dist * force;
          forces[i].fx += fx;
          forces[i].fy += fy;
          forces[j].fx -= fx;
          forces[j].fy -= fy;
        } else {
          // Repulsion: push unconnected nodes apart
          const force = repelStrength / (dist * dist);
          const fx = dx / dist * force;
          const fy = dy / dist * force;
          forces[i].fx -= fx;
          forces[i].fy -= fy;
          forces[j].fx += fx;
          forces[j].fy += fy;
        }
      }
    }

    // Apply forces with damping
    for (let i = 0; i < nodes.length; i += 1) {
      nodes[i].x = clamp(nodes[i].x + forces[i].fx * dt * damping, 0.04, 0.96);
      nodes[i].y = clamp(nodes[i].y + forces[i].fy * dt * damping, 0.06, 0.94);
    }
    damping *= 0.955;
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
  // Include materialized active links
  for (const link of links) {
    if (!link.active) continue;
    map.get(link.a).add(link.b);
    map.get(link.b).add(link.a);
  }
  // Also include potential connections: any two nodes within LINK_RADIUS can communicate
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      if (distance(nodes[i], nodes[j]) <= LINK_RADIUS) {
        map.get(nodes[i].id).add(nodes[j].id);
        map.get(nodes[j].id).add(nodes[i].id);
      }
    }
  }
  return map;
}

function pathPolicyScore(pathIds) {
  if (!pathIds || pathIds.length < 2) return 0.6;
  const pathNodes = pathIds.map(getNode).filter(Boolean);
  if (pathNodes.length !== pathIds.length) return 0;
  const ranks = pathNodes.map((node) => typeRank(node.type));
  const layered = ranks.every((rank, index) => index === 0 || rank >= ranks[index - 1]);
  const reverseLayered = ranks.every((rank, index) => index === 0 || rank <= ranks[index - 1]);
  const hasEdgeBridge = pathNodes.some((node) => node.type === 'Edge');
  const terminalCloudDirect = pathNodes.length === 2 && pathNodes.some((node) => node.type === 'Terminal') && pathNodes.some((node) => node.type === 'Cloud');
  let score = 0.52;
  if (layered || reverseLayered) score += 0.32;
  if (hasEdgeBridge) score += 0.18;
  if (terminalCloudDirect) score -= 0.28;
  if (pathNodes.length === 3 && pathNodes[1].type === 'Edge') score += 0.18;
  return clamp(score, 0.18, 1.24);
}

function findPathWithinTwoHops(originId, targetId) {
  if (originId === targetId) return [originId];
  const map = neighborMap();
  const paths = [];
  if (map.get(originId)?.has(targetId)) paths.push([originId, targetId]);
  for (const mid of map.get(originId) || []) {
    if (map.get(mid)?.has(targetId)) paths.push([originId, mid, targetId]);
  }
  if (!paths.length) return null;
  return paths
    .map((path) => ({ path, metrics: pathMetrics(path), policy: pathPolicyScore(path) }))
    .filter((item) => item.metrics)
    .sort((left, right) => (right.policy + right.metrics.score * 0.35) - (left.policy + left.metrics.score * 0.35))[0]?.path || null;
}

function linkBetween(a, b) {
  // First check existing materialized link
  const existing = links.find((link) => (link.a === a && link.b === b) || (link.a === b && link.b === a));
  if (existing) return existing;
  // Fallback: if nodes are within LINK_RADIUS, return a virtual link for metrics
  const nodeA = getNode(a);
  const nodeB = getNode(b);
  if (!nodeA || !nodeB) return null;
  const d = distance(nodeA, nodeB);
  if (d > LINK_RADIUS) return null;
  return {
    a, b,
    distance: Number((d * 1000).toFixed(1)),
    bandwidth: Math.round(between(160, 900)),
    latency: Math.round(between(4, 38) + d * 70),
    loss: Number(between(0.1, 2.8).toFixed(2)),
    utilization: 0.2,
    active: true
  };
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

function activeLinkBetween(a, b, role) {
  return links.find((link) => {
    const samePair = (link.a === a && link.b === b) || (link.a === b && link.b === a);
    return samePair && link.active && (!role || link.role === role);
  }) || null;
}

function bestGatewayForTerminal(terminal) {
  const gateways = [terminal.gatewayEdgeId, terminal.backupEdgeId]
    .filter(Boolean)
    .map(getNode)
    .filter((node) => node && node.status === 'online');
  const candidates = gateways.length
    ? gateways
    : nodes.filter((node) => node.type === 'Edge' && node.status === 'online');

  return candidates
    .map((edge) => {
      const access = activeLinkBetween(terminal.id, edge.id, 'terminal-edge') || linkBetween(terminal.id, edge.id);
      const backhaul = activeLinkBetween(edge.id, 'N001', 'edge-cloud') || linkBetween(edge.id, 'N001');
      if (!access || !backhaul) return null;
      const residual = Math.min(access.bandwidth * (1 - access.utilization), backhaul.bandwidth * (1 - backhaul.utilization));
      const score = residual / 1200 - (access.latency + backhaul.latency) / 160 - (access.loss + backhaul.loss) / 10;
      return { edge, score };
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score)[0]?.edge || null;
}

function buildUplinkRoute(originId) {
  const origin = getNode(originId);
  const cloud = nodes.find((node) => node.type === 'Cloud');
  if (!origin || !cloud) return null;
  if (origin.type === 'Cloud') return [origin.id];
  if (origin.type === 'Edge') return [origin.id, cloud.id];
  const gateway = bestGatewayForTerminal(origin);
  if (!gateway) return null;
  return [origin.id, gateway.id, cloud.id];
}

function buildDownlinkRoute(targetId) {
  const target = getNode(targetId);
  const cloud = nodes.find((node) => node.type === 'Cloud');
  if (!target || !cloud) return null;
  if (target.type === 'Cloud') return [cloud.id];
  if (target.type === 'Edge') return [cloud.id, target.id];
  const uplink = buildUplinkRoute(target.id);
  return uplink ? [...uplink].reverse() : null;
}

function createPacketJourney(options) {
  const path = options.path?.filter(Boolean);
  if (!path?.length) return null;
  for (let i = 0; i < path.length - 1; i += 1) ensureLink(path[i], path[i + 1]);
  const metrics = pathMetrics(path) || { bottleneck: 120, latency: 0, loss: 0 };
  const journey = {
    id: `P${String(nextPacketId++).padStart(4, '0')}`,
    taskId: options.taskId,
    kind: options.kind,
    label: options.label,
    direction: options.direction,
    origin: path[0],
    target: path[path.length - 1],
    path,
    data: Math.max(1, Math.round(options.data || 1)),
    priority: options.priority || '中',
    createdAt: Date.now(),
    startAt: Date.now() + Number(options.delayMs || 0),
    progress: 0,
    currentHop: 0,
    status: Number(options.delayMs || 0) > 0 ? 'waiting' : 'transmitting',
    latency: Math.round(metrics.latency || 0),
    bottleneck: Math.round(metrics.bottleneck || 0),
    loss: Number((metrics.loss || 0).toFixed(2))
  };
  packetJourneys.unshift(journey);
  while (packetJourneys.length > MAX_PACKET_JOURNEYS) packetJourneys.pop();
  return journey;
}

function attachPacketJourneys(task) {
  if (!task.accepted) return;
  const uplink = buildUplinkRoute(task.origin);
  const downlink = buildDownlinkRoute(task.origin);
  const journeys = [];
  if (uplink) {
    journeys.push(createPacketJourney({
      taskId: task.id,
      kind: 'situation',
      label: '上行态势回传',
      direction: 'uplink',
      path: uplink,
      data: task.demand.data,
      priority: task.priority
    }));
  }
  if (downlink) {
    journeys.push(createPacketJourney({
      taskId: task.id,
      kind: 'control',
      label: '下行控制指令',
      direction: 'downlink',
      path: downlink,
      data: Math.max(8, task.demand.data * 0.08),
      priority: task.priority,
      delayMs: 1200
    }));
  }
  task.packetIds = journeys.filter(Boolean).map((journey) => journey.id);
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
      const commScore = clamp(metrics.bottleneck / 900, 0, 1.5);
      const policyScore = pathPolicyScore(path);
      return {
        node,
        path,
        metrics,
        score: resourceScore * 1.45 + commScore * 1.65 + metrics.score * 0.62 + policyScore + (node.type === 'Cloud' ? 0.18 : 0),
        canHold
      };
    })
    .filter(Boolean)
    .filter((candidate) => candidate.canHold)
    .sort((left, right) => right.score - left.score);
}

function splitWeight(candidate) {
  const computeRatio = candidate.node.computeFree / Math.max(1, candidate.node.computeTotal);
  const storageRatio = candidate.node.storageFree / Math.max(1, candidate.node.storageTotal);
  const commRatio = clamp(candidate.metrics.bottleneck / 900, 0.05, 1.6);
  return Math.max(0.05, computeRatio * 0.42 + storageRatio * 0.28 + commRatio * 0.3);
}

function createTask(payload = {}) {
  const online = nodes.filter((node) => node.status === 'online');
  const terminalOrigins = online.filter((node) => node.type === 'Terminal');
  const origin = payload.origin && getNode(payload.origin) ? getNode(payload.origin) : choose(terminalOrigins.length ? terminalOrigins : online);
  const demand = {
    compute: Number(payload.compute || Math.round(between(520, 1680))),
    storage: Number(payload.storage || Math.round(between(220, 820))),
    data: Number(payload.data || Math.round(between(180, 920)))
  };
  const priority = payload.priority || choose(['低', '中', '高', '紧急']);
  const splitStrategy = payload.splitStrategy || 'equal';
  const candidates = twoHopCandidates(origin.id, demand).slice(0, 12);
  let remainingCompute = demand.compute;
  let remainingStorage = demand.storage;
  const fragments = [];
  const selected = candidates.slice(0, Math.min(candidates.length, Number(payload.fragmentCount || 12)));

  for (let index = 0; index < selected.length; index += 1) {
    const candidate = selected[index];
    if (remainingCompute <= 0 || remainingStorage <= 0) break;
    const isLast = index === selected.length - 1;
    const remainingSlots = Math.max(1, selected.length - index);
    const remainingCandidates = selected.slice(index);
    const remainingWeight = remainingCandidates.reduce((sum, item) => sum + splitWeight(item), 0);
    const weightShare = remainingWeight > 0 ? splitWeight(candidate) / remainingWeight : 1 / remainingSlots;
    const weightedCompute = Math.round(remainingCompute * weightShare);
    const weightedStorage = Math.round(remainingStorage * weightShare);
    const targetCompute = splitStrategy === 'equal' ? (isLast ? remainingCompute : Math.round(remainingCompute / remainingSlots)) : weightedCompute;
    const targetStorage = splitStrategy === 'equal' ? (isLast ? remainingStorage : Math.round(remainingStorage / remainingSlots)) : weightedStorage;
    const computeSlice = Math.min(targetCompute, candidate.node.computeFree, remainingCompute);
    const storageSlice = Math.min(targetStorage, candidate.node.storageFree, remainingStorage);
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

  const accepted = remainingCompute <= demand.compute * 0.5 && fragments.length > 0;

  // Materialize links along fragment paths — links are created only when data flows
  if (accepted) {
    for (const fragment of fragments) {
      for (let i = 0; i < fragment.path.length - 1; i += 1) {
        ensureLink(fragment.path[i], fragment.path[i + 1]);
      }
    }
  }

  const task = {
    id: `T${String(nextTaskId++).padStart(4, '0')}`,
    createdAt: Date.now(),
    origin: origin.id,
    demand,
    priority,
    splitStrategy,
    status: accepted ? 'dispatching' : 'rejected',
    accepted,
    remaining: { compute: Math.max(0, remainingCompute), storage: Math.max(0, remainingStorage) },
    fragments,
    trace: fragments.flatMap((fragment) => fragment.path.map((nodeId, order) => ({ nodeId, order, fragmentId: fragment.id }))).slice(0, 80),
    message: accepted ? '2-hop elastic scheduling accepted' : 'insufficient resource/link quality within 2 hops'
  };

  if (!accepted) releaseTaskResources(task);
  attachPacketJourneys(task);
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

function resetSimulation(opts = {}) {
  if (opts.nodeCount && Number.isFinite(opts.nodeCount) && opts.nodeCount >= 3 && opts.nodeCount <= 2000) {
    NODE_COUNT = opts.nodeCount;
  }
  if (opts.edgeCount !== undefined && Number.isFinite(opts.edgeCount)) {
    const maxEdge = Math.floor(NODE_COUNT * MAX_EDGE_RATIO);
    EDGE_COUNT = Math.min(maxEdge, Math.max(3, Math.round(opts.edgeCount)));
  } else {
    EDGE_COUNT = defaultEdgeCount(NODE_COUNT);
  }
  if (opts.linkRadius !== undefined && Number.isFinite(opts.linkRadius)) {
    LINK_RADIUS = Math.max(0.1, Math.min(1.5, Number(opts.linkRadius)));
  }
  nodes.length = 0;
  links.length = 0;
  tasks.length = 0;
  packetJourneys.length = 0;
  nextTaskId = 1;
  nextLinkId = 1;
  nextPacketId = 1;
  lastAutoTaskAt = 0;
  tickCount = 0;
  paused = false;
  createNodes();
  applyForceLayout();
  createStableTopology();
  createTask({ priority: '高' });
  broadcast('state', snapshot());
}

function simulateLinks() {
  const now = Date.now();
  const idleThreshold = 15000; // 15s of no usage → deactivate
  for (const link of links) {
    if (link.persistent) {
      link.active = true;
      link.lastUsedAt = now;
    }
    // Only fluctuate metrics for active links (data is flowing)
    if (link.active) {
      const drift = between(-0.055, 0.065);
      const floor = link.persistent ? 0.04 : 0.02;
      const ceiling = link.persistent ? 0.88 : 0.94;
      link.utilization = Number(clamp(link.utilization + drift, floor, ceiling).toFixed(2));
      link.latency = Math.round(clamp(link.latency + between(-3, 4), 3, 110));
      link.loss = Number(clamp(link.loss + between(-0.18, 0.2), 0.02, 8.5).toFixed(2));
    }
    // Deactivate idle links that haven't been used recently
    if (!link.persistent && link.active && link.lastUsedAt && now - link.lastUsedAt > idleThreshold) {
      link.active = false;
      link.changedAt = now;
    }
  }
  // Clean up links that have been inactive for a long time
  for (let i = links.length - 1; i >= 0; i -= 1) {
    if (!links[i].active && links[i].changedAt && now - links[i].changedAt > 60000) {
      links.splice(i, 1);
    }
  }
}

function simulateNodes() {
  for (const node of nodes) {
    node.txMbps = 0;
    node.rxMbps = 0;
    node.pulse = (node.pulse + between(0.025, 0.075)) % 1;
    node.load = clamp(1 - node.computeFree / node.computeTotal, 0, 1);
    if (random() < 0.004 && node.type !== 'Cloud') node.status = node.status === 'online' ? 'degraded' : 'online';
    if (node.status === 'degraded' && random() < 0.12) node.status = 'online';
  }
  simulateNodePhysics();
}

function simulateNodePhysics() {
  // Continuous force-directed motion with Brownian drift — nodes wander, links follow
  const linkSet = new Map();
  for (const link of links) {
    if (!link.active) continue;
    if (!linkSet.has(link.a)) linkSet.set(link.a, new Set());
    if (!linkSet.has(link.b)) linkSet.set(link.b, new Set());
    linkSet.get(link.a).add(link.b);
    linkSet.get(link.b).add(link.a);
  }

  const range = LINK_RADIUS * 2.2;
  const forces = new Array(nodes.length);
  for (let i = 0; i < nodes.length; i += 1) forces[i] = { fx: 0, fy: 0 };

  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const dx = nodes[j].x - nodes[i].x;
      const dy = nodes[j].y - nodes[i].y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.001;
      if (dist > range) continue;

      const connected = linkSet.get(nodes[i].id)?.has(nodes[j].id);
      if (connected) {
        // Attraction toward ideal distance — stronger to overcome equilibrium
        const target = LINK_RADIUS * 0.65;
        const force = (dist - target) * 0.018;
        const fx = dx / dist * force;
        const fy = dy / dist * force;
        forces[i].fx += fx;
        forces[i].fy += fy;
        forces[j].fx -= fx;
        forces[j].fy -= fy;
      }
      // Universal soft repulsion to prevent crowding
      if (dist < 0.06) {
        const repel = (0.06 - dist) * 0.03;
        const fx = dx / dist * repel;
        const fy = dy / dist * repel;
        forces[i].fx -= fx;
        forces[i].fy -= fy;
        forces[j].fx += fx;
        forces[j].fy += fy;
      }
    }
  }

  // Apply forces + Brownian drift for visible wandering motion
  const dt = 0.7;
  for (let i = 0; i < nodes.length; i += 1) {
    const brownX = between(-0.006, 0.006);
    const brownY = between(-0.006, 0.006);
    nodes[i].x = clamp(nodes[i].x + forces[i].fx * dt + brownX, 0.04, 0.96);
    nodes[i].y = clamp(nodes[i].y + forces[i].fy * dt + brownY, 0.06, 0.94);
  }

  // Update link distances
  for (const link of links) {
    if (!link.active) continue;
    const a = getNode(link.a);
    const b = getNode(link.b);
    if (!a || !b) continue;
    const d = distance(a, b);
    link.distance = Number((d * 1000).toFixed(1));
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
        if (link) {
          link.utilization = Number(clamp(link.utilization + 0.012, 0.02, 0.98).toFixed(2));
          link.lastUsedAt = now;
          if (!link.active) { link.active = true; link.changedAt = now; }
        }
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

function simulatePacketJourneys() {
  const now = Date.now();
  for (const journey of packetJourneys) {
    if (journey.status === 'complete') continue;
    if (now < journey.startAt) {
      journey.status = 'waiting';
      continue;
    }
    const metrics = pathMetrics(journey.path) || { bottleneck: journey.bottleneck || 120, latency: journey.latency || 20 };
    const hopCount = Math.max(1, journey.path.length - 1);
    const speed = clamp((metrics.bottleneck || 120) / Math.max(180, journey.data * 3.2), 0.025, 0.18);
    journey.progress = clamp(journey.progress + speed * between(0.05, 0.11), 0, 1);
    journey.currentHop = Math.min(hopCount - 1, Math.floor(journey.progress * hopCount));
    journey.status = journey.progress >= 0.995 ? 'complete' : 'transmitting';
    journey.latency = Math.round(metrics.latency || journey.latency || 0);
    journey.bottleneck = Math.round(metrics.bottleneck || journey.bottleneck || 0);
    journey.loss = Number((metrics.loss || journey.loss || 0).toFixed(2));

    if (journey.path.length > 1 && journey.status !== 'complete') {
      const aId = journey.path[journey.currentHop];
      const bId = journey.path[journey.currentHop + 1];
      const a = getNode(aId);
      const b = getNode(bId);
      const link = ensureLink(aId, bId);
      const rate = Math.max(1, Math.round(journey.data * (journey.direction === 'uplink' ? 0.045 : 0.018)));
      if (a) a.txMbps += rate;
      if (b) b.rxMbps += rate;
      if (link) {
        link.utilization = Number(clamp(link.utilization + (journey.direction === 'uplink' ? 0.018 : 0.01), 0.04, 0.98).toFixed(2));
        link.lastUsedAt = now;
        link.active = true;
      }
    } else if (journey.status === 'complete' && !journey.completedAt) {
      journey.completedAt = now;
    }
  }
}

function snapshot() {
  const onlineNodes = nodes.filter((node) => node.status === 'online').length;
  const activeLinks = links.filter((link) => link.active).length;
  const avgUtil = links.length ? links.reduce((sum, link) => sum + link.utilization, 0) / links.length : 0;
  const runningTasks = tasks.filter((task) => ['dispatching', 'running'].includes(task.status)).length;
  const nodeTypes = nodes.reduce((counts, node) => {
    counts[node.type] = (counts[node.type] || 0) + 1;
    return counts;
  }, {});

  return {
    tick: tickCount,
    generatedAt: Date.now(),
    paused,
    summary: {
      nodeCount: nodes.length,
      onlineNodes,
      activeLinks,
      totalLinks: links.length,
      avgUtilization: Number(avgUtil.toFixed(2)),
      nodeTypes,
      edgeLimit: EDGE_COUNT,
      maxEdgeLimit: Math.floor(NODE_COUNT * MAX_EDGE_RATIO),
      linkRadius: LINK_RADIUS,
      runningTasks,
      activePackets: packetJourneys.filter((packet) => ['waiting', 'transmitting'].includes(packet.status)).length,
      completeTasks: tasks.filter((task) => task.status === 'complete').length,
      rejectedTasks: tasks.filter((task) => task.status === 'rejected').length
    },
    nodes,
    links,
    tasks: tasks.slice(0, 18).map((task) => ({
      ...task,
      packetJourneys: (task.packetIds || [])
        .map((id) => packetJourneys.find((journey) => journey.id === id))
        .filter(Boolean)
    })),
    packetJourneys: packetJourneys.slice(0, 32)
  };
}

function broadcast(event, data) {
  const encoded = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(encoded);
}

function step() {
  if (paused) return;
  tickCount += 1;
  simulateLinks();
  simulateNodes();
  simulateTasks();
  simulatePacketJourneys();
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
    if (url.pathname === '/api/reset' && req.method === 'POST') {
      const body = await readBody(req);
      const nodeCount = Number(body.nodeCount);
      if (!Number.isFinite(nodeCount) || nodeCount < 3 || nodeCount > 2000) {
        return json(res, 400, { error: 'invalid_node_count', message: '节点数量需在 3-2000 之间' });
      }
      resetSimulation({
        nodeCount,
        edgeCount: body.edgeCount !== undefined ? Number(body.edgeCount) : undefined,
        linkRadius: body.linkRadius !== undefined ? Number(body.linkRadius) : undefined
      });
      return json(res, 200, snapshot());
    }
    if (url.pathname === '/api/config' && req.method === 'GET') {
      return json(res, 200, {
        nodeCount: NODE_COUNT,
        edgeCount: EDGE_COUNT,
        maxEdgeCount: Math.floor(NODE_COUNT * MAX_EDGE_RATIO),
        linkRadius: LINK_RADIUS
      });
    }
    if (url.pathname === '/api/pause' && req.method === 'GET') {
      return json(res, 200, { paused });
    }
    if (url.pathname === '/api/pause' && req.method === 'POST') {
      const body = await readBody(req);
      paused = body.paused !== undefined ? Boolean(body.paused) : !paused;
      if (!paused) lastAutoTaskAt = Date.now();
      broadcast('state', snapshot());
      return json(res, 200, { paused });
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
applyForceLayout();
createStableTopology();
createTask({ priority: '高' });
setInterval(step, TICK_MS);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Comm-compute network simulator running at http://127.0.0.1:${PORT}`);
  console.log(`Nodes: ${nodes.length}, links: ${links.length}`);
});
