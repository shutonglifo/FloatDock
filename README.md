# 浮窗坞 / FloatDock

Windows 桌面悬浮球：点一下弹出一圈功能图标，支持把任意窗口钉在最前面、快捷文本框、绑定自己的程序。

## 功能

- **悬浮球**：大小 24–180px、透明度 20–100% 可调，可换成自定义图标；拖动贴边最多藏一半，松手位置记住。
- **径向功能圈**：10 个槽位，空槽展开时不出现；图标数量决定圈的大小。球靠边时功能圈按可用空间展开成半圆 / 扇形，**球本身不跳位**。图标可拖动换位，功能圈不收起。
- **窗口置顶**：点「窗口置顶」后图钉跟随指针，把它放到任意窗口的标题栏上即可置顶；钉住后标题栏最小化按钮左侧会出现一枚钉标，点它取消置顶。
- **快捷文本框**：内置编辑窗口，也可切回调用系统记事本。
- **槽位绑定程序**：从开始菜单 + UWP 别名列表里直接选（本机实测 205 项），显示程序自身的应用图标以便识别。
- **开机自启**开关；改名前的旧设置自动迁移。

## 开发

```bash
npm install
npm start          # 直接跑
npm run pack       # 生成 dist/win-unpacked（免安装目录）
npm run dist       # 生成便携版 exe + NSIS 安装包
```

仅支持 Windows（依赖 `koffi` 直接调用 user32/gdi32/shell32/dwmapi，无子进程）。

## 图标

- 界面图标取自 [Iconsax](https://iconsax.io) 免费集（`iconsax@0.1.1`，MIT）。功能圈 44px 用 bulk 实底，设置面板用 linear 细线；由 `scripts/vendor-icons.cjs` 导出到 `src/ui/icons.js`，运行时不依赖该包。
- 图钉仍用 [Lucide](https://lucide.dev)（ISC）——Iconsax 免费集里没有图钉。
- 程序 / 文件夹 / 文件槽位显示目标自身的 shell 图标（`PrivateExtractIconsW` + `DrawIconEx` 提取）。
- 应用图标由 `scripts/make-icon.cjs` 离屏渲染生成 `build/icon.png`。

## 目录

```
src/main/     主进程：悬浮球、功能圈布局、置顶、图标提取、程序枚举、设置存储
src/ui/       渲染层：悬浮球、功能圈、设置面板、图钉、钉标、编辑器
scripts/      图标导出与生成脚本
LOG.md        逐版本改动记录（含根因与实测数字）
```

## 许可

MIT。第三方图标分别遵循 Iconsax（MIT）与 Lucide（ISC）。
