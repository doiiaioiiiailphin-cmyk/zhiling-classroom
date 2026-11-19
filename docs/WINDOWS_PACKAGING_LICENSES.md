# Windows 语音组件分发

## Opus

Windows x64 包使用 MSYS2 UCRT64 的 Opus 1.6.1-2，按 BSD 三条款许可证分发。原始版权声明、再分发条款、免责条款及专利声明链接均保留在 `COPYING`。打包后，许可原文和来源记录位于 `ZhilingClassroom/_internal/licenses/opus/`。分发时应交付整个 `ZhilingClassroom` 目录。 [Opus 原始许可](https://opus-codec.org/license/) · [MSYS2 构建来源](https://packages.msys2.org/packages/mingw-w64-ucrt-x86_64-opus)

## doubaoime-asr

项目锁定的提交 `267972f815f519fd7c6149f85a8b7cc99daf61a5` 未附再分发许可证。Windows 包在首次使用默认语音、用户确认后，直接从该仓库下载源码。上游 README 写明供学习和研究使用，并随源码一起保存在用户目录。 [锁定提交](https://github.com/yangmoling/doubaoime-asr/commit/267972f815f519fd7c6149f85a8b7cc99daf61a5) · [上游 README](https://github.com/yangmoling/doubaoime-asr/blob/267972f815f519fd7c6149f85a8b7cc99daf61a5/README.md#免责声明)

依赖文件优先从清华、华为云 PyPI 镜像下载，镜像不可用时再使用 PyPI 官方源。校验通过后安装到 `%LOCALAPPDATA%\ZhilingClassroom\addons\builtin-free-asr`。缓存按依赖版本和 Python ABI 分目录，后续使用直接加载已下载的版本。Windows x64 构建支持常规 CPython 3.11 至 3.14。

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build_windows.ps1
```
