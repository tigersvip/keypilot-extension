# 版本发布

使用 Node.js 24 和 `npm ci` 安装锁定依赖。开发中的版本不代表已经发布；可下载版本以 GitHub Releases 为准。

1. 更新 `CHANGELOG.md`，写明新版本的用户可见变化和限制。
2. 执行 `npm version 1.14.1 --no-git-tag-version`（版本号按实际填写）。版本钩子同步 manifest、lockfile 和 README；手动改动后也可运行 `npm run version:sync`。
3. 执行 `npm run release:check`、`npm run check`、`npm test`、`npm run build`、`npm run test:regression` 和 `npx tsx tools/package.mts`。首次浏览器测试先运行 `npx playwright install chromium`。
4. 提交并推送 main。GitHub Actions 使用独立 Chromium 和合成资料运行回归，并检查 ZIP 不超过 10,000,000 字节、解压内容不超过 15,000,000 字节。下载 CI 的 `release-package` artifact 可提前验收。
5. 确认后创建与 package.json 一致的版本标签（例如 `git tag v1.14.1`），再推送该标签。标签流程重新验证同一份源码，通过后发布 ZIP、更新说明和 SHA-256 文件。

标签与源码版本不一致、版本文档过期、测试失败或包体超限都会阻止发布。已有 Release 不会被自动覆盖；修复后使用新版本标签。不要删除或移动已发布标签。

校验下载包：Windows 使用 `Get-FileHash .\keypilot-extension-v1.14.1.zip -Algorithm SHA256`，macOS/Linux 使用 `shasum -a 256 keypilot-extension-v1.14.1.zip`，与同版本 `.sha256` 文件比较。

流水线只上传安装包、说明、校验文件和失败测试证据，不上传本机密码库、备份或用户浏览器资料。普通验证任务仅有仓库读取权限；标签发布任务才使用 GitHub 提供的临时写入令牌。无需新增个人访问令牌。

测试使用 Playwright 自带 Chromium。它覆盖自动化用例中的浏览器行为，不代替用户在实际 Chrome、Edge 和 macOS 上的验收。参考：[Playwright 扩展测试](https://playwright.dev/docs/chrome-extensions)、[GitHub Node.js CI](https://docs.github.com/en/actions/tutorials/build-and-test-code/nodejs)。
