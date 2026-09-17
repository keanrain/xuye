# 续页 · Xuye

**接住想法，接着往前。**

本地优先的个人知识与行动助手。Markdown 是真实内容，云同步可选，桌面和手机共用 Web 页面。

## 当前交付状态

本仓库初始化材料来自 v0.11 正式文档和固定 Files.md 提交的 P0 验证工作包。
**目前是开发基线，不是可运行的续页应用。** 已有测试程序、两份候选补丁及原始测试日志；没有完整 Files.md checkout，补丁未集成到真实页面，Agent、Today、系统提醒和容器没有通过验收。

目标远端为 `keanrain/xuye`，计划私有；本地打包时没有创建或推送远端仓库。运行下方发布脚本成功后，才以返回的 GitHub 结果为准。

## 创建 GitHub 仓库并首次推送

需要 Git、Python 3.10+ 和 GitHub CLI `gh`。解压保留 `.git/`，进入本目录执行：

```bash
python3 scripts/publish_github.py
```

脚本使用本机 GitHub CLI 的认证；未登录时引导浏览器登录，不要求向聊天提交 token。实际账户必须是 `keanrain`。它只创建私有 `xuye`、推送 `main`，并核对远端可见性和提交。不同账户、不同 origin、本地未提交修改或非预期远端内容都会停止；没有 force-push、删除仓库、公开发布或部署。

如果仓库创建后推送失败，核对输出后显式续跑：

```bash
python3 scripts/publish_github.py --resume
```

续跑只接受空的同名私有仓库，或其 `main` 已等于本机提交的状态；不会覆盖已有不同历史。

只检查本地交付、不联网：

```bash
python3 scripts/publish_github.py --check
```

## 开发依据

[知识库索引](docs/README.md) · [产品](docs/PRODUCT.md) · [业务规格](docs/PRODUCT-SPEC.md) · [技术](docs/TECHNICAL_DESIGN.md) · [交互](docs/DESIGN.md)

`docs/` 是现行产品与技术说明；`p0/` 是测试代码、固定源码材料、候选补丁和历史日志；`scripts/` 是执行入口。原始声明和 Files.md MIT 文本保留在 `p0/pinned/9e948ba/LICENSE` 与 `p0/sources/FILESMD-LICENSE`。续页整体开源许可尚未选择，不能将局部上游许可自动解释为全项目已发布许可。

## 下一项交付必须是可运行的本地原型

取得固定上游完整源码，先保留页面和编辑器，禁用旧同步与 Bot，只用隔离测试库打通输入、编辑、本地保存和重开恢复。只处理这条链路的阻塞；不要继续横向修复全部上游功能。然后接入只读助手，再接入受控写回与行动安排。

已有 P0 续跑入口：

```bash
python3 scripts/p0.py prepare
python3 scripts/p0.py audit
python3 scripts/p0.py go-test
python3 scripts/p0.py web
```

这些命令依赖真实网络与所需环境，不表示它们已经在本轮执行成功。上游要求 Go 1.24+；`web` 只启动本机静态页面，不等于产品功能已完成。

现有函数级回归（Node 22+、Python 3.10+、Git）：

```bash
python3 scripts/p0.py check-fixed
python3 scripts/p0.py check-delete-guard
```

历史测试中 baseline 的失败是刻意保留的回归证据；检查器整体退出 0 仅表示预期红/绿结果均得到验证。

## 发布脚本依据

GitHub CLI 官方说明：
- https://cli.github.com/manual/gh_repo_create
- https://cli.github.com/manual/gh_auth_login

首次推送会上传当前 Git 提交，不会创建 GitHub Issues、启用收费服务或发布网站。此目录没有模型凭据、同步登录信息或真实个人知识库。
