# 发布

## 首次公开

1. 检查 README 中仓库、视频和插件下载链接是否指向自己的 GitHub 仓库。
2. 运行 `npm ci`、`npm test`、`npm run audit:public` 和 `npm run package`。
3. `npm run export:public` 导出到新的 `.local/open-source/`，只包含允许公开的文件，不携带 Git 历史、私有录音、测试结果或视频制作过程。
4. 在导出目录初始化新的 Git 仓库，再推送到 GitHub。不要直接把包含旧私人记录引用的工作区历史推上去。

导出目录已存在时脚本会拒绝覆盖，可指定另一空目录：

```bash
npm run export:public -- .local/open-source-next
```

## 发布插件

保持 `package.json`、`public/manifest.json`、`src/shared/protocol.ts` 和 `package-lock.json` 的版本一致。构建验证后推送 `v` 开头的版本标签：

```bash
git tag v0.4.0
git push origin main --tags
```

GitHub Actions 会在独立构建任务中测试、审查并打包。只有校验通过且标签与版本一致时，发行任务才获得 `contents: write` 权限，创建 Release，上传：

- `vibe-iter-chrome.zip`
- `SHA256SUMS.txt`
- `vibe-iter-demo.mp4`

README 的固定下载入口使用 `releases/latest/download/vibe-iter-chrome.zip`，每次发布无需修改版本链接。插件 ZIP 的根目录直接包含 `manifest.json`。不要发布 `.crx` 私钥、个人浏览器目录或测试录制包。

## 视频展示

视频放在 README Header 正下方，早于安装入口。当前使用 GitHub 视频附件显示原生播放器，并保留 1080p 原片下载链接。17 MB 的原片在仓库 `blob/main` 页面不提供文件预览，不要把这种链接标成「在线播放」。

README 内的原生播放器需要 GitHub 网页上传生成的真实视频附件链接；普通仓库链接和手写 `<video>` 会被过滤为非播放器内容。通过 GitHub 的 README 编辑器上传视频，拿到生成的 `user-attachments` 链接后，将 `demo-video:start` 与 `demo-video:end` 注释之间的内容替换为独占一段的附件链接，并验证实际播放。SSH 推送权限不等同于网页附件上传会话。

附件大小上限取决于 GitHub 账号方案；必要时将预览转为小于 10 MB 的 H.264/AAC MP4，1080p 原片继续保留在仓库与 Release 中。不要手写不存在的附件地址。

视频单独保存在源码仓库及 Release 中，不进入插件 ZIP。更换演示视频前，检查音频、画面、浏览器界面、字幕和媒体元数据。
