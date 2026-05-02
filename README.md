# WANG Minecraft Launcher

Minecraft 启动器，Electron + 原生 JS。

## 功能

- 版本列表获取（BMCLAPI / Mojang 双源）
- 一键下载 + 启动游戏
- 微软正版登录（OAuth2 PKCE）(暂未实现)
- 离线模式登录
- Java 路径 / 游戏目录 / 内存设置

## 快速开始

```bash
npm install
npm start
```

## 项目结构

```
ml/
├── package.json          # 项目配置
├── main.js               # Electron 主进程（窗口、IPC）
├── auth.js               # 微软 OAuth2 PKCE 登录 + 离线登录
├── launcher.js           # 版本列表、下载、游戏启动
├── preload.js            # 安全桥接
└── renderer/
    ├── index.html        # 界面结构
    ├── style.css         # Design 样式
    └── app.js            # 前端逻辑
```

## 技术栈

| 层 | 技术 |
|---|---|
| 框架 | Electron 28 |
| 前端 | 原生 HTML/CSS/JS（无框架） |
| 下载源 | BMCLAPI 优先，Mojang 官方兜底 |
| 认证 | Microsoft OAuth2 PKCE + Xbox Live + Minecraft |

## 使用说明

1. **登录** — 账号页面选择微软登录或离线登录
2. **选版本** — 版本页面搜索并选择 Minecraft 版本
3. **启动** — 首页点击启动按钮，自动下载并启动游戏
4. **设置** — 配置 Java 路径、游戏目录、内存

## 许可证

MIT
