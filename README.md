# 白描 OCR v2 修复版（Saladict / Pot 划词翻译插件）

适用于 [Saladict（沙拉翻译，pot-desktop fork）](https://github.com/allentown521/saladict) 及 [Pot](https://github.com/pot-app/pot-desktop) 的**白描 OCR 文字识别插件**。

原版 [pot-app-recognize-plugin-baimiao](https://github.com/TechDecryptor/pot-app-recognize-plugin-baimiao) 已失效：白描网页版接口升级到 v2 后，旧插件直接提交图片 dataUrl 会被服务端拒绝，识别时报 **"图片上传出错，请强制刷新网页后重试"**。本插件按新版接口逆向重写，已实测可用。

## 安装

1. 从 [Releases](../../releases) 下载 `plugin.com.saladict.baimiao-ocr.potext`
2. 打开沙拉翻译 / Pot：**偏好设置 → 服务设置 → 文字识别 → 添加外部插件 → 安装外部插件**，选择下载的 `.potext` 文件
3. 在配置里填写白描账号（手机号/邮箱 + 密码），保存即可

## 配置

| 配置项 | 说明 |
|---|---|
| 手机号/邮箱 | 选填。不填走匿名模式（匿名额度很少且按 IP 共享，**推荐填写**） |
| 密码 | 选填，与上面配套 |

## 工作原理（白描 v2 接口流程）

1. 登录：`POST /api/user/login`（账号）或 `POST /api/user/login/anonymous`（匿名）
2. 申请额度：`POST /api/perm/single`，body 为 `{mode: "single", version: "v2"}`
3. 上传图片：`GET /api/oss/sign?mime_type=image/png` 获取阿里云 OSS 签名 → 用签名字段 multipart 上传图片到 `host`，得到 `file_key`
4. 提交识别：`POST /api/ocr/image/{engine}`，payload 携带 `fileKey`（v2 不再接受 dataUrl）
5. 轮询 `GET /api/ocr/image/{engine}/status?jobStatusId=...` 直到 `isEnded`，解析 `ydResp.words_result`

设备标识（`X-Auth-Uuid`）与登录 token 通过 SQLite（tauri-plugin-sql）持久化在插件目录内：uuid 稳定后服务端不会把每次识别当成新设备登录，token 复用也减少了重复登录。识别提交使用最小 payload `{batchId, total, token, hash, fileKey}`；hash 为图片 dataUrl 的 SHA1。

## 打包脚本示例

`.potext` 本质是一个 zip：**main.js、info.json、图标文件必须位于压缩包根目录**，文件名为插件 id + `.potext` 后缀。用 Python 打包（`python build.py`，产物在 `dist/`）：

```python
#!/usr/bin/env python3
"""打包脚本示例：将插件打包为 .potext"""
import os
import zipfile

PLUGIN_ID = 'plugin.com.saladict.baimiao-ocr'  # 与 info.json 的 id 保持一致
FILES = ['main.js', 'info.json', 'icon.png']

os.makedirs('dist', exist_ok=True)
out = os.path.join('dist', PLUGIN_ID + '.potext')

if os.path.exists(out):
    os.remove(out)

with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for name in FILES:
        z.write(name, name)  # 第二个参数 = 压缩包内路径，必须是根目录

print('打包完成:', out)
```

等价的命令行方式：

```bash
zip plugin.com.saladict.baimiao-ocr.potext main.js info.json icon.png
```

> 注意：三个文件必须在压缩包根目录，不能套文件夹；并且 zip 内必须存在名为 `info.json`（含 `plugin_type` 字段）和 `main.js` 的文件，否则安装时会被判定为无效插件。

推送代码后 GitHub Actions（`.github/workflows/build.yml`）会自动打包并上传 artifact，打 `v*` 标签时会自动发布到 Release。

## 目录结构

```
main.js                      插件逻辑（普通脚本，定义 recognize(base64, lang, options)）
info.json                    元数据与配置声明（needs：username / password）
icon.png                     图标
build.py                     打包脚本
.github/workflows/build.yml  CI：自动打包，tag 时自动发布 Release
```

## 致谢与许可

- 流程参考原版 [pot-app-recognize-plugin-baimiao](https://github.com/TechDecryptor/pot-app-recognize-plugin-baimiao)，按白描 v2 接口重写
- 基于 [Saladict](https://github.com/allentown521/saladict) / [Pot](https://github.com/pot-app/pot-desktop) 的插件规范开发

[MIT](LICENSE) © 2026 MinatoHikari
