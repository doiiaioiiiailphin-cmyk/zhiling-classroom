import base64
import binascii
import hashlib
import json
import os
from datetime import UTC, datetime
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy import text

from .db import Database, SettingsRow
from .schemas import ASRModelsRequest, AppSettings, DesktopHotkeys, LLMProvider, iso_utc


OPENCODE_FREE_PROVIDER_ID = "opencode-free-bridge"
DEFAULT_LLM_PROVIDER_ID = "deepseek"


LLM_PRESETS = (
    ("deepseek", "DeepSeek", "openai-compatible", "https://api.deepseek.com/v1"),
    ("openai", "OpenAI", "openai", "https://api.openai.com/v1"),
    ("anthropic", "Anthropic", "anthropic", "https://api.anthropic.com"),
    ("gemini", "Google Gemini", "gemini", "https://generativelanguage.googleapis.com"),
    ("aliyun", "阿里云百炼", "openai-compatible", "https://dashscope.aliyuncs.com/compatible-mode/v1"),
    ("zhipu", "智谱 GLM", "openai-compatible", "https://open.bigmodel.cn/api/paas/v4"),
    ("moonshot", "月之暗面 Kimi", "openai-compatible", "https://api.moonshot.cn/v1"),
    ("volcengine", "火山方舟", "openai-compatible", "https://ark.cn-beijing.volces.com/api/v3"),
    ("siliconflow", "硅基流动", "openai-compatible", "https://api.siliconflow.cn/v1"),
    ("openrouter", "OpenRouter", "openai-compatible", "https://openrouter.ai/api/v1"),
    ("groq", "Groq", "openai-compatible", "https://api.groq.com/openai/v1"),
    ("custom", "自定义接口", "openai-compatible", ""),
)

LEGACY_DEFAULT_LLM_ROUTING = {
    "chat": "anthropic",
    "sentenceCorrection": "gemini",
    "resegmentation": "openai",
    "keyTermHighlight": "gemini",
    "bubbleExplanation": "openai",
}

ASR_PRESETS = (
    ("builtin-free-asr", "本地离线语音（SenseVoice）", "builtin-free-asr", "local://sensevoice"),
    ("openai-audio", "OpenAI 语音", "openai-audio", "https://api.openai.com/v1"),
    ("aliyun-asr", "阿里云通义听悟", "aliyun-tingwu", "wss://dashscope.aliyuncs.com/api-ws/v1/inference"),
    ("volcengine-asr", "豆包流式语音", "volcengine-asr", "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel"),
    ("iflytek-asr", "科大讯飞转写", "iflytek-rtasr", "wss://rtasr.xfyun.cn/v1/ws"),
    ("tencent-asr", "腾讯云语音", "tencent-asr", "wss://asr.cloud.tencent.com/asr/v2"),
    ("deepgram", "Deepgram", "deepgram", "wss://api.deepgram.com/v1/listen"),
    ("assemblyai", "AssemblyAI", "assemblyai", "wss://streaming.assemblyai.com/v3/ws"),
    ("elevenlabs", "ElevenLabs", "elevenlabs-scribe", "https://api.elevenlabs.io/v1"),
    ("custom-asr", "自定义语音", "custom-asr", ""),
)

# Fingerprints of the catalogs seeded by the previous version. Used only to migrate existing settings.
LEGACY_SEED_HASHES = {
    "openai": "fd383e013a162a0249dad735e39d17e3dcca21fcdb2563c37215b8e6696371fd",
    "anthropic": "622f7d4ac97aa4d43c62500be4f706c8b74b1eea77d3cefe9ff39a74a5a657ac",
    "gemini": "838b76661c2bc62b3a57031a662288a83fe492f893d5b832a4ccea48621af77b",
    "openai-audio": "c686d522c76be62736e13d6548f33b9a50c48cee367eb6c8fd368d8b486e9233",
    "aliyun-asr": "23ba4c46ab8de0d7bcf69a3aa155c0d66b81d009b10b3b6d7ab4b0aa7a51312f",
    "volcengine-asr": "6d2bd5e5c2bed06f871d1f9db25e7b4cce70128a2d4befb6e135d609094399fb",
    "iflytek-asr": "aebb6b4a3d13646bbd71c021150e19d20c0f9d4a3a8657182cb48a9d2e535bab",
    "tencent-asr": "f83ab96101846844a4d94d86828fc561bfd4743f90c5edd2260d54af924af74b",
    "deepgram": "9b6f1375d3180d20bb812fa1dadd1b45c633fcd4402820f899a3b4b86c00c00f",
    "assemblyai": "117967b08d67152cbf37b1b07cf9520e73f2f0b9c7fc06779339db6e66c95fb6",
    "elevenlabs": "43eb7a0e3e61bf9112b8375b5495bd894632f42f3d0694848bbf62cc419bea4a",
    "custom-asr": "17d9bd1180bf3fc18fec74c8e1dc54b2789bfa2adc16a73d601ca114b1a04787",
}


def is_legacy_seed(provider_id: str, models: list[str]) -> bool:
    expected = LEGACY_SEED_HASHES.get(provider_id)
    return expected is not None and expected == hashlib.sha256(
        json.dumps(models, separators=(",", ":")).encode("utf-8"),
    ).hexdigest()


def same_asr_connection(first: ASRModelsRequest, second: ASRModelsRequest) -> bool:
    return all(
        (getattr(first, field) or "").strip() == (getattr(second, field) or "").strip()
        for field in ASRModelsRequest.model_fields
    )


def remove_legacy_catalogs(settings: AppSettings, previous: AppSettings | None = None):
    removed = {}
    for provider in settings.llm_providers.values():
        if not provider.last_fetched_at and is_legacy_seed(provider.provider_id, provider.available_models):
            removed[provider.provider_id] = provider.available_models
            provider.available_models = []
    for _, binding in settings.feature_routing:
        if binding.model_id in removed.get(binding.provider_id, []):
            binding.model_id = ""
    for provider in settings.asr_providers.values():
        if is_legacy_seed(provider.provider_id, provider.available_models):
            stored = previous.asr_providers.get(provider.provider_id) if previous else None
            if stored and same_asr_connection(stored, provider) and stored.available_models == provider.available_models:
                continue
            if provider.selected_model_id == provider.available_models[0]:
                provider.selected_model_id = ""
            provider.available_models = []


def llm_preset(preset) -> LLMProvider:
    key, name, protocol, endpoint = preset
    return LLMProvider(
        provider_id=key, name=name, protocol=protocol, base_url=endpoint,
        api_key="", available_models=[],
    )


def migrate_remove_opencode_defaults(settings: AppSettings):
    """移除旧版默认内置的 opencode-free-bridge 模型源；若用户未自行配置模型，自动将可开关 AI 功能置为关闭。"""
    settings.llm_providers.pop(OPENCODE_FREE_PROVIDER_ID, None)
    configured_id = next(
        (
            pid
            for pid, cfg in settings.llm_providers.items()
            if cfg.api_key.strip() or (cfg.is_custom and cfg.base_url.strip())
        ),
        None,
    )
    fallback_id = configured_id or (
        DEFAULT_LLM_PROVIDER_ID
        if DEFAULT_LLM_PROVIDER_ID in settings.llm_providers
        else next(iter(settings.llm_providers), DEFAULT_LLM_PROVIDER_ID)
    )
    if (
        settings.selected_llm_provider_id == OPENCODE_FREE_PROVIDER_ID
        or settings.selected_llm_provider_id not in settings.llm_providers
    ):
        settings.selected_llm_provider_id = fallback_id

    for feature in LEGACY_DEFAULT_LLM_ROUTING:
        binding = settings.feature_routing.binding(feature)
        if (
            binding.provider_id == OPENCODE_FREE_PROVIDER_ID
            or binding.provider_id not in settings.llm_providers
        ):
            binding.provider_id = fallback_id
            binding.model_id = ""
            if feature != "chat":
                binding.enabled = False


def default_settings() -> AppSettings:
    llm = {preset[0]: llm_preset(preset).wire() for preset in LLM_PRESETS}
    llm["custom"]["isCustom"] = True

    asr = {}
    for key, name, protocol, endpoint in ASR_PRESETS:
        asr[key] = dict(
            providerId=key, name=name, protocol=protocol, baseUrl=endpoint,
            apiKey="", availableModels=[], selectedModelId="",
        )
    for provider_id in ("volcengine-asr", "iflytek-asr", "tencent-asr"):
        asr[provider_id]["appId"] = ""
    asr["custom-asr"]["isCustom"] = True

    return AppSettings.model_validate({
        "selectedLlmProviderId": DEFAULT_LLM_PROVIDER_ID,
        "llmProviders": llm,
        "featureRouting": {
            feature: dict(
                enabled=(feature == "chat"),
                providerId=DEFAULT_LLM_PROVIDER_ID,
                modelId="",
            )
            for feature in LEGACY_DEFAULT_LLM_ROUTING
        },
        "selectedAsrProviderId": "builtin-free-asr",
        "asrProviders": asr,
        "enableSpeakerDiarization": True,
        "expectedSpeakerMode": "auto",
        "recognitionLanguage": "zh-en",
        "audioInputSource": "mixed",
        "audioDeviceId": "default",
        "systemAudioDeviceId": "default",
        "micEnabled": True,
        "systemAudioEnabled": True,
        "enableWebrtcAec3": False,
        "aec3PromptDismissed": False,
        "enableDualChannelSpeakerSplit": True,
        "globalHotwords": [],
        "desktopHotkeys": DesktopHotkeys().wire(),
        "enableVadAutoPause": True,
        "autoSaveSession": True,
        "defaultExportFormat": "markdown",
    })


class SettingsStore:
    prefix = "aesgcm:v1:"
    context = b"zhiling-classroom/app_settings/v1"

    def __init__(self, db: Database, data_dir: Path):
        self.db = db
        self.cipher = AESGCM(self._load_key(data_dir))

    @staticmethod
    def _load_key(data_dir: Path) -> bytes:
        override = os.getenv("ZHILING_SETTINGS_KEY")
        if override:
            try:
                key = base64.b64decode(override, altchars=b"-_", validate=True)
                if len(key) != 32:
                    raise ValueError
                return key
            except (ValueError, binascii.Error):
                raise RuntimeError("ZHILING_SETTINGS_KEY 必须是 32 字节密钥的 Base64 编码") from None
        path = data_dir / "settings.key"
        if not path.exists():
            with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as file:
                file.write(AESGCM.generate_key(bit_length=256))
        key = path.read_bytes()
        if len(key) != 32:
            raise RuntimeError("设置加密密钥文件损坏")
        return key

    def encode(self, settings: AppSettings) -> str:
        plain = settings.model_dump_json(by_alias=True, exclude_unset=True).encode("utf-8")
        nonce = os.urandom(12)
        encrypted = self.cipher.encrypt(nonce, plain, self.context)
        return self.prefix + base64.urlsafe_b64encode(nonce + encrypted).decode("ascii")

    def decode(self, stored: str) -> AppSettings:
        if not stored.startswith(self.prefix):
            raw_bytes = stored.encode("utf-8")
        else:
            blob = base64.urlsafe_b64decode(stored[len(self.prefix):])
            raw_bytes = self.cipher.decrypt(blob[:12], blob[12:], self.context)
        payload = json.loads(raw_bytes)
        if isinstance(payload, dict):
            asr_map = payload.get("asrProviders")
            if isinstance(asr_map, dict):
                asr_map.pop("local-sensevoice", None)
                if "builtin-free-asr" not in asr_map:
                    asr_map["builtin-free-asr"] = {
                        "providerId": "builtin-free-asr",
                        "name": "本地离线语音（SenseVoice）",
                        "protocol": "builtin-free-asr",
                        "baseUrl": "local://sensevoice",
                        "apiKey": "",
                        "availableModels": [],
                        "selectedModelId": "",
                    }
                elif isinstance(asr_map["builtin-free-asr"], dict):
                    entry = asr_map["builtin-free-asr"]
                    if entry.get("name") in ("", None, "默认免登录语音"):
                        entry["name"] = "本地离线语音（SenseVoice）"
                    if entry.get("baseUrl") in ("", None, "builtin://default"):
                        entry["baseUrl"] = "local://sensevoice"
                cur_sel = payload.get("selectedAsrProviderId")
                cur_cfg = asr_map.get(cur_sel) if isinstance(cur_sel, str) else None
                if cur_sel == "local-sensevoice" or (
                    cur_sel == "aliyun-asr"
                    and isinstance(cur_cfg, dict)
                    and not (cur_cfg.get("apiKey") or "").strip()
                ):
                    payload["selectedAsrProviderId"] = "builtin-free-asr"
            source = payload.get("audioInputSource", "mixed")
            payload.setdefault("systemAudioDeviceId", "default")
            payload.setdefault("micEnabled", source != "system-only")
            payload.setdefault("systemAudioEnabled", source != "mic-only")
            payload.setdefault("enableWebrtcAec3", False)
            payload.setdefault("aec3PromptDismissed", False)
            payload.setdefault("enableDualChannelSpeakerSplit", True)
            payload.setdefault("globalHotwords", [])
            default_hk = DesktopHotkeys().model_dump(mode="json", by_alias=True)
            hotkeys = payload.get("desktopHotkeys")
            if not isinstance(hotkeys, dict):
                hotkeys = {}
            payload["desktopHotkeys"] = {
                "enabled": bool(hotkeys.get("enabled", True)),
                "toggleRecording": hotkeys.get("toggleRecording", default_hk["toggleRecording"]),
                "toggleMicMute": hotkeys.get("toggleMicMute", default_hk["toggleMicMute"]),
                "captureScreenshot": hotkeys.get("captureScreenshot", default_hk["captureScreenshot"]),
                "bookmarkConfused": hotkeys.get("bookmarkConfused", default_hk["bookmarkConfused"]),
                "toggleMiniOverlay": hotkeys.get("toggleMiniOverlay", default_hk["toggleMiniOverlay"]),
            }
        settings = AppSettings.model_validate(payload)
        migrate_remove_opencode_defaults(settings)
        return settings

    async def initialize(self):
        async with self.db.write() as session:
            row = await session.get(SettingsRow, 1)
            schema_version = await session.scalar(text("PRAGMA user_version"))
            if row is None:
                session.add(SettingsRow(id=1, settings_json=self.encode(default_settings())))
            else:
                settings = self.decode(row.settings_json)
                if schema_version == 0:
                    remove_legacy_catalogs(settings)
                if schema_version < 3 or not row.settings_json.startswith(self.prefix):
                    row.settings_json = self.encode(settings)
            if schema_version < 3:
                await session.execute(text("PRAGMA user_version = 3"))

    async def get(self) -> AppSettings:
        async with self.db.sessions() as session:
            row = await session.get(SettingsRow, 1)
            return self.decode(row.settings_json)

    async def put(self, settings: AppSettings) -> AppSettings:
        async with self.db.write() as session:
            row = await session.get(SettingsRow, 1)
            previous = self.decode(row.settings_json)
            migrate_remove_opencode_defaults(settings)
            remove_legacy_catalogs(settings, previous)
            row.settings_json = self.encode(settings)
        return settings

    async def save_opencode_catalog(self, models: list[str]):
        async with self.db.write() as session:
            row = await session.get(SettingsRow, 1)
            settings = self.decode(row.settings_json)
            provider = settings.llm_providers.get(OPENCODE_FREE_PROVIDER_ID)
            if provider is None:
                return
            provider.available_models = models
            provider.last_fetched_at = iso_utc(datetime.now(UTC))
            for _, binding in settings.feature_routing:
                if binding.provider_id == OPENCODE_FREE_PROVIDER_ID and binding.model_id not in models:
                    binding.model_id = ""
            row.settings_json = self.encode(settings)

    async def save_asr_catalog(self, config: ASRModelsRequest, models: list[str]):
        # The ASR settings contract has no fetched-at field. Record successful replies so a
        # stale settings PUT can be distinguished from a genuine catalog with the same IDs.
        async with self.db.write() as session:
            row = await session.get(SettingsRow, 1)
            settings = self.decode(row.settings_json)
            provider = settings.asr_providers.get(config.provider_id)
            if provider and same_asr_connection(provider, config) and provider.available_models != models:
                provider.available_models = models
                row.settings_json = self.encode(settings)
