# 钥航 KeyPilot

KeyPilot 是一个本地优先的浏览器密码管理与自动填表插件，面向需要频繁登录后台、联盟平台、云服务、站点管理面板和业务表单的用户。

它的核心目标很简单：账号、密码和填表资料只保存在本机加密 Vault 中，不依赖云端同步，不调用第三方 Logo / Favicon 服务，不把用户的网站域名或资料发送给外部服务。

> 当前项目处于 Beta / Preview 阶段，适合测试、二次开发和安全审计前的功能验证。正式保存重要账号前，建议先完成代码审计、兼容性测试和扩展商店发布前安全检查。

## English Summary

KeyPilot is a local-first Chrome / Edge extension for password management, autofill, one-click login, password generation, and structured identity/profile form filling. Data is encrypted locally and stored in the browser extension storage.

## 功能概览

- 本地加密 Vault：主密码派生密钥，浏览器本地保存加密数据。
- 账号管理：新增、编辑、查看、复制、删除、收藏、移动文件夹。
- 当前网站匹配：支持主域名和子域名泛匹配。
- 自动填充与一键登录：填写用户名、密码，并在安全条件满足时尝试点击登录按钮。
- 网页内快捷菜单：在登录框和填表页面旁显示 KeyPilot 图标，悬停或点击后选择账号或身份资料。
- 自动保存提示：登录成功后提示保存新账号或更新已有账号。
- 密码生成器：支持长度、大小写、数字、符号、排除字符、必须包含字符。
- 身份ID / 填表资料：支持从 Excel / CSV / `.kpfill` 导入批量资料，并在网页表单中填写。
- 指定账号导出：可搜索并勾选部分账号导出为 RoboForm CSV。
- 指定资料导出：可选择部分身份资料导出为 `.kpfill`，方便发送给可信对象导入。
- RoboForm / Chrome / Edge CSV 导入：支持预览、重复检测、冲突处理。
- 加密备份：支持导出和导入加密 Vault 备份。
- 设置页：独立 options 页面，管理安全、自动填表、自动保存、域名和高级设置。
- 安全中心：本地密码强度与重复情况统计。
- 高安全模式：可关闭明文 Vault 和解锁密钥的会话缓存，降低本机缓存暴露面。

## 隐私与安全原则

- 主密码不会写入持久化存储。
- 明文 Vault 只在解锁后的运行时会话中使用。
- `chrome.storage.local` 中只保存加密后的 Vault。
- 解锁缓存使用 `chrome.storage.session`，浏览器会话结束后自动清理。
- 开启高安全模式后，KeyPilot 不再写入解锁缓存；关闭弹窗、刷新后台页或重启浏览器后需要重新输入主密码。
- 密钥派生使用 PBKDF2 + SHA-256。
- Vault 加密使用 AES-GCM。
- 不上传账号、密码、表单资料或网站域名。
- 不使用 Google Favicon、Clearbit Logo 或其他第三方图标 API。
- Favicon 优先读取网页声明的 icon，其次尝试网站根路径 `/favicon.ico`，失败时使用本地默认图标。

## 当前限制

- 项目尚未经过第三方安全审计。
- 真实网站登录流程差异很大，一键登录兼容性仍需要持续积累规则。
- 暂无云同步、团队共享、Passkey、正式 TOTP 管理、泄露监控。
- 自动保存登录信息依赖浏览器页面信号，仍需更多站点测试。
- 当前主要面向 Chromium 内核浏览器，Firefox 适配尚未开始。

## 技术栈

- Manifest V3
- React 18
- TypeScript
- Vite
- Web Crypto API
- Chrome Extension APIs

## 项目结构

```text
.
├── public/                 # manifest、图标、测试页面
├── src/
│   ├── background/         # service worker
│   ├── content/            # 网页表单识别、内联菜单、自动填充
│   ├── options/            # 独立设置页
│   ├── popup/              # 浏览器工具栏弹窗
│   ├── shared/             # 加密、Vault、导入导出、域名匹配等共享逻辑
│   └── vault/              # 后台 Vault 管理页
├── popup.html
├── options.html
├── vault.html
└── vite.config.ts
```

## 本地开发

安装依赖：

```bash
npm install
```

如果 PowerShell 阻止 `npm.ps1`，可以使用：

```bash
npm.cmd install
```

构建扩展：

```bash
npm run build
```

或：

```bash
npm.cmd run build
```

构建产物会输出到：

```text
dist/
```

## 在 Chrome / Edge 中加载

1. 执行 `npm run build`。
2. 打开 Chrome 的 `chrome://extensions/`，或 Edge 的 `edge://extensions/`。
3. 打开“开发者模式”。
4. 点击“加载已解压的扩展程序”。
5. 选择项目生成的 `dist/` 目录。
6. 点击浏览器工具栏中的 KeyPilot 图标开始使用。

## 基础测试流程

1. 首次打开插件，创建本地 Vault。
2. 新增一个测试账号，填写标题、网址、用户名和密码。
3. 打开对应网站或测试登录页。
4. 打开 KeyPilot，确认当前网站匹配账号。
5. 点击“登录”或“浏览并填写”。
6. 验证用户名、密码是否正确填入。
7. 手动登录成功后，检查是否出现保存或更新账号提示。

## 测试实验室

项目内置了一组本地测试页面，用于验证登录识别、分步登录、自动保存和 favicon 读取。

```bash
npm.cmd run build
npm.cmd run lab
```

然后访问：

```text
http://127.0.0.1:4173/test-lab/
```

测试页面包括：

- 普通登录表单
- 分步登录表单
- 含验证码 / OTP 的安全表单
- 保存登录信息捕获
- Favicon 读取与回退

## 导入和导出

账号导入：

- RoboForm CSV
- Chrome CSV
- Edge CSV
- 通用 CSV

身份资料导入：

- Excel `.xlsx`
- CSV `.csv`
- KeyPilot `.kpfill`

身份资料导出：

- 可导出全部资料
- 可搜索并勾选指定资料导出为 `.kpfill`

账号导出：

- 可搜索并勾选指定账号导出为 RoboForm CSV
- CSV 会包含明文用户名和密码

注意：CSV 和 `.kpfill` 可能包含明文密码或敏感字段，请只在可信环境中保存和传输。

## 发布前检查

公开发布前建议至少完成：

- 运行 `npm run build` 并确认无 TypeScript 错误。
- 不提交 `node_modules/`、`dist/`、真实 CSV、真实 Excel、真实 `.kpfill` 或 Vault 备份文件。
- 检查 `public/manifest.json` 权限说明是否准确。
- 对常见站点做登录、填表、保存提示和异常流程测试。
- 完成隐私政策和安全说明。
- 如果要上架 Chrome Web Store，需要准备商店截图、权限说明和隐私声明。

## Roadmap

- 更完整的站点规则库和自动登录失败修复。
- TOTP 管理和验证码字段识别。
- Passkey / WebAuthn 相关能力调研。
- 更细的导出权限和加密分享流程。
- 多浏览器兼容性测试。
- 单元测试和端到端测试。
- Chrome Web Store 发布材料。

## 贡献

欢迎提交 issue、兼容性案例、站点规则、文档改进和 pull request。请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 安全问题

如果你发现安全漏洞，请不要直接公开披露可利用细节。请参考 [SECURITY.md](SECURITY.md)。

## License

MIT License. See [LICENSE](LICENSE).
