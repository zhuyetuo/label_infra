# 平台到底在调哪些服务

写这份是因为**这件事被搞错过**：代码注释、界面文案、报错信息里到处写着
「线上模型（algo_service）」，而平台根本不调 `algo_service`。报错里写错服务名
的代价很直接——出问题时人跑去查一个根本没参与的服务。

## 平台会调的两个

```
label_infra（这个仓库，算法数据标注平台）
   │
   ├──HTTP──▶  imu_train / label_service      「算法服务」
   │              模型跑在**服务器上**（sklearn）
   │              app/services/algo_client.py 连的就是它
   │              地址：ALGO_SERVICE_URL（默认 8383）
   │
   └──HTTP──▶  algo_tinyml / edge_service     「端侧服务」
                  跑的是**烧进项圈的那份 C**
                  app/services/edge_client.py
                  地址：EDGE_SERVICE_URL（默认 8900）
```

### 为什么端侧那个要单独起一个服务

**因为现在还没有板子。** 模型和后处理上板之后行不行，总得先有个办法验。
`algo_tinyml` 把 `core/*.c` 编成 `.so` 给 Python 调，对外说跟算法服务一样的
接口，于是平台可以拿真实样本跑一遍，看板上那套会报什么。
有板子之后这个服务的角色就只剩回归对照了。

它的 `stable/viterbi` **直接调 `imu_train/label_service/postprocess.py`**，
不是另抄一份——抄的话滞回门槛、合并规则迟早分家，而分家之后「模型对比」
里混进了后处理的差异，那个差异不显示在任何地方。

## 平台**不**调的那个

```
algo_service        **没有任何人调它**——它不对外提供推理接口
   定时跑：TDengine（项圈上报的 IMU 原始数据）→ 推理 → 写 MySQL
           （pet_dog_behavior / pet_dog_daily_summary）

   后端（Java）那边也不调它，是**定期去 MySQL 查有没有新结果**。
   所以整条链上它跟谁都没有 HTTP 调用关系，只通过数据库交接。
```

这是**内测版本**的做法：项圈把原始 IMU 全传到服务端，流量太大也费电，
所以最终方向是端上推理。**这个仓库基本不要动。**

一个推论：在平台这边**永远不会**因为 algo_service 出问题而报错——
它不在任何一条请求路径上。报错里出现它的名字，就是文案写错了。

「日常统计」页面上那句「跟线上项圈那条线（algo_service 的日汇总）不是同一份
数据」说的就是它——那是对的，两边数据源、模型、后处理都不一样，数字别互相
对着看。除此之外，平台的任何功能都跟它无关。

## 命名是历史遗留

| 代码里 | 实际连的 |
|---|---|
| `algo_client.py` / `AlgoServiceError` | imu_train 的 label_service |
| `ALGO_SERVICE_URL` / `algo_service_timeout_sec` | 同上 |
| `edge_client.py` / `EDGE_SERVICE_URL` | algo_tinyml 的 edge_service |

**不改名**：`ALGO_SERVICE_URL` 已经写在各处部署配置里，改名要同步改部署，
而漏改的表现是「AI 服务连不上」，跟改名这件事看不出关系。

但**报错文案和界面文字一律说「算法服务」**，不出现 `algo_service` 这个词——
名字可以历史遗留，报错不能把人指到错的地方。

## 「版本」下拉的三组

| 组 | 模型跑在哪 | 版本串 |
|---|---|---|
| 算法服务（imu_train 的 label_service） | 服务器 sklearn，**默认那一份**模型 | `stable` / `viterbi` / `raw` |
| 服务端模型 | 同一台算法服务上挂的**另一份**模型 | `srv:<标签>[@后处理]` |
| 端侧模型 | 烧进项圈的那份 C | `edge:<标签>[@后处理]` |

前两组差的只有模型（后处理同一份代码）；第三组差的是整条链。
界面上那个问号（`InferModeHelp`）里有一张对照表。
