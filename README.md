# 欧倍尔自动完成课程

欧倍尔虚拟仿真云平台（oberyun.com）课程与考试自动完成工具。

## 功能

- 自动遍历课程所有章节资源（视频/PDF/文档）并标记为已完成
- 考试自动答题（安全通识-文科类，100 题答案库，实测 100 分）
- 启动器自动注入脚本到每个标签页，支持跨导航持久注入
- 页面右下角可视化状态浮窗，无需打开控制台即可查看进度
- API 失败自动重试（502/503/504 等临时错误）

## 快速使用

1. 双击 `OberyunAutoComplete.exe`
2. 自动打开浏览器并导航到欧倍尔平台，登录账号
3. 脚本自动开始处理课程与考试，**页面右下角**会显示运行进度浮窗

## 文件说明

| 文件 | 说明 |
|------|------|
| `OberyunAutoComplete.exe` | 启动器（.NET 8 single-file），启动浏览器并注入脚本 |
| `oberyun-auto.js` | 自动完成脚本（课程标记完成 + 考试答题）v8.1 |
| `exam-answers.txt` | 考试答案库（已实测 100 分验证） |
| `oberyun-build/Program.cs` | 启动器源码（v3.1） |
| `oberyun-build/OberyunAuto.csproj` | 启动器项目文件 |

## 构建启动器

```bash
cd oberyun-build
dotnet publish -c Release -r win-x64 --self-contained true /p:PublishSingleFile=true -o ..
```

构建产物 `OberyunAutoComplete.exe` 输出到项目根目录。

## 版本历史

### v8.1 (脚本) / v3.1 (启动器)
- 修复课程列表 API 502 等临时错误，增加自动重试机制（每路径最多 3 次，间隔 3 秒）
- 修复启动器 CDP 注入：`awaitPromise=false` 避免超时、按 id 匹配响应、注入后验证脚本运行状态

### v8.0 (脚本) / v3.0 (启动器)
- 修复课程列表 API 路径（正确路径带 `/V2/` 前缀，自动回退尝试）
- 添加页面右下角可视化状态浮窗
- 增强 `getHttp()` 鲁棒性
- 考试打开方式从 `window.open` 改为当前页导航，避免会话丢失

## 考试答题原理

- 通过 CDP 向浏览器注入 JS，按 DOM 顺序点击 radio/checkbox 选项
- 多选题每次点击间隔 600ms，避免 `saveAnswers` 请求乱序
- 交卷后自动读取成绩

## 免责声明

仅供学习交流使用，请遵守平台相关规定。
