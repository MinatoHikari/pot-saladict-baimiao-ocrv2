#!/usr/bin/env python3
"""打包脚本示例：将插件打包为 .potext

.potext 本质是一个 zip 压缩包，要求 main.js / info.json / 图标文件位于压缩包根目录，
文件名必须为插件 id（info.json 里的 id 字段）+ .potext 后缀。
运行: python build.py  （产物在 dist/ 目录）
"""
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
