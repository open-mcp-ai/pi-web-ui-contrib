# pi-web-ui-contrib

给 [pi-web-ui](https://github.com/xing-shuyin/pi-web-ui) 用的插件集合。

| 插件 | 说明 |
| --- | --- |
| [🖥️ termcp](plugins/termcp-bridge/) | 把 [termcp](https://github.com/open-mcp-ai/termcp) 接进 pi-web-ui：顶栏多一个完整的终端工作区视图，并把它的 31 个工具（SSH / SFTP / 端口转发 / 消息推送）交给 AI。termcp 实例自动就位——没在跑就自己拉起，已经在跑就接管，空闲后自行退出。 |

## 装

从插件市场同步本仓库的目录：

```bash
pi-web-ui install --catalog https://raw.githubusercontent.com/backrise/pi-web-ui-contrib/main/catalog.json
```

单装一个：

```bash
pi-web-ui install backrise/pi-web-ui-contrib/plugins/termcp-bridge
```

或设置 →「界面插件」→「插件市场」里一键装。

## 目录

```
plugins/<id>/      一个子目录一个插件，各自带 manifest.json
catalog.json       插件市场目录（供 pi-web-ui 一键同步安装）
```

每个插件目录里的 `README.md` 写清它对你机器的改动、前置条件与卸载方式。
