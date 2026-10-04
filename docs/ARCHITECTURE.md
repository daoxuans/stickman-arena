# 架构与状态边界（当前实现）

本文件帮助接手者快速定位修改点，不是尚未实现功能的技术方案。产品规则与验收以 [PRD](../outputs/PRD-火柴人竞技场-20261004.md) 为准，运行方式见 [README](../README.md)。

## 两条运行链

| 模式 | 入口与状态 | 计算与展示 | 持久性 |
|---|---|---|---|
| 单人闯关 | `public/app.js` 收集键盘/触控输入；`public/campaign.js` 负责本关、波次、光波和回档 | `shared/levels.js` 给出 56 关配置，`shared/combat.js` 固定步长处理双方战斗；`public/render.js` 绘制场景与角色 | 只将 `currentLevel`、`checkpointLevel`、`deaths`、`completed`、`cleared` 写入当前浏览器；战斗现场不持久化。 |
| 联机 1v1 | `public/app.js` 管理房间 UI、WebSocket 与本端按键 | `server/index.js` 管房间/身份/倒计时并调用同一 `shared/combat.js` 判定；约 20Hz 发快照；客户端只做有限位置平滑 | 房间和对局只在服务进程内存中；不写闯关记录。 |

`public/index.html` 与 `public/styles.css` 定义单页双模式界面；Canvas 逻辑场地为 960×540。联机客户端可能显示位置预测，但生命、命中与胜负以服务端状态为准。`shared/combat.js` 每步按固定 1/60 秒模拟，保持可重放；不要把浏览器时间、DOM 或未播种随机值引入战斗判定。

## 模块职责与变更入口

| 路径 | 职责 | 改动时先看 |
|---|---|---|
| `shared/levels.js` | 四主题、56 关名字/平台/敌人波次、16 存档关、九个 Boss 关与偶数坠物配置 | `test/levels.test.js`、`test/integration.test.js`、PRD §3.3/附录 D |
| `shared/combat.js` | 拳脚、跳/闪、重力/平台/命中/AI、地面与坠物伤害、PvP 胜负 | `test/combat.test.js`；保证闯关/PvP 分支不串功能 |
| `public/campaign.js` | 闯关波次、光波、通关/失败、进度读写 | `test/campaign.test.js`；回档和刷新语义 |
| `public/app.js` | 页面状态、输入聚合、HUD/路线、音效、联机消息与模式切换 | `test/bootstrap.test.js`、`test/sound.test.js`、`test/server.test.js` |
| `public/render.js` | 照片选图与渐入、四主题绘制、角色动作与反馈 | `test/render.test.js`、`test/backgrounds.test.js`、设计基线 |
| `public/index.html`、`public/styles.css` | 页面结构、可见字段、适配与样式 | 桌面/窄屏/触控/减少动态效果走查 |
| `server/index.js` | 静态资源边界、房间与会话、输入校验、倒计时、服务判定与快照 | `test/server.test.js`；非法输入/离开/断线/重赛 |

## 状态所有权

| 数据 | 所有者与存放位置 | 生命周期/边界 |
|---|---|---|
| 关卡配置 | `shared/levels.js` 静态配置 | 浏览器闯关和自动化测试共用；服务端联机不用单人关卡波次。 |
| 单人进度 | `public/campaign.js`，浏览器本地键 `stickman-arena.campaign.v1` | 入存档关、失败、过关、通关重开时变更；存储拒绝时仅内存回退，刷新可能丢失。 |
| 当前闯关现场 | `CampaignSession` 内存 | 模式切换期间暂停；刷新只从进度所指关卡满血起点重建。 |
| 联机房间 | `server/index.js` 内存中的房间和连接会话 | 至多两人、六位房码；房主离房即删房，加入者离房则房主回等待；服务重启后消失。 |
| 联机输入与结果 | 客户端发送六类按键和递增序号，服务端维护房内战斗状态 | 倒计时/结束时输入不参与战斗；结果由服务端 KO/超时结算，重赛须双人确认。 |
| 照片资源 | `public/assets/backgrounds/` 的 18 张 1600×900 WebP | 只在选中的单人关卡按需载入；联机用绘制背景。`pic/` 原图被 Git 忽略且不能从网站访问。 |

HTTP 仅服务公开 `public/` 与浏览器所需的 `shared/` 资源，不开放服务端源码或本机 `pic/`。默认监听 `127.0.0.1:3000`；局域网访问需显式设置监听地址，公网还缺认证和 TLS/反向代理等保护。

## 现有边界与已知问题

- 房间服务对等待房约 15 分钟无活动会删除；进行中/已结束房间没有同类闲置清理。等待房过期时浏览器房主可能仍显示旧房码，见 PRD G-01。
- P2 真实对战主题来自房主，但已禁用的主题下拉可能显示本地旧选项，见 PRD G-02。
- 当前没有账号、云存档、断线续局或房间持久化；自动化测试主要是本机进程/模拟画布，不能证明公网时延、真实手机帧率或全部辅助技术可用。
- 12 张外部风景照片有来源清单；用户上传照片的使用/肖像授权仍需确认。不要把“去 EXIF”当作授权证明。

若要改变数据所有权（例如云存档、跨设备对战、公网房间），先在 PRD/决策记录中确认行为与失败语义，再设计新契约；不要仅改一端代码。
