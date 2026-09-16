# dsh-vps-manager

DSH 的 VPS 管理插件。三大功能：

1. **看信息** —— `/vps-*` 宿主命令，不经过模型、不花 token
2. **跟 AI 说话干活** —— 5 个 `vps_*` 工具 + 分级确认（只读自动 / 改动问 / 高危红字问）
3. **一键安装** —— 菜谱库（内置 + 「我的」），面板、命令、AI 三个入口共用一套引擎

外加一个管理面板：机器列表、应用商店、任务、机器设置页、添加机器向导。

设计文档：`~/dsh/工作流/dsh-vps-manager-设计.md`

## 目录

```
lib/
  index.js         插件入口（tools 硬依赖；commands / webServer / skills 走 ctx.inject）
  payload.js       远端载荷协议：命令恒为 sh -s、脚本走 base64 stdin、哨兵判定
  prelude.sh       远端前导：OS / PKG / INIT / SUDO 探测与 pkg_install 等辅助函数
  spawn.js         本地进程封装（官方 runNativeCommand 不支持 stdin，故自写）
  ssh.js           ssh 参数、别名白名单、失败分类
  engine.js        执行引擎：只读直跑 / 改动走远端任务，12 种结果状态
  task.js          远端任务：列表、日志、终止（进程组）
  risk.js          档位判定：只读白名单 + 高危规则 + 敏感路径
  safety.js        分级确认、ctx.approval、连通性保险
  files.js         改远端文件：备份 → 写入 → 校验 → 失败还原
  recipes.js       菜谱加载 / 校验 / detect → run → verify
  recipe-store.js  「存成菜谱」：id 前缀、格式校验、凭据扫描
  actions.js       三个入口共用的业务动作
  tools.js         AI 的 5 个工具
  commands.js      14 条 /vps-* 命令
  routes.js        面板路由 /api-vps/*（token + 同源 + 局域网降级）
  onboarding.js    添加向导：钥匙、放公钥、指纹、保存
  client.js        面板（手写单文件，无构建链）
  skills/          嵌入式 skill 正文
recipes/           内置菜谱（查询 9 条 + 安装/配置 3 条）
test/              92 个测试
```

## 开发

```bash
npm install
npm test
```

测试不需要真机：本机 `sh -s` 冒充远端 sshd，载荷协议、任务、锁、备份还原、
档位判定、面板路由与渲染都能验。真机 / 容器验证见设计文档第十四节。

## 数据位置

- `$DSH_HOME/vps-manager/hosts.yml` 机器清单（可手工编辑）
- `$DSH_HOME/vps-manager/recipes/` 「我的」菜谱
- `$DSH_HOME/vps-manager/audit/` 操作记录
- `~/.ssh/config.d/dsh-vps.conf` 插件写的 SSH 配置（只在 `~/.ssh/config` 顶部加一行 Include）
- 远端 `~/.cache/dsh-vps/` 任务目录与备份
