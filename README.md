# 通信算力网络仿真环境

这是一个轻量化通信算力网络仿真原型，面向 Linux 部署和现场演示。它使用一个 Node.js 进程同时提供仿真后端、数据接口和浏览器展示界面，无需数据库、无需前端构建步骤。

## 已实现能力

- 构建 200 个仿真节点，包含 1 个云节点、最多 `max(10, ceil(总节点数 / 3))` 个边缘节点，其余为终端节点。
- 云边端节点状态完整建模：节点包含画布坐标、经纬度、通信收发速率、链路容量、算力、存储、在线状态、网关归属；支持界面点击弹窗查看，也支持 CSV/JSON 导出。
- 稳定组网：启动和重置时主动铺设“终端双归属边缘、边缘云回传、边缘横向互联”的持久拓扑，保障端-边-云信息高效稳定回传。
- 拓扑优化支持 30-200 节点演示规模：调度时复用邻接图和 2 跳候选路径，避免每个候选节点重复全图构图；界面可动态重置节点数、边缘节点数和通信半径。
- 通信链路模拟与可视化：主画布展示全网拓扑、链路热度、传输流光、任务路径高亮，链路亮度和活跃路径发光已增强。
- 上下行数据包追踪：每个被接受任务都会生成“上行态势回传”和“下行控制指令”两类数据包，记录路径、当前跳、进度、时延、瓶颈带宽和丢包情况。
- 终端回传数据留痕：上行态势包会关联终端采集数据，经过边缘节点时写入中转记录，到达云节点后写入云端收件箱；点击云节点可查看最近收到的终端回传数据。
- 遥感图协同态势感知：界面可上传遥感图作为态势底图，后端生成态势感知帧，展示目标、传感节点、融合边缘节点、置信度和感知时延。
- 任务拆解与周边执行：任务可从任意节点发起，调度层限定 2 跳通联范围，按剩余算力、剩余存储、通信容量和层级路径偏好选择执行节点，支持默认均分与资源权重拆分。
- 首尾相接有向任务图：每个接受任务会生成 `taskGraph`，任务发起方按比例下发分片，计算节点沿有向环接力，最后汇聚回任务发起方；界面“任务追踪”面板展示边关系和比例。
- 数据接口：提供 REST API 和 SSE 实时推送，展示层通过 `/api/events` 获取状态变化。
- 展示层：包含动态拓扑、点击节点状态弹窗、节点传输详情、链路详情表、任务追踪、数据采集、态势感知和导出入口。

## 三层结构

### 数据层

内存保存网络状态，默认包含：

- 200 个节点的类型、位置、区域、状态、总算力、剩余算力、总存储、剩余存储、收发速率。
- 节点间通信链路状态：端点、链路角色、带宽、时延、丢包率、负载、在线/中断、是否为持久组网链路。
- 数据包追踪队列：上行态势包与下行控制包的方向、路径、进度、当前跳和传输指标。
- 终端采集与云端接收记录：`telemetryRecords` 保存终端采样数据，`relayLogs` 保存边缘中转记录，`cloudInbox` 保存云节点已接收数据。
- 态势感知记录：`tsSensingFrames` 保存遥感图感知帧、目标坐标、传感节点、融合节点、置信度、感知状态和时延。
- 最近任务队列和每个任务分片的执行进度。

### 调度层

调度入口位于 `POST /api/tasks`，也会周期性自动注入任务。算法步骤：

1. 以任务发起节点为中心寻找 2 跳内通联节点。
2. 过滤离线节点、链路不可达节点、资源过低节点。
3. 对候选节点评分：剩余算力、剩余存储、路径瓶颈带宽、路径时延、丢包率、链路利用率，以及端-边-云路径偏好。
4. 选择前若干候选节点，默认按均分策略拆分任务分片；接口保留 `splitStrategy`，可切换为资源权重策略。
5. 更新分片节点资源占用，并在任务完成后释放资源。
6. 为被接受任务创建上行态势回传包和下行控制指令包，优先选择终端所属边缘网关与边-云主干链路。
7. 生成首尾相接有向图 `taskGraph`：发起方到各计算节点为下发边，计算节点之间为接力边，最后一个计算节点到发起方为汇聚边；每条边记录分片比例和数据量。

### 展示层

`public/` 下是无依赖浏览器界面：

- `动态拓扑`：Canvas 绘制 200 节点拓扑、链路状态和任务路径。
- `节点弹窗`：点击任意节点，展示通信容量、链路数量、算力、存储、时延、收发速率；云节点会显示最近收到的终端回传数据，边缘节点会显示中转记录，终端节点会显示采集记录。
- `链路详情`：表格展示单条链路实时指标和链路角色，便于区分端-边主链路、边-云主链路和弹性链路。
- `任务追踪`：优先展示当前任务的上行态势回传、下行控制指令逐节点路径，同时展示首尾相接有向任务图。
- `数据采集`：展示终端采集、边缘中转、云端入库的数量、路径和日志。
- `态势感知`：上传遥感图后将其作为底图，叠加态势目标、协同传感链路、融合节点、置信度和时延。
- `数据接入`：左侧提供遥感图上传、协同态势感知触发、节点/链路/任务 CSV 导出按钮。

## Linux 部署

建议 Node.js 24 LTS 或更高版本。

```bash
cd comm-compute-net-sim
npm start
```

默认监听：

```text
http://127.0.0.1:4173
```

如需指定端口或节点数量：

```bash
PORT=8080 NODE_COUNT=500 npm start
```

也可以在浏览器界面的"仿真设置"面板中动态调整节点数量（3-2000），无需重启服务。

## API

### 获取全网状态

```http
GET /api/state
```

### 数据库 A 对接视图接口

以下接口只返回当前仿真内存态，不写入数据库。字段按数据库 A 的表结构命名，适合对接“海上移动终端上行态势监控”场景。

```http
GET /api/database-a/interfaces
GET /api/database-a?limit=200
GET /api/database-a/platform-tracks?limit=120
GET /api/database-a/node-snapshots?limit=200
GET /api/database-a/link-status?limit=200
GET /api/database-a/tasks?limit=80
GET /api/database-a/task-fragments?limit=160
GET /api/database-a/packet-journeys?limit=120
GET /api/database-a/telemetry-records?limit=120
GET /api/database-a/relay-arrival-logs?limit=180
GET /api/database-a/ts-sensing?limit=160
```

外部系统也可以上报船只/飞机轨迹，服务只保存在当前仿真内存态中，不写数据库：

```http
POST /api/platform-tracks
Content-Type: application/json

{
  "id": "V001",
  "type": "vessel",
  "name": "海上终端船-001",
  "latitude": 20.3486,
  "longitude": 114.1269,
  "altitude_m": 0,
  "heading_deg": 82.5,
  "speed_kn": 12.4,
  "associated_node_id": "N038",
  "status": "active",
  "zone": "C"
}
```

返回内容覆盖：

- `platform_tracks`：船只/飞机位置、经纬度、高度、航向、航速、关联通信节点。
- `node_snapshots`：云、边、端节点剩余算力、剩余存储、TX/RX 速率、在线状态。
- `link_status`：带宽、时延、丢包率、ACK 状态、重传次数、RSSI。
- `tasks`：算力/存储/数据需求量、优先级、调度状态。
- `task_fragments`：分片分配节点、路径、执行进度、瓶颈带宽。
- `packet_journeys`：上行态势与下行控制指令的逐跳路径、进度、逐跳 ACK。
- `telemetry_records`：终端上行态势采样数据。
- `relay_arrival_logs`：边缘中转记录与云端入库记录合并表。
- `ts_sensing`：遥感图协同态势感知目标、传感节点、融合节点、置信度和时延。

### 导出节点、链路和任务

界面左侧“数据接入”面板提供导出按钮，也可以直接调用接口。`format` 支持 `json` 和 `csv`：

```http
GET /api/export/nodes?format=csv&limit=1000
GET /api/export/links?format=csv&limit=1000
GET /api/export/tasks?format=csv&limit=1000
GET /api/export/task-fragments?format=csv&limit=1000
GET /api/export/telemetry?format=csv&limit=1000
GET /api/export/ts-sensing?format=csv&limit=1000
```

节点导出包含：

- `node_id`、`name`、`type`、`zone`
- `latitude`、`longitude`、`x`、`y`
- `compute_total`、`compute_free`
- `storage_total`、`storage_free`
- `tx_mbps`、`rx_mbps`、`load`、`status`
- `gateway_edge_id`、`backup_edge_id`

### 遥感图态势描述回传

浏览器端可在“数据接入”面板上传遥感图，图像作为当前浏览器展示底图；用户在“态势描述”中填写人工或大模型生成的图像描述。点击“上传态势描述”后，系统会假设所选终端节点拍摄到该图像，并把描述作为上行数据包经“终端 → 边缘 → 云端”路径回传。云节点收到后会在“态势感知”和“数据采集”视图展示该描述、坐标、路径和接收状态。

新业务接口：

```http
POST /api/situation-descriptions
Content-Type: application/json

{
  "sourceId": "N068",
  "imageName": "remote-sensing.jpg",
  "description": "终端拍摄到海域态势图，包含多条航迹线、目标标注和疑似协同活动，需要回传云端展示。"
}
```

返回内容包含：

- `record`：图像态势描述数据记录，`payload.kind = image_situation_description`。
- `journey`：该描述的上行数据包，含数据包编号、进度、时延、瓶颈带宽和路径。
- `route`：端边云回传路径，例如 `N068 → N035 → N001`。

兼容接口仍保留 `ts-sensing`，其中 `TS` 为“态势”的业务缩写；界面面向演示统一显示“态势感知”。它可用于旧的仿真态势帧生成：

```http
POST /api/ts-sensing/scan
Content-Type: application/json

{
  "imageName": "remote-sensing.jpg",
  "targetCount": 9
}
```

返回内容包含：

- `targets`：目标位置、经纬度、类型、航向和速度。
- `detections`：每个目标的协同传感节点、融合节点、置信度、状态和感知时延。
- `fusedCount`、`weakCount`：高置信融合目标数和弱感知目标数。

### 实时状态推送

```http
GET /api/events
```

返回 Server-Sent Events，事件类型包括：

- `state`：全网快照。
- `task`：新任务产生。

### 注入任务

```http
POST /api/tasks
Content-Type: application/json

{
  "origin": "N001",
  "compute": 960,
  "storage": 420,
  "data": 520,
  "priority": "高",
  "splitStrategy": "equal"
}
```

`splitStrategy` 默认为 `equal`，也可传 `resourceWeighted`，按候选节点剩余算力、剩余存储和链路瓶颈容量加权拆分。

返回 `201` 表示调度接受，`409` 表示 2 跳范围内资源或链路质量不足。接受后的任务对象包含：

- `fragments`：任务分片的执行节点、路径、计算/存储/数据量、进度和瓶颈带宽。
- `packetIds`：上行态势回传包和下行控制包。
- `taskGraph`：首尾相接有向任务图，含节点角色、边方向、拆分比例和数据量。

### 重置仿真

```http
POST /api/reset
Content-Type: application/json

{
  "nodeCount": 300
}
```

重置仿真环境并重新生成指定数量的节点与链路。`nodeCount` 需在 3-2000 之间。返回 `200` 及新的全网快照。

## 演示建议

1. 打开首页后先看动态拓扑，观察链路流光和节点传输脉冲。
2. 点击拓扑中的任意节点，查看弹窗里的通信、算力和存储状态，也可以直接以该节点发起任务。
3. 在左侧“数据接入”上传遥感图，切到“态势感知”，点击“协同态势感知”，展示目标、传感链路、融合节点和置信度。
4. 切到“任务追踪”，讲解任务如何被拆成分片，并按首尾相接有向图下发、接力和汇聚。
5. 切到“数据采集”，展示终端采集、边缘中转、云端入库全过程。
6. 切到“链路详情”，展示链路时延、丢包率和负载会动态变化。
7. 点击左侧导出按钮，导出节点、链路或任务 CSV，说明仿真状态可交给外部系统留档或对接。

## 文件说明

- `server.js`：仿真数据层、调度算法、HTTP API、SSE 推送。
- `public/index.html`：页面结构。
- `public/styles.css`：视觉布局。
- `public/app.js`：浏览器端实时渲染和交互。
