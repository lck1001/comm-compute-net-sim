import http from 'node:http';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');
const dataDir = path.join(__dirname, 'data');
const simulationDatabasePath = path.join(dataDir, 'simulation-results.json');
const topologyCsvPath = process.env.TOPOLOGY_CSV
  ? path.resolve(process.env.TOPOLOGY_CSV)
  : path.join(__dirname, 'docs', '轨迹.csv');
const csvTopologyRecords = loadTopologyCsv(topologyCsvPath);
const PORT = Number(process.env.PORT || 4173);
const DEFAULT_EDGE_COUNT = 9;
const TERMINALS_PER_EDGE = 20;
const DEFAULT_NODE_COUNT = 1 + DEFAULT_EDGE_COUNT + DEFAULT_EDGE_COUNT * TERMINALS_PER_EDGE;
const DEFAULT_TOTAL_NETWORK_BANDWIDTH = 12000;
let NODE_COUNT = Number(process.env.NODE_COUNT || DEFAULT_NODE_COUNT);
const TICK_MS = 900;
const MAX_TASKS = 96;
const MAX_PACKET_JOURNEYS = 240;
const MAX_TELEMETRY_RECORDS = 240;
const MAX_RELAY_LOGS = 320;
const MAX_CLOUD_INBOX = 240;
const MAX_EXTERNAL_PLATFORM_TRACKS = 240;
const MAX_TS_FRAMES = 80;
const TS_TARGET_COUNT = Number(process.env.TS_TARGET_COUNT || 70);
const MARITIME_BOUNDS = {
  minLat: 18.2,
  maxLat: 22.8,
  minLng: 111.4,
  maxLng: 116.9
};

function defaultEdgeCount(total) {
  return Math.min(Math.max(1, total - 1), DEFAULT_EDGE_COUNT);
}
let EDGE_COUNT = process.env.EDGE_COUNT
  ? Math.min(NODE_COUNT - 1, Math.max(1, Number(process.env.EDGE_COUNT)))
  : defaultEdgeCount(NODE_COUNT);
let LINK_RADIUS = Number(process.env.LINK_RADIUS || 0.55);
let TOTAL_NETWORK_BANDWIDTH = Number(process.env.NETWORK_BANDWIDTH || DEFAULT_TOTAL_NETWORK_BANDWIDTH);

const nodeTypes = [
  { type: 'Cloud', label: '云节点', compute: [1800, 2400], storage: [2200, 3200], bandwidth: [6200, 9000], color: '#f6c453' },
  { type: 'Edge', label: '边缘节点', compute: [520, 980], storage: [640, 1280], bandwidth: [1100, 1800], color: '#e0555a' },
  { type: 'Terminal', label: '终端节点', compute: [100, 360], storage: [120, 520], bandwidth: [160, 420], color: '#70a7ff' }
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

function decodeCsv(buffer) {
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(buffer);
  }
  try {
    return new TextDecoder('gb18030').decode(buffer);
  } catch {
    return buffer.toString('utf8');
  }
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (char !== '\r') {
      cell += char;
    }
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((item) => item.some((value) => String(value).trim()));
}

function topologyNodeType(unitName, branch) {
  const text = `${unitName || ''}${branch || ''}`;
  if (text.includes('岸基中心')) return 'Cloud';
  if (/航母|编队/.test(text)) return 'Edge';
  return 'Terminal';
}

function loadTopologyCsv(filePath) {
  if (!existsSync(filePath)) return [];
  const rows = parseCsv(decodeCsv(readFileSync(filePath)));
  const records = [];
  rows.slice(1).forEach((row, index) => {
    const unitName = String(row[0] || '').trim();
    const branch = String(row[2] || '').trim();
    const longitude = Number(row[4]);
    const latitude = Number(row[5]);
    if (!unitName || !Number.isFinite(longitude) || !Number.isFinite(latitude)) return;
    records.push({
      rowIndex: index + 2,
      unitName,
      branch,
      longitude,
      latitude,
      nodeType: topologyNodeType(unitName, branch)
    });
  });
  return records;
}

function topologyBounds(records) {
  const points = records.filter((record) => Number.isFinite(record.latitude) && Number.isFinite(record.longitude));
  if (!points.length) return { ...MARITIME_BOUNDS };
  const latitudes = points.map((record) => record.latitude);
  const longitudes = points.map((record) => record.longitude);
  let minLat = Math.min(...latitudes);
  let maxLat = Math.max(...latitudes);
  let minLng = Math.min(...longitudes);
  let maxLng = Math.max(...longitudes);
  const latSpan = Math.max(0.4, maxLat - minLat);
  const lngSpan = Math.max(0.4, maxLng - minLng);
  minLat -= latSpan * 0.16;
  maxLat += latSpan * 0.22;
  minLng -= lngSpan * 0.18;
  maxLng += lngSpan * 0.12;
  return { minLat, maxLat, minLng, maxLng };
}

function applyTopologyBounds(records) {
  const bounds = topologyBounds(records);
  MARITIME_BOUNDS.minLat = bounds.minLat;
  MARITIME_BOUNDS.maxLat = bounds.maxLat;
  MARITIME_BOUNDS.minLng = bounds.minLng;
  MARITIME_BOUNDS.maxLng = bounds.maxLng;
}

function sourceRecordSort(left, right) {
  const typeOrder = { Cloud: 0, Edge: 1, Terminal: 2 };
  return (typeOrder[left.nodeType] ?? 9) - (typeOrder[right.nodeType] ?? 9)
    || String(left.unitName).localeCompare(String(right.unitName), 'zh-CN');
}

function sampleTopologyRecords(pool, count) {
  if (!pool.length || count <= 0) return [];
  const shuffled = [...pool];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  if (count <= shuffled.length) return shuffled.slice(0, count);
  const selected = [...shuffled];
  while (selected.length < count) selected.push(choose(pool));
  return selected;
}

let seed = Number(process.env.SIM_SEED || 20260704);
const clients = new Set();
const nodes = [];
const links = [];
const tasks = [];
const packetJourneys = [];
const telemetryRecords = [];
const relayLogs = [];
const cloudInbox = [];
const externalPlatformTracks = [];
const tsSensingFrames = [];
let nextTaskId = 1;
let nextLinkId = 1;
let nextPacketId = 1;
let nextTelemetryId = 1;
let nextTsFrameId = 1;
let tickCount = 0;
let paused = false;
let lastScenarioRun = null;
let persistenceTimer = null;
let persistenceReason = 'startup';

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

function toIso(value) {
  return value ? new Date(value).toISOString() : null;
}

function idNumber(id) {
  return Number(String(id || '').replace(/\D/g, '')) || 0;
}

function typeInfo(type) {
  return nodeTypes.find((item) => item.type === type) || nodeTypes[2];
}

function bandwidthScale() {
  return clamp(TOTAL_NETWORK_BANDWIDTH / DEFAULT_TOTAL_NETWORK_BANDWIDTH, 0.28, 4.5);
}

function createNodeFromSource(index, source, options = {}) {
  const info = typeInfo(source.nodeType);
  const computeTotal = Math.round(between(info.compute[0], info.compute[1]));
  const storageTotal = Math.round(between(info.storage[0], info.storage[1]));
  const bandwidthTotal = Math.round(between(info.bandwidth[0], info.bandwidth[1]) * bandwidthScale());
  const point = geoToCanvas(source.latitude, source.longitude);
  const duplicateOffset = options.duplicateOffset || { x: 0, y: 0 };
  return {
    id: `N${String(index).padStart(3, '0')}`,
    name: source.nodeType === 'Cloud' ? '岸基中心' : source.unitName,
    type: source.nodeType,
    label: info.label,
    unitName: source.unitName,
    branch: source.branch,
    sourceColumns: {
      A: source.unitName,
      C: source.branch,
      E: source.longitude,
      F: source.latitude
    },
    zone: options.zone || (source.nodeType === 'Cloud' ? '岸基' : source.nodeType === 'Edge' ? '近岸' : '远海'),
    latitude: Number(source.latitude.toFixed(6)),
    longitude: Number(source.longitude.toFixed(6)),
    x: clamp(point.x + duplicateOffset.x, 0.04, 0.96),
    y: clamp(point.y + duplicateOffset.y, 0.06, 0.94),
    computeTotal,
    storageTotal,
    memoryTotal: storageTotal,
    computeFree: computeTotal,
    storageFree: storageTotal,
    memoryFree: storageTotal,
    bandwidthTotal,
    bandwidthFree: bandwidthTotal,
    bandwidthUsed: 0,
    txMbps: 0,
    rxMbps: 0,
    load: between(0.08, 0.42),
    status: 'online',
    color: info.color,
    hopsToCloud: source.nodeType === 'Cloud' ? 0 : source.nodeType === 'Edge' ? 1 : 2,
    pulse: random(),
    geoFixed: true
  };
}

function createCsvNodes() {
  const maxEdge = Math.max(1, NODE_COUNT - 1);
  EDGE_COUNT = Math.min(maxEdge, Math.max(0, Math.round(EDGE_COUNT)));
  const terminalCount = Math.max(0, NODE_COUNT - 1 - EDGE_COUNT);
  const edgePool = csvTopologyRecords.filter((record) => record.nodeType === 'Edge');
  const terminalPool = csvTopologyRecords.filter((record) => record.nodeType === 'Terminal');
  const selectedEdges = sampleTopologyRecords(edgePool.length ? edgePool : csvTopologyRecords, EDGE_COUNT)
    .map((record) => ({ ...record, nodeType: 'Edge' }));
  const selectedTerminals = sampleTopologyRecords(terminalPool.length ? terminalPool : csvTopologyRecords, terminalCount)
    .map((record) => ({ ...record, nodeType: 'Terminal' }));
  const sampledRecords = [...selectedEdges, ...selectedTerminals];
  const rawBounds = topologyBounds(sampledRecords.length ? sampledRecords : csvTopologyRecords);
  const cloudSource = {
    unitName: '岸基中心',
    branch: '岸基中心',
    nodeType: 'Cloud',
    longitude: rawBounds.minLng,
    latitude: rawBounds.maxLat
  };
  const sources = [cloudSource, ...sampledRecords];
  applyTopologyBounds(sources);

  const duplicateCounts = new Map();
  sources.forEach((source, index) => {
    const key = `${source.longitude.toFixed(4)},${source.latitude.toFixed(4)}`;
    const count = duplicateCounts.get(key) || 0;
    duplicateCounts.set(key, count + 1);
    const angle = count * Math.PI * 0.72;
    const radius = count ? 0.012 + count * 0.004 : 0;
    nodes.push(createNodeFromSource(index + 1, source, {
      duplicateOffset: {
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius
      }
    }));
  });
}

function createNodes() {
  if (csvTopologyRecords.length) {
    createCsvNodes();
    return;
  }
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
    const bandwidthTotal = Math.round(between(typeInfo.bandwidth[0], typeInfo.bandwidth[1]) * bandwidthScale());
    const hopsToCloud = typeInfo.type === 'Cloud' ? 0 : typeInfo.type === 'Edge' ? 1 : 2;

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
      memoryTotal: storageTotal,
      computeFree: computeTotal,
      storageFree: storageTotal,
      memoryFree: storageTotal,
      bandwidthTotal,
      bandwidthFree: bandwidthTotal,
      bandwidthUsed: 0,
      txMbps: 0,
      rxMbps: 0,
      load: between(0.08, 0.42),
      status: 'online',
      color: typeInfo.color,
      hopsToCloud,
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
    bandwidth: Math.round(between(profile.bandwidth[0], profile.bandwidth[1]) * bandwidthScale()),
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
    if (options.selfOrganized !== undefined) link.selfOrganized = Boolean(options.selfOrganized);
    if (options.medium) link.medium = options.medium;
    if (options.topologyLayer) link.topologyLayer = options.topologyLayer;
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
    selfOrganized: Boolean(options.selfOrganized),
    medium: options.medium || (role === 'edge-cloud' ? 'wired' : 'wireless'),
    topologyLayer: options.topologyLayer || role,
    reservedMbps: 0,
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

function topologyPairsByDistance(items) {
  const pairs = [];
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      pairs.push({ a: items[i], b: items[j], d: distance(items[i], items[j]) });
    }
  }
  return pairs.sort((left, right) => left.d - right.d);
}

function optimizedEdgeMeshPairs(edges) {
  if (edges.length < 2) return [];
  const parent = new Map(edges.map((edge) => [edge.id, edge.id]));
  const find = (id) => {
    let current = id;
    while (parent.get(current) !== current) current = parent.get(current);
    return current;
  };
  const merge = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return false;
    parent.set(rb, ra);
    return true;
  };
  const selected = new Map();
  for (const pair of topologyPairsByDistance(edges)) {
    if (merge(pair.a.id, pair.b.id)) selected.set(linkKey(pair.a, pair.b), pair);
  }
  const peerCount = edges.length <= 12 ? 3 : 2;
  for (const edge of edges) {
    for (const peer of nearestNodes(edge, edges, peerCount, { sameZoneBonus: 0.72 })) {
      selected.set(linkKey(edge, peer), { a: edge, b: peer, d: distance(edge, peer) });
    }
  }
  return [...selected.values()];
}

function terminalsByGateway(terminals) {
  const groups = new Map();
  for (const terminal of terminals) {
    const key = terminal.gatewayEdgeId || 'ungrouped';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(terminal);
  }
  return groups;
}

function assignTerminalsToEdges(terminals, edges) {
  if (!terminals.length || !edges.length) return;
  const capacity = Math.ceil(terminals.length / edges.length);
  const assigned = new Map(edges.map((edge) => [edge.id, 0]));
  const orderedTerminals = [...terminals].sort((left, right) => (
    Math.min(...edges.map((edge) => distance(left, edge)))
    - Math.min(...edges.map((edge) => distance(right, edge)))
  ));

  for (const terminal of orderedTerminals) {
    const ranked = [...edges]
      .sort((left, right) => distance(terminal, left) - distance(terminal, right));
    const gateway = ranked.find((edge) => assigned.get(edge.id) < capacity) || ranked[0];
    const backup = ranked.find((edge) => edge.id !== gateway.id) || gateway;
    terminal.gatewayEdgeId = gateway.id;
    terminal.backupEdgeId = backup.id;
    terminal.edgeDomain = `EDGE-${String(edges.indexOf(gateway) + 1).padStart(2, '0')}`;
    assigned.set(gateway.id, (assigned.get(gateway.id) || 0) + 1);
  }
}

function createTerminalAdHocMesh(terminals) {
  const selected = new Map();
  for (const group of terminalsByGateway(terminals).values()) {
    if (group.length < 2) continue;
    const peerCount = group.length <= 10 ? 2 : 3;
    for (const terminal of group) {
      for (const peer of nearestNodes(terminal, group, peerCount)) {
        selected.set(linkKey(terminal, peer), { a: terminal, b: peer, d: distance(terminal, peer) });
      }
    }
  }
  for (const pair of [...selected.values()]) {
    createPhysicalLink(pair.a.id, pair.b.id, {
      role: 'terminal-peer',
      persistent: true,
      active: true,
      force: true,
      selfOrganized: true,
      medium: 'wireless',
      topologyLayer: 'terminal-ad-hoc'
    });
  }
}

function assignMultiHopRelayHints(terminals, edges, cloud) {
  const edgeById = new Map(edges.map((edge) => [edge.id, edge]));
  for (const terminal of terminals) {
    delete terminal.multiHopRelay;
    if (idNumber(terminal.id) % 4 !== 0) continue;

    const gateway = edgeById.get(terminal.gatewayEdgeId);
    if (!gateway) continue;

    const sameGatewayPeers = terminals.filter((peer) => (
      peer.id !== terminal.id
      && (peer.gatewayEdgeId === gateway.id || peer.backupEdgeId === gateway.id)
    ));
    const peer = nearestNodes(terminal, sameGatewayPeers, 1)[0];
    const edgeRelay = nearestNodes(gateway, edges.filter((edge) => edge.id !== gateway.id), 1, { sameZoneBonus: 0.82 })[0];

    if (peer && idNumber(terminal.id) % 8 === 0) {
      createPhysicalLink(terminal.id, peer.id, {
        role: 'terminal-peer',
        persistent: true,
        active: true,
        force: true,
        selfOrganized: true,
        medium: 'wireless',
        topologyLayer: 'terminal-relay-hop'
      });
      createPhysicalLink(peer.id, gateway.id, {
        role: 'terminal-edge',
        persistent: true,
        active: true,
        force: true,
        selfOrganized: false,
        medium: 'wireless',
        topologyLayer: 'terminal-relay-access'
      });
      terminal.multiHopRelay = {
        mode: 'terminal-terminal-edge-cloud',
        relayTerminalId: peer.id,
        gatewayEdgeId: gateway.id,
        cloudId: cloud.id,
        hopCount: 3
      };
      continue;
    }

    if (edgeRelay) {
      createPhysicalLink(gateway.id, edgeRelay.id, {
        role: 'edge-mesh',
        persistent: true,
        active: true,
        force: true,
        selfOrganized: true,
        medium: 'wireless',
        topologyLayer: 'edge-relay-backbone'
      });
      terminal.multiHopRelay = {
        mode: 'terminal-edge-edge-cloud',
        gatewayEdgeId: gateway.id,
        relayEdgeId: edgeRelay.id,
        cloudId: cloud.id,
        hopCount: 3
      };
    }
  }
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
      force: true,
      selfOrganized: false,
      medium: 'wired',
      topologyLayer: 'cloud-backhaul'
    });
  }

  for (const pair of optimizedEdgeMeshPairs(edges)) {
    createPhysicalLink(pair.a.id, pair.b.id, {
      role: 'edge-mesh',
      persistent: true,
      active: true,
      force: true,
      selfOrganized: true,
      medium: 'wireless',
      topologyLayer: 'edge-self-organized-backbone'
    });
  }

  assignTerminalsToEdges(terminals, edges);
  for (const terminal of terminals) {
    const gateway = getNode(terminal.gatewayEdgeId) || edges[0];
    createPhysicalLink(terminal.id, gateway.id, {
      role: 'terminal-edge',
      persistent: true,
      active: true,
      force: true,
      selfOrganized: false,
      medium: 'wireless',
      topologyLayer: 'terminal-access'
    });
  }

  createTerminalAdHocMesh(terminals);
  assignMultiHopRelayHints(terminals, edges, cloud);
}

function applyForceLayout() {
  if (csvTopologyRecords.length) return;
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

function findPathWithinTwoHops(originId, targetId, map = neighborMap()) {
  if (originId === targetId) return [originId];
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
    bandwidth: Math.round(between(160, 900) * bandwidthScale()),
    latency: Math.round(between(4, 38) + d * 70),
    loss: Number(between(0.1, 2.8).toFixed(2)),
    utilization: 0.2,
    reservedMbps: 0,
    active: true
  };
}

function availableNetworkBandwidth() {
  const reserved = links.reduce((sum, link) => sum + Math.max(0, Number(link.reservedMbps || 0)), 0);
  const utilization = links.length
    ? links.reduce((sum, link) => sum + link.utilization, 0) / links.length
    : 0;
  return Math.max(0, TOTAL_NETWORK_BANDWIDTH * (1 - utilization * 0.45) - reserved);
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
  const bottleneck = Math.min(...pathLinks.map((link) => (
    Math.max(0, link.bandwidth * (1 - link.utilization) - Number(link.reservedMbps || 0))
  )));
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

function hintedMultiHopRoute(terminal, cloud) {
  const hint = terminal?.multiHopRelay;
  if (!hint || !cloud) return null;
  let path = null;
  if (hint.mode === 'terminal-terminal-edge-cloud') {
    path = [terminal.id, hint.relayTerminalId, hint.gatewayEdgeId, cloud.id];
  } else if (hint.mode === 'terminal-edge-edge-cloud') {
    path = [terminal.id, hint.gatewayEdgeId, hint.relayEdgeId, cloud.id];
  }
  if (!path || path.some((nodeId) => !nodeId || !getNode(nodeId))) return null;
  return pathMetrics(path) ? path : null;
}

function buildUplinkRoute(originId) {
  const origin = getNode(originId);
  const cloud = nodes.find((node) => node.type === 'Cloud');
  if (!origin || !cloud) return null;
  if (origin.type === 'Cloud') return [origin.id];
  if (origin.type === 'Edge') return [origin.id, cloud.id];
  const relayRoute = hintedMultiHopRoute(origin, cloud);
  if (relayRoute) return relayRoute;
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

function createTelemetryRecord(sourceId, task, path) {
  const source = getNode(sourceId);
  if (!source) return null;
  const viaEdge = path?.find((nodeId) => getNode(nodeId)?.type === 'Edge') || null;
  const record = {
    id: `D${String(nextTelemetryId++).padStart(4, '0')}`,
    taskId: task.id,
    source: source.id,
    sourceName: source.name,
    sourceZone: source.zone,
    viaEdge,
    target: path?.[path.length - 1] || 'N001',
    path: path || [],
    payload: {
      temperature: Number(between(31.5, 39.2).toFixed(1)),
      signalStrength: Math.round(between(58, 96)),
      terminalLoad: Number(source.load.toFixed(2)),
      computeFree: Math.round(source.computeFree),
      storageFree: Math.round(source.storageFree),
      sampleSizeMb: Math.max(8, Math.round(task.demand.data * between(0.18, 0.42)))
    },
    status: 'generated',
    createdAt: Date.now(),
    relayedAt: null,
    receivedAt: null,
    packetId: null
  };
  telemetryRecords.unshift(record);
  while (telemetryRecords.length > MAX_TELEMETRY_RECORDS) telemetryRecords.pop();
  return record;
}

function defaultSituationDescription(source, imageName) {
  const geo = nodeGeo(source);
  const lat = geo.latitude.toFixed(4);
  const lng = geo.longitude.toFixed(4);
  return `${source.id} 终端在 ${lat}, ${lng} 采集到 ${imageName || '态势数据'}：图中可见海域背景、多条态势航迹线及若干目标标注，疑似存在海面/空中平台协同活动，建议上传云端进行态势融合展示。`;
}

function createSituationDescriptionRecord(options = {}) {
  const source = getNode(options.sourceId)
    || nodes.find((node) => node.type === 'Terminal' && node.status === 'online' && node.gatewayEdgeId)
    || nodes.find((node) => node.type === 'Terminal')
    || nodes.find((node) => node.type === 'Edge')
    || nodes[0];
  if (!source) return { error: 'no_source_node', message: '当前没有可用节点' };
  const path = buildUplinkRoute(source.id);
  if (!path?.length || path.length < 2) {
    return { error: 'no_uplink_route', message: `${source.id} 暂无可用上行链路` };
  }
  const imageName = String(options.imageName || '态势数据').slice(0, 120);
  const description = String(options.description || '').trim().slice(0, 1200) || defaultSituationDescription(source, imageName);
  const geo = nodeGeo(source);
  const tags = Array.isArray(options.tags)
    ? options.tags.map((tag) => String(tag).trim()).filter(Boolean).slice(0, 8)
    : ['图像描述', '态势回传', '云端融合'];
  const viaEdge = path.find((nodeId) => getNode(nodeId)?.type === 'Edge') || null;
  const taskId = `IMG${String(nextTelemetryId).padStart(4, '0')}`;
  const sampleSizeMb = Math.max(6, Math.round(description.length / 16 + between(6, 18)));
  const record = {
    id: `D${String(nextTelemetryId++).padStart(4, '0')}`,
    taskId,
    source: source.id,
    sourceName: source.name,
    sourceZone: source.zone,
    viaEdge,
    target: path[path.length - 1],
    path,
    payload: {
      kind: 'image_situation_description',
      imageName,
      description,
      tags,
      latitude: Number(geo.latitude.toFixed(5)),
      longitude: Number(geo.longitude.toFixed(5)),
      locationText: options.locationText || `${geo.latitude.toFixed(4)}, ${geo.longitude.toFixed(4)}`,
      capturedBy: source.id,
      capturedAt: Date.now(),
      signalStrength: Math.round(between(66, 98)),
      terminalLoad: Number(source.load.toFixed(2)),
      computeFree: Math.round(source.computeFree),
      storageFree: Math.round(source.storageFree),
      sampleSizeMb
    },
    status: 'generated',
    createdAt: Date.now(),
    relayedAt: null,
    receivedAt: null,
    packetId: null
  };
  telemetryRecords.unshift(record);
  while (telemetryRecords.length > MAX_TELEMETRY_RECORDS) telemetryRecords.pop();

  const journey = createPacketJourney({
    taskId,
    kind: 'image_situation',
    telemetryId: record.id,
    label: '图像态势描述回传',
    direction: 'uplink',
    path,
    data: sampleSizeMb,
    priority: options.priority || '高',
    delayMs: Math.round(between(150, 1100)),
    speedMultiplier: 24
  });
  if (journey) {
    record.packetId = journey.id;
    record.status = 'transmitting';
  }
  return { record, journey, route: path };
}

function telemetryById(id) {
  return telemetryRecords.find((record) => record.id === id);
}

function createPacketJourney(options) {
  const path = options.path?.filter(Boolean);
  if (!path?.length) return null;
  for (let i = 0; i < path.length - 1; i += 1) ensureLink(path[i], path[i + 1]);
  const metrics = pathMetrics(path) || { bottleneck: 120, latency: 0, loss: 0 };
  const explicitDelay = Number(options.delayMs || 0);
  const jitter = explicitDelay > 0
    ? Math.round(between(-Math.min(300, explicitDelay * 0.5), 500))
    : Math.round(between(80, 900));
  const delayMs = Math.max(0, explicitDelay + jitter);
  const journey = {
    id: `P${String(nextPacketId++).padStart(4, '0')}`,
    taskId: options.taskId,
    kind: options.kind,
    telemetryId: options.telemetryId || null,
    label: options.label,
    direction: options.direction,
    origin: path[0],
    target: path[path.length - 1],
    path,
    data: Math.max(1, Math.round(options.data || 1)),
    priority: options.priority || '中',
    createdAt: Date.now(),
    startAt: Date.now() + delayMs,
    progress: 0,
    currentHop: 0,
    status: delayMs > 0 ? 'waiting' : 'transmitting',
    latency: Math.round(metrics.latency || 0),
    bottleneck: Math.round(metrics.bottleneck || 0),
    loss: Number((metrics.loss || 0).toFixed(2)),
    speedMultiplier: Math.max(1, Number(options.speedMultiplier || 1))
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
    const telemetry = createTelemetryRecord(task.origin, task, uplink);
    const journey = createPacketJourney({
      taskId: task.id,
      kind: 'situation',
      telemetryId: telemetry?.id,
      label: '上行态势回传',
      direction: 'uplink',
      path: uplink,
      data: task.demand.data,
      priority: task.priority
    });
    if (telemetry && journey) {
      telemetry.packetId = journey.id;
      telemetry.status = 'transmitting';
    }
    journeys.push(journey);
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
      delayMs: Math.round(between(600, 2200))
    }));
  }
  task.packetIds = journeys.filter(Boolean).map((journey) => journey.id);
}

function twoHopCandidates(originId, demand, options = {}) {
  const map = neighborMap();
  const candidateMap = new Map();
  const executionPool = options.executionPool?.length ? new Set(options.executionPool) : null;
  const eligible = (node) => !executionPool || executionPool.has(node.id);
  const addCandidate = (candidate) => {
    if (!candidate?.node) return;
    const previous = candidateMap.get(candidate.node.id);
    if (!previous || candidate.score > previous.score) candidateMap.set(candidate.node.id, candidate);
  };

  nodes
    .map((node) => {
      const path = findPathWithinTwoHops(originId, node.id, map);
      if (!path || node.status !== 'online' || !eligible(node)) return null;
      const metrics = pathMetrics(path);
      if (!metrics) return null;
      const resourceScore = node.computeFree / Math.max(1, node.computeTotal) + node.storageFree / Math.max(1, node.storageTotal);
      const canHold = node.computeFree >= demand.compute * 0.04 && node.storageFree >= demand.storage * 0.035;
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
    .forEach(addCandidate);

  // Demo-safe fallback: if the strict 2-hop neighborhood is too sparse, still allow
  // cloud/edge execution through the known uplink path so ordinary validation tasks
  // do not get rejected just because the chosen terminal is poorly connected.
  const origin = getNode(originId);
  const cloud = nodes.find((node) => node.type === 'Cloud' && node.status === 'online');
  const fallbackNodes = [
    ...(origin?.type === 'Terminal'
      ? [bestGatewayForTerminal(origin), origin.backupEdgeId ? getNode(origin.backupEdgeId) : null]
      : []),
    ...nodes.filter((node) => node.type === 'Edge' && node.status === 'online')
      .sort((left, right) => (right.computeFree + right.storageFree) - (left.computeFree + left.storageFree))
      .slice(0, 8),
    cloud
  ].filter(Boolean);

  for (const node of fallbackNodes) {
    if (node.status !== 'online' || !eligible(node)) continue;
    if (node.computeFree < demand.compute * 0.04 || node.storageFree < demand.storage * 0.035) continue;
    const uplink = buildUplinkRoute(originId);
    let path = null;
    if (node.id === originId) path = [originId];
    else if (node.type === 'Cloud' && uplink) path = uplink;
    else {
      path = findPathWithinTwoHops(originId, node.id, map);
      if (!path && origin?.type === 'Terminal' && origin.gatewayEdgeId) path = [originId, origin.gatewayEdgeId, node.id];
      if (!path && cloud && node.type === 'Edge') path = [originId, node.id];
    }
    if (!path) continue;
    for (let i = 0; i < path.length - 1; i += 1) createPhysicalLink(path[i], path[i + 1], { active: true, force: true });
    const metrics = pathMetrics(path);
    if (!metrics) continue;
    const resourceScore = node.computeFree / Math.max(1, node.computeTotal) + node.storageFree / Math.max(1, node.storageTotal);
    const commScore = clamp(metrics.bottleneck / 900, 0, 1.5);
    const policyScore = pathPolicyScore(path);
    addCandidate({
      node,
      path,
      metrics,
      score: resourceScore * 1.45 + commScore * 1.65 + metrics.score * 0.62 + policyScore + 0.34,
      canHold: true
    });
  }

  return [...candidateMap.values()].sort((left, right) => right.score - left.score);
}

function splitWeight(candidate) {
  const computeRatio = candidate.node.computeFree / Math.max(1, candidate.node.computeTotal);
  const storageRatio = candidate.node.storageFree / Math.max(1, candidate.node.storageTotal);
  const commRatio = clamp(candidate.metrics.bottleneck / 900, 0.05, 1.6);
  return Math.max(0.05, computeRatio * 0.42 + storageRatio * 0.28 + commRatio * 0.3);
}

function normalizeImagePayload(payload = {}) {
  const sourceBytes = Number(payload.imageSizeBytes ?? payload.sizeBytes ?? 0);
  const sourceMb = Number(payload.sourceImageMb ?? (sourceBytes / (1024 * 1024)));
  if (!Number.isFinite(sourceMb) || sourceMb <= 0) {
    return { error: 'invalid_image', message: '请先选择有效图像，再启动任务。' };
  }
  const compressedMb = Number((sourceMb / 3).toFixed(3));
  const targetCount = clamp(Math.round(Number(payload.targetCount || TS_TARGET_COUNT)), 1, 200);
  return {
    name: String(payload.imageName || '待分析图像').slice(0, 120),
    sourceBytes: Math.round(sourceBytes || sourceMb * 1024 * 1024),
    sourceMb: Number(sourceMb.toFixed(3)),
    compressedMb,
    compressionRatio: 1 / 3,
    targetCount,
    description: `图像压缩为原始大小的 1/3，算法将按 ${compressedMb} MB 图像内存、节点可用资源和链路带宽进行分布式调度。`
  };
}

function imageDemand(image, sequence = 0) {
  const targetFactor = image.targetCount * 7;
  const jitter = 0.88 + ((sequence * 37) % 17) / 100;
  return {
    compute: Math.max(140, Math.round((220 + image.compressedMb * 82 + targetFactor) * jitter)),
    storage: Math.max(56, Math.round((48 + image.compressedMb * 1.8 + image.targetCount * 0.7) * jitter)),
    data: Math.max(1, Number((image.compressedMb * (0.94 + (sequence % 5) * 0.03)).toFixed(2)))
  };
}

function terminalSchedulingScore(terminal) {
  const gateway = getNode(terminal.gatewayEdgeId);
  const access = gateway ? activeLinkBetween(terminal.id, gateway.id, 'terminal-edge') : null;
  const memoryRatio = terminal.storageFree / Math.max(1, terminal.storageTotal);
  const computeRatio = terminal.computeFree / Math.max(1, terminal.computeTotal);
  const pathBandwidth = access
    ? Math.max(0, access.bandwidth * (1 - access.utilization) - Number(access.reservedMbps || 0))
    : 0;
  return memoryRatio * 0.48 + computeRatio * 0.24 + clamp(pathBandwidth / 500, 0, 1) * 0.28;
}

function chooseDistributedWorkers(count = 20) {
  const edges = nodes.filter((node) => node.type === 'Edge' && node.status === 'online');
  const terminals = nodes.filter((node) => node.type === 'Terminal' && node.status === 'online');
  const selected = [];
  for (const edge of edges) {
    const domainCandidates = terminals
      .filter((node) => node.gatewayEdgeId === edge.id)
      .sort((left, right) => terminalSchedulingScore(right) - terminalSchedulingScore(left))
      .slice(0, 2);
    selected.push(edge, ...domainCandidates);
  }
  const candidates = [...nodes]
    .filter((node) => node.status === 'online' && node.type !== 'Cloud')
    .sort((left, right) => {
      const leftScore = left.type === 'Edge'
        ? left.computeFree / left.computeTotal + left.storageFree / left.storageTotal
        : terminalSchedulingScore(left);
      const rightScore = right.type === 'Edge'
        ? right.computeFree / right.computeTotal + right.storageFree / right.storageTotal
        : terminalSchedulingScore(right);
      return rightScore - leftScore;
    });
  for (const node of candidates) {
    if (selected.some((item) => item.id === node.id)) continue;
    selected.push(node);
    if (selected.length >= count) break;
  }
  return selected.slice(0, count).map((node) => node.id);
}

function sampleItems(items, count) {
  const pool = [...items];
  const selected = [];
  while (pool.length && selected.length < count) {
    const index = Math.floor(random() * pool.length);
    selected.push(pool.splice(index, 1)[0]);
  }
  return selected;
}

function chooseBatchOrigins() {
  const origins = [];
  for (const edge of nodes.filter((node) => node.type === 'Edge')) {
    const terminals = nodes.filter((node) => (
      node.type === 'Terminal'
      && node.status === 'online'
      && node.gatewayEdgeId === edge.id
    ));
    origins.push(...sampleItems(terminals, Math.min(5, terminals.length)));
  }
  return origins;
}

function buildTaskGraph(taskId, originId, fragments, demand) {
  const totalCompute = fragments.reduce((sum, fragment) => sum + fragment.compute, 0) || 1;
  const graphNodes = [
    { id: originId, role: 'origin', label: '任务发起方', ratio: 0 },
    ...fragments.map((fragment, index) => ({
      id: fragment.nodeId,
      fragmentId: fragment.id,
      role: 'compute',
      label: `分片 ${index + 1}`,
      ratio: Number((fragment.compute / totalCompute).toFixed(3)),
      compute: fragment.compute,
      storage: fragment.storage,
      data: fragment.data
    }))
  ];
  const edges = [];
  fragments.forEach((fragment, index) => {
    const nextFragment = fragments[(index + 1) % fragments.length];
    edges.push({
      id: `${taskId}-D${index + 1}`,
      from: originId,
      to: fragment.nodeId,
      role: 'dispatch',
      ratio: Number((fragment.compute / totalCompute).toFixed(3)),
      data: fragment.data
    });
    if (nextFragment && (nextFragment.nodeId !== fragment.nodeId || fragments.length === 1)) {
      edges.push({
        id: `${taskId}-R${index + 1}`,
        from: fragment.nodeId,
        to: index === fragments.length - 1 ? originId : nextFragment.nodeId,
        role: index === fragments.length - 1 ? 'gather' : 'handoff',
        ratio: Number((fragment.compute / totalCompute).toFixed(3)),
        data: Math.max(4, Math.round(fragment.data * 0.18))
      });
    }
  });
  return {
    mode: 'closedDirectedGraph',
    origin: originId,
    demand,
    nodes: graphNodes,
    edges,
    description: '首尾相接有向图：任务发起方按比例下发分片，节点计算后沿有向环传递部分结果，最后汇聚回发起方。'
  };
}

function createTask(payload = {}) {
  const online = nodes.filter((node) => node.status === 'online');
  const terminalOrigins = online.filter((node) => node.type === 'Terminal');
  const origin = payload.origin && getNode(payload.origin) ? getNode(payload.origin) : choose(terminalOrigins.length ? terminalOrigins : online);
  const image = payload.image || null;
  const demand = {
    compute: Number(payload.compute || Math.round(between(520, 1680))),
    storage: Number(payload.storage || Math.round(between(220, 820))),
    data: Number(payload.data || Math.round(between(180, 920)))
  };
  const priority = payload.priority || choose(['低', '中', '高', '紧急']);
  const splitStrategy = payload.splitStrategy || 'resourceWeighted';
  const candidates = twoHopCandidates(origin.id, demand, {
    executionPool: payload.executionPool
  }).slice(0, 20);
  let remainingCompute = demand.compute;
  let remainingStorage = demand.storage;
  const fragments = [];
  const selected = candidates.slice(0, Math.min(candidates.length, Number(payload.fragmentCount || 8)));

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
    if (computeSlice < Math.min(16, demand.compute * 0.03) || storageSlice < Math.min(8, demand.storage * 0.03)) continue;
    candidate.node.computeFree -= computeSlice;
    candidate.node.storageFree -= storageSlice;
    candidate.node.memoryFree = candidate.node.storageFree;
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

  const coveredCompute = demand.compute - remainingCompute;
  const coveredStorage = demand.storage - remainingStorage;
  const accepted = fragments.length > 0
    && coveredCompute >= demand.compute * 0.35
    && coveredStorage >= demand.storage * 0.3;

  // Materialize links along fragment paths — links are created only when data flows
  if (accepted) {
    for (const fragment of fragments) {
      fragment.reservedMbps = Math.max(4, Math.min(fragment.bottleneck * 0.32, fragment.data / 2.8));
      fragment.reservedLinkIds = [];
      for (let i = 0; i < fragment.path.length - 1; i += 1) {
        const link = ensureLink(fragment.path[i], fragment.path[i + 1]);
        if (link) {
          link.reservedMbps = Number((Number(link.reservedMbps || 0) + fragment.reservedMbps).toFixed(2));
          fragment.reservedLinkIds.push(link.id);
        }
      }
    }
  }

  const taskId = `T${String(nextTaskId++).padStart(4, '0')}`;
  const task = {
    id: taskId,
    createdAt: Date.now(),
    origin: origin.id,
    demand,
    priority,
    splitStrategy,
    image,
    targetCount: image?.targetCount || Number(payload.targetCount || 0),
    scheduler: {
      mode: payload.schedulerMode || 'distributed-resource-aware',
      executionPool: payload.executionPool || [],
      objective: 'image-memory + compute-free + path-bottleneck + network-budget'
    },
    status: accepted ? 'dispatching' : 'rejected',
    accepted,
    remaining: { compute: Math.max(0, remainingCompute), storage: Math.max(0, remainingStorage) },
    fragments,
    taskGraph: buildTaskGraph(taskId, origin.id, fragments, demand),
    trace: fragments.flatMap((fragment) => fragment.path.map((nodeId, order) => ({ nodeId, order, fragmentId: fragment.id }))).slice(0, 80),
    message: accepted
      ? 'distributed image-memory and bandwidth scheduling accepted'
      : 'insufficient memory, compute, or bandwidth within the distributed scheduling domain'
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
    node.memoryFree = node.storageFree;
    for (const linkId of fragment.reservedLinkIds || []) {
      const link = links.find((item) => item.id === linkId);
      if (link) {
        link.reservedMbps = Math.max(0, Number((Number(link.reservedMbps || 0) - Number(fragment.reservedMbps || 0)).toFixed(2)));
      }
    }
  }
  task.released = true;
}

function createImageScenario(payload = {}) {
  const image = normalizeImagePayload(payload);
  if (image.error) return image;
  const mode = payload.mode === 'batch60' ? 'batch60' : 'single';
  const workerPool = mode === 'batch60' ? chooseDistributedWorkers(20) : [];
  const origins = mode === 'batch60'
    ? chooseBatchOrigins()
    : [...nodes]
      .filter((node) => node.type === 'Terminal' && node.status === 'online')
      .sort((left, right) => terminalSchedulingScore(right) - terminalSchedulingScore(left))
      .slice(0, 1);
  if (!origins.length) return { error: 'no_origin', message: '当前没有可用终端节点。' };

  const taskCount = mode === 'batch60' ? 60 : 1;
  const createdTasks = [];
  for (let index = 0; index < taskCount; index += 1) {
    const origin = origins[index % origins.length];
    const demand = imageDemand(image, index);
    const task = createTask({
      origin: origin.id,
      ...demand,
      image,
      targetCount: image.targetCount,
      splitStrategy: 'resourceWeighted',
      fragmentCount: mode === 'batch60' ? 6 : 8,
      executionPool: workerPool,
      schedulerMode: mode === 'batch60' ? 'distributed-20-worker-pool' : 'distributed-image-task'
    });
    createdTasks.push(task);
    broadcast('task', task);
  }
  const frame = createTSSensingFrame({
    imageName: image.name,
    targetCount: image.targetCount
  });
  lastScenarioRun = {
    id: `RUN${String(Date.now()).slice(-8)}`,
    mode,
    image,
    targetCount: image.targetCount,
    taskCount,
    origins: origins.map((node) => node.id),
    workerPool,
    acceptedTasks: createdTasks.filter((task) => task.accepted).length,
    rejectedTasks: createdTasks.filter((task) => !task.accepted).length,
    startedAt: Date.now(),
    frameId: frame.id
  };
  queuePersistence(mode === 'batch60' ? 'batch_60_started' : 'single_image_started');
  return { run: lastScenarioRun, tasks: createdTasks, frame };
}

function resetSimulation(opts = {}) {
  if (opts.nodeCount && Number.isFinite(opts.nodeCount) && opts.nodeCount >= 3 && opts.nodeCount <= 2000) {
    NODE_COUNT = opts.nodeCount;
  }
  if (opts.edgeCount !== undefined && Number.isFinite(opts.edgeCount)) {
    const maxEdge = Math.max(1, NODE_COUNT - 1);
    EDGE_COUNT = Math.min(maxEdge, Math.max(1, Math.round(opts.edgeCount)));
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
  telemetryRecords.length = 0;
  relayLogs.length = 0;
  cloudInbox.length = 0;
  externalPlatformTracks.length = 0;
  tsSensingFrames.length = 0;
  nextTaskId = 1;
  nextLinkId = 1;
  nextPacketId = 1;
  nextTelemetryId = 1;
  nextTsFrameId = 1;
  tickCount = 0;
  paused = false;
  lastScenarioRun = null;
  createNodes();
  applyForceLayout();
  createStableTopology();
  queuePersistence('simulation_reset');
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
  if (csvTopologyRecords.length) {
    updateActiveLinkDistances();
    return;
  }
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

  updateActiveLinkDistances();
}

function updateActiveLinkDistances() {
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

function recordRelayArrival(journey, nodeId, now) {
  if (journey.direction !== 'uplink' || !journey.telemetryId) return;
  const node = getNode(nodeId);
  const record = telemetryById(journey.telemetryId);
  if (!node || !record || node.type !== 'Edge') return;
  const duplicate = relayLogs.some((log) => log.telemetryId === record.id && log.nodeId === node.id);
  if (duplicate) return;
  const log = {
    id: `R${String(relayLogs.length + 1).padStart(4, '0')}`,
    telemetryId: record.id,
    packetId: journey.id,
    taskId: journey.taskId,
    nodeId: node.id,
    nodeName: node.name,
    source: record.source,
    action: 'relay',
    receivedAt: now,
    forwardedAt: now + Math.round(between(80, 320)),
    latency: journey.latency,
    bottleneck: journey.bottleneck
  };
  relayLogs.unshift(log);
  while (relayLogs.length > MAX_RELAY_LOGS) relayLogs.pop();
  record.status = 'relayed';
  record.viaEdge = node.id;
  record.relayedAt = now;
}

function recordCloudArrival(journey, now) {
  if (journey.direction !== 'uplink' || !journey.telemetryId) return;
  const record = telemetryById(journey.telemetryId);
  if (!record || cloudInbox.some((item) => item.telemetryId === record.id)) return;
  const cloudNode = getNode(journey.target);
  const item = {
    id: `C${String(cloudInbox.length + 1).padStart(4, '0')}`,
    telemetryId: record.id,
    packetId: journey.id,
    taskId: journey.taskId,
    cloudNodeId: cloudNode?.id || journey.target,
    source: record.source,
    sourceName: record.sourceName,
    sourceZone: record.sourceZone,
    viaEdge: record.viaEdge || journey.path.find((nodeId) => getNode(nodeId)?.type === 'Edge') || null,
    receivedAt: now,
    path: journey.path,
    payload: record.payload,
    latency: journey.latency,
    bottleneck: journey.bottleneck,
    loss: journey.loss
  };
  cloudInbox.unshift(item);
  while (cloudInbox.length > MAX_CLOUD_INBOX) cloudInbox.pop();
  record.status = 'cloud_received';
  record.receivedAt = now;
}

function processJourneyArrivals(journey, reachedIndex, now) {
  if (!Number.isFinite(journey.lastReachedIndex)) journey.lastReachedIndex = 0;
  if (reachedIndex <= journey.lastReachedIndex) return;
  for (let index = journey.lastReachedIndex + 1; index <= reachedIndex; index += 1) {
    const nodeId = journey.path[index];
    recordRelayArrival(journey, nodeId, now);
    if (index === journey.path.length - 1) recordCloudArrival(journey, now);
  }
  journey.lastReachedIndex = reachedIndex;
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
    const multiplier = Math.max(1, Number(journey.speedMultiplier || 1));
    journey.progress = clamp(journey.progress + speed * between(0.05, 0.11) * multiplier, 0, 1);
    journey.currentHop = Math.min(hopCount - 1, Math.floor(journey.progress * hopCount));
    journey.status = journey.progress >= 0.995 ? 'complete' : 'transmitting';
    journey.latency = Math.round(metrics.latency || journey.latency || 0);
    journey.bottleneck = Math.round(metrics.bottleneck || journey.bottleneck || 0);
    journey.loss = Number((metrics.loss || journey.loss || 0).toFixed(2));
    const reachedIndex = Math.min(journey.path.length - 1, Math.floor(journey.progress * hopCount));
    processJourneyArrivals(journey, reachedIndex, now);

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
      processJourneyArrivals(journey, journey.path.length - 1, now);
    }
  }
}

function dbLimit(url, fallback) {
  const limit = Number(url.searchParams.get('limit') || fallback);
  if (!Number.isFinite(limit) || limit <= 0) return fallback;
  return Math.min(Math.round(limit), 1000);
}

function nodeGeo(node) {
  if (Number.isFinite(node?.latitude) && Number.isFinite(node?.longitude)) {
    return {
      latitude: Number(node.latitude.toFixed(6)),
      longitude: Number(node.longitude.toFixed(6))
    };
  }
  const latRange = MARITIME_BOUNDS.maxLat - MARITIME_BOUNDS.minLat;
  const lngRange = MARITIME_BOUNDS.maxLng - MARITIME_BOUNDS.minLng;
  return {
    latitude: Number((MARITIME_BOUNDS.minLat + (1 - node.y) * latRange).toFixed(6)),
    longitude: Number((MARITIME_BOUNDS.minLng + node.x * lngRange).toFixed(6))
  };
}

function geoToCanvas(latitude, longitude) {
  const latRange = MARITIME_BOUNDS.maxLat - MARITIME_BOUNDS.minLat;
  const lngRange = MARITIME_BOUNDS.maxLng - MARITIME_BOUNDS.minLng;
  return {
    x: clamp((longitude - MARITIME_BOUNDS.minLng) / lngRange, 0.02, 0.98),
    y: clamp(1 - (latitude - MARITIME_BOUNDS.minLat) / latRange, 0.04, 0.96)
  };
}

function sensingTargets(count = TS_TARGET_COUNT) {
  const tracks = databaseAPlatformTracks(Math.max(count, 24))
    .filter((track) => track.status !== 'offline')
    .slice(0, count);
  if (tracks.length) {
    return tracks.map((track, index) => ({
      id: `TS-${String(index + 1).padStart(3, '0')}`,
      name: track.name,
      class: track.type === 'aircraft' ? '空中目标' : '海面目标',
      ...geoToCanvas(track.latitude, track.longitude),
      latitude: track.latitude,
      longitude: track.longitude,
      speed_kn: track.speed_kn,
      heading_deg: track.heading_deg,
      source_track_id: track.id
    }));
  }
  return nodes.slice(1, count + 1).map((node, index) => {
    const geo = nodeGeo(node);
    return {
      id: `TS-${String(index + 1).padStart(3, '0')}`,
      name: `仿真目标-${String(index + 1).padStart(3, '0')}`,
      class: node.type === 'Edge' ? '空中目标' : '海面目标',
      x: node.x,
      y: node.y,
      latitude: geo.latitude,
      longitude: geo.longitude,
      speed_kn: Number((6 + node.load * 18).toFixed(1)),
      heading_deg: Number(((node.pulse * 360 + index * 29) % 360).toFixed(1)),
      source_track_id: null
    };
  });
}

function sensorScore(sensor, target) {
  const d = Math.hypot(sensor.x - target.x, sensor.y - target.y);
  const range = sensor.type === 'Cloud' ? 0.7 : sensor.type === 'Edge' ? 0.38 : 0.22;
  const resource = clamp(sensor.computeFree / Math.max(1, sensor.computeTotal), 0, 1);
  const signal = clamp(1 - d / range, 0, 1);
  return signal * 0.68 + resource * 0.22 + (sensor.status === 'online' ? 0.1 : 0);
}

function createTSSensingFrame(options = {}) {
  const targets = sensingTargets(Number(options.targetCount || TS_TARGET_COUNT));
  const onlineSensors = nodes.filter((node) => node.status === 'online' && node.type !== 'Cloud');
  const edges = nodes.filter((node) => node.status === 'online' && node.type === 'Edge');
  const detections = [];
  for (const target of targets) {
    const sensors = onlineSensors
      .map((sensor) => ({ sensor, score: sensorScore(sensor, target) }))
      .filter((item) => item.score > 0.18)
      .sort((left, right) => right.score - left.score)
      .slice(0, 4);
    const fusionEdge = edges
      .map((edge) => ({ edge, distance: Math.hypot(edge.x - target.x, edge.y - target.y) }))
      .sort((left, right) => left.distance - right.distance)[0]?.edge || null;
    const confidence = sensors.length
      ? clamp(sensors.reduce((sum, item) => sum + item.score, 0) / sensors.length + Math.min(0.18, sensors.length * 0.035), 0.2, 0.99)
      : 0.16;
    detections.push({
      id: `${target.id}-D${String(nextTsFrameId).padStart(4, '0')}`,
      target,
      sensor_nodes: sensors.map((item) => ({
        node_id: item.sensor.id,
        node_type: item.sensor.type,
        confidence: Number(item.score.toFixed(3)),
        link_path: fusionEdge ? (findPathWithinTwoHops(item.sensor.id, fusionEdge.id) || [item.sensor.id, fusionEdge.id]) : [item.sensor.id]
      })),
      fusion_node_id: fusionEdge?.id || 'N001',
      confidence: Number(confidence.toFixed(3)),
      status: confidence >= 0.72 ? 'fused' : confidence >= 0.42 ? 'tracking' : 'weak',
      latency_ms: Math.round(18 + (1 - confidence) * 120 + sensors.length * 6),
      evidence_count: sensors.length
    });
  }
  const frame = {
    id: `TSF${String(nextTsFrameId++).padStart(4, '0')}`,
    createdAt: Date.now(),
    sourceImageName: options.imageName || options.sourceImageName || '遥感图',
    targets: detections.map((item) => item.target),
    detections,
    fusedCount: detections.filter((item) => item.status === 'fused').length,
    weakCount: detections.filter((item) => item.status === 'weak').length
  };
  tsSensingFrames.unshift(frame);
  while (tsSensingFrames.length > MAX_TS_FRAMES) tsSensingFrames.pop();
  return frame;
}

function databaseATSSensing(limit = 80) {
  return tsSensingFrames.slice(0, limit).flatMap((frame) => frame.detections.map((detection) => ({
    frame_id: frame.id,
    source_image_name: frame.sourceImageName,
    target_id: detection.target.id,
    target_name: detection.target.name,
    target_class: detection.target.class,
    latitude: detection.target.latitude,
    longitude: detection.target.longitude,
    canvas_x: Number(detection.target.x.toFixed(4)),
    canvas_y: Number(detection.target.y.toFixed(4)),
    fusion_node_id: detection.fusion_node_id,
    sensor_node_ids: detection.sensor_nodes.map((sensor) => sensor.node_id),
    evidence_count: detection.evidence_count,
    confidence: detection.confidence,
    status: detection.status,
    latency_ms: detection.latency_ms,
    sensed_at: toIso(frame.createdAt)
  })));
}

function normalizePlatformTrack(payload = {}) {
  const associatedNodeId = payload.associated_node_id || payload.associatedNodeId || payload.node_id || payload.nodeId;
  const node = associatedNodeId ? getNode(associatedNodeId) : null;
  const fallbackGeo = node ? nodeGeo(node) : {
    latitude: (MARITIME_BOUNDS.minLat + MARITIME_BOUNDS.maxLat) / 2,
    longitude: (MARITIME_BOUNDS.minLng + MARITIME_BOUNDS.maxLng) / 2
  };
  const type = ['vessel', 'aircraft', 'vehicle'].includes(payload.type) ? payload.type : 'vessel';
  const latitude = Number(payload.latitude ?? payload.lat ?? fallbackGeo.latitude);
  const longitude = Number(payload.longitude ?? payload.lng ?? payload.lon ?? fallbackGeo.longitude);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    return { error: 'invalid_latitude', message: 'latitude 需为 -90 到 90 之间的数字' };
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    return { error: 'invalid_longitude', message: 'longitude 需为 -180 到 180 之间的数字' };
  }
  return {
    id: String(payload.id || `${type === 'aircraft' ? 'A' : type === 'vehicle' ? 'M' : 'V'}${String(externalPlatformTracks.length + 1).padStart(3, '0')}`),
    type,
    name: String(payload.name || payload.callsign || (type === 'aircraft' ? '外部飞机' : '外部船只')),
    latitude: Number(latitude.toFixed(6)),
    longitude: Number(longitude.toFixed(6)),
    altitude_m: Number(payload.altitude_m ?? payload.altitudeM ?? (type === 'aircraft' ? 1200 : 0)),
    heading_deg: Number(clamp(Number(payload.heading_deg ?? payload.headingDeg ?? payload.heading ?? 0), 0, 360).toFixed(1)),
    speed_kn: Number(Math.max(0, Number(payload.speed_kn ?? payload.speedKn ?? payload.speed ?? 0)).toFixed(1)),
    associated_node_id: associatedNodeId ? String(associatedNodeId) : null,
    status: ['active', 'idle', 'offline'].includes(payload.status) ? payload.status : 'active',
    zone: String(payload.zone || node?.zone || 'A'),
    recorded_at: toIso(payload.recorded_at || payload.recordedAt || Date.now())
  };
}

function upsertExternalPlatformTrack(payload) {
  const track = normalizePlatformTrack(payload);
  if (track.error) return track;
  const index = externalPlatformTracks.findIndex((item) => item.id === track.id);
  if (index >= 0) {
    externalPlatformTracks.splice(index, 1);
  }
  externalPlatformTracks.unshift(track);
  while (externalPlatformTracks.length > MAX_EXTERNAL_PLATFORM_TRACKS) externalPlatformTracks.pop();
  return track;
}

function platformTrackForNode(node, index) {
  const geo = nodeGeo(node);
  const isAirborne = node.type === 'Edge' && index % 9 === 0;
  const heading = (node.pulse * 360 + idNumber(node.id) * 17 + tickCount * 3) % 360;
  const platformPrefix = isAirborne ? 'A' : 'V';
  const speed = isAirborne
    ? 190 + ((idNumber(node.id) * 13 + tickCount * 7) % 140)
    : 8 + node.load * 12 + (node.pulse % 0.35) * 10;
  return {
    id: `${platformPrefix}${String(index + 1).padStart(3, '0')}`,
    type: isAirborne ? 'aircraft' : 'vessel',
    name: isAirborne ? `海域巡航飞机-${String(index + 1).padStart(3, '0')}` : `海上移动终端-${String(index + 1).padStart(3, '0')}`,
    latitude: geo.latitude,
    longitude: geo.longitude,
    altitude_m: isAirborne ? Math.round(900 + (node.pulse * 1800) % 2200) : 0,
    heading_deg: Number(heading.toFixed(1)),
    speed_kn: Number(speed.toFixed(1)),
    associated_node_id: node.id,
    status: node.status === 'offline' ? 'offline' : node.status === 'degraded' ? 'idle' : 'active',
    zone: node.zone,
    recorded_at: toIso(Date.now())
  };
}

function databaseAPlatformTracks(limit = 80) {
  const terminals = nodes.filter((node) => node.type === 'Terminal');
  const mobileEdges = nodes.filter((node) => node.type === 'Edge').slice(0, Math.max(1, Math.floor(limit / 12)));
  const generated = [...terminals, ...mobileEdges].map(platformTrackForNode);
  return [...externalPlatformTracks, ...generated].slice(0, limit);
}

function databaseANodeSnapshots(limit = nodes.length) {
  return nodes.slice(0, limit).map((node) => ({
    node_id: node.id,
    name: node.name,
    type: node.type,
    unit_name: node.unitName || node.name,
    branch: node.branch || node.label,
    source_columns: node.sourceColumns || null,
    zone: node.zone,
    latitude: nodeGeo(node).latitude,
    longitude: nodeGeo(node).longitude,
    x: Number(node.x.toFixed(4)),
    y: Number(node.y.toFixed(4)),
    compute_total: Math.round(node.computeTotal),
    compute_free: Math.round(node.computeFree),
    storage_total: Math.round(node.storageTotal),
    storage_free: Math.round(node.storageFree),
    tx_mbps: Number(node.txMbps.toFixed(2)),
    rx_mbps: Number(node.rxMbps.toFixed(2)),
    load: Number(node.load.toFixed(3)),
    status: node.status,
    gateway_edge_id: node.gatewayEdgeId || null,
    backup_edge_id: node.backupEdgeId || null,
    uplink_route_mode: node.multiHopRelay?.mode || 'default',
    uplink_hop_count: node.multiHopRelay?.hopCount || (node.type === 'Cloud' ? 0 : node.type === 'Edge' ? 1 : 2),
    relay_terminal_id: node.multiHopRelay?.relayTerminalId || null,
    relay_edge_id: node.multiHopRelay?.relayEdgeId || null,
    snapshot_at: toIso(Date.now())
  }));
}

function linkAck(link) {
  const retransmit = Math.max(0, Math.round(link.loss / 1.6 + link.utilization * 2 - 0.8));
  const ackReceived = Boolean(link.active && link.loss < 7.5 && retransmit < 6);
  return {
    ack_received: ackReceived,
    ack_latency_ms: ackReceived ? Number((link.latency * 1.85 + retransmit * 7).toFixed(1)) : null,
    retransmit_count: retransmit,
    rssi_dbm: ['terminal-edge', 'terminal-peer', 'flex'].includes(link.role)
      ? Math.round(clamp(-48 - link.distance / 32 - link.loss * 2.4, -112, -38))
      : null
  };
}

function databaseALinkStatus(limit = links.length) {
  return links.slice(0, limit).map((link) => {
    const na = getNode(link.a);
    const nb = getNode(link.b);
    return {
    link_id: link.id,
    node_a: link.a,
    node_b: link.b,
    role: link.role,
    hops_a: na?.hopsToCloud ?? null,
    hops_b: nb?.hopsToCloud ?? null,
    bandwidth_mbps: Math.round(link.bandwidth),
    latency_ms: Number(link.latency.toFixed(1)),
    loss_rate: Number(link.loss.toFixed(2)),
    utilization: Number(link.utilization.toFixed(3)),
    distance_m: Number(link.distance.toFixed(1)),
    active: Boolean(link.active),
    persistent: Boolean(link.persistent),
    self_organized: Boolean(link.selfOrganized),
    medium: link.medium || null,
    topology_layer: link.topologyLayer || null,
    ...linkAck(link),
    recorded_at: toIso(Date.now())
  };
  });
}

function databaseATasks(limit = 80) {
  return tasks.slice(0, limit).map((task) => ({
    task_id: task.id,
    origin_node_id: task.origin,
    demand_compute: Math.round(task.demand.compute),
    demand_storage: Math.round(task.demand.storage),
    demand_data: Math.round(task.demand.data),
    priority: task.priority,
    split_strategy: task.splitStrategy,
    status: task.status,
    accepted: Boolean(task.accepted),
    progress: Number((task.progress || 0).toFixed(3)),
    task_graph_mode: task.taskGraph?.mode || null,
    graph_node_count: task.taskGraph?.nodes?.length || 0,
    graph_edge_count: task.taskGraph?.edges?.length || 0,
    remaining_compute: Math.round(task.remaining?.compute || 0),
    remaining_storage: Math.round(task.remaining?.storage || 0),
    elapsed_ms: Math.round(task.elapsedMs || 0),
    message: task.message || '',
    created_at: toIso(task.createdAt),
    completed_at: task.status === 'complete' ? toIso(task.createdAt + (task.elapsedMs || 0)) : null
  }));
}

function databaseATaskFragments(limit = 160) {
  return tasks
    .flatMap((task) => task.fragments.map((fragment) => ({
      fragment_id: fragment.id,
      task_id: task.id,
      node_id: fragment.nodeId,
      path: fragment.path,
      compute_slice: Math.round(fragment.compute),
      storage_slice: Math.round(fragment.storage),
      data_slice: Math.round(fragment.data),
      progress: Number(fragment.progress.toFixed(3)),
      stage: fragment.stage,
      latency_ms: Number(fragment.latency.toFixed(1)),
      bottleneck_mbps: Math.round(fragment.bottleneck),
      score: Number(fragment.score.toFixed(2))
    })))
    .slice(0, limit);
}

function journeyHopAckMap(journey) {
  const hopCount = Math.max(0, journey.path.length - 1);
  const reachedHop = journey.status === 'complete' ? hopCount : Math.floor((journey.progress || 0) * hopCount);
  const map = {};
  for (let index = 0; index < hopCount; index += 1) {
    const link = linkBetween(journey.path[index], journey.path[index + 1]);
    map[`hop_${index}`] = Boolean(index < reachedHop && link && linkAck(link).ack_received);
  }
  return map;
}

function databaseAPacketJourneys(limit = 120) {
  return packetJourneys.slice(0, limit).map((journey) => ({
    packet_id: journey.id,
    task_id: journey.taskId,
    kind: journey.kind,
    direction: journey.direction,
    telemetry_id: journey.telemetryId || null,
    label: journey.label,
    origin_node_id: journey.origin,
    target_node_id: journey.target,
    path: journey.path,
    hop_count: Math.max(0, journey.path.length - 1),
    data_mb: Math.round(journey.data),
    priority: journey.priority,
    progress: Number((journey.progress || 0).toFixed(3)),
    current_hop: journey.currentHop,
    status: journey.status,
    latency_ms: Number((journey.latency || 0).toFixed(1)),
    bottleneck_mbps: Math.round(journey.bottleneck || 0),
    loss_rate: Number((journey.loss || 0).toFixed(2)),
    hop_ack_map: journeyHopAckMap(journey),
    created_at: toIso(journey.createdAt),
    started_at: toIso(journey.startAt),
    completed_at: toIso(journey.completedAt)
  }));
}

function databaseATelemetryRecords(limit = 120) {
  return telemetryRecords.slice(0, limit).map((record) => ({
    record_id: record.id,
    task_id: record.taskId,
    packet_id: record.packetId,
    payload_kind: record.payload.kind || 'sensor_sample',
    source_node_id: record.source,
    source_name: record.sourceName,
    source_zone: record.sourceZone,
    via_edge_id: record.viaEdge,
    target_node_id: record.target,
    path: record.path,
    image_name: record.payload.imageName || null,
    situation_description: record.payload.description || null,
    latitude: record.payload.latitude || null,
    longitude: record.payload.longitude || null,
    location_text: record.payload.locationText || null,
    tags: record.payload.tags || null,
    temperature: record.payload.temperature,
    signal_strength: record.payload.signalStrength,
    terminal_load: record.payload.terminalLoad,
    compute_free: Math.round(record.payload.computeFree),
    storage_free: Math.round(record.payload.storageFree),
    sample_size_mb: Math.round(record.payload.sampleSizeMb),
    status: record.status,
    created_at: toIso(record.createdAt),
    relayed_at: toIso(record.relayedAt),
    received_at: toIso(record.receivedAt)
  }));
}

function databaseARelayArrivalLogs(limit = 180) {
  const relayRows = relayLogs.map((log) => {
    const record = telemetryById(log.telemetryId);
    return {
      log_id: log.id,
      log_type: 'relay',
      telemetry_id: log.telemetryId,
      packet_id: log.packetId,
      task_id: log.taskId,
      node_id: log.nodeId,
      node_name: log.nodeName,
      source_node_id: log.source,
      source_zone: record?.sourceZone || null,
      via_edge_id: log.nodeId,
      path: record?.path?.slice(0, Math.max(1, record.path.indexOf(log.nodeId) + 1)) || [log.source, log.nodeId],
      action: log.action,
      latency_ms: Number((log.latency || 0).toFixed(1)),
      bottleneck_mbps: Math.round(log.bottleneck || 0),
      loss_rate: null,
      payload: record?.payload || null,
      received_at: toIso(log.receivedAt),
      forwarded_at: toIso(log.forwardedAt)
    };
  });
  const cloudRows = cloudInbox.map((item) => ({
    log_id: item.id,
    log_type: 'cloud_arrival',
    telemetry_id: item.telemetryId,
    packet_id: item.packetId,
    task_id: item.taskId,
    node_id: item.cloudNodeId,
    node_name: getNode(item.cloudNodeId)?.name || '云节点',
    source_node_id: item.source,
    source_zone: item.sourceZone,
    via_edge_id: item.viaEdge,
    path: item.path,
    action: 'received',
    latency_ms: Number((item.latency || 0).toFixed(1)),
    bottleneck_mbps: Math.round(item.bottleneck || 0),
    loss_rate: Number((item.loss || 0).toFixed(2)),
    payload: item.payload,
    received_at: toIso(item.receivedAt),
    forwarded_at: null
  }));
  return [...relayRows, ...cloudRows]
    .sort((left, right) => Date.parse(right.received_at || 0) - Date.parse(left.received_at || 0))
    .slice(0, limit);
}

function databaseASnapshot(url) {
  const limit = dbLimit(url, 200);
  return {
    database: 'A',
    generated_at: toIso(Date.now()),
    scenario: '海上移动终端上行态势监控',
    tables: {
      platform_tracks: databaseAPlatformTracks(Math.min(limit, 120)),
      node_snapshots: databaseANodeSnapshots(limit),
      link_status: databaseALinkStatus(limit),
      tasks: databaseATasks(Math.min(limit, 120)),
      task_fragments: databaseATaskFragments(Math.min(limit, 240)),
      packet_journeys: databaseAPacketJourneys(Math.min(limit, 160)),
      telemetry_records: databaseATelemetryRecords(Math.min(limit, 160)),
      relay_arrival_logs: databaseARelayArrivalLogs(Math.min(limit, 240)),
      ts_sensing: databaseATSSensing(Math.min(limit, 160))
    }
  };
}

function databaseAInterfaces() {
  return {
    database: 'A',
    note: '以下接口只返回仿真内存态，不写入数据库；字段使用数据库 A 表结构命名。',
    endpoints: [
      { method: 'GET', path: '/api/database-a', description: '一次性返回 8 类表结构数据', query: { limit: '每类数据最大返回条数，默认 200，最大 1000' } },
      { method: 'GET', path: '/api/database-a/platform-tracks', description: '移动载体轨迹：船只/飞机位置、航向、航速、关联通信节点' },
      { method: 'POST', path: '/api/platform-tracks', description: '外部系统上报船只/飞机位置，保存在仿真内存态中' },
      { method: 'GET', path: '/api/database-a/node-snapshots', description: '云边端节点资源和在线状态快照' },
      { method: 'GET', path: '/api/database-a/link-status', description: '通信链路带宽、时延、丢包、ACK、重传和 RSSI' },
      { method: 'GET', path: '/api/database-a/tasks', description: '任务记录：算力/存储/数据需求量、优先级、调度状态' },
      { method: 'GET', path: '/api/database-a/task-fragments', description: '任务分片：节点分配、路径、进度、瓶颈带宽' },
      { method: 'GET', path: '/api/database-a/packet-journeys', description: '上行态势与下行控制指令逐跳追踪和 ACK' },
      { method: 'GET', path: '/api/database-a/telemetry-records', description: '终端上行态势采样数据' },
      { method: 'GET', path: '/api/database-a/relay-arrival-logs', description: '边缘中转记录与云端入库记录合并表' },
      { method: 'GET', path: '/api/database-a/ts-sensing', description: '遥感图协同态势感知：目标、传感节点、融合节点、置信度' },
      { method: 'POST', path: '/api/situation-descriptions', description: '终端图像态势描述上行回传，经边缘节点转发至云端收件箱' },
      { method: 'POST', path: '/api/ts-sensing/scan', description: '兼容接口：基于当前遥感图名称触发一次协同态势感知帧生成' },
      { method: 'GET', path: '/api/export/nodes?format=csv', description: '导出节点快照，format 支持 json/csv' },
      { method: 'GET', path: '/api/export/links?format=csv', description: '导出链路状态，format 支持 json/csv' },
      { method: 'GET', path: '/api/export/tasks?format=csv', description: '导出任务和分片状态，format 支持 json/csv' }
    ]
  };
}

function snapshot() {
  const onlineNodes = nodes.filter((node) => node.status === 'online').length;
  const activeLinks = links.filter((link) => link.active).length;
  const selfOrganizedLinks = links.filter((link) => link.selfOrganized).length;
  const activeSelfOrganizedLinks = links.filter((link) => link.selfOrganized && link.active).length;
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
      selfOrganizedLinks,
      activeSelfOrganizedLinks,
      edgeMeshLinks: links.filter((link) => link.role === 'edge-mesh').length,
      terminalPeerLinks: links.filter((link) => link.role === 'terminal-peer').length,
      totalLinks: links.length,
      avgUtilization: Number(avgUtil.toFixed(2)),
      nodeTypes,
      edgeLimit: EDGE_COUNT,
      maxEdgeLimit: Math.floor(NODE_COUNT * MAX_EDGE_RATIO),
      linkRadius: LINK_RADIUS,
      runningTasks,
      activePackets: packetJourneys.filter((packet) => ['waiting', 'transmitting'].includes(packet.status)).length,
      telemetryRecords: telemetryRecords.length,
      relayLogs: relayLogs.length,
      cloudInbox: cloudInbox.length,
      tsFrames: tsSensingFrames.length,
      tsDetections: tsSensingFrames[0]?.detections.length || 0,
      tsFused: tsSensingFrames[0]?.fusedCount || 0,
      completeTasks: tasks.filter((task) => task.status === 'complete').length,
      rejectedTasks: tasks.filter((task) => task.status === 'rejected').length
    },
    nodes: nodes.map((node) => ({
      ...node,
      latitude: nodeGeo(node).latitude,
      longitude: nodeGeo(node).longitude
    })),
    links,
    tasks: tasks.slice(0, 18).map((task) => ({
      ...task,
      packetJourneys: (task.packetIds || [])
        .map((id) => packetJourneys.find((journey) => journey.id === id))
        .filter(Boolean)
    })),
    packetJourneys: packetJourneys.slice(0, 32),
    telemetryRecords: telemetryRecords.slice(0, 48),
    relayLogs: relayLogs.slice(0, 64),
    cloudInbox: cloudInbox.slice(0, 48),
    tsSensingFrames: tsSensingFrames.slice(0, 12)
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
  if (tickCount % 4 === 0) createTSSensingFrame({ imageName: tsSensingFrames[0]?.sourceImageName || '遥感图' });
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

function exportRows(kind, url) {
  const limit = dbLimit(url, 1000);
  if (kind === 'nodes') return databaseANodeSnapshots(limit);
  if (kind === 'links') return databaseALinkStatus(limit);
  if (kind === 'tasks') return databaseATasks(limit);
  if (kind === 'task-fragments') return databaseATaskFragments(limit);
  if (kind === 'telemetry') return databaseATelemetryRecords(limit);
  if (kind === 'ts-sensing') return databaseATSSensing(limit);
  return null;
}

function exportResponse(res, url, kind) {
  const rows = exportRows(kind, url);
  if (!rows) return json(res, 404, { error: 'unknown_export', message: '未知导出类型' });
  const format = (url.searchParams.get('format') || 'json').toLowerCase();
  if (format === 'csv') {
    const body = rowsToCsv(rows);
    res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${kind}.csv"`,
      'cache-control': 'no-store'
    });
    res.end(body);
    return null;
  }
  return json(res, 200, {
    exported_at: toIso(Date.now()),
    kind,
    count: rows.length,
    rows
  });
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
    if (url.pathname === '/api/database-a/interfaces' && req.method === 'GET') return json(res, 200, databaseAInterfaces());
    if (url.pathname === '/api/database-a' && req.method === 'GET') return json(res, 200, databaseASnapshot(url));
    if (url.pathname === '/api/database-a/platform-tracks' && req.method === 'GET') return json(res, 200, databaseAPlatformTracks(dbLimit(url, 120)));
    if (url.pathname === '/api/database-a/node-snapshots' && req.method === 'GET') return json(res, 200, databaseANodeSnapshots(dbLimit(url, nodes.length)));
    if (url.pathname === '/api/database-a/link-status' && req.method === 'GET') return json(res, 200, databaseALinkStatus(dbLimit(url, links.length)));
    if (url.pathname === '/api/database-a/tasks' && req.method === 'GET') return json(res, 200, databaseATasks(dbLimit(url, 120)));
    if (url.pathname === '/api/database-a/task-fragments' && req.method === 'GET') return json(res, 200, databaseATaskFragments(dbLimit(url, 240)));
    if (url.pathname === '/api/database-a/packet-journeys' && req.method === 'GET') return json(res, 200, databaseAPacketJourneys(dbLimit(url, 160)));
    if (url.pathname === '/api/database-a/telemetry-records' && req.method === 'GET') return json(res, 200, databaseATelemetryRecords(dbLimit(url, 160)));
    if (url.pathname === '/api/database-a/relay-arrival-logs' && req.method === 'GET') return json(res, 200, databaseARelayArrivalLogs(dbLimit(url, 240)));
    if (url.pathname === '/api/database-a/ts-sensing' && req.method === 'GET') return json(res, 200, databaseATSSensing(dbLimit(url, 160)));
    if (url.pathname.startsWith('/api/export/') && req.method === 'GET') {
      return exportResponse(res, url, url.pathname.replace('/api/export/', ''));
    }
    if (url.pathname === '/api/platform-tracks' && req.method === 'POST') {
      const body = await readBody(req);
      const track = upsertExternalPlatformTrack(body);
      if (track.error) return json(res, 400, track);
      broadcast('state', snapshot());
      return json(res, 201, track);
    }
    if (url.pathname === '/api/ts-sensing/scan' && req.method === 'POST') {
      const body = await readBody(req);
      const frame = createTSSensingFrame(body);
      broadcast('state', snapshot());
      return json(res, 201, frame);
    }
    if (url.pathname === '/api/situation-descriptions' && req.method === 'POST') {
      const body = await readBody(req);
      const result = createSituationDescriptionRecord(body);
      if (result.error) return json(res, 400, result);
      broadcast('state', snapshot());
      return json(res, 201, result);
    }
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
createTSSensingFrame({ imageName: '初始化遥感底图' });
createTask({ priority: '高' });
setInterval(step, TICK_MS);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Comm-compute network simulator running at http://127.0.0.1:${PORT}`);
  console.log(`Nodes: ${nodes.length}, links: ${links.length}`);
});
