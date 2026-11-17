# 自托管浏览器服务

Cloudflare 负责网页、Access、配对与 WebSocket 中继；Windows / Linux 主机负责独立的 Chromium。服务主动出站，无需公网入站端口、Tunnel 或暴露 CDP。`/admin` 接收 JPEG 画面，转发鼠标、拖动、滚轮和键盘输入；官方登录、验证码由管理员直接操作。没有自动解验证码、伪装指纹、轮换网络或外部验证码服务。

这条路线不消耗 Cloudflare Browser Run 分钟数；Worker / Durable Objects 的请求、资源与流量配额仍适用。普通无头浏览器及当前网络是否被 DeepSeek 接受需要实测，不能保证免验证码。主机必须保持运行和联网。

## Windows

在项目目录使用 Node.js 22.18+。运行前，将示例中的 `https://feed.example.com` 替换为本站的 HTTPS origin。

```powershell
npm ci
npm run browser:install
$env:FEEDFISH_SERVER = "https://feed.example.com"
npm run browser-agent
```

服务显示五分钟配对码和管理后台地址。在浏览器打开地址，确认配对码后点“配对”；随后刷新设备状态、点“打开实时窗口”。无需 F12、Cookie、Token 或本地入站监听。

配对后页面会在可见时自动等待浏览器上线，最长两分钟，上线后启用“打开实时窗口”。画面显示在后台页面内，默认不会弹出桌面窗口。更新本机脚本后重启服务即可保留原 profile；普通重启用 `npm run browser-agent`，只有解除 / 更换配对才用 `--pair`。

## Linux / VPS

选择 Playwright 支持的 Linux 发行版与架构，以下安装示例面向 Debian / Ubuntu。使用普通专用用户运行浏览器，安装系统依赖时可按系统权限要求使用 sudo。将示例中的 `https://feed.example.com` 替换为本站的 HTTPS origin。

```bash
npm ci
npm run browser:install -- --with-deps
export FEEDFISH_SERVER=https://feed.example.com
npm run browser-agent
```

`browser:install` 将 Chromium 放入本项目 `.local/playwright`；Windows 安装不需要 `--with-deps`。Linux 需要安装图形、字体、声音等系统库，但默认无头模式不需要桌面或 DISPLAY。跨系统迁移时重新 `npm ci` 和安装浏览器，不复制 `node_modules`、浏览器二进制或登录 profile。

可用 systemd 保持服务运行；将示例中的用户、路径与 `FEEDFISH_SERVER` 替换为实际值。服务使用专用用户运行。

```ini
[Unit]
Description=feedfish browser agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=feedfish
WorkingDirectory=/opt/feedfish
Environment=FEEDFISH_SERVER=https://feed.example.com
ExecStart=/usr/bin/node /opt/feedfish/scripts/browser-agent.mjs
Restart=on-failure
RestartSec=20
RestartPreventExitStatus=78
UMask=0077

[Install]
WantedBy=multi-user.target
```

先在同一专用用户下交互完成配对，再启用服务。配对到期、被撤销或安装配置失败时退出码为 78，上述配置会停止自动重启，等待人工处理；不要移除此项反复申请新配对。

## 配置与资料

| 项目 | 默认值 / 行为 |
| --- | --- |
| `FEEDFISH_SERVER` | 必填。填入部署站点的 HTTPS origin。HTTP 仅用于回环开发地址。 |
| `FEEDFISH_AGENT_NAME` | 机器名；后台显示的设备名 |
| `FEEDFISH_AGENT_DIR` | 项目内 `.local/browser-agent`，保存设备连接密钥与独立浏览器 profile |
| `FEEDFISH_BROWSER_CHANNEL` | `chromium`，普通新版无头 Chromium；可显式使用已安装的 `chrome` / `msedge` |
| `FEEDFISH_BROWSER_EXECUTABLE` | 可选自选 Chromium 路径；兼容性由部署者核对 |
| `PLAYWRIGHT_BROWSERS_PATH` | 项目内 `.local/playwright`；安装与运行必须一致 |
| `npm run browser-agent -- --pair` | 重新配对，不删除浏览器 profile |
| `npm run browser-agent -- --headed` | 在有桌面的主机显示独立浏览器窗口；默认不打开可见窗口 |

登录 profile **在运行浏览器的机器上**，不再导出到 Cloudflare。不要共享、提交或上传该目录。Linux 目录权限设为 0700、设备文件 0600；Windows 目录取消继承，仅授予当前用户和 SYSTEM 访问。它不是可跨机使用的凭证备份格式，浏览器自身的系统密钥机制仍适用。

设备连接权限有效 30 天，配对码仅五分钟、单次使用；后台可立即撤销。单次实时控制窗口最多十分钟，到期需重新通过当前 Access 会话打开；独立浏览器与登录资料不会因此关闭。一次只允许一台已配对服务、一个管理员控制窗口。更换服务需要明确确认，旧连接立即失效。

关闭画面使用实时窗口内的“关闭实时窗口”，它保留设备配对与登录。要停用设备，展开“设备管理”并使用“解除设备配对”；此操作会让服务退出。此后重新运行普通启动命令仍会使用已失效的旧设备密钥，应运行 `npm run browser-agent -- --pair`，用新配对码重新批准。无需重装 Chromium 或删除 profile。

终端会区分 `DEVICE_NOT_PAIRED` / `DEVICE_REVOKED` 等已确认的设备授权问题，以及 `EDGE_FORBIDDEN`（入口 HTTP 403，原因未定）。未知入口拦截不会直接被标为设备已撤销；窗口到期或连接附加信息丢失也有独立关闭码。

网络断线采用有上限的退避重连；未完成的操作不重放，排队过久的输入会丢弃。输入、画面、Cookie、Token 不写中继存储或审计。中继持久化设备名、期限、连接密钥哈希、配对元数据和管理员启用的收款账号 ID。页面离开或关闭控制窗口即停止传输画面。浏览器只允许顶层访问固定 Platform 域名，关闭弹窗和下载，不开放任意 URL、JavaScript、文件、剪贴板读取或 shell。

## 当前范围

当前提供实时交互、账号核验、管理员的 1 CNY 微信 / 支付宝测试，以及公开微信 / 支付宝订单。协议 v3 支持在后台选择收款账号和 1–100000 CNY 整数元。每次取码前在同一浏览器内核对已启用的账号、读取正常官网设备与验证 SDK，再请求官方接口。Token 仅在专用浏览器的请求内使用。

升级后在原终端按 Ctrl+C，正常运行 `npm run browser-agent` 并刷新后台。已有配对和有效登录可继续使用。打开实时窗口登录需要收款的 DeepSeek 账号，再点“启用当前登录账号”。管理员可以随时解绑，解绑后暂停新单。切换账号前先解绑，再在官网切换并启用。

展开“验证自托管支付通道”，点击微信或支付宝测试按钮。金额固定为 1 CNY，只创建未付款账单；二维码来自该次官方响应。请求在本站先记录，再派发一次；执行端不重放任务，忙碌 / 离线时明确拒绝，已派发后超时或结果不确定则保留 `unknown`，不能自动重新创建。结果只包含经过投影的支付字段，不回传完整响应、凭证或历史账单。人工验证码仍需在实时画面内处理。

自托管测试面板默认展开，旧 Cloudflare 测试入口保持关闭。既有账单保留原通道和账号归属。

新账单标记为 `provider_transport=agent`，并记录创建时的 `provider_account_id`。后台测试另有 `is_admin_test=1`，不会被后来的公开订单替换测试结果。前台轮询读取本站账本，并按单笔间隔触发后台查单。每分钟 Cron 优先核对付款码仍有效的订单，将自托管查询串行派发。查询时执行端须登录该账单所属账号。账单在取得上游确认的实际付款时间后才记录该时间。

启用公开收款时，设置 `PAYMENTS_ENABLED=true`、`PUBLIC_PAYMENT_TRANSPORT=agent` 和 `PUBLIC_PAYMENT_METHODS=wechat,alipay`。新单要求 Turnstile、整数金额、方法白名单、在线执行端、已启用的账号及本站幂等预留。确认未发出支付的情况允许在同一收款账号下重试同一订单；已经派发后的不确定结果不重新创建。前台错误不暴露登录 Token、设备名或管理操作细节。

执行任务最多等待 65 秒；本机任务有更短期限，创建前还必须保留请求超时余量。任务在途时中继暂停转发其他浏览器操作，画面与心跳继续工作。断线与超时不自动重发，避免重复生成订单。

实现依据：[Playwright 浏览器安装](https://playwright.dev/docs/browsers)、[CDP 会话](https://playwright.dev/docs/api/class-cdpsession)、[Cloudflare WebSocket Hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)。
