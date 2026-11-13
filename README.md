# 港区设备稀疏管理表的关联采集

本项目用于授权资料接入的单次查看与接收留存，使用 Node.js 22。来源协议见 `docs/source-contract.md`。本地演练服务只绑定回环地址，数据不含真实个人资料或账号。

## 安装与运行

依赖由 `package-lock.json` 固定。首次准备环境运行 `npm ci --ignore-scripts`，浏览器项目使用 Playwright 1.56.1 对应的 Chromium；浏览器及系统库在镜像准备阶段安装，不在业务命令中下载。

```sh
npm run build
npm test
npm run demo
npm start
```

`npm run demo` 启动本地来源和接入服务，实际获取单次查看结果并写入临时接收记录，显示完整 JSON，随后关闭服务并清理临时目录。通常在十秒内结束。`npm start` 启动常驻服务，默认端口3000，可通过 PORT 与 DATA_DIR 修改监听端口和接收目录。设置 SOURCE_URL 可连接另一进程中已启动的本地来源；不设置时自动创建演练来源。恢复演练可先用 `npm run source` 在另一终端启动来源，记下输出地址，保持该进程运行，仅重启设置了 SOURCE_URL 的接入服务。

## 接口与模块

`GET /health` 查看状态，`GET /inspect` 单次查看来源响应（保留用途），`GET /receive?key=sample` 保存单次接收，`GET /receipts/sample` 读取回执。相同key和相同内容可重复接收，不同内容拒绝覆盖。

`GET /collect` 采集整张管理表并输出设备清单：每个列根独立按词典序推进，行身份取完整 OID 后缀（复合索引不拆分），不按返回位置拼接。清单中每个单元格带来源（请求序号、网关调用号、启动标识），缺失单元格标注 `missing` 并经全量重读确认；`scan` 段说明扫描一致性（启动标识、尝试次数、列结束方式、复核结果）。网关限制响应大小时按 `limit` 分页；扫描期间增删接口或设备重启时按有边界重读处理，仍不稳定则返回 `incomplete` 与明确原因，不用无限重试换取成功。再次调用 `/collect` 会与上一份清单比对：稳定接口按后缀对齐，计数器差值按位宽处理回绕，设备重启后差值置空，新增与移除接口单独列出。进程在列与列之间停止时进度保存在 `scan-state.json`，下次调用续采；暂停期间设备重启则丢弃旧进度，不混用两次启动的数据。可用 `limit`、`maxAttempts` 查询参数调整分页与重读边界。

`src/connector.mjs` 解释单次来源响应，`src/walk.mjs` 逐列采集并组装整表，`src/diff.mjs` 比对两轮清单，`fixtures/source.mjs` 提供可重复启动的本地来源（含稀疏表、拓扑变化、设备重启、计数器回绕演练端点），`src/service.mjs` 组织访问入口，`src/store.mjs` 保存查看结果、设备清单与续采状态。`test/connector.test.mjs` 验证协议原语和演练源，`test/walk.test.mjs` 与 `test/diff.test.mjs` 验证整表采集与差异解释，`test/service.test.mjs` 验证服务与留存边界。

生产接入地址与凭据需由部署配置给出；演练客户端拒绝访问回环以外的地址。文档中的接口不向外提供任意目标代理。异常以明确错误响应返回，接收失败不覆盖原回执。
