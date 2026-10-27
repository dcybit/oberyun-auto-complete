# 欧倍尔自动完成课程

欧倍尔虚拟仿真云平台（oberyun.com）课程与考试自动完成工具。

## 功能

- 自动遍历课程所有章节资源（视频/PDF/文档）并标记为已完成
- 考试自动答题（安全通识-文科类，100 题答案库，实测 100 分）
- 启动器自动注入脚本到每个标签页，支持跨导航持久注入

## 运行

1. 双击 `OberyunAutoComplete.exe`
2. 自动打开浏览器并导航到欧倍尔平台，登录账号
3. 脚本自动开始处理课程与考试，进度查看浏览器 Console（F12）

## 文件说明

| 文件 | 说明 |
|------|------|
| `OberyunAutoComplete.exe` | 启动器（.NET 8 single-file），启动浏览器并注入脚本 |
| `oberyun-auto.js` | 自动完成脚本（课程标记完成 + 考试答题） |
| `exam-answers.txt` | 考试答案库（已实测 100 分验证） |
| `Program.cs` | 启动器源码（v1.0 旧版，构建用 `oberyun-build/Program.cs`） |
| `oberyun-build/` | 启动器 .NET 8 项目源码（v3.0） |

## 构建启动器

```bash
cd oberyun-build
dotnet publish -c Release -r win-x64 --self-contained true /p:PublishSingleFile=true
```

## 考试答题原理

- 通过 CDP 向浏览器注入 JS，按 DOM 顺序点击 radio/checkbox 选项
- 多选题每次点击间隔 600ms，避免 `saveAnswers` 请求乱序
- 交卷后自动读取成绩

## 免责声明

仅供学习交流使用，请遵守平台相关规定。
