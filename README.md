# OpenFeedfish

OpenFeedfish 是一个自托管的 DeepSeek 账户充值页面。访客输入人民币金额，选择微信支付或支付宝，生成付款二维码。付款后，页面显示由后端核对的订单状态。收款账户由部署者在管理后台设置。

Cloudflare Pages 托管网页，Worker 处理订单与定时查单，D1 保存账单。访客收款使用部署者在 Windows 或 Linux 上运行的自托管 Chromium。管理员也可以在 Cloudflare Browser Run 上运行账户核验和固定金额测试。项目依赖 DeepSeek 网页的内部接口，上游变更可能影响取码或查单。

## 本地演示

安装 Git 和 Node.js 22.18 或更新版本，从新目录检出并运行。

```sh
git clone --branch public https://github.com/biliyoyo250/OpenFeedfish.git
cd OpenFeedfish
npm ci
npm run dev
```

打开 [充值页](http://127.0.0.1:8787/) 或 [管理后台](http://127.0.0.1:8787/admin)。演示使用本地 D1 和模拟订单，不需要 Cloudflare 或 DeepSeek 凭证。生成二维码后，可以用页面上的模拟操作检查付款状态。演示二维码无法付款。

另开终端可运行 `node scripts/smoke.mjs` 验证演示下单、查单和模拟付款。`npm test` 运行测试，`npm run build` 生成 `dist/`。

## Cloudflare Worker 和 Pages 部署

两种浏览器部署方式共用 Cloudflare Worker、Pages、D1 和 Cloudflare Access。先部署这些组件，再配置其中一种浏览器。

| 浏览器方式 | 运行位置 | 这一版本支持的流程 |
| --- | --- | --- |
| 自托管无头 Chromium | 自己的 Windows、Linux 或 VPS | 访客正式取码和查单、管理员测试、实时登录和手动验证 |
| Cloudflare 托管浏览器（Browser Run） | Cloudflare，从 Worker 的 `BROWSER` 绑定启动 | 管理员诊断、固定账户核验及 1 CNY 测试订单。访客取码应使用自托管执行端 |

### 1. 创建 D1 并设置各项绑定

使用 Node.js 22.18 或更新版本，在仓库根目录安装依赖并登录 Wrangler。`whoami` 用来核对当前登录账号。下面以 `feedfish` 为 D1 名称。

```sh
npm ci
npx wrangler login
npx wrangler whoami
npx wrangler d1 create feedfish
```

编辑根目录 `wrangler.jsonc`。把新数据库的名称和 ID 写入 `d1_databases[0].database_name` 和 `database_id`，保留绑定名 `DB`。如更换数据库名称，同时修改 `package.json` 的 `dev` 脚本和下面的迁移命令。为 Worker 设置 `name`，并把 `pages/wrangler.jsonc` 中 `PAYMENT_API` 的 `service` 改为同一个名称。为 Pages 项目选择可用的名称，同步修改 `pages/wrangler.jsonc` 的 `name` 和 `package.json` 中 `deploy:pages` 的 `--project-name`。两个项目使用同一个 Cloudflare 账户。

保持 `workers_dev=false` 并通过 Pages 服务绑定调用 Worker。`AGENT_RELAY` 绑定与 Durable Object 迁移用于自托管执行端。第一次部署保持 `LOCAL_DEMO=false`、`PAYMENTS_ENABLED=false`、`BROWSER_LOGIN_ENABLED=false` 和 `LEGACY_CLOUD_TESTS_ENABLED=false`。

### 2. 应用迁移并部署 Worker

```sh
npx wrangler d1 migrations apply feedfish --remote
npm run build
npx wrangler deploy --dry-run
npm run deploy:worker
npx wrangler pages project create feedfish --production-branch public
```

`npm run deploy:worker` 从根目录的 `wrangler.jsonc` 执行 `wrangler deploy`，部署订单处理代码和后台静态资源，并注册每分钟一次的查单定时任务。创建 Pages 时使用自己的项目名和生产分支。已有项目可跳过创建命令。

### 3. 配置 Access、Turnstile 和 Secrets

在 Cloudflare Zero Trust 创建 Access 应用，保护 `/admin`、`/admin/*` 和 `/api/admin/*`，策略限制到部署者授权的邮箱。用于后台的域名和路径需对应同一 Access 应用 Audience。保护仍可访问的 Pages 默认域名、预览域名和自定义域名的管理入口。若仅使用自定义域名，可以重定向默认域名，并单独保护预览部署。[Pages Access 配置](https://developers.cloudflare.com/pages/platform/known-issues/#enable-access-on-your-pagesdev-domain) · [重定向默认域名](https://developers.cloudflare.com/pages/how-to/redirect-to-custom-domain/)

在 Turnstile 创建组件，允许实际付款页的主机名。在根目录 `wrangler.jsonc` 的 `vars` 填写 `ACCESS_TEAM_DOMAIN`（`https://<团队名>.cloudflareaccess.com`）、`ACCESS_AUD`（Access 应用 Audience）、`ADMIN_EMAILS`（逗号分隔的邮箱白名单）和 `TURNSTILE_SITE_KEY`。以下命令交互式录入 Secret。`ORDER_TOKEN_SECRET` 使用至少 32 个高熵随机字符，`ACCOUNT_ENCRYPTION_KEY` 使用独立生成的 32 个随机字节并用 Base64 编码。Turnstile 的服务端密钥必须与 site key 配对。

```sh
npx wrangler secret put ORDER_TOKEN_SECRET
npx wrangler secret put ACCOUNT_ENCRYPTION_KEY
npx wrangler secret put TURNSTILE_SECRET_KEY
```

### 4. 发布 Pages 并验证入口

在仓库根目录继续执行。按实际生产分支替换 `public`。

```sh
npm run deploy:worker
npm run deploy:pages -- --branch public
```

访问 Pages 地址检查首页和 `/api/config`。在未登录的会话里确认 `/admin` 和 `/api/admin/session` 要求 Access 认证，再使用获准邮箱登录并打开后台。配置新部署时使用独立的 D1、Access 应用和测试域名。确认浏览器配置、取码和查单后再开放正式收款。

## 自托管无头 Chromium

用 Windows、Linux 或 VPS 托管浏览器。把示例域名替换为自己的 Pages 站点 HTTPS 源地址。执行端主动出站连接，无需开放入站端口。[自托管执行端详细说明](docs/BROWSER_AGENT.md)

PowerShell（Windows）

```powershell
npm ci
npm run browser:install
$env:FEEDFISH_SERVER = 'https://checkout.example.com'
npm run browser-agent
```

Bash（Linux，包含安装 Chromium 所需系统库）

```sh
npm ci
npm run browser:install -- --with-deps
export FEEDFISH_SERVER=https://checkout.example.com
npm run browser-agent
```

1. 登录 `/admin`，输入终端显示的配对码。执行端上线后，打开实时窗口。
2. 在实时窗口登录要收款的 DeepSeek 账户，按官网提示完成人机验证，再点击“启用当前登录账号”。执行端要持续运行并联网。默认浏览器资料位于执行主机的 `.local/browser-agent/`。
3. 使用后台自托管支付测试。测试会向上游创建真实的 1 CNY 待付款订单。需要验证对账时，再付款并查看后台状态。
4. 把 `PUBLIC_PAYMENT_TRANSPORT` 设置为 `agent`，按需配置 `PUBLIC_PAYMENT_METHODS` 为 `wechat,alipay` 或其中一种。确认 Turnstile 和测试流程后，把 `PAYMENTS_ENABLED` 设为 `true`，执行 `npm run deploy:worker`。

设备重新配对时，设好同一个 `FEEDFISH_SERVER` 并执行 `npm run browser-agent -- --pair`。

## Cloudflare 托管浏览器（Browser Run）

Browser Run 模式适用于管理员诊断和固定金额测试，使用 Cloudflare 的浏览器会话配额。保留根目录 `wrangler.jsonc` 的 `"browser": { "binding": "BROWSER" }` 和 `nodejs_compat`。浏览器由 Worker 创建，无需启动本机 `browser-agent` 或安装 Chromium。[Cloudflare Browser Run 部署](https://developers.cloudflare.com/browser-run/playwright/)

### 在独立部署验证绑定和浏览器连通性

1. 保持 `PAYMENTS_ENABLED=false` 和 `BROWSER_LOGIN_ENABLED=false`，将 `LEGACY_CLOUD_TESTS_ENABLED` 设为 `true` 后执行 `npm run deploy:worker`。`BROWSER_LOGIN_ENABLED` 控制旧云端登录流程，诊断不需要启用它。
2. 在测试站点登录 Access，在同一站点打开 `/api/admin/account/authorize/connectivity?mode=resources`。`configured: true` 表示 Worker 找到了 `BROWSER` 绑定。应检查是否同时返回资源计数或 `BROWSER_RESOURCES_UNAVAILABLE`。
3. 打开 `/api/admin/account/authorize/connectivity?mode=browser`。这会启动临时浏览器并检查 DeepSeek 页面的匿名连通性。`reachable: true` 表示探针拿到响应，仍需结合 `httpStatus` 和 `isJson` 判断响应；未登录响应可能是 401。这一步不需要 DeepSeek 账户授权、不创建付款订单，也不能验证真实取码。

### 可选的管理员付款链路测试

云浏览器的账户核验和 1 CNY 取码要求通过 DeepSeek 官方授权获得并保存的 DSH 授权、该授权对应的固定 CNY 账户以及 Worker 的订单签名密钥和账户加密密钥。取码还需要官方授权响应包含对应的 CNY 账号身份，以便 Worker 将该授权绑定到账户。手动导入网页 `userToken` 无法用于此项测试。

在管理员自己的电脑将 `FEEDFISH_SERVER` 设为测试站点 HTTPS 源地址，然后执行 `npm run connect-account`。在终端显示的本机地址点击“连接 DeepSeek”，完成官方授权。回到 `/admin`，在已登录的同一站点打开 `/api/admin/session`，可从 `account.accountId` 核对保存的账户。用 `npx wrangler secret put DEEPSEEK_ACCOUNT_ID` 把同一收款账户 ID 固定在测试 Worker。保持 `LEGACY_CLOUD_TESTS_ENABLED=true`，并继续关闭公开收款。

当前后台页面只提供自托管浏览器的测试按钮。云浏览器测试通过同源且通过 Access 的管理员 API 执行。`POST /api/admin/account/check` 的 JSON 使用 `transport: "browser"`，只核验账户。`POST /api/admin/account/test-payment` 使用 `transport: "browser"`、UUID v4 的 `requestId` 和 `paymentMethod: "wechat"` 或 `"alipay"`，会创建一笔真实的 1 CNY 待付款订单。这两个请求均需要当前管理员会话、同源请求和 `X-Feedfish-Admin: 1`。当测试结果不确定时，先核对官方账单，避免重复创建。测试完成后将 `LEGACY_CLOUD_TESTS_ENABLED` 恢复为 `false` 并再次部署 Worker。

当前访客下单代码不会走 `BROWSER` 绑定。`PUBLIC_PAYMENT_TRANSPORT=worker` 使用 Worker 直连上游，同样不会启动 Browser Run。要开放当前版本的浏览器取码，请按自托管方式将 `PUBLIC_PAYMENT_TRANSPORT` 设为 `agent`。

## 使用

**访客**在充值页输入金额（1–100000 CNY 的整数元），选填昵称和留言，选择支付方式并按提示完成人机验证。扫码付款后，留在原页面等待状态更新。支付应用显示已扣款而页面尚未确认时，请联系收款人核对。

**管理员**在 `/admin` 查看近期账单和浏览器执行端状态。可解绑收款账号以暂停生成新付款码，也可将 `PAYMENTS_ENABLED` 设置为 `false` 并重新部署 Worker。切换账号前先解绑，再用实时窗口登录并启用另一个账户。已有订单仍按创建时的收款账户核对。

## 常见问题

**为什么提示暂时无法生成付款码？** 检查 `PAYMENTS_ENABLED`、Worker 的订单密钥、配置的支付方式及 Turnstile 的两把密钥。确认执行端在线，浏览器中的 DeepSeek 登录有效，并且后台已启用收款账户。遇到 DeepSeek 的验证提示时，通过后台实时窗口处理。

**为什么后台登录后仍返回 403？** 检查 Access 是否覆盖正在访问的域名及管理路径，`ACCESS_TEAM_DOMAIN` 和 `ACCESS_AUD` 是否对应这一个应用，以及登录邮箱是否同时获 Access 策略和 `ADMIN_EMAILS` 允许。

**付款成功后为什么还显示待确认？** Worker 通过轮询和每分钟定时任务查单。若页面显示订单状态不确定（`unknown`），请核对 DeepSeek 官方账单，再决定后续操作。遇到已扣款或结果不确定的订单，请勿重复付款。

**需要 DeepSeek API Key 或支付回调吗？** 自托管执行端通过专用浏览器登录 DeepSeek 账户。订单由本项目主动查单，无需填写 DeepSeek API Key 或配置支付回调。

**设备重启后需要重新配对吗？** 正常重启会复用保存在原主机的配对信息和浏览器资料。配对到期、被撤销或更换设备时，应使用 `--pair`。请勿分享、提交或上传浏览器资料目录。

## 安全报告

发现漏洞时，请通过 [mailme@yoyo250.fun](mailto:mailme@yoyo250.fun) 私下报告。可以用 [PGP 公钥](https://r2.yoyo250.fun/yoyo250.asc) 加密邮件。请提供受影响的版本或提交、复现步骤、影响和必要的脱敏证据。公开讨论前请给维护者留出调查和修复的时间。报告中请勿附上真实 Cookie、Token、订单读取凭证、支付二维码或个人资料。
