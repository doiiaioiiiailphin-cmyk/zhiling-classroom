from datetime import UTC, datetime
from typing import Annotated, Generic, Literal, TypeVar

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator
from pydantic.alias_generators import to_camel, to_snake

ApiProtocol = Literal["openai", "anthropic", "gemini", "openai-compatible"]
AsrProtocol = Literal[
    "builtin-free-asr",
    "openai-audio", "aliyun-tingwu", "volcengine-asr", "iflytek-rtasr", "tencent-asr",
    "deepgram", "assemblyai", "elevenlabs-scribe", "custom-asr",
]
Feature = Literal["chat", "sentenceCorrection", "resegmentation", "keyTermHighlight", "bubbleExplanation"]
ThinkingLevel = Literal["none", "low", "medium", "max"]
SessionStatus = Literal["idle", "recording", "paused"]
Language = Literal["zh-en", "zh", "en", "auto"]
SpeakerMode = Literal["auto", "dual", "multi"]
Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=255)]
Label = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
Id = Annotated[str, StringConstraints(min_length=1, max_length=64)]
ModelId = Annotated[str, StringConstraints(max_length=400)]
Text = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=16000)]
CleanedText = Annotated[str, StringConstraints(strip_whitespace=True, max_length=16000)]
Secret = Annotated[str, StringConstraints(max_length=8000)]
BaseUrl = Annotated[str, StringConstraints(max_length=2048)]
T = TypeVar("T")


class WireModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid", strict=True)

    def wire(self) -> dict:
        return self.model_dump(mode="json", by_alias=True, exclude_unset=True)


class Data(WireModel, Generic[T]):
    data: T


def iso_utc(value: datetime) -> str:
    value = value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)
    return value.isoformat(timespec="milliseconds").replace("+00:00", "Z")


class FolderCreate(WireModel):
    name: Name
    parent_id: Id | None = None
    hotwords: Annotated[list[Label], Field(max_length=200)] | None = None


class FolderRename(WireModel):
    name: Name | None = None
    hotwords: Annotated[list[Label], Field(max_length=200)] | None = None

    @model_validator(mode="after")
    def reject_empty_or_null_updates(self):
        if not self.model_fields_set:
            raise ValueError("请提供需要更新的字段")
        for field in self.model_fields_set:
            if getattr(self, field) is None:
                raise ValueError(f"{to_camel(field)} 不能为空")
        return self


FolderPatch = FolderRename


class FolderItem(WireModel):
    id: Id
    name: str
    parent_id: Id | None
    hotwords: list[str] = Field(default_factory=list)
    created_at: str
    updated_at: str


class SessionCreate(WireModel):
    folder_id: Id | None = None


class SessionPatch(WireModel):
    title: Name | None = None
    folder_id: Id | None = None
    status: SessionStatus | None = None
    duration_seconds: Annotated[int, Field(ge=0, le=2_147_483_647)] | None = None

    @model_validator(mode="after")
    def reject_null_updates(self):
        for field in self.model_fields_set - {"folder_id"}:
            if getattr(self, field) is None:
                raise ValueError(f"{to_camel(field)} 不能为空")
        return self


class SessionCard(WireModel):
    id: Id
    folder_id: Id | None
    title: str
    status: SessionStatus
    duration_seconds: int
    speaker_count: int
    segment_count: int
    created_at: str
    updated_at: str


class SpeakerRename(WireModel):
    label: Label


class SpeakerProfile(WireModel):
    id: Id
    label: str


class UtteranceItem(WireModel):
    id: Id
    speaker_id: Id
    speaker_label: str
    timestamp_text: str
    start_time_ms: int
    end_time_ms: int
    raw_text: str
    refined_text: str
    is_refined: bool
    is_bookmarked: bool = False
    bookmark_kind: Literal["confused", "important"] | None = None
    user_note: str | None = None
    is_manual_edited: bool = False


class UtterancePatch(WireModel):
    refined_text: CleanedText | None = None
    is_bookmarked: bool | None = None
    bookmark_kind: Literal["confused", "important"] | None = None
    user_note: CleanedText | None = None

    @model_validator(mode="after")
    def validate_patch(self):
        if not self.model_fields_set:
            raise ValueError("请提供需要更新的字段")
        return self


class BookmarkNowRequest(WireModel):
    kind: Literal["confused", "important"] = "confused"
    note: CleanedText | None = None
    timestamp_ms: Annotated[int, Field(ge=0, le=2_147_483_647)] | None = None


class Correction(WireModel):
    refined_text: CleanedText


class BatchCorrectionItem(WireModel):
    utterance_id: Id
    refined_text: CleanedText


class BatchCorrection(WireModel):
    items: Annotated[list[BatchCorrectionItem], Field(min_length=1, max_length=16)]


class Regrouping(WireModel):
    action: Literal["append_to_last", "create_new_segment"]
    updated_topic_title: Name


class BatchRegroupDecision(WireModel):
    utterance_id: Id
    action: Literal["append_to_last", "create_new_segment"]
    updated_topic_title: Name


class BatchRegrouping(WireModel):
    decisions: Annotated[list[BatchRegroupDecision], Field(min_length=1, max_length=16)]


class Term(WireModel):
    term: Annotated[str, StringConstraints(min_length=1, max_length=128)]
    explanation: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]


class ExtractedTerms(WireModel):
    highlights: Annotated[list[Term], Field(max_length=32)]


class Highlight(WireModel):
    id: Id
    term: str
    explanation: str


class SegmentExplanation(WireModel):
    title: str
    core_points: list[str]
    elaboration: str
    thinking: str | None = None


class GeneratedExplanation(SegmentExplanation):
    title: Name
    core_points: Annotated[list[Name], Field(min_length=1, max_length=12)]
    elaboration: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=4000)]


class KnowledgeSegment(WireModel):
    id: Id
    session_id: Id
    order_index: int
    topic_title: str
    utterances: list[UtteranceItem]
    highlights: list[Highlight]
    detailed_explanation: SegmentExplanation | None = None


class SessionAttachmentItem(WireModel):
    id: Id
    session_id: Id
    segment_id: Id | None = None
    kind: Literal["screenshot", "image", "material"]
    file_name: str
    mime_type: str
    size_bytes: int
    width: int | None = None
    height: int | None = None
    timestamp_ms: int | None = None
    timestamp_text: str | None = None
    caption: str | None = None
    extracted_preview: str | None = None
    url: str
    created_at: str


class CaptureScreenRequest(WireModel):
    timestamp_ms: Annotated[int, Field(ge=0, le=2_147_483_647)] | None = None
    segment_id: Id | None = None
    caption: CleanedText | None = None


class SessionStudyNote(WireModel):
    content_markdown: str
    thinking: str | None = None
    updated_at: str


class FlashcardItem(WireModel):
    id: str
    front: str
    back: str
    tag: str = ""


class GeneratedFlashcard(WireModel):
    front: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=600)]
    back: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2000)]
    tag: Annotated[str, StringConstraints(strip_whitespace=True, max_length=120)] = ""


class GeneratedFlashcards(WireModel):
    cards: Annotated[list[GeneratedFlashcard], Field(min_length=1, max_length=12)]


class SessionExportRequest(WireModel):
    format: Literal["markdown", "docx", "txt", "anki"]
    include_study_note: bool = True
    include_highlights: bool = True
    include_chat: bool = True
    include_transcript: bool = True


class SearchHitItem(WireModel):
    session_id: Id
    session_title: str
    folder_id: Id | None = None
    kind: Literal["title", "topic", "utterance", "highlight", "note", "chat"]
    segment_id: Id | None = None
    utterance_id: Id | None = None
    timestamp_ms: int | None = None
    timestamp_text: str | None = None
    snippet: str
    updated_at: str


class ChatRequest(WireModel):
    content: Text
    attachment_ids: Annotated[list[Id], Field(max_length=6)] = Field(default_factory=list)


class ChatMessage(WireModel):
    id: Id
    session_id: Id
    role: Literal["user", "assistant"]
    content: str
    thinking: str | None = None
    referenced_segment_count: int | None = None
    attachments: list[SessionAttachmentItem] = Field(default_factory=list)
    created_at: str


class Workspace(WireModel):
    session: SessionCard
    speakers: list[SpeakerProfile]
    segments: list[KnowledgeSegment]
    messages: list[ChatMessage]
    study_note: SessionStudyNote | None = None
    flashcards: list[FlashcardItem] = Field(default_factory=list)
    attachments: list[SessionAttachmentItem] = Field(default_factory=list)
    has_audio: bool = False
    audio_duration_ms: int = 0


class LLMModelsRequest(WireModel):
    provider_id: Id
    protocol: ApiProtocol
    base_url: BaseUrl
    api_key: Secret


class ASRModelsRequest(WireModel):
    provider_id: Id
    protocol: AsrProtocol
    base_url: BaseUrl
    api_key: Secret
    app_id: Secret | None = None


class LLMProvider(LLMModelsRequest):
    name: Name
    is_custom: bool | None = None
    available_models: list[ModelId]
    last_fetched_at: str | None = None


class ASRProvider(ASRModelsRequest):
    name: Name
    is_custom: bool | None = None
    available_models: list[ModelId]
    selected_model_id: ModelId


class ModelBinding(WireModel):
    enabled: bool
    provider_id: str
    model_id: ModelId


class FeatureRouting(WireModel):
    chat: ModelBinding
    sentence_correction: ModelBinding
    resegmentation: ModelBinding
    key_term_highlight: ModelBinding
    bubble_explanation: ModelBinding

    def binding(self, feature: Feature) -> ModelBinding:
        return getattr(self, to_snake(feature))


def _default_mod_prefix() -> str:
    import sys

    return "Option+Shift" if sys.platform == "darwin" else "Alt+Shift"


class DesktopHotkeys(WireModel):
    enabled: bool = True
    toggle_recording: str = Field(default_factory=lambda: f"{_default_mod_prefix()}+R")
    toggle_mic_mute: str = Field(default_factory=lambda: f"{_default_mod_prefix()}+M")
    capture_screenshot: str = Field(default_factory=lambda: f"{_default_mod_prefix()}+S")
    bookmark_confused: str = Field(default_factory=lambda: f"{_default_mod_prefix()}+B")
    toggle_mini_overlay: str = Field(default_factory=lambda: f"{_default_mod_prefix()}+O")


class AppSettings(WireModel):
    selected_llm_provider_id: str
    llm_providers: dict[str, LLMProvider]
    feature_routing: FeatureRouting
    selected_asr_provider_id: str
    asr_providers: dict[str, ASRProvider]
    enable_speaker_diarization: bool
    expected_speaker_mode: SpeakerMode
    recognition_language: Language
    audio_input_source: Literal["mixed", "mic-only", "system-only"]
    audio_device_id: str
    system_audio_device_id: str = "default"
    mic_enabled: bool = True
    system_audio_enabled: bool = True
    enable_webrtc_aec3: bool = False
    aec3_prompt_dismissed: bool = False
    enable_dual_channel_speaker_split: bool = True
    global_hotwords: Annotated[list[Label], Field(max_length=200)] = Field(default_factory=list)
    desktop_hotkeys: DesktopHotkeys = Field(default_factory=DesktopHotkeys)
    enable_vad_auto_pause: bool
    auto_save_session: bool
    default_export_format: Literal["markdown", "docx", "txt"]


class Aec3AddonStatus(WireModel):
    installed: bool
    version: str
    size_bytes: int


class UpdateAssetInfo(WireModel):
    name: str
    size_bytes: int = 0
    sha256: str = ""
    download_url: str


class UpdateCheckResult(WireModel):
    current_version: str
    latest_version: str
    has_update: bool
    release_title: str = ""
    release_notes: str = ""
    release_url: str = ""
    published_at: str = ""
    platform: str
    arch: str
    repo: str = ""
    can_auto_apply: bool = False
    staged_ready: bool = False
    asset: UpdateAssetInfo | None = None
    checked_at: str = ""


class UpdateApplyResult(WireModel):
    scheduled: bool
    mode: Literal["auto-replace", "dev-manual"]
    version: str
    download_path: str
    message: str


class NativeAudioEndpoint(WireModel):
    id: str
    raw_id: str
    name: str
    is_default: bool
    is_communications_default: bool


class NativeAudioDevices(WireModel):
    platform: str
    wasapi_supported: bool
    inputs: list[NativeAudioEndpoint]
    loopbacks: list[NativeAudioEndpoint]


class StreamFormat(WireModel):
    sample_rate: Literal[16000]
    channels: Literal[1]
    encoding: Literal["pcm_s16le", "opus_webm"]


class RecordingStart(WireModel):
    type: Literal["recording.start"]
    payload: StreamFormat


class ChannelActivityPayload(WireModel):
    mic_rms: Annotated[float, Field(ge=0.0, le=10.0)]
    sys_rms: Annotated[float, Field(ge=0.0, le=10.0)]
    dual_active: bool = False


class ChannelActivityCommand(WireModel):
    type: Literal["channel.activity"]
    payload: ChannelActivityPayload


class RecordingControl(WireModel):
    type: Literal["recording.pause", "recording.resume", "recording.stop"]


class PartialEvent(WireModel):
    speaker_id: Id
    speaker_label: str
    text: str


class FinalEvent(WireModel):
    segment_id: Id
    utterance: UtteranceItem


class CorrectedEvent(WireModel):
    segment_id: Id
    utterance_id: Id
    refined_text: str


class HighlightsEvent(WireModel):
    segment_id: Id
    highlights: list[Highlight]
