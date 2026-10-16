# 开发与验证

Node.js 20+、npm：

```bash
npm ci
npm run build
npm test
npm run audit:public
npm run package
```

`build` 运行 TypeScript 检查及 Vite 构建；`package` 再检查构建产物、版本和清单引用，并生成确定性 ZIP 和 SHA-256。`package:check` 只检查已构建的 `dist`。测试游戏与 fixture 在开发时从 `public/` 提供，不进入插件包。

## 浏览器回归

测试使用一次性 Chromium 用户目录与假麦克风，避免访问开发者自己的录音和浏览器历史。

```bash
python -m pip install -r scripts/requirements-test.txt
python -m playwright install chromium
npm run dev -- --host 127.0.0.1 --port 4173
```

另一个终端执行：

```bash
python scripts/game_smoke.py --base-url http://127.0.0.1:4173
python scripts/extension_smoke.py
python scripts/ui_smoke.py
python scripts/legacy_export_smoke.py
python scripts/package_smoke.py
```

`package_smoke.py` 直接解压并加载发行 ZIP，使用假麦克风、阻断转录服务，验证关闭 UI 后持续录制、截图和完整 ZIP 导出。先运行 `npm run package`。

Whisper 整场回归需先按 README 配置并启动本机服务：

```bash
python scripts/session_recording_smoke.py --seconds 16
python scripts/recording_recovery_smoke.py
```

`--seconds 310` 用于长场次回归。合成中文麦克风样本目前使用 Windows SAPI，因此整场回归脚本需要 Windows 和中文语音；插件运行与 Python 转录服务不依赖 SAPI。截图、临时音频和日志仅进入忽略的 `shots/` 或 `.local/`。

## 公开范围

`scripts/public-files.mjs` 定义公开文件清单。`npm run audit:public` 检查常见凭证、私人路径和本地录音引用；它是辅助检查，不是对安全或隐私的保证。首次开源应使用 `npm run export:public` 导出经过检查的源文件，不复制工作区 Git 历史。之后只在公开仓库中迭代。

在公开仓库运行 `npm run audit:public -- --tracked` 还会拒绝清单之外的已跟踪文件；CI 和发布流程均启用此检查。完整历史的密钥检查可使用 Gitleaks。不要在公开 issue、日志或 CI 上传未遮盖的扫描内容、真实录音或屏幕记录。
