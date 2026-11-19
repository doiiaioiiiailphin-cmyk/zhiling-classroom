import asyncio
from urllib.parse import quote, urlsplit, urlunsplit

import httpx

from ...errors import AppError
from ...schemas import ASRModelsRequest, ASRProvider, AppSettings
from ..http import UpstreamRejected, change_scheme, endpoint, invalid_response, request_json, require_key, route
from ..llm import unique_ids
from .base import ASRStreamAdapter, Recognition, asr_error
from .builtin_shell import BuiltinFreeAsrAdapter
from .china import IFlytek, Tencent, Volcengine
from .openai import DIARIZE_MODEL, OpenAIDiarized, OpenAIRealtime, is_transcription_model
from .streaming import AssemblyAI, CustomASR, DashScope, Deepgram, ElevenLabs

STREAMING_PROBE_CANDIDATES: dict[str, tuple[str, ...]] = {
    "iflytek-rtasr": ("rtasr-role-v1", "rtasr-standard-v1"),
    "volcengine-asr": (
        "volc.seedasr.sauc.duration",
        "volc.seedasr.sauc.concurrent",
        "volc.bigasr.sauc.duration",
        "volc.bigasr.sauc.concurrent",
    ),
    "tencent-asr": ("16k_zh_en", "16k_zh", "16k_zh_large", "16k_en"),
    "assemblyai": ("whisper-rt", "u3-rt-pro"),
    "elevenlabs-scribe": ("scribe_v3_live", "scribe_v2_realtime"),
    "aliyun-tingwu": ("paraformer-realtime-v2", "gummy-realtime-v1", "fun-asr-realtime"),
}

def recognition_options(settings: AppSettings, hotwords: list[str] | tuple[str, ...] = ()) -> Recognition:
    return Recognition(
        settings.recognition_language, settings.enable_speaker_diarization,
        settings.expected_speaker_mode, settings.enable_vad_auto_pause,
        tuple(hotwords),
    )


def base_before(url: str, suffixes: tuple[str, ...]) -> str:
    parsed = urlsplit(url)
    path = parsed.path.rstrip("/")
    for suffix in suffixes:
        if path.endswith(suffix):
            path = path[:-len(suffix)]
            break
    return urlunsplit(parsed._replace(path=path))


def dashscope_model(model: str) -> bool:
    return model.startswith(("paraformer-realtime", "gummy-realtime", "fun-asr-realtime")) and "-8k" not in model


def unsupported_model() -> AppError:
    return AppError(400, "ASR_UNSUPPORTED_MODEL", "当前模型没有可用的实时转写协议，请重新拉取模型并选择")


def build_adapter(
    client: httpx.AsyncClient,
    config: ASRProvider,
    options: Recognition,
) -> ASRStreamAdapter:
    protocol = config.protocol
    if protocol == "builtin-free-asr":
        return BuiltinFreeAsrAdapter(options)

    key = require_key(config.api_key, optional=protocol == "custom-asr")
    model = config.selected_model_id.strip()
    if not model and protocol != "iflytek-rtasr":
        raise AppError(400, "ASR_MODEL_REQUIRED", "请在设置中选择语音转写模型")
    schemes = {"http", "https", "ws", "wss"} if protocol in {"openai-audio", "elevenlabs-scribe"} else {"ws", "wss"}
    url = endpoint(config.base_url, schemes)
    app_id = config.app_id.strip() if config.app_id else None

    match protocol:
        case "openai-audio":
            if not is_transcription_model(model):
                raise unsupported_model()
            base = base_before(url, ("/realtime", "/audio/transcriptions"))
            if model == DIARIZE_MODEL:
                return OpenAIDiarized(client, change_scheme(base, websocket=False), key, options)
            return OpenAIRealtime(base, key, model, options)
        case "aliyun-tingwu":
            if not dashscope_model(model):
                raise unsupported_model()
            return DashScope(url, key, model, options)
        case "deepgram":
            if model.startswith("flux"):
                raise unsupported_model()
            return Deepgram(url, key, model, options)
        case "volcengine-asr":
            return Volcengine(url, key, require_key(app_id) if app_id else None, model, options)
        case "iflytek-rtasr" | "tencent-asr":
            if not app_id:
                raise AppError(400, "ASR_APP_ID_REQUIRED", "请在语音供应商设置中填写 App ID")
            if protocol == "iflytek-rtasr":
                return IFlytek(url, key, require_key(app_id), model, options)
            return Tencent(url, key, require_key(app_id), model, options)
        case "assemblyai":
            if model == "universal-streaming-diarize":
                model = "u3-rt-pro" if options.language == "en" else "whisper-rt"
            return AssemblyAI(url, key, model, options)
        case "elevenlabs-scribe":
            model = {"scribe_v1": "scribe_v3_live", "scribe_v1_experimental": "scribe_v2_realtime"}.get(model, model)
            return ElevenLabs(change_scheme(url, websocket=True), key, model, options)
        case "custom-asr":
            return CustomASR(url, key, model, app_id, options)
    raise unsupported_model()


async def probe_realtime_models(
    client: httpx.AsyncClient, config: ASRModelsRequest, *, selected_model: str = "",
) -> list[str]:
    candidates = unique_ids([selected_model, *STREAMING_PROBE_CANDIDATES.get(config.protocol, ())])
    if not candidates:
        raise unsupported_model()

    async def probe_single(model_id: str) -> str:
        provider = ASRProvider(
            **config.model_dump(exclude_unset=True),
            name="ASR", available_models=[], selected_model_id=model_id,
        )
        diarize = config.protocol == "iflytek-rtasr" and model_id != "rtasr-standard-v1"
        adapter = build_adapter(client, provider, Recognition("auto", diarize, "auto", True))
        try:
            await adapter.start()
        finally:
            await adapter.close()
        return model_id

    outcomes = await asyncio.gather(*(probe_single(model_id) for model_id in candidates), return_exceptions=True)
    accepted = [item for item in outcomes if isinstance(item, str)]
    if accepted:
        return accepted
    for item in outcomes:
        if isinstance(item, AppError) and item.status in (400, 401):
            raise item
    for item in outcomes:
        if isinstance(item, AppError):
            raise item
    for item in outcomes:
        if isinstance(item, BaseException):
            raise item
    raise unsupported_model()


async def list_asr_models(
    client: httpx.AsyncClient, config: ASRModelsRequest, *, selected_model: str = "",
) -> list[str]:
    protocol = config.protocol
    if protocol == "builtin-free-asr":
        return ["default"]
    key = require_key(config.api_key, optional=protocol == "custom-asr")
    base = endpoint(config.base_url, {"http", "https", "wss", "ws"})
    http_base = change_scheme(base, websocket=False)
    bearer = {"Authorization": f"Bearer {key}"} if key else {}
    try:
        match protocol:
            case "openai-audio":
                root = base_before(http_base, ("/realtime", "/audio/transcriptions"))
                result = await request_json(client, "GET", route(root, "models"), headers=bearer)
                return unique_ids(row["id"] for row in result["data"] if is_transcription_model(row["id"]))
            case "aliyun-tingwu":
                root = base_before(http_base, ("/api-ws/v1/inference",))
                try:
                    catalog = route(root, "api/v1/models")
                    models = []
                    for page in range(1, 31):
                        body = await request_json(client, "GET", catalog, headers=bearer, params={
                            "capabilities": ["Realtime-ASR", "Realtime-Audio-Translate"],
                            "page_no": page, "page_size": 50,
                        })
                        if body.get("success") is False:
                            raise asr_error(body.get("code"), body.get("message"))
                        output = body["output"]
                        rows = output["models"]
                        models.extend(row["model"] for row in rows if dashscope_model(row["model"]))
                        if not rows or page * output.get("page_size", 50) >= output["total"]:
                            return unique_ids(models)
                    raise invalid_response()
                except UpstreamRejected as error:
                    if error.upstream_status not in (404, 405):
                        raise
                    return await probe_realtime_models(client, config, selected_model=selected_model)
            case "deepgram":
                root = base_before(http_base, ("/listen",))
                headers = {"Authorization": f"Token {key}"}
                path = "models" if not config.app_id else f"projects/{quote(config.app_id, safe='')}/models"
                result = await request_json(client, "GET", route(root, path, "v1"), headers=headers)
                return unique_ids(
                    name for row in result["stt"] if row.get("streaming")
                    if isinstance(name := row.get("canonical_name") or row.get("name"), str)
                    and not name.startswith("flux")
                )
            case "iflytek-rtasr" | "volcengine-asr" | "tencent-asr" | "assemblyai":
                return await probe_realtime_models(client, config, selected_model=selected_model)
            case "elevenlabs-scribe":
                root = base_before(http_base, ("/speech-to-text/realtime",))
                try:
                    rows = await request_json(
                        client, "GET", route(root, "models", "v1"), headers={"xi-api-key": key},
                    )
                except UpstreamRejected as error:
                    if error.upstream_status not in (404, 405):
                        raise
                else:
                    if not isinstance(rows, list):
                        raise invalid_response()
                    models = unique_ids(
                        model for row in rows
                        if isinstance(model := row.get("model_id"), str)
                        and model.startswith("scribe_") and model.endswith(("_live", "_realtime"))
                    )
                    if models:
                        return models
                return await probe_realtime_models(client, config, selected_model=selected_model)
            case "custom-asr":
                root = base_before(http_base, ("/stream", "/ws", "/realtime"))
                result = await request_json(client, "GET", route(root, "models"), headers=bearer)
                rows = result["data"] if isinstance(result, dict) else result
                return unique_ids(row["id"] if isinstance(row, dict) else row for row in rows)
    except (KeyError, TypeError, AttributeError):
        raise invalid_response() from None
    raise unsupported_model()
