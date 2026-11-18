# 邻友购 · 洗护狂欢季 买三退一小程序（CloudBase 版）

基于 PRD《微信小程序-邀请达标门店退款》的可预览 MVP。当前演示主题为**洗发水促销活动 · 买三退一**（邀请 3 位好友下单，本人订单全额返还）。后端全部运行在 CloudBase：云函数负责全部业务逻辑，文档型数据库负责数据持久化；支付与退款当前为 mock，便于无认证预览。

## 当前演示数据（mock）

- **品牌**：邻友购
- **活动**：邻友购 · 洗护狂欢季 买三退一，商品「氨基酸植萃洗发水 500ml / 单瓶装」，售价 ¥129（划线价 ¥198）
- **海报**：可在「运营 → 活动配置 → 活动海报」里随时换图（上传到云端）；默认图 `miniprogram/images/poster.jpg`（94K）
- **门店**：邻友购·上海南京西路店 / 徐家汇店 / 北京国贸店（地址、电话、库存均为 mock）
- **佣金规则**：买三退一（inviteTarget=3，达标返还本人订单一单金额）
- **海报上传规范**（配置页已标注）：竖版约 2:3、推荐 720×1080 / 1024×1536、宽度 ≥720px、JPG/PNG、2MB 内（超出自动压缩）。海报采用**分片上传**绕开 HTTP 网关约 96KB 的请求体上限。

> 提示：若换成「买六送一 / 买二退一」等海报，记得在配置页同步修改商品名、邀请达标人数 N、售价，页面动态文案「买 N 退一」会跟随配置变化。

## 目录结构

```
project.config.json          AppID: wxc924d24af61816e9
cloudbaserc.json             环境: linyougo-dev-d0gkgswl0504c86e2 (ap-shanghai)
cloudfunctions/api/          核心业务云函数（全部业务逻辑 + 微信登录 + 两档角色鉴权）
miniprogram/
  app.js                     CloudBase 环境、HTTP 地址、登录态与角色配置
  app.json                   tabBar custom:true（按角色渲染）
  custom-tab-bar/            自定义 tabBar：user 显示 3 项，admin 显示 5 项
  utils/api.js               wx.login 登录态 + wx.request(HTTP) 优先 + wx.cloud 兜底 + 角色缓存
  utils/tab.js               tabBar 同步 + 管理类页面权限守卫
  pages/
    index/                   活动首页（活动规则、门店、入口，普通用户可见）
    activity/                确认订单（选店、填邀请码、下单+模拟支付）
    orders/                  我的订单（不展示身份信息，仅在无管理员时显示自举入口）
    order-detail/            订单详情、5分钟核销码、佣金进度
    invite/                  邀请码/链接、有效人数进度、佣金状态
    landing/                 受邀落地页（带参 code 进入）
    staff/                   店员工作台（管理员专属，核销、受理取消）
    admin/                   管理员专属：运营看板 + 财务流水 + 身份卡片 + 成员管理
    mine/                    我的：头像 / 昵称 / openid / 角色 / 订单统计（所有角色可见）
    config/                  管理员专属：活动配置页（活动/商品/门店/海报）
```

## ✅ 预览方案：HTTP 直连 CloudBase（无需微信认证/云开发）

小程序 AppID `wxc924d24af61816e9` **未做微信认证**，微信侧开通云开发会报 `-601055`（个人/非个人主体未认证均不能开通云服务）。因此本项目的业务调用**不走 `wx.cloud.callFunction`**，改为通过 **CloudBase HTTP 访问服务**，用 `wx.request` 直接调用云端 `api` 云函数。后端数据依然 100% 来自 CloudBase 云数据库，与本地无关。

云端已就绪：`linyougo-dev-...` 文档型数据库已开通、`api` 云函数已部署、HTTP 路由已建、演示数据已就绪、端到端 18/18 通过。

HTTP 访问服务地址（已写入 `app.js → globalData.apiBase`）：
```
https://linyougo-dev-d0gkgswl0504c86e2-1534792212.ap-shanghai.app.tcloudbase.com/api
```

**在微信开发者工具里操作（一次性，二选一）：**

- **快速预览（推荐）**：点右上角「详情」→「本地设置」→ 勾选「**不校验合法域名、web-view、TLS 版本以及 HTTPS 证书**」。之后直接编译即可，无需任何云端配置。
- **体验版/真机预览**：需在微信公众平台 →「开发管理」→「开发设置」→「服务器域名」→ `request 合法域名` 中添加：
  ```
  https://linyougo-dev-d0gkgswl0504c86e2-1534792212.ap-shanghai.app.tcloudbase.com
  ```
  （填域名，不带 `/api` 路径）

编译后首页加载活动海报与云端数据。普通初始化不再创建演示门店，请在「运营配置 → 门店」中新增门店。选择「搜索地点或地址」，确认地图上的地点，再按需要填写楼层、门牌号或取货点。云端会保存显示地址和 GCJ-02 经纬度。

真机使用地图选点前，需要在微信公众平台开通 `wx.chooseLocation` 并在用户隐私保护指引中声明位置用途。

`e2eTest` 和 `edgeTest` 仅在隔离测试环境运行，它们会清空该环境的订单等业务集合。

> 关于身份：已接入**真实微信登录**，详见下一章。未配置 AppSecret 或登录失败时自动回退固定预览身份 `preview`，预览功能不会中断。

## 微信登录与身份（2026-11-18 接入）

小程序现在按**真实微信号**区分用户，不再所有人共用一个账号。HTTP 访问服务不带微信上下文，因此走标准 `code2session` 换取 openid + 自定义登录态：

```
小程序 wx.login() → code
  → POST /api { action:'login', code }
  → 云函数用 AppID + AppSecret 调 api.weixin.qq.com/sns/jscode2session
  → 拿到 openid，签发 token 存入 sessions 集合（7 天有效）
  → 之后每个请求带 token，云函数解析出 openid 作为 buyer
```

前端 `utils/api.js` 自动完成登录、缓存 token、`NO_LOGIN` 失效重登；**登录不可用时静默回退 `_testOpenid=preview`**（5 分钟内不重复重试），所以未配置密钥或微信侧异常时预览功能照常可用。

### AppSecret 从哪看

1. 打开 **微信公众平台** `mp.weixin.qq.com`，用小程序管理员账号登录
2. 左侧菜单 **「管理」→「开发管理」→「开发设置」**
3. 在 **「开发者 ID」** 模块找到 **「小程序密钥（AppSecret）」**，点击「生成 / 重置」，**管理员微信扫码**后显示
4. ⚠️ 平台**不保存明文**：AppSecret 只在生成时完整显示一次，忘记只能重置；重置后旧密钥立即失效，需同步更新所有使用它的系统

> 微信登录（`wx.login` / `code2session`）**不需要微信认证**，与「微信云开发需认证」「微信支付需企业认证」是三件独立的事。本项目 AppID 未认证也能正常登录。

### 密钥存放

AppSecret **绝不进前端代码、也不写进云函数源码**，只作为云函数环境变量：

| 变量 | 说明 |
|---|---|
| `WX_APPID` | 小程序 ID（公开信息，可放配置文件） |
| `WX_APPSECRET` | 小程序密钥（**仅云端**，`cloudbaserc.json` 不保存明文） |
| `ADMIN_OPENIDS` | 可选，运营白名单，逗号分隔的 openid（形如 `wx_xxxx`） |
| `ALLOW_TEST_IDENTITY` | 可选，设 `false` 关闭 `_testOpenid` 测试通道（上线建议关闭） |

配置方式（二选一）：

- **控制台（推荐）**：CloudBase 控制台 → 云函数 `api` → 函数配置 → 环境变量，添加 `WX_APPSECRET`
- **CLI**：临时在 `cloudbaserc.json` 的 `functions[].envVariables` 填入 → 执行 `tcb config update fn api`（提示时选 **Merge**）→ 推送成功后把明文删掉

> CLI 3.9.3 有个显示层 bug：`tcb config diff fn api` 会把本地 `WX_*` 显示成 `wX_*`，但云端实际键名是正确的 `WX_APPID` / `WX_APPSECRET`（用 `tcb fn env pull api --output-file .env.local` 可核实）。云函数已同时兼容两种大小写写法。

当前云端已配置 `WX_APPSECRET`，`whoAmI` 返回 `appSecretConfigured: true`；用无效 code 调用 `login` 返回微信 `40029 invalid code`，证明密钥有效且云函数能出公网访问微信接口。

### 昵称与头像（2026-11-18 新增「我的」页）

微信**不再提供**用户昵称与头像：`wx.getUserProfile` 自 2022 年起对未认证/新版本返回匿名数据（"微信用户" + 灰色头像），`getUserInfo` 更是早已收回。因此昵称头像只能由用户**主动填写**：

| 字段 | 交互 | 说明 |
|---|---|---|
| 头像 | `<button open-type="chooseAvatar">` | 从微信头像或相册选取 |
| 昵称 | `<input type="nickname">` | 键盘上方可一键填入微信昵称 |

- 头像在前端用离屏 canvas **居中裁成正方形并逐级压缩**（240/200/160 + 质量 0.7/0.55/0.4），直到 base64 ≤ 45KB。上限来自 HTTP 网关约 96KB 的请求体限制，超限服务端直接返回 `AVATAR_TOO_LARGE`。
- 存储：`profiles` 集合，一 openid 一条 —— `{ _id: 'profile_<openid>', openid, nickname, avatar(base64 dataURL), updatedAt }`。集合由云函数首次写入时懒创建。
- 接口：`getProfile` / `saveProfile`（**需登录**，非 admin 接口），字段级更新 —— 只传 nickname 不会清空头像，反之亦然；昵称超过 20 字按 20 字截断，头像格式非法返回 `BAD_AVATAR`。
- 数据隔离：`openid` 取自登录态而非请求参数，任何人只能读写自己的资料。


### 身份优先级与鉴权

`resolveIdentity()` 按以下顺序解析「你是谁」，每次请求重设，进程内不串号：

1. `_testOpenid`（测试通道，供 e2e/edge 与预览兜底；可用 `ALLOW_TEST_IDENTITY=false` 关闭）
2. `token` → 查 `sessions` 集合 → 真实 openid（`wx_` 前缀）
3. `cloud.getWXContext().OPENID`（将来认证后改走 `wx.cloud.callFunction` 时自动生效）

`resolveRole()` 再判定「你能做什么」，两档角色见下一节。**微信只提供 openid（身份标识），不提供角色**；角色由本项目自己的管理员白名单决定，与「微信认证（主体资质认证）」无关。

## 权限隔离：两档角色（user / admin，2026-11-18 新增）

> **「微信认证」≠「微信登录身份」**。微信认证是企业/个体户的主体资质认证（决定能否用微信支付等），不提供任何用户角色信息；微信登录（`wx.login` → `code2session`）拿到的 `openid` 才是标识「这个用户是谁」的东西，**且不需要微信认证**。所以这两档隔离用的是微信登录身份，不是微信认证。

| 角色 | 可见范围 |
|---|---|
| **普通用户 user** | 活动（首页 / 活动页 / 邀请落地页）、我的订单（下单 / 支付 / 订单详情 / 核销码）。tabBar 只有「活动」「我的订单」 |
| **管理员 admin** | 全部：上述 + 店员工作台（全门店核销 / 取消）、运营看板、资金流水、活动配置、成员管理。tabBar 四个入口全显示 |

**安全边界在云函数，不在前端**。前端自定义 tabBar 与无权限遮罩只是体验层（隐藏入口），真正拦截由 `ADMIN_ACTIONS` + `requireAdmin()` 完成：

- **公开**（无需登录）：`login` / `getActivity` / `getPosterRaw` / `getInvitation` / `whoAmI`
- **需登录**：活动与订单类接口（`createOrder` / `mockPay` / `getMyOrders` / `getOrderDetail` / `genVerifyCode`）+ 个人资料（`getProfile` / `saveProfile`）
- **仅管理员**：`admin*`、店员 `staffOrders/staffVerify/staffCancel`、`mockRefund`、`seed`、`dashboard`、`ledger`、`e2eTest`、`edgeTest`

普通用户调用管理员接口返回 `FORBIDDEN`；无身份返回 `NO_LOGIN`（前端自动清 token 重登一次）；越权查他人订单返回 `FORBIDDEN`（`buyer` 归属校验）。管理员在 `isStaff()` 里兜底获得全部门店权限；若该身份已绑定明确的 `staff` 记录，则优先按记录的 `storeIds` 限定（保证自检里的「错门店核销」断言有效）。

### 管理员从哪来（三种方式）

1. **首位自举（推荐，最省事）**：真机用真实微信登录后，进「我的订单」页，页面顶部会出现 **「设为首位管理员」** 按钮（仅当系统还没有任何管理员、且当前是真实微信身份时出现，其余情况不显示任何身份信息）。点一下即把当前 openid 写入 `admins` 集合成为首位管理员，之后只有管理员能添加其他成员。
2. **小程序内添加**：管理员 → 「运营」tab → **「成员管理」** → 粘贴对方 openid → 添加。对方 openid 可在云开发控制台「数据库 → `sessions`」按最近登录时间查到；同一 tab 可移除成员。
3. **环境变量白名单**：云函数 `api` 配置 `ADMIN_OPENIDS`（逗号分隔多个 openid）。此来源优先级最高且不可在小程序内移除，适合固化主管理员账号。

`admins` 集合结构：`{ _id: 'adm_<openid>', openid, enabled, grantedBy, createdAt }`；`adminRevoke` 把 `enabled` 置为 false（软删除）。

### 预览期与生产期的开关

| 环境变量 | 默认 | 作用 |
|---|---|---|
| `ALLOW_TEST_IDENTITY` | `true` | 测试通道总开关。设 `false` 后 `_testOpenid` 完全失效，只能走真实微信登录 |
| `PREVIEW_ADMIN` | `true` | 预览期把固定演示身份视为管理员，保证未配域名时演示功能不残 |
| `PREVIEW_ADMIN_IDS` | `preview,staff` | 允许提权的固定演示身份白名单。**任意其他 `_testOpenid` 一律降为普通用户**，堵住「随便编个身份就是管理员」的提权口子 |
| `ADMIN_OPENIDS` | 空 | 环境变量管理员白名单 |

**预览期**（默认）：登录失败回退 `preview` 身份 → 仍是 admin → 四个 tab 全可用，不影响演示。
**生产期**：设 `ALLOW_TEST_IDENTITY=false` + `PREVIEW_ADMIN=false` + 配好 `ADMIN_OPENIDS`（或用首位自举写入 `admins`）→ 只有真实微信身份且在白名单中的账号才是 admin，其余全部是 user。

### 怎么验证登录生效

微信开发者工具编译 → 「运营」tab 顶部 **「当前登录身份」** 卡片：

- 显示 **「真实微信登录」+ `wx_` 开头的 openid** = 接入成功，不同微信号 / 不同手机现在是不同账号，可真机跑通「A 下单 → B 用邀请码 → 达标返佣」
- 显示 **「预览身份（未登录）」** = 回退到了 preview，检查 AppSecret 是否配置、网络是否正常
- 卡片现在还会显示 **角色**（管理员 / 普通用户），可一键复制 openid，点「重新登录·诊断」强制刷新
- 管理员专属：卡片下方「成员管理」tab 可增删管理员

> 现状：真实登录后该 openid 不在 `staff` 表里，但**管理员角色会兜底赋予全门店权限**，所以管理员可直接进店员工作台核销；普通用户则被 `ADMIN_ACTIONS` 拦在门外。

### FAQ：真机调试为什么没有弹出「微信登录」？

**因为微信登录本来就不弹窗。** `wx.login()` 是静默接口：小程序一启动，微信客户端就把当前微信号的临时 `code` 交给前端，前端拿去换 `openid`，全程无界面、无需用户点「授权」。这是微信小程序的标准登录方式，与 App/网页里「输入账号密码 / 点微信登录按钮」完全不同。

会弹窗的是另外两类能力，本项目都没用到：
- 获取头像昵称（`getUserProfile` / 头像昵称填写能力）：业务只需要 openid，不需要
- 手机号授权（`getPhoneNumber`）：需要微信认证 + 按次计费，且并非登录必需

所以「没让我登录」≠ 没登录。判断是否生效看运营 tab 的「当前登录身份」卡片：显示「**真实微信登录**」+ `wx_` 开头的 openid 即为已登录。

**真机调试下如果显示「预览身份（未登录）」**，说明登录请求失败、已自动回退。最常见原因是 **`request 合法域名` 没配**：本地模拟器勾「不校验合法域名」能通，真机（真机调试 / 预览 / 体验版）会严格校验，导致所有 `wx.request`（包括登录请求）都被拦。卡片会显示具体诊断原因，也可点「**重新登录·诊断**」弹窗查看结果。

根治办法（**不需要微信认证，个人主体也能配**）：微信公众平台 →「开发管理」→「开发设置」→「服务器域名」→ `request 合法域名` 添加：

```
linyougo-dev-d0gkgswl0504c86e2-1534792212.ap-shanghai.app.tcloudbase.com
```

只填域名，不带 `https://` 和 `/api`；保存后重新编译、重新扫码（域名配置有生效缓存，隔 1–2 分钟再试）。配好后真机调试、扫码预览、体验版的登录与全部数据请求都会正常。

### 上线前安全清单

- [ ] 设 `ALLOW_TEST_IDENTITY=false` 关闭测试通道（否则任何人可伪造 `_testOpenid` 冒充用户）
- [ ] 设 `PREVIEW_ADMIN=false`，并确认 `PREVIEW_ADMIN_IDS` 不含可被猜到的值
- [ ] 确定管理员来源：跑一次首位自举写入 `admins`，或配置 `ADMIN_OPENIDS` 环境变量白名单
- [ ] 配置 request 合法域名（当前靠「不校验合法域名」预览）
- [ ] 微信认证 + 商户号，把 `mockPay` / `mockRefund` 换成微信支付 v3
- [ ] AppSecret 定期轮换（重置后同步云端环境变量）
- [ ] 复核自定义 tabBar 仅按 `whoAmI().role` 渲染；注意**前端隐藏入口不构成安全边界**，所有敏感接口必须保留在 `ADMIN_ACTIONS` 里

## 运营配置入口（活动 / 商品 / 门店 / 海报）

配置不再是硬编码在 `seed()` 里——运营可在小程序内改，数据写入云端，首页实时读取。入口：**「运营」tab → 顶部「活动配置」**。

- **活动 / 商品**：品牌、活动名、副标题、商品名、规格、售价、划线价、邀请门槛 N、三个截止时间（日期 + 时间选择器）
- **活动门店**：新增 / 编辑 / 删除（有订单关联的门店会拒绝删除，避免历史订单丢失）
- **活动海报**：从相册/拍照选图 → 自动压缩并分片上传到云端 → 首页立即换图；可一键恢复默认海报

**海报技术实现**（当前环境是 PostgreSQL 版 CloudBase，云存储无永久公开 URL）：上传的图片以 base64 存进云数据库活动文档的 `posterData` 字段，云函数 `getPosterRaw` 通过 HTTP 访问服务以 `GET /api?action=getPosterRaw` 输出 `image/jpeg` 二进制，`<image>` 组件直接加载该永久地址（带时间戳参数避开缓存）。已验证返回图片与原文件 MD5 一致。

**接口**（均在 `api` 云函数）：`adminGetConfig`、`adminSaveActivity`、`adminSavePoster`、`adminPosterInit/Chunk/Merge`、`adminResetPoster`、`adminSaveStore`、`adminDeleteStore`、`getPosterRaw`。金额由前端元转分，云函数做白名单字段校验 + 审计日志。

> 鉴权：`admin*` / `seed` / `e2eTest` / `edgeTest` / `dashboard` / `ledger` 统一走 `requireAdmin()`。预览期 `ADMIN_OPENIDS` 留空即放行；配置白名单后仅白名单微信账号可操作，测试通道（`_testOpenid`）始终放行以便联调。

## 联调验证结果（2026-11-18）

| 自检 | 命令 | 结果 |
|---|---|---|
| 端到端主链路 | `action:'e2eTest'` | ✅ 18/18 步通过 |
| 幂等与边界 | `action:'edgeTest'` | ✅ 6/6 项通过 |
| 配置读写 | 活动/门店写入并读回一致 | ✅ 通过 |
| 海报上传/获取 | 分片 init→chunk→merge，`getPosterRaw` 返回 image/jpeg，MD5 与原图一致 | ✅ 通过 |
| 微信登录链路 | `login` 返回微信 `40029 invalid code` | ✅ 密钥正确、接口可达 |
| 身份鉴权 | 无效 token → `NO_LOGIN`；公开接口不受影响 | ✅ 通过 |
| 两档角色权限矩阵 | 18 项只读断言：user 仅活动/订单，admin 全部放行，越权 `FORBIDDEN` | ✅ 全部符合预期 |
| 管理员管理链路 | 授予 → 生效（role=admin）→ 列表 → 移除 → 恢复自举状态 | ✅ 通过、无残留 |
| 角色改造回归 | `e2eTest` 18/18、`edgeTest` 6/6，`WRONG_STORE` 断言正常 | ✅ 通过 |

覆盖：下单→归因→3人达标锁定→佣金生成→退款到账→核销→门店取消→看板流水；支付回调重复、退款回调重复、重复受邀去重、错门店核销、无效邀请码均按预期拒绝。`_testOpenid`/`e2eTest`/`edgeTest` 仅供自动化联调，小程序正常调用不受影响。

## 本地预览步骤

1. 用微信开发者工具「导入项目」选择本目录，AppID 已填好（无需开通云开发）
2. 「详情」→「本地设置」→ 勾选「不校验合法域名」（体验版/真机则按上文配置 request 合法域名）
3. 编译预览——首页自动加载海报与云端数据（云端数据已就绪，无需本地初始化）
4. 改了云函数代码后重新部署（**只更新代码，不碰 HTTP 网关配置**）：
   ```
   tcb fn code update api --dir cloudfunctions/api
   ```
   > `tcb fn deploy` 会因重建 HTTP 访问服务报 `[CreateCloudBaseGWAPI] path invalid`，请勿使用。改环境变量用 `tcb config update fn api`（提示选 Merge）。

## 演示主链路

0. 首页顶部为活动海报（点击放大），下方是商品卡、活动规则与参与门店
1. 首页「立即参与」→ 选门店下单 → 自动模拟支付 → 进入邀请页拿到邀请码
2. 把邀请码发给另一个微信号（真实登录后即为不同账号），从落地页 `?code=邀请码` 进入下单支付 → 计为 1 个有效邀请
3. 集齐 N 人 → 邀请状态变「已达标」，自动生成佣金发放单
4. 邀请页「模拟退款成功」→ 佣金「已到账」，资金流水记一笔
5. 店员工作台（预览身份已绑定为演示店员）→ 核销 / 受理未核销取消
6. 「运营」tab 看达标率、核销率；财务 tab 看佣金与取消两类资金流水

## 关键实现（对齐 PRD）

- 金额一律以「分」存储，前端展示时 /100
- 幂等：佣金单 `_id=CM_<订单>`、有效邀请 `_id=IR_<邀请>_<受邀openid>`；支付回调按 `pending_pay→paid` CAS
- 并发互斥：达标判定与资金锁定放在 `db.runTransaction` 内，配合状态 CAS；渠道状态不明时保留资金占用
- 规则版本：订单快照购买时 `ruleVersion`
- 资金：`剩余可退 = 实付 − 已出款 − 在途占用`；已全额返佣时门店取消显示可退 0 元

## 接真实微信支付（后续）

替换云函数中两处 mock：
- `mockPay()` → 微信支付 v3 JSAPI 下单 + 支付结果回调验签
- `mockRefund()` → 微信支付退款接口 + 退款回调验签（商户退款单号沿用 `refundNo`）

需要：小程序微信认证 + 微信支付商户号 mch_id + API v3 密钥 + 商户证书序列号/私钥（放云函数环境变量，勿入前端）。
