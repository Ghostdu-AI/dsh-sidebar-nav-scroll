# dsh-sidebar-nav-scroll

把 DSH 侧边栏顶部的「全局面板」列表限制为自身自然高度的一半，并给溢出的部分加滚动条；
省下来的高度自动让给下方的工作区（sidebar 的面板列表是 `flex: none`，工作区是 `flex: 1`，
所以不需要任何额外的布局补丁）。

被限制的列表就是侧边栏里这一段：

```
插件 / 插件市场 / 归档会话 / 自动化任务 / IM机器人 / Worktree Space / 记忆系统 / 更多
```

## 工作方式

* 浏览器端在运行时测量每一行的真实高度和真实的 `row-gap`，再按 `fraction` 算出上限；
  不写死 36px / 2px，宿主改样式时也不会算错。
* 自然高度由**行元素本身**累加得到，不读 `scrollHeight`，因此上限生效后测量不会自我影响。
* 上限写在注入的样式表里（通过自定义属性 `--dsh-sidebar-nav-scroll-cap` 传值），
  所以侧边栏折叠成窄条时，样式表里的折叠保护规则可以稳定地覆盖它。
* 列表定位不依赖宿主的 CSS Module 类名：只要找到任意 `panelRow` 行元素，取它最近的
  `<nav>` 就是面板列表；找不到时才回退到类名匹配。
* 侧边栏折叠（`[data-sidebar-collapsed]` 或折叠态类名）时自动不设上限。

## 配置

在 DSH Web 的侧边栏点「插件」，在**已安装插件**里找到「侧边栏面板列表限高」，点标题
进入它的页面，就能看到本插件的设置卡片：

* **高度上限（占自然高度的比例）** — 滑块，5%–100%
* **至少保留几行** — 数字输入，0 表示不限制
* **启用限高** — 勾选框
* **恢复默认** — 清掉已保存的值

改动即时生效，不需要重载页面；卡片、控制台 API 和别的标签页写的是同一个键，任何一方
改动，侧边栏的高度上限都会跟着变。

### 为什么配置在浏览器侧

宿主侧的 patch 行**无法**把配置送进浏览器（`dsh.client` 的启动图谱只带
`id/url/rev/inject/immediately/external`），所以设置存放在浏览器侧；卡片只是这份
存储的可视化入口，也能用控制台直接改：

| 位置 | 说明 |
| --- | --- |
| `localStorage["dsh-sidebar-nav-scroll"]` | JSON 对象，例如 `{"fraction":0.5,"minRows":2,"enabled":true}` |
| `window.__DSH_SIDEBAR_SCROLL__` | 控制台 API：`get()` / `set({fraction,minRows,enabled})` / `reset()` / `status()` |

优先级：`localStorage` > 插件 `apply(ctx, config)` 收到的 `config` > 内置默认值
（`fraction: 0.5`、`minRows: 2`、`enabled: true`）。

`fraction` 取值范围 0.05–1；`minRows` 是至少完整显示多少行（按测得的行高计算下限）；
`enabled: false` 会完全停用插件并还原侧边栏。

控制台示例：

```js
__DSH_SIDEBAR_SCROLL__.set({ fraction: 0.4, minRows: 3 })  // 改成四成，至少三行
__DSH_SIDEBAR_SCROLL__.status()                          // {attached,collapsed,rows,naturalHeight,capHeight}
__DSH_SIDEBAR_SCROLL__.reset()                           // 回到默认值
```

设置卡片注册在插件页的 `plugins.bundle.config` 槽位上（键是本包的包名），组件是普通
React 组件，不依赖插件的 `configForms` 服务；宿主版本没有这个槽位时，卡片不会出现，
控制台接口照旧可用。


## 安装

这是一个 DSH 客户端插件（bundle），只作用于 Web 端（`dsh.client.platform = "web"`）。
在 DSH Web 的侧边栏点「插件」→「已安装插件」→「添加插件」，把下面任意一种 spec
填进去即可（`installBundle` 接受 `pnpm add` 支持的所有写法）：

```text
github:Ghostdu-AI/dsh-sidebar-nav-scroll
https://github.com/Ghostdu-AI/dsh-sidebar-nav-scroll.git
Ghostdu-AI/dsh-sidebar-nav-scroll
```

也可以先 clone 到本地，再用 `link:` / `file:` 指向目录做开发：

```bash
git clone https://github.com/Ghostdu-AI/dsh-sidebar-nav-scroll.git
# 在「添加插件」里填： link:/绝对路径/dsh-sidebar-nav-scroll
```

安装并启用后，侧边栏的「全局面板」列表会立即被限高；不需要重启 DSH。开发时
修改 `client.js` 保存后，宿主会检测到文件变化并给插件推一个新的 revision，浏览器端
热重载该插件。

> 私有仓库需要宿主已配置好对应的 git 凭据；`installBundle` 的连通性预检
> （`git ls-remote`）会禁用凭据助手与交互提示，因此私有仓库请优先用本地路径安装。

## 开发

`test/` 目录里带了一份浏览器端的回归测试（基于 jsdom，复刻了宿主侧边栏的 DOM 与
布局）。装好依赖后运行：

```bash
npm install
npm test
```

## 已知限制

* 本插件只作用于 Web 端（`dsh.client.platform = "web"`），桌面壳内置的浏览器同样适用。
* 配置存在 `localStorage` 里，浏览器侧 origin 变化时会丢失（与宿主其它浏览器端插件一致）。
* 设置卡片依赖插件页的 `plugins.bundle.config` 槽位（0.1.7 及之后的插件页提供）；
  更早的版本只有控制台接口。

## 许可证

MIT
