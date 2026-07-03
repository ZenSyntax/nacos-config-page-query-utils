# Nacos 配置列表分页与排序助手

## 开发目的

本脚本用于解决 Nacos 2.x 配置管理页在日常使用中的分页、查询和排序状态不便保存的问题。

在 Nacos 2.4.3 等 2.x 版本中，配置列表页的分页条数、排序方向等行为主要由前端组件内部状态驱动。用户手动选择每页 100 条、点击 Data Id 排序，或从配置详情页返回列表页时，页面并不总是把这些选择稳定保存为可复用的用户偏好。刷新页面、重新进入配置列表页或从详情页返回后，仍需要重复手动设置。

本仓库提供一个可直接粘贴到 Tampermonkey、Violentmonkey 等用户脚本管理器中的脚本，通过浏览器侧增强的方式，为 Nacos 配置列表页补充以下能力：

1. 记住用户选择的单页条数。
2. 记住用户选择的排序列和排序方向。
3. 在刷新、首次进入或从详情页返回列表页时自动恢复偏好。
4. 不修改 Nacos 服务端代码，不依赖固定主机或端口。

## 简介

这是一个面向 Nacos 2.x 配置管理页的油猴脚本，用于在配置列表页面记住分页条数和排序偏好。

## 功能

1. 访问 `/nacos/#/configurationManagement` 时自动启用，不绑定固定主机或端口。
2. 页面右侧显示圆形悬浮按钮，点击后展开设置面板。
3. 设置面板支持配置单页条数、排序列和排序方向。
4. 单页条数输入框失去焦点后会写入当前页面查询参数，并重置到第 1 页。
5. 排序列或排序方向修改后会立即重排当前页展示的配置列表。
6. 使用 cookie 保存分页条数、排序偏好和悬浮控件位置，刷新后自动恢复。
7. 圆形按钮支持长按拖拽，展开后的设置面板支持长按顶部区域拖拽。

## 适用范围

当前脚本主要面向 Nacos 2.x，已按 Nacos 2.x 配置管理页行为实现。

Nacos 3.x 的配置管理页分页逻辑已经明显不同，本脚本暂不主动支持 3.x 或更高版本。如需支持新版本，建议单独确认其路由、接口和分页参数行为后再扩展。

## 安装方式

1. 安装 Tampermonkey、Violentmonkey 或同类用户脚本管理器。
2. 新建用户脚本。
3. 将 `nacos-config-page-query-utils.user.js` 的内容复制到用户脚本编辑器中。
4. 保存后访问 Nacos 配置管理页面。

脚本匹配规则为：

```javascript
// @match        http://*/nacos*
// @match        https://*/nacos*
```

真正执行分页、排序和 UI 逻辑前，脚本还会在运行时确认当前路径为 Nacos 页面，并且 hash 路由以 `#/configurationManagement` 开头。排序仅对当前页展示数据生效，不修改 Nacos 后端查询或跨页排序逻辑。

## 偏好保存

脚本使用以下 cookie key 保存偏好：

```text
nacos_config_page_query_utils_settings
```

保存内容包括：

1. 单页条数。
2. 排序列。
3. 排序方向。
4. 悬浮控件位置。

cookie 路径为 `/nacos`，有效期为 1 年。

## Nacos 新版本与社区方案调研

调研时间：2026-07-03。

### 调研问题

1. 新版 Nacos 是否实现了记住用户选定分页/查询参数的功能？
2. 代码托管平台上，尤其是 GitHub，是否已有类似的支持 Nacos 前端页面记住用户选定分页/查询参数的插件或社区版 Nacos？

### 结论摘要

1. 截至调研时，Nacos 最新正式版本为 `3.2.2`。
2. Nacos `3.2.2` 的新控制台 `console-ui-next` 已经对配置列表页做了 URL 参数同步：可以从 URL 读取并写回 `dataId`、`groupName`、`appName`、`searchMode`、`pageNo`、`pageSize`。
3. 这属于“URL 参数恢复”，不是“用户偏好持久化”。如果 URL 中没有 `pageSize`，默认分页条数仍为 10；源码中未看到针对配置列表分页偏好的 `localStorage` 或 Zustand `persist` 持久化。
4. 未发现成熟的、专门用于“让官方 Nacos 前端记住分页/查询参数”的第三方插件或用户脚本项目。
5. 官方 Nacos 插件体系主要面向服务端扩展，例如配置变更插件，不是前端页面增强插件体系。

### 新版 Nacos 的实现情况

Nacos `3.2.2` 发布说明中提到 Console 体验改进，涉及 Config、Naming、MCP、Skill、AI resources、namespace workflows 等控制台能力。

参考链接：

- <https://github.com/alibaba/nacos/releases>

源码层面，`console-ui-next` 的配置列表页使用 `useSearchParams` 管理 URL 参数：

1. 首次进入页面时，从 URL 读取 `dataId`、`groupName`、`appName`、`searchMode`、`pageNo`、`pageSize`。
2. 页面状态变化时，将这些参数重新写回 URL。
3. 因此，当 URL 中携带这些参数时，刷新页面可以恢复对应查询条件和分页状态。

参考源码：

- <https://github.com/alibaba/nacos/blob/3.2.2/console-ui-next/src/pages/configurationManagement/index.tsx>

但配置列表状态管理仍然以默认值初始化，`pageNo` 默认为 1，`pageSize` 默认为 10；未看到对配置列表分页条数、排序偏好或查询偏好的本地持久化。

参考源码：

- <https://github.com/alibaba/nacos/blob/3.2.2/console-ui-next/src/stores/config-store.ts>

旧控制台 `console-ui` 中也存在从 URL 读取 `pageSize`、`pageNo` 的逻辑，但该逻辑更偏向页面跳转参数传递，并不等价于全局记住用户偏好。

参考源码：

- <https://github.com/alibaba/nacos/blob/3.2.2/console-ui/src/pages/ConfigurationManagement/ConfigurationManagement/ConfigurationManagement.js>

### 社区插件与社区版情况

未发现成熟的、专门用于配置列表分页/查询参数记忆的 Nacos 前端插件或用户脚本。

已发现但不匹配本需求的相关项目或线索包括：

1. Greasy Fork 上存在 Nacos 相关用户脚本，但功能主要是配置内容区域全屏优化，不是分页或查询参数记忆。
   - <https://greasyfork.org/de/scripts/489792-nacos%E9%85%8D%E7%BD%AE%E5%86%85%E5%AE%B9%E5%8C%BA%E5%9F%9F%E5%85%A8%E5%B1%8F/versions>
2. GitHub 上存在与 Nacos 配置中心编辑器显示体验相关的历史 issue，但不涉及配置列表分页/查询状态保存。
   - <https://github.com/alibaba/nacos/issues/2644>
3. `r-nacos` 是 Rust 实现的 Nacos 替代服务，带有独立 Web 控制台，但它不是给官方 Nacos 控制台做前端增强的插件。
   - <https://github.com/nacos-group/r-nacos>
4. 官方插件机制中的配置变更插件主要用于服务端侧配置变更扩展，不适用于控制台页面分页和查询偏好保存。
   - <https://nacos.io/docs/latest/plugin/config-change-plugin/>

### 相关历史线索

官方曾在服务列表页相关 issue 和 PR 中处理过“从详情页返回列表时保留查询信息”的体验问题。该线索说明官方确实关注过控制台页面状态保留，但其范围不是“全局记住用户分页偏好”，也不是针对 Nacos 2.4.3 配置列表页的直接解决方案。

参考链接：

- <https://github.com/alibaba/nacos/issues/9597>
- <https://github.com/alibaba/nacos/pull/9598>

### 对本仓库的意义

对于仍在使用 Nacos 2.4.3 或其他 2.x 版本的场景，本脚本仍有实际价值：

1. 不需要升级 Nacos 服务端。
2. 不需要修改 Nacos 镜像或前端构建产物。
3. 可以补足配置列表页分页条数和排序偏好恢复能力。
4. 与 Nacos 3.x 的 URL 参数同步能力定位不同，本脚本更接近“用户偏好记忆”。
