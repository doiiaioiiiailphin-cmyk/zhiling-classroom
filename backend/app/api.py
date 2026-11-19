from collections.abc import AsyncIterator
import json
import logging
from typing import Annotated, Literal

from fastapi import APIRouter, Body, Depends, Request, Response, WebSocket
from fastapi.responses import StreamingResponse
from pydantic import StrictBool

from .errors import AppError
from .providers.asr import list_asr_models
from .providers.llm import llm_adapter
from .repository import Repository
from .schemas import (
    ASRModelsRequest, Aec3AddonStatus, AppSettings, BookmarkNowRequest, CaptureScreenRequest, ChatMessage, ChatRequest,
    Data, FlashcardItem, FolderCreate, FolderItem, FolderRename, LLMModelsRequest,
    NativeAudioDevices, SearchHitItem, SegmentExplanation, SessionAttachmentItem, SessionCard, SessionCreate,
    SessionExportRequest, SessionPatch, SpeakerRename, UtteranceItem, UtterancePatch, Workspace,
)
from .services.exporter import export_session_document
from .settings import same_asr_connection

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1")
ws_router = APIRouter(prefix="/ws/v1")

SSE_HEADERS = {
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
}


def repository(request: Request) -> Repository:
    return request.app.state.repo


Repo = Annotated[Repository, Depends(repository)]


async def sse_encode(events: AsyncIterator[dict]) -> AsyncIterator[bytes]:
    try:
        async for item in events:
            payload = json.dumps(item, ensure_ascii=False, separators=(",", ":"))
            yield f"data: {payload}\n\n".encode("utf-8")
    except AppError as error:
        payload = json.dumps({"type": "error", "error": error.payload()}, ensure_ascii=False, separators=(",", ":"))
        yield f"data: {payload}\n\n".encode("utf-8")
    except Exception as error:
        logger.error("Unexpected SSE failure (%s)", type(error).__name__)
        fallback = {"type": "error", "error": {"code": "INTERNAL_ERROR", "message": "流式生成处理失败"}}
        yield f"data: {json.dumps(fallback, ensure_ascii=False, separators=(',', ':'))}\n\n".encode("utf-8")


@router.get("/folders", response_model_exclude_unset=True)
async def folders(repo: Repo) -> Data[list[FolderItem]]:
    return Data(data=await repo.list_folders())


@router.post("/folders", status_code=201, response_model_exclude_unset=True)
async def create_folder(body: FolderCreate, repo: Repo) -> Data[FolderItem]:
    return Data(data=await repo.create_folder(body.name, body.parent_id, body.hotwords))


@router.patch("/folders/{id}", response_model_exclude_unset=True)
async def rename_folder(id: str, body: FolderRename, repo: Repo) -> Data[FolderItem]:
    return Data(data=await repo.rename_folder(id, body.name, hotwords=body.hotwords))


@router.delete("/folders/{id}", status_code=204)
async def delete_folder(id: str, repo: Repo) -> Response:
    await repo.delete_folder(id)
    return Response(status_code=204)


@router.get("/sessions")
async def sessions(repo: Repo) -> Data[list[SessionCard]]:
    return Data(data=await repo.list_sessions())


@router.post("/sessions", status_code=201, response_model_exclude_unset=True)
async def create_session(body: SessionCreate, repo: Repo) -> Data[Workspace]:
    return Data(data=await repo.create_session(body.folder_id))


@router.patch("/sessions/{id}")
async def patch_session(id: str, body: SessionPatch, repo: Repo) -> Data[SessionCard]:
    return Data(data=await repo.patch_session(id, body))


@router.delete("/sessions/{id}", status_code=204)
async def delete_session(id: str, request: Request) -> Response:
    await request.app.state.streams.delete_session(id)
    return Response(status_code=204)


@router.get("/sessions/{id}/workspace", response_model_exclude_unset=True)
async def workspace(id: str, request: Request, repo: Repo) -> Data[Workspace]:
    audio_ms = request.app.state.audio.existing_duration_ms(id)
    return Data(data=await repo.workspace(id, audio_duration_ms=audio_ms))


@router.patch("/sessions/{sessionId}/speakers/{speakerId}", status_code=204)
async def rename_speaker(sessionId: str, speakerId: str, body: SpeakerRename, repo: Repo) -> Response:
    await repo.rename_speaker(sessionId, speakerId, body.label)
    return Response(status_code=204)


@router.post("/sessions/{sessionId}/segments/{segmentId}/explain", response_model_exclude_unset=True)
async def explain(sessionId: str, segmentId: str, request: Request) -> Data[SegmentExplanation]:
    return Data(data=await request.app.state.ai.explain(sessionId, segmentId))


@router.post("/sessions/{sessionId}/segments/{segmentId}/explain/stream")
async def explain_stream(sessionId: str, segmentId: str, request: Request) -> StreamingResponse:
    events = await request.app.state.ai.explain_stream(sessionId, segmentId)
    return StreamingResponse(sse_encode(events), media_type="text/event-stream", headers=SSE_HEADERS)


@router.post("/sessions/{sessionId}/chat", response_model_exclude_unset=True)
async def chat(sessionId: str, body: ChatRequest, request: Request) -> Data[ChatMessage]:
    return Data(data=await request.app.state.ai.chat(sessionId, body.content, body.attachment_ids))


@router.post("/sessions/{sessionId}/chat/stream")
async def chat_stream(sessionId: str, body: ChatRequest, request: Request) -> StreamingResponse:
    events = await request.app.state.ai.chat_stream(sessionId, body.content, body.attachment_ids)
    return StreamingResponse(sse_encode(events), media_type="text/event-stream", headers=SSE_HEADERS)


@router.post("/sessions/{sessionId}/notes/stream")
async def notes_stream(sessionId: str, request: Request) -> StreamingResponse:
    events = await request.app.state.ai.notes_stream(sessionId)
    return StreamingResponse(sse_encode(events), media_type="text/event-stream", headers=SSE_HEADERS)


@router.post("/sessions/{sessionId}/flashcards", response_model_exclude_unset=True)
async def session_flashcards(sessionId: str, request: Request) -> Data[list[FlashcardItem]]:
    return Data(data=await request.app.state.ai.generate_flashcards(sessionId))


@router.post("/sessions/{sessionId}/export")
async def export_session(sessionId: str, body: SessionExportRequest, request: Request, repo: Repo) -> Response:
    audio_ms = request.app.state.audio.existing_duration_ms(sessionId)
    ws = await repo.workspace(sessionId, audio_duration_ms=audio_ms)
    raw, mime, headers = export_session_document(ws, body)
    return Response(content=raw, media_type=mime, headers=headers)


@router.get("/sessions/{sessionId}/audio")
async def get_session_audio(sessionId: str, request: Request, repo: Repo) -> Response:
    await repo.stream_state(sessionId)
    range_hdr = request.headers.get("range")
    body, status, headers = request.app.state.audio.read_wav_slice(sessionId, range_hdr)
    return Response(content=body, status_code=status, media_type="audio/wav", headers=headers)


@router.post("/sessions/{sessionId}/retranscribe-gap")
async def retranscribe_gap(sessionId: str, request: Request) -> Data[dict]:
    return Data(data=await request.app.state.streams.retranscribe_gap(sessionId))


@router.post("/sessions/import-audio")
async def import_audio(
    request: Request,
    fileName: str = "recording.wav",
    title: str | None = None,
    folderId: str | None = None,
) -> StreamingResponse:
    raw = await request.body()
    if len(raw) > 260 * 1024 * 1024:
        raise AppError(400, "AUDIO_FILE_TOO_LARGE", "单次导入音频文件不能超过 260 MB")
    events = await request.app.state.streams.import_audio_stream(
        folder_id=folderId or None,
        title=title or None,
        file_name=fileName,
        raw_media=raw,
    )
    return StreamingResponse(sse_encode(events), media_type="text/event-stream", headers=SSE_HEADERS)


@router.patch("/sessions/{sessionId}/utterances/{utteranceId}", response_model_exclude_unset=True)
async def patch_utterance(
    sessionId: str, utteranceId: str, body: UtterancePatch, request: Request, repo: Repo,
) -> Data[UtteranceItem]:
    seg_id, updated, pruned = await repo.patch_utterance(sessionId, utteranceId, body)
    await request.app.state.streams.publish(
        sessionId, "utterance.updated", {"segmentId": seg_id, "utterance": updated.wire()},
    )
    if pruned is not None:
        await request.app.state.streams.publish(
            sessionId, "highlights.updated", {"segmentId": seg_id, "highlights": [h.wire() for h in pruned]},
        )
    return Data(data=updated)


@router.post("/sessions/{sessionId}/bookmarks/now")
async def bookmark_now(
    sessionId: str, body: BookmarkNowRequest, request: Request, repo: Repo,
) -> Data[dict]:
    seg_id, updated, created_seg = await repo.bookmark_now(sessionId, body)
    if created_seg is not None:
        segments = await repo.segments(sessionId)
        await request.app.state.streams.publish(
            sessionId, "segments.regrouped", {"segments": [s.wire() for s in segments]},
        )
        await request.app.state.streams.publish(
            sessionId, "utterance.final", {"segmentId": seg_id, "utterance": updated.wire()},
        )
    else:
        await request.app.state.streams.publish(
            sessionId, "utterance.updated", {"segmentId": seg_id, "utterance": updated.wire()},
        )
    return Data(data={"segmentId": seg_id, "utterance": updated.wire()})


@router.post("/sessions/{sessionId}/attachments", status_code=201, response_model_exclude_unset=True)
async def upload_attachment(
    sessionId: str,
    request: Request,
    fileName: str = "image.png",
    mimeType: str | None = None,
    kind: str | None = None,
    segmentId: str | None = None,
    timestampMs: int | None = None,
    caption: str | None = None,
) -> Data[SessionAttachmentItem]:
    raw = await request.body()
    resolved_mime = mimeType or request.headers.get("content-type") or "application/octet-stream"
    item = await request.app.state.attachments.save_uploaded(
        session_id=sessionId,
        file_name=fileName,
        mime_type=resolved_mime,
        data=raw,
        kind=kind,
        segment_id=segmentId or None,
        timestamp_ms=timestampMs,
        caption=caption,
    )
    await request.app.state.streams.publish(sessionId, "attachment.created", {"attachment": item.wire()})
    return Data(data=item)


@router.post("/sessions/{sessionId}/capture-screen", status_code=201, response_model_exclude_unset=True)
async def capture_screen(
    sessionId: str, body: CaptureScreenRequest, request: Request,
) -> Data[SessionAttachmentItem]:
    item = await request.app.state.attachments.capture_screen(sessionId, body)
    await request.app.state.streams.publish(sessionId, "attachment.created", {"attachment": item.wire()})
    return Data(data=item)


@router.get("/sessions/{sessionId}/attachments/{attachmentId}/raw")
async def get_attachment_raw(sessionId: str, attachmentId: str, request: Request) -> Response:
    data, mime_type, _ = await request.app.state.attachments.read_raw(sessionId, attachmentId)
    return Response(
        content=data,
        media_type=mime_type,
        headers={"Cache-Control": "private, max-age=86400"},
    )


@router.delete("/sessions/{sessionId}/attachments/{attachmentId}", status_code=204)
async def delete_attachment(sessionId: str, attachmentId: str, request: Request) -> Response:
    await request.app.state.attachments.remove(sessionId, attachmentId)
    await request.app.state.streams.publish(sessionId, "attachment.deleted", {"attachmentId": attachmentId})
    return Response(status_code=204)


@router.get("/search", response_model_exclude_unset=True)
async def global_search(
    repo: Repo, q: str = "", folderId: str | None = None,
) -> Data[list[SearchHitItem]]:
    return Data(data=await repo.search_global(q, folder_id=folderId or None))


@router.get("/settings", response_model_exclude_unset=True)
async def get_settings(request: Request, response: Response) -> Data[AppSettings]:
    response.headers["Cache-Control"] = "no-store"
    return Data(data=await request.app.state.settings.get())


@router.put("/settings", response_model_exclude_unset=True)
async def put_settings(body: AppSettings, request: Request, response: Response) -> Data[AppSettings]:
    response.headers["Cache-Control"] = "no-store"
    saved = await request.app.state.settings.put(body)
    request.app.state.desktop.update_hotkeys(saved.desktop_hotkeys)
    return Data(data=saved)


@router.post("/providers/models")
async def provider_models(body: LLMModelsRequest, request: Request) -> Data[list[str]]:
    state = request.app.state
    return Data(data=await llm_adapter(state.http, body, opencode=state.opencode).list_models())


@router.post("/asr-providers/models")
async def asr_models(body: ASRModelsRequest, request: Request) -> Data[list[str]]:
    store = request.app.state.settings
    settings = await store.get()
    provider = settings.asr_providers.get(body.provider_id)
    selected_model = provider.selected_model_id.strip() if provider and same_asr_connection(provider, body) else ""
    models = await list_asr_models(request.app.state.http, body, selected_model=selected_model)
    await store.save_asr_catalog(body, models)
    return Data(data=models)


@router.get("/addons/builtin-free-asr")
async def get_builtin_asr(request: Request, response: Response) -> Data[bool]:
    response.headers["Cache-Control"] = "no-store"
    return Data(data=request.app.state.builtin_asr.ready())


@router.post("/addons/opencode/download", status_code=204)
async def download_opencode(request: Request, confirmed: Annotated[StrictBool, Body(embed=True)]) -> Response:
    await request.app.state.opencode.decide_download(confirmed)
    return Response(status_code=204)


@router.post("/addons/builtin-free-asr/download", status_code=204)
async def download_builtin_asr(
    request: Request, confirmed: Annotated[Literal[True], Body(embed=True)],
) -> Response:
    await request.app.state.builtin_asr.install(request.app.state.http)
    return Response(status_code=204)


@router.get("/addons/webrtc-aec3")
async def get_aec3_addon(request: Request, response: Response) -> Data[Aec3AddonStatus]:
    response.headers["Cache-Control"] = "no-store"
    return Data(data=request.app.state.addons.status())


@router.post("/addons/webrtc-aec3/download")
async def download_aec3_addon(request: Request) -> StreamingResponse:
    events = request.app.state.addons.download_stream(request.app.state.http)
    return StreamingResponse(sse_encode(events), media_type="text/event-stream", headers=SSE_HEADERS)


@router.get("/addons/webrtc-aec3/worklet-lib.js")
async def get_aec3_worklet_js(request: Request) -> Response:
    content = request.app.state.addons.read_worklet_js()
    return Response(
        content=content,
        media_type="application/javascript",
        headers={"Cache-Control": "no-store"},
    )


@router.get("/addons/webrtc-aec3/module.wasm")
async def get_aec3_wasm(request: Request) -> Response:
    content = request.app.state.addons.read_wasm()
    return Response(
        content=content,
        media_type="application/wasm",
        headers={"Cache-Control": "no-store"},
    )


@router.get("/audio/devices")
async def get_audio_devices(request: Request, response: Response) -> Data[NativeAudioDevices]:
    response.headers["Cache-Control"] = "no-store"
    return Data(data=await request.app.state.win_audio.list_devices())


@ws_router.websocket("/audio/loopback")
async def audio_loopback_stream(websocket: WebSocket, deviceId: str = "default"):
    await websocket.app.state.win_audio.serve_loopback(websocket, deviceId)


@ws_router.websocket("/sessions/{sessionId}/stream")
async def classroom_stream(websocket: WebSocket, sessionId: str):
    await websocket.app.state.streams.serve(websocket, sessionId)


@ws_router.websocket("/desktop/events")
async def desktop_events_stream(websocket: WebSocket):
    await websocket.app.state.desktop.serve(websocket)
