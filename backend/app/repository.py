import asyncio
import json
import re
from collections import defaultdict
from datetime import datetime, timedelta
from hashlib import sha256
from pathlib import Path
from uuid import uuid4
from weakref import WeakValueDictionary
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import delete, func, select, tuple_, update
from sqlalchemy.ext.asyncio import AsyncSession

from .db import (
    ClassSession, Database, Folder, Message, Segment, SegmentHighlight,
    SessionAttachment, Speaker, StickyNote, StickyNoteTimestamp, Utterance, now,
)
from .errors import AppError, missing
from .schemas import (
    BookmarkNowRequest, ChatMessage, FinalEvent, FlashcardItem, FolderItem, Highlight,
    KnowledgeSegment, Regrouping, SearchHitItem, SegmentExplanation, SessionAttachmentItem,
    SessionCard, SessionPatch, SessionStatus, SessionStudyNote, SpeakerProfile,
    StickyNoteCreate, StickyNoteItem, StickyNotePatch, StickyNoteTimestampConflict,
    StickyNoteTimestampItem, Term, UtteranceItem, UtterancePatch, Workspace, iso_utc,
)


class Locks:
    def __init__(self):
        self.locks: WeakValueDictionary[str, asyncio.Lock] = WeakValueDictionary()

    def get(self, key: str) -> asyncio.Lock:
        lock = self.locks.get(key)
        if lock is None:
            lock = self.locks[key] = asyncio.Lock()
        return lock


async def require(db: AsyncSession, table, id_: str, label: str):
    row = await db.get(table, id_)
    if row is None:
        raise missing(label)
    return row


def format_ms(ms: int) -> str:
    minutes, seconds = divmod(max(0, ms) // 1000, 60)
    return f"{minutes:02d}:{seconds:02d}"


STICKY_TIMESTAMP_RE = re.compile(r"\[(?:(\d{1,2}):)?(\d{1,3}):(\d{2})\]")


def format_sticky_sec(total_sec: int) -> str:
    safe = max(0, int(total_sec))
    hours, rem = divmod(safe, 3600)
    minutes, seconds = divmod(rem, 60)
    if hours > 0:
        return f"{hours:02d}:{minutes:02d}:{seconds:02d}"
    return f"{minutes:02d}:{seconds:02d}"


def extract_sticky_timestamps(content: str) -> list[tuple[int, str, int]]:
    """Extract valid [MM:SS] or [HH:MM:SS] (seconds last) timestamps as (sec, formatted_text, char_offset)."""
    if not content:
        return []
    matches: list[tuple[int, str, int]] = []
    for match in STICKY_TIMESTAMP_RE.finditer(content):
        hrs_raw, mins_raw, secs_raw = match.group(1), match.group(2), match.group(3)
        hrs = int(hrs_raw) if hrs_raw is not None else 0
        mins = int(mins_raw)
        secs = int(secs_raw)
        if secs >= 60:
            continue
        if hrs_raw is not None and mins >= 60:
            continue
        total_sec = hrs * 3600 + mins * 60 + secs
        matches.append((total_sec, format_sticky_sec(total_sec), match.start()))
    return matches


def sticky_note_display_title(row: StickyNote, fallback_index: int = 1) -> str:
    if row.title and row.title.strip():
        return row.title.strip()
    for line in (row.content or "").splitlines():
        cleaned = line.strip()
        if cleaned:
            return cleaned[:24]
    return f"课堂便签 #{fallback_index}"


def sticky_note_item(
    row: StickyNote,
    timestamps: list[StickyNoteTimestamp],
    conflicts: list[StickyNoteTimestampConflict] | None = None,
) -> StickyNoteItem:
    sorted_ts = sorted(
        timestamps,
        key=lambda t: (
            int(t.char_offset) if t.char_offset is not None else 0,
            int(t.timestamp_sec) if t.timestamp_sec is not None else 0,
            t.id,
        ),
    )
    return StickyNoteItem(
        id=row.id,
        session_id=row.session_id,
        title=row.title or "",
        content=row.content or "",
        paper_color=row.paper_color if row.paper_color in {"cream", "butter", "sage", "blush"} else "cream",
        pos_x=int(row.pos_x) if row.pos_x is not None else 120,
        pos_y=int(row.pos_y) if row.pos_y is not None else 96,
        width=int(row.width) if row.width is not None else 340,
        height=int(row.height) if row.height is not None else 300,
        is_open=bool(row.is_open),
        z_order=int(row.z_order) if row.z_order is not None else 1,
        is_translucent=bool(row.is_translucent),
        timestamps=[
            StickyNoteTimestampItem(
                id=t.id,
                note_id=t.note_id,
                timestamp_sec=int(t.timestamp_sec) if t.timestamp_sec is not None else 0,
                timestamp_text=t.timestamp_text or format_ms(max(0, int(t.timestamp_sec or 0) * 1000)),
                char_offset=int(t.char_offset) if t.char_offset is not None else 0,
                created_at=iso_utc(t.created_at),
            )
            for t in sorted_ts
        ],
        conflicts=conflicts or [],
        created_at=iso_utc(row.created_at),
        updated_at=iso_utc(row.updated_at),
    )


def parse_hotwords(raw_json: str | None) -> list[str]:
    if not raw_json:
        return []
    try:
        parsed = json.loads(raw_json)
        if isinstance(parsed, list):
            return list(dict.fromkeys(str(item).strip() for item in parsed if str(item).strip()))
    except ValueError:
        pass
    return []


def folder_item(row: Folder) -> FolderItem:
    item = FolderItem(
        id=row.id, name=row.name, parent_id=row.parent_id,
        created_at=iso_utc(row.created_at), updated_at=iso_utc(row.updated_at),
    )
    hotwords = parse_hotwords(row.hotwords_json)
    if hotwords:
        item.hotwords = hotwords
    return item


def session_card(row: ClassSession, speakers: int, segments: int) -> SessionCard:
    return SessionCard(
        id=row.id,
        folder_id=row.folder_id,
        title=row.title or "未命名课堂",
        status=row.status if row.status in {"idle", "recording", "paused"} else "idle",
        duration_seconds=max(0, int(row.duration_seconds or 0)),
        speaker_count=speakers,
        segment_count=segments,
        created_at=iso_utc(row.created_at),
        updated_at=iso_utc(row.updated_at),
    )


def speaker_profile(speaker: Speaker) -> SpeakerProfile:
    return SpeakerProfile(id=speaker.id, label=speaker.label)


def speaker_identity(session_id: str, channel: str) -> str:
    return sha256(f"{session_id}:{channel}".encode()).hexdigest()[:32]


def default_speaker_label(channel: str, existing_count: int) -> str:
    if channel == "phys:mic":
        return "我（麦克风）"
    if channel == "phys:sys":
        return "课堂老师（内录）"
    return f"讲话人 {existing_count + 1}"


def utterance_item(row: Utterance, label: str) -> UtteranceItem:
    start_ms = max(0, int(row.start_time_ms or 0))
    end_ms = max(start_ms, int(row.end_time_ms if row.end_time_ms is not None else start_ms))
    raw_text = row.raw_text or ""
    item = UtteranceItem(
        id=row.id,
        speaker_id=row.speaker_id,
        speaker_label=label or "讲话人",
        timestamp_text=format_ms(start_ms),
        start_time_ms=start_ms,
        end_time_ms=end_ms,
        raw_text=raw_text,
        refined_text=row.refined_text if row.refined_text is not None else raw_text,
        is_refined=bool(row.is_refined),
    )
    if row.is_bookmarked:
        item.is_bookmarked = True
        if row.bookmark_kind in ("confused", "important"):
            item.bookmark_kind = row.bookmark_kind
    if row.user_note:
        item.user_note = row.user_note
    if row.is_manual_edited:
        item.is_manual_edited = True
    return item


def highlight_item(row: SegmentHighlight) -> Highlight:
    return Highlight(id=row.id, term=row.term, explanation=row.explanation)


def attachment_item(row: SessionAttachment) -> SessionAttachmentItem:
    item = SessionAttachmentItem(
        id=row.id,
        session_id=row.session_id,
        segment_id=row.segment_id,
        kind=row.kind if row.kind in {"screenshot", "image", "material"} else "material",
        file_name=row.file_name or "未命名附件",
        mime_type=row.mime_type or "application/octet-stream",
        size_bytes=max(0, int(row.size_bytes or 0)),
        url=f"/api/v1/sessions/{row.session_id}/attachments/{row.id}/raw",
        created_at=iso_utc(row.created_at),
    )
    if row.width is not None:
        item.width = row.width
    if row.height is not None:
        item.height = row.height
    if row.timestamp_ms is not None:
        item.timestamp_ms = row.timestamp_ms
        item.timestamp_text = format_ms(row.timestamp_ms)
    if row.caption:
        item.caption = row.caption
    if row.extracted_text:
        item.extracted_preview = row.extracted_text[:240]
    return item


def message_item(row: Message, attachments_map: dict[str, SessionAttachmentItem] | None = None) -> ChatMessage:
    message = ChatMessage(
        id=row.id,
        session_id=row.session_id,
        role=row.role if row.role in {"user", "assistant"} else "assistant",
        content=row.content or "",
        created_at=iso_utc(row.created_at),
    )
    if row.thinking:
        message.thinking = row.thinking
    if row.referenced_segment_count is not None:
        message.referenced_segment_count = row.referenced_segment_count
    if row.attachment_ids_json and attachments_map:
        try:
            att_ids = json.loads(row.attachment_ids_json)
            if isinstance(att_ids, list):
                resolved = [attachments_map[aid] for aid in att_ids if aid in attachments_map]
                if resolved:
                    message.attachments = resolved
        except (ValueError, TypeError):
            pass
    return message


def segment_item(row: Segment, utterances=None, highlights=None) -> KnowledgeSegment:
    segment = KnowledgeSegment(
        id=row.id,
        session_id=row.session_id,
        order_index=int(row.order_index or 0),
        topic_title=row.topic_title or "",
        utterances=utterances or [],
        highlights=highlights or [],
    )
    if row.detailed_explanation:
        try:
            segment.detailed_explanation = SegmentExplanation.model_validate_json(row.detailed_explanation)
        except (ValueError, TypeError):
            segment.detailed_explanation = None
    return segment


def classroom_title() -> str:
    try:
        zone = ZoneInfo("Asia/Taipei")
    except ZoneInfoNotFoundError:
        zone = None
    current = datetime.now(zone)
    return f"新课堂记录（{current.month}月{current.day}日）"


class Repository:
    def __init__(self, database: Database):
        self.db = database

    async def list_folders(self) -> list[FolderItem]:
        async with self.db.sessions() as db:
            rows = await db.scalars(select(Folder).order_by(Folder.created_at.desc(), Folder.id))
            return [folder_item(row) for row in rows]

    async def create_folder(
        self, name: str, parent_id: str | None, hotwords: list[str] | None = None,
    ) -> FolderItem:
        async with self.db.write() as db:
            if parent_id is not None:
                await require(db, Folder, parent_id, "父文件夹")
            cleaned = list(dict.fromkeys(h.strip() for h in (hotwords or []) if h.strip()))
            folder = Folder(
                name=name,
                parent_id=parent_id,
                hotwords_json=json.dumps(cleaned, ensure_ascii=False) if cleaned else None,
            )
            db.add(folder)
            await db.flush()
            return folder_item(folder)

    async def rename_folder(
        self, id_: str, name: str | None = None, *, hotwords: list[str] | None = None,
    ) -> FolderItem:
        async with self.db.write() as db:
            folder = await require(db, Folder, id_, "文件夹")
            if name is not None:
                folder.name = name
            if hotwords is not None:
                cleaned = list(dict.fromkeys(h.strip() for h in hotwords if h.strip()))
                folder.hotwords_json = json.dumps(cleaned, ensure_ascii=False) if cleaned else None
            await db.flush()
            return folder_item(folder)

    async def folder_hotwords_for_session(self, session_id: str) -> list[str]:
        async with self.db.sessions() as db:
            row = await db.get(ClassSession, session_id)
            if row is None or not row.folder_id:
                return []
            collected: list[str] = []
            seen_folders: set[str] = set()
            fid: str | None = row.folder_id
            while fid and fid not in seen_folders:
                seen_folders.add(fid)
                folder = await db.get(Folder, fid)
                if folder is None:
                    break
                collected.extend(parse_hotwords(folder.hotwords_json))
                fid = folder.parent_id
            return list(dict.fromkeys(collected))

    async def delete_folder(self, id_: str):
        async with self.db.write() as db:
            folder = await require(db, Folder, id_, "文件夹")
            # Keep timestamps in sync with the foreign-key SET NULL behavior.
            await db.execute(update(Folder).where(Folder.parent_id == id_).values(parent_id=None))
            await db.execute(update(ClassSession).where(ClassSession.folder_id == id_).values(folder_id=None))
            await db.delete(folder)

    def card_query(self):
        speaker_count = (
            select(func.count(Speaker.id)).where(Speaker.session_id == ClassSession.id).scalar_subquery()
        )
        segment_count = (
            select(func.count(Segment.id)).where(Segment.session_id == ClassSession.id).scalar_subquery()
        )
        return select(ClassSession, speaker_count, segment_count)

    async def list_sessions(self) -> list[SessionCard]:
        async with self.db.sessions() as db:
            rows = await db.execute(self.card_query().order_by(ClassSession.updated_at.desc(), ClassSession.id))
            return [session_card(*row) for row in rows]

    async def create_session(self, folder_id: str | None) -> Workspace:
        async with self.db.write() as db:
            if folder_id is not None:
                await require(db, Folder, folder_id, "文件夹")
            row = ClassSession(folder_id=folder_id, title=classroom_title(), status="recording")
            db.add(row)
            await db.flush()
            return Workspace(session=session_card(row, 0, 0), speakers=[], segments=[], messages=[])

    async def patch_session(self, id_: str, patch: SessionPatch) -> SessionCard:
        async with self.db.write() as db:
            row = await require(db, ClassSession, id_, "课堂")
            changes = patch.model_dump(exclude_unset=True)
            if changes.get("folder_id") is not None:
                await require(db, Folder, changes["folder_id"], "文件夹")
            if "duration_seconds" in changes:
                changes["duration_seconds"] = max(row.duration_seconds, changes["duration_seconds"])
            for key, value in changes.items():
                setattr(row, key, value)
            await db.flush()
            return session_card(*(await db.execute(self.card_query().where(ClassSession.id == id_))).one())

    async def delete_session(self, id_: str):
        async with self.db.write() as db:
            await db.delete(await require(db, ClassSession, id_, "课堂"))

    async def workspace(self, id_: str, *, audio_duration_ms: int = 0) -> Workspace:
        async with self.db.sessions() as db:
            row = await require(db, ClassSession, id_, "课堂")
            speakers = list(await db.scalars(
                select(Speaker).where(Speaker.session_id == id_).order_by(Speaker.label, Speaker.id)
            ))
            segments = await self._segments(db, id_)
            attachment_rows = list(await db.scalars(
                select(SessionAttachment).where(SessionAttachment.session_id == id_)
                .order_by(SessionAttachment.created_at, SessionAttachment.id)
            ))
            attachments = [attachment_item(att) for att in attachment_rows]
            att_map = {att.id: att for att in attachments}
            messages = await db.scalars(
                select(Message).where(Message.session_id == id_).order_by(Message.created_at, Message.id)
            )
            ws = Workspace(
                session=session_card(row, len(speakers), len(segments)),
                speakers=[speaker_profile(speaker) for speaker in speakers],
                segments=segments,
                messages=[message_item(msg, att_map) for msg in messages],
            )
            if row.study_note_json:
                try:
                    ws.study_note = SessionStudyNote.model_validate_json(row.study_note_json)
                except (ValueError, TypeError):
                    pass
            if row.flashcards_json:
                try:
                    raw_cards = json.loads(row.flashcards_json)
                    if isinstance(raw_cards, list):
                        parsed_cards: list[FlashcardItem] = []
                        for item in raw_cards:
                            try:
                                parsed_cards.append(FlashcardItem.model_validate(item))
                            except (ValueError, TypeError):
                                continue
                        ws.flashcards = parsed_cards
                except (ValueError, TypeError):
                    pass
            if attachments:
                ws.attachments = attachments
            sticky_notes = await self._load_sticky_notes(db, id_)
            if sticky_notes:
                ws.sticky_notes = sticky_notes
            resolved_audio_ms = audio_duration_ms
            if resolved_audio_ms <= 0 and row.audio_file_path:
                try:
                    st = Path(row.audio_file_path).stat()
                    if st.st_size > 44:
                        resolved_audio_ms = (st.st_size - 44) // 32
                except OSError:
                    resolved_audio_ms = 0
            if resolved_audio_ms > 0:
                ws.has_audio = True
                ws.audio_duration_ms = resolved_audio_ms
            return ws

    async def rename_speaker(self, session_id: str, speaker_id: str, label: str):
        async with self.db.write() as db:
            speaker = await db.get(Speaker, speaker_id)
            if speaker is None or speaker.session_id != session_id:
                raise missing("讲话人")
            speaker.label = label

    async def stream_state(self, session_id: str) -> tuple[int, SessionStatus]:
        async with self.db.sessions() as db:
            row = await require(db, ClassSession, session_id, "课堂")
            end_ms = await db.scalar(
                select(func.max(Utterance.end_time_ms)).where(Utterance.session_id == session_id)
            )
            return max(row.duration_seconds * 1000, end_ms or 0), row.status

    async def checkpoint(
        self, session_id: str, duration_ms: int, status: SessionStatus | None = None, audio_path: str | None = None,
    ) -> int:
        async with self.db.write() as db:
            row = await require(db, ClassSession, session_id, "课堂")
            row.duration_seconds = max(row.duration_seconds, duration_ms // 1000)
            if status is not None:
                row.status = status
            if audio_path is not None:
                row.audio_file_path = audio_path
            return row.duration_seconds

    async def _speaker(self, db: AsyncSession, session_id: str, channel: str) -> Speaker:
        speaker = await db.scalar(
            select(Speaker).where(Speaker.session_id == session_id, Speaker.diarization_channel == channel)
        )
        if speaker is None:
            await require(db, ClassSession, session_id, "课堂")
            count = await db.scalar(select(func.count(Speaker.id)).where(Speaker.session_id == session_id))
            speaker = Speaker(
                id=speaker_identity(session_id, channel), session_id=session_id,
                diarization_channel=channel, label=default_speaker_label(channel, count or 0),
            )
            db.add(speaker)
            await db.flush()
        return speaker

    async def preview_speaker(self, session_id: str, channel: str) -> SpeakerProfile:
        async with self.db.sessions() as db:
            speaker = await db.scalar(
                select(Speaker).where(Speaker.session_id == session_id, Speaker.diarization_channel == channel)
            )
            if speaker is not None:
                return speaker_profile(speaker)
        preview_label = (
            "我（麦克风）" if channel == "phys:mic"
            else "课堂老师（内录）" if channel == "phys:sys"
            else "识别中"
        )
        return SpeakerProfile(id=speaker_identity(session_id, channel), label=preview_label)

    async def save_final(
        self, session_id: str, channel: str, text: str, start_ms: int, end_ms: int,
    ) -> tuple[FinalEvent, KnowledgeSegment | None]:
        async with self.db.write() as db:
            row = await require(db, ClassSession, session_id, "课堂")
            speaker = await self._speaker(db, session_id, channel)
            segment = await db.scalar(
                select(Segment).where(Segment.session_id == session_id).order_by(Segment.order_index.desc()).limit(1)
            )
            created_segment = None
            if segment is None:
                segment = Segment(session_id=session_id, topic_title="课堂转写", order_index=1)
                db.add(segment)
                await db.flush()
                created_segment = segment_item(segment)
            self.invalidate_explanation(segment)
            row.updated_at = now()
            utterance = Utterance(
                session_id=session_id, segment_id=segment.id, speaker_id=speaker.id,
                start_time_ms=start_ms, end_time_ms=end_ms, raw_text=text, refined_text=text,
            )
            db.add(utterance)
            await db.flush()
            return FinalEvent(segment_id=segment.id, utterance=utterance_item(utterance, speaker.label)), created_segment

    @staticmethod
    def invalidate_explanation(segment: Segment):
        segment.detailed_explanation = None
        segment.updated_at = now()

    async def _segments(
        self, db: AsyncSession, session_id: str, *, from_index: int | None = None,
        to_index: int | None = None, through: Utterance | None = None,
    ) -> list[KnowledgeSegment]:
        query = select(Segment).where(Segment.session_id == session_id)
        if from_index is not None:
            query = query.where(Segment.order_index >= from_index)
        if to_index is not None:
            query = query.where(Segment.order_index <= to_index)
        rows = list(await db.scalars(query.order_by(Segment.order_index)))
        if not rows:
            return []
        picked = query.with_only_columns(Segment.id)
        speeches = (
            select(Utterance, Speaker.label).join(Speaker, Speaker.id == Utterance.speaker_id)
            .where(Utterance.segment_id.in_(picked))
        )
        if through is not None:
            speeches = speeches.where(
                tuple_(Utterance.created_at, Utterance.id) <= (through.created_at, through.id)
            )
        utterances = defaultdict(list)
        for utterance, label in await db.execute(speeches.order_by(
            Utterance.start_time_ms, Utterance.created_at, Utterance.id
        )):
            utterances[utterance.segment_id].append(utterance_item(utterance, label))
        highlights = defaultdict(list)
        for row in await db.scalars(select(SegmentHighlight).where(
            SegmentHighlight.segment_id.in_(picked)
        ).order_by(SegmentHighlight.term)):
            highlights[row.segment_id].append(highlight_item(row))
        return [segment_item(row, utterances[row.id], highlights[row.id]) for row in rows]

    async def segments(self, session_id: str) -> list[KnowledgeSegment]:
        async with self.db.sessions() as db:
            return await self._segments(db, session_id)

    async def correction_context(self, utterance_id: str) -> dict | None:
        async with self.db.sessions() as db:
            current = await db.get(Utterance, utterance_id)
            if current is None:
                return None
            segment = await db.get(Segment, current.segment_id)
            rows = list(await db.scalars(select(Utterance.refined_text).where(
                Utterance.session_id == current.session_id,
                tuple_(Utterance.created_at, Utterance.id) < (current.created_at, current.id),
                Utterance.refined_text != "",
            ).order_by(Utterance.created_at.desc(), Utterance.id.desc()).limit(10)))
            previous = [text for text in reversed(rows) if text.strip()][-6:]
            payload: dict = {"previousUtterances": previous, "rawText": current.raw_text}
            if segment is not None and segment.topic_title.strip():
                payload["topicTitle"] = segment.topic_title
            return payload

    async def batch_correction_context(self, utterance_ids: list[str]) -> dict | None:
        if not utterance_ids:
            return None
        async with self.db.sessions() as db:
            rows = list(await db.scalars(
                select(Utterance).where(Utterance.id.in_(utterance_ids))
                .order_by(Utterance.created_at, Utterance.id)
            ))
            if not rows:
                return None
            first = rows[0]
            segment = await db.get(Segment, first.segment_id)
            prev_rows = list(await db.scalars(select(Utterance.refined_text).where(
                Utterance.session_id == first.session_id,
                tuple_(Utterance.created_at, Utterance.id) < (first.created_at, first.id),
                Utterance.refined_text != "",
            ).order_by(Utterance.created_at.desc(), Utterance.id.desc()).limit(10)))
            previous = [text for text in reversed(prev_rows) if text.strip()][-6:]
            payload: dict = {
                "previousUtterances": previous,
                "utterances": [
                    {"utteranceId": u.id, "rawText": u.raw_text}
                    for u in rows
                ],
            }
            if segment is not None and segment.topic_title.strip():
                payload["topicTitle"] = segment.topic_title
            return payload

    async def save_correction(self, utterance_id: str, text: str) -> tuple[str, list[Highlight] | None]:
        async with self.db.write() as db:
            utterance = await require(db, Utterance, utterance_id, "转写")
            if not utterance.is_manual_edited:
                utterance.refined_text = text
            utterance.is_refined = True
            segment = await require(db, Segment, utterance.segment_id, "段落")
            self.invalidate_explanation(segment)
            await db.flush()
            return segment.id, await self._prune_highlights(db, segment.id)

    async def mark_filler_refined(self, utterance_id: str, *, clear_text: bool = True) -> str | None:
        async with self.db.write() as db:
            utterance = await db.get(Utterance, utterance_id)
            if utterance is None:
                return None
            if clear_text:
                utterance.refined_text = ""
            utterance.is_refined = True
            return utterance.segment_id

    async def filter_non_empty_refined(self, utterance_ids: list[str]) -> list[str]:
        if not utterance_ids:
            return []
        async with self.db.sessions() as db:
            rows = await db.execute(
                select(Utterance.id, Utterance.refined_text).where(Utterance.id.in_(utterance_ids))
            )
            non_empty = {uid for uid, text in rows if text and text.strip()}
            return [uid for uid in utterance_ids if uid in non_empty]

    async def utterance_raw_and_segment(self, utterance_id: str) -> tuple[str, str] | None:
        async with self.db.sessions() as db:
            utterance = await db.get(Utterance, utterance_id)
            if utterance is None:
                return None
            return utterance.raw_text, utterance.segment_id

    async def batch_regroup_context(self, utterance_ids: list[str]) -> dict | None:
        if not utterance_ids:
            return None
        async with self.db.sessions() as db:
            rows = [
                u for u in await db.scalars(
                    select(Utterance).where(Utterance.id.in_(utterance_ids))
                    .order_by(Utterance.created_at, Utterance.id)
                )
                if u.refined_text.strip()
            ]
            if not rows:
                return None
            first = rows[0]
            segment = await require(db, Segment, first.segment_id, "段落")
            segments = await self._segments(
                db, first.session_id, from_index=segment.order_index - 1, to_index=segment.order_index,
                through=first,
            )
            batch_id_set = set(utterance_ids)
            recent_segments = []
            for item in segments:
                prev_texts = [
                    u.refined_text for u in item.utterances
                    if u.id not in batch_id_set and u.refined_text.strip()
                ][-20:]
                if prev_texts:
                    recent_segments.append({
                        "topicTitle": item.topic_title,
                        "utterances": prev_texts,
                    })
            return {
                "recentSegments": recent_segments,
                "utterances": [
                    {"utteranceId": u.id, "text": u.refined_text}
                    for u in rows
                ],
            }

    async def regroup_context(self, utterance_id: str) -> dict | None:
        async with self.db.sessions() as db:
            current = await db.get(Utterance, utterance_id)
            if current is None or not current.refined_text.strip():
                return None
            segment = await require(db, Segment, current.segment_id, "段落")
            segments = await self._segments(
                db, current.session_id, from_index=segment.order_index - 1, to_index=segment.order_index,
                through=current,
            )
            recent_segments = []
            for item in segments:
                prev_texts = [
                    u.refined_text for u in item.utterances
                    if u.id != current.id and u.refined_text.strip()
                ][-24:]
                if prev_texts:
                    recent_segments.append({
                        "topicTitle": item.topic_title,
                        "utterances": prev_texts,
                    })
            return {
                "recentSegments": recent_segments,
                "utterance": current.refined_text,
            }

    async def regroup(self, utterance_id: str, decision: Regrouping) -> str:
        async with self.db.write() as db:
            current = await require(db, Utterance, utterance_id, "转写")
            segment = await require(db, Segment, current.segment_id, "段落")
            cut = tuple_(Utterance.created_at, Utterance.id)
            pivot = (current.created_at, current.id)
            preceding = await db.scalar(select(Utterance.id).where(
                Utterance.segment_id == segment.id, cut < pivot, Utterance.refined_text != "",
            ).limit(1))
            self.invalidate_explanation(segment)
            if decision.action == "append_to_last" or preceding is None:
                segment.topic_title = decision.updated_topic_title
                return segment.id
            # All pending utterances tentatively share the last segment; move the tail with this split.
            target = Segment(
                session_id=current.session_id, order_index=segment.order_index + 1,
                topic_title=decision.updated_topic_title,
            )
            db.add(target)
            await db.flush()
            await db.execute(update(Utterance).where(
                Utterance.segment_id == segment.id, cut >= pivot,
            ).values(segment_id=target.id))
            await self._transfer_highlights_on_split(db, segment.id, target.id)
            return target.id

    async def _transfer_highlights_on_split(self, db: AsyncSession, source_id: str, target_id: str):
        existing = list(await db.scalars(select(SegmentHighlight).where(
            SegmentHighlight.segment_id == source_id
        ).order_by(SegmentHighlight.term)))
        if not existing:
            return
        source_texts = list(await db.execute(
            select(Utterance.raw_text, Utterance.refined_text).where(Utterance.segment_id == source_id)
        ))
        target_texts = list(await db.execute(
            select(Utterance.raw_text, Utterance.refined_text).where(Utterance.segment_id == target_id)
        ))
        for row in existing:
            in_source = any(row.term in raw or row.term in refined for raw, refined in source_texts)
            in_target = any(row.term in raw or row.term in refined for raw, refined in target_texts)
            if in_source and in_target:
                db.add(SegmentHighlight(segment_id=target_id, term=row.term, explanation=row.explanation))
            elif in_target and not in_source:
                row.segment_id = target_id
            elif not in_source:
                await db.delete(row)

    async def segment_texts(
        self, utterance_id: str, *, use_refined: bool, max_utterances: int | None = None,
    ) -> tuple[str, list[str], list[str]] | None:
        async with self.db.sessions() as db:
            current = await db.get(Utterance, utterance_id)
            if current is None:
                return None
            field = Utterance.refined_text if use_refined else Utterance.raw_text
            texts = [
                t for t in await db.scalars(select(field).where(
                    Utterance.segment_id == current.segment_id,
                    tuple_(Utterance.created_at, Utterance.id) <= (current.created_at, current.id),
                ).order_by(Utterance.start_time_ms, Utterance.created_at, Utterance.id))
                if t and t.strip()
            ]
            if max_utterances is not None and len(texts) > max_utterances:
                texts = texts[-max_utterances:]
            existing_terms = list(await db.scalars(select(SegmentHighlight.term).where(
                SegmentHighlight.segment_id == current.segment_id,
            ).order_by(SegmentHighlight.term)))
            return current.segment_id, texts, existing_terms

    async def _prune_highlights(self, db: AsyncSession, segment_id: str) -> list[Highlight] | None:
        existing = list(await db.scalars(select(SegmentHighlight).where(
            SegmentHighlight.segment_id == segment_id
        ).order_by(SegmentHighlight.term)))
        if not existing:
            return None
        texts = list(await db.execute(
            select(Utterance.raw_text, Utterance.refined_text).where(Utterance.segment_id == segment_id)
        ))
        kept = []
        for row in existing:
            if any(row.term in raw or row.term in refined for raw, refined in texts):
                kept.append(highlight_item(row))
            else:
                await db.delete(row)
        return kept if len(kept) != len(existing) else None

    async def save_highlights(
        self, segment_id: str, terms: list[Term], *, use_refined: bool = True, merge: bool = False,
    ) -> list[Highlight]:
        async with self.db.write() as db:
            await require(db, Segment, segment_id, "段落")
            text_pairs = list(await db.execute(
                select(Utterance.raw_text, Utterance.refined_text).where(Utterance.segment_id == segment_id)
            ))
            primary_texts = [refined if use_refined else raw for raw, refined in text_pairs]

            def exists_in_segment(term_str: str) -> bool:
                if any(term_str in text for text in primary_texts):
                    return True
                return any(term_str in raw or term_str in refined for raw, refined in text_pairs)

            merged_by_term: dict[str, str] = {}
            if merge:
                existing_rows = list(await db.scalars(select(SegmentHighlight).where(
                    SegmentHighlight.segment_id == segment_id
                )))
                for row in existing_rows:
                    if exists_in_segment(row.term):
                        merged_by_term[row.term] = row.explanation

            for term in terms:
                if any(term.term in text for text in primary_texts):
                    merged_by_term[term.term] = term.explanation

            await db.execute(delete(SegmentHighlight).where(SegmentHighlight.segment_id == segment_id))
            rows = [
                SegmentHighlight(segment_id=segment_id, term=term_key, explanation=explanation)
                for term_key, explanation in sorted(merged_by_term.items())
            ]
            db.add_all(rows)
            await db.flush()
            return [highlight_item(row) for row in rows]

    async def save_highlights_for_utterances(
        self, utterance_ids: list[str], terms: list[Term], *, use_refined: bool = True,
    ) -> list[tuple[str, list[Highlight]]]:
        if not utterance_ids:
            return []
        async with self.db.sessions() as db:
            seg_ids = list(await db.scalars(
                select(Segment.id)
                .join(Utterance, Utterance.segment_id == Segment.id)
                .where(Utterance.id.in_(utterance_ids))
                .group_by(Segment.id, Segment.order_index)
                .order_by(Segment.order_index)
            ))
        results: list[tuple[str, list[Highlight]]] = []
        for seg_id in seg_ids:
            saved = await self.save_highlights(seg_id, terms, use_refined=use_refined, merge=True)
            results.append((seg_id, saved))
        return results

    async def explain_input(
        self, session_id: str, segment_id: str,
    ) -> tuple[KnowledgeSegment, list[str], datetime]:
        async with self.db.sessions() as db:
            row = await db.get(Segment, segment_id)
            if row is None or row.session_id != session_id:
                raise missing("段落")
            target = (await self._segments(
                db, session_id, from_index=row.order_index, to_index=row.order_index,
            ))[0]
            if not target.utterances:
                raise AppError(400, "SEGMENT_EMPTY", "该段落暂无转写")
            neighbor_titles = list(await db.scalars(select(Segment.topic_title).where(
                Segment.session_id == session_id,
                Segment.order_index.in_([row.order_index - 1, row.order_index + 1]),
            ).order_by(Segment.order_index)))
            return target, neighbor_titles, row.updated_at

    async def save_explanation(self, session_id: str, segment_id: str, revision: datetime, detail: SegmentExplanation):
        async with self.db.write() as db:
            row = await db.get(Segment, segment_id)
            if row is None or row.session_id != session_id:
                raise missing("段落")
            if row.updated_at == revision:
                row.detailed_explanation = detail.model_dump_json(by_alias=True, exclude_unset=True)

    async def chat_inputs(self, session_id: str) -> tuple[list[KnowledgeSegment], list[ChatMessage]]:
        async with self.db.sessions() as db:
            await require(db, ClassSession, session_id, "课堂")
            segments = await self._segments(db, session_id)
            attachment_rows = list(await db.scalars(
                select(SessionAttachment).where(SessionAttachment.session_id == session_id)
            ))
            att_map = {att.id: attachment_item(att) for att in attachment_rows}
            history = list(await db.scalars(select(Message).where(
                Message.session_id == session_id
            ).order_by(Message.created_at.desc(), Message.id.desc()).limit(16)))
            return segments, [message_item(msg, att_map) for msg in reversed(history)]

    async def save_chat(
        self, session_id: str, question: str, answer: str, count: int,
        thinking: str | None = None, attachment_ids: list[str] | None = None,
    ) -> ChatMessage:
        async with self.db.write() as db:
            session = await require(db, ClassSession, session_id, "课堂")
            saved_at = now()
            cleaned_thinking = thinking.strip() if thinking and thinking.strip() else None
            valid_att_ids: list[str] = []
            att_map: dict[str, SessionAttachmentItem] = {}
            if attachment_ids:
                rows = list(await db.scalars(
                    select(SessionAttachment).where(
                        SessionAttachment.session_id == session_id,
                        SessionAttachment.id.in_(attachment_ids),
                    )
                ))
                att_map = {row.id: attachment_item(row) for row in rows}
                valid_att_ids = [aid for aid in attachment_ids if aid in att_map]
            user_msg = Message(
                session_id=session_id,
                role="user",
                content=question,
                attachment_ids_json=json.dumps(valid_att_ids) if valid_att_ids else None,
                created_at=saved_at,
            )
            reply = Message(
                session_id=session_id, role="assistant", content=answer, thinking=cleaned_thinking,
                referenced_segment_count=count, created_at=saved_at + timedelta(microseconds=1),
            )
            db.add_all([user_msg, reply])
            session.updated_at = saved_at
            await db.flush()
            return message_item(reply, att_map)

    async def save_study_note(
        self, session_id: str, content_markdown: str, thinking: str | None = None,
    ) -> SessionStudyNote:
        async with self.db.write() as db:
            session = await require(db, ClassSession, session_id, "课堂")
            stamp = now()
            note = SessionStudyNote(
                content_markdown=content_markdown.strip(),
                updated_at=iso_utc(stamp),
            )
            if thinking and thinking.strip():
                note.thinking = thinking.strip()
            session.study_note_json = note.model_dump_json(by_alias=True, exclude_unset=True)
            session.updated_at = stamp
            await db.flush()
            return note

    async def save_flashcards(self, session_id: str, cards: list[FlashcardItem]) -> list[FlashcardItem]:
        async with self.db.write() as db:
            session = await require(db, ClassSession, session_id, "课堂")
            payload = [card.wire() for card in cards]
            session.flashcards_json = json.dumps(payload, ensure_ascii=False)
            session.updated_at = now()
            await db.flush()
            return cards

    async def patch_utterance(
        self, session_id: str, utterance_id: str, patch: UtterancePatch,
    ) -> tuple[str, UtteranceItem, list[Highlight] | None]:
        async with self.db.write() as db:
            utterance = await db.get(Utterance, utterance_id)
            if utterance is None or utterance.session_id != session_id:
                raise missing("转写")
            speaker = await require(db, Speaker, utterance.speaker_id, "讲话人")
            segment = await require(db, Segment, utterance.segment_id, "段落")
            pruned: list[Highlight] | None = None

            if "refined_text" in patch.model_fields_set and patch.refined_text is not None:
                utterance.refined_text = patch.refined_text
                utterance.is_refined = True
                utterance.is_manual_edited = True
                self.invalidate_explanation(segment)
                await db.flush()
                pruned = await self._prune_highlights(db, segment.id)

            if "is_bookmarked" in patch.model_fields_set and patch.is_bookmarked is not None:
                utterance.is_bookmarked = patch.is_bookmarked
                if not patch.is_bookmarked:
                    utterance.bookmark_kind = None
                elif not utterance.bookmark_kind:
                    utterance.bookmark_kind = patch.bookmark_kind or "confused"

            if "bookmark_kind" in patch.model_fields_set:
                utterance.bookmark_kind = patch.bookmark_kind
                if patch.bookmark_kind is not None:
                    utterance.is_bookmarked = True

            if "user_note" in patch.model_fields_set:
                cleaned_note = (patch.user_note or "").strip()
                utterance.user_note = cleaned_note or None

            session = await require(db, ClassSession, session_id, "课堂")
            session.updated_at = now()
            await db.flush()
            return segment.id, utterance_item(utterance, speaker.label), pruned

    async def delete_utterances(
        self, session_id: str, utterance_ids: list[str], *, require_all: bool = False,
    ) -> tuple[list[str], list[KnowledgeSegment]]:
        unique_ids = list(dict.fromkeys(uid.strip() for uid in utterance_ids if uid and uid.strip()))
        if not unique_ids:
            raise AppError(400, "EMPTY_UTTERANCE_IDS", "请至少选择一条要删除的转写记录")
        async with self.db.write() as db:
            session = await require(db, ClassSession, session_id, "课堂")
            found_map: dict[str, str] = {}
            for start in range(0, len(unique_ids), 400):
                chunk = unique_ids[start:start + 400]
                rows = await db.execute(
                    select(Utterance.id, Utterance.segment_id).where(
                        Utterance.session_id == session_id,
                        Utterance.id.in_(chunk),
                    )
                )
                for uid, seg_id in rows:
                    found_map[uid] = seg_id

            if require_all and len(found_map) < len(unique_ids):
                raise missing("转写")

            deleted_ids = [uid for uid in unique_ids if uid in found_map]
            if not deleted_ids:
                return [], await self._segments(db, session_id)

            affected_seg_ids = list(dict.fromkeys(found_map[uid] for uid in deleted_ids))
            for start in range(0, len(deleted_ids), 400):
                chunk = deleted_ids[start:start + 400]
                await db.execute(
                    delete(Utterance).where(
                        Utterance.session_id == session_id,
                        Utterance.id.in_(chunk),
                    )
                )
            await db.flush()

            for seg_id in affected_seg_ids:
                segment = await db.get(Segment, seg_id)
                if segment is None or segment.session_id != session_id:
                    continue
                remaining_utterances = await db.scalar(
                    select(func.count(Utterance.id)).where(Utterance.segment_id == seg_id)
                ) or 0
                remaining_images = await db.scalar(
                    select(func.count(SessionAttachment.id)).where(
                        SessionAttachment.session_id == session_id,
                        SessionAttachment.segment_id == seg_id,
                        SessionAttachment.kind != "material",
                    )
                ) or 0
                if remaining_utterances == 0 and remaining_images == 0:
                    await db.delete(segment)
                else:
                    self.invalidate_explanation(segment)
                    await self._prune_highlights(db, seg_id)

            session.updated_at = now()
            await db.flush()
            segments = await self._segments(db, session_id)
            return deleted_ids, segments

    async def bookmark_now(
        self, session_id: str, req: BookmarkNowRequest,
    ) -> tuple[str, UtteranceItem, KnowledgeSegment | None]:
        async with self.db.write() as db:
            session = await require(db, ClassSession, session_id, "课堂")
            latest = await db.scalar(
                select(Utterance)
                .where(Utterance.session_id == session_id)
                .order_by(Utterance.start_time_ms.desc(), Utterance.created_at.desc(), Utterance.id.desc())
                .limit(1)
            )
            created_segment: KnowledgeSegment | None = None
            if latest is not None:
                latest.is_bookmarked = True
                latest.bookmark_kind = req.kind
                if req.note and req.note.strip():
                    latest.user_note = req.note.strip()
                speaker = await require(db, Speaker, latest.speaker_id, "讲话人")
                session.updated_at = now()
                await db.flush()
                return latest.segment_id, utterance_item(latest, speaker.label), None

            # 课堂尚无转写句时，在当前时间点创建一条难点书签锚点句
            ts_ms = req.timestamp_ms if req.timestamp_ms is not None else session.duration_seconds * 1000
            speaker = await self._speaker(db, session_id, "phys:mic")
            segment = await db.scalar(
                select(Segment).where(Segment.session_id == session_id).order_by(Segment.order_index.desc()).limit(1)
            )
            if segment is None:
                segment = Segment(session_id=session_id, topic_title="课堂重点书签", order_index=1)
                db.add(segment)
                await db.flush()
                created_segment = segment_item(segment)
            placeholder = (req.note or "").strip() or "（课堂难点书签锚点）"
            utterance = Utterance(
                session_id=session_id,
                segment_id=segment.id,
                speaker_id=speaker.id,
                start_time_ms=ts_ms,
                end_time_ms=ts_ms,
                raw_text=placeholder,
                refined_text=placeholder,
                is_refined=True,
                is_manual_edited=True,
                is_bookmarked=True,
                bookmark_kind=req.kind,
                user_note=(req.note or "").strip() or None,
            )
            db.add(utterance)
            session.updated_at = now()
            await db.flush()
            return segment.id, utterance_item(utterance, speaker.label), created_segment

    async def create_attachment(
        self,
        *,
        attachment_id: str | None = None,
        session_id: str,
        segment_id: str | None,
        kind: str,
        file_name: str,
        mime_type: str,
        file_path: str,
        size_bytes: int,
        width: int | None = None,
        height: int | None = None,
        timestamp_ms: int | None = None,
        caption: str | None = None,
        extracted_text: str | None = None,
    ) -> SessionAttachmentItem:
        async with self.db.write() as db:
            session = await require(db, ClassSession, session_id, "课堂")
            resolved_segment_id = segment_id
            if resolved_segment_id is not None:
                seg = await db.get(Segment, resolved_segment_id)
                if seg is None or seg.session_id != session_id:
                    resolved_segment_id = None
            elif kind in ("screenshot", "image"):
                latest_seg = await db.scalar(
                    select(Segment).where(Segment.session_id == session_id)
                    .order_by(Segment.order_index.desc()).limit(1)
                )
                if latest_seg is not None:
                    resolved_segment_id = latest_seg.id

            resolved_ts = timestamp_ms
            if resolved_ts is None and kind in ("screenshot", "image"):
                resolved_ts = session.duration_seconds * 1000

            row = SessionAttachment(
                id=attachment_id or uuid4().hex,
                session_id=session_id,
                segment_id=resolved_segment_id,
                kind=kind,
                file_name=file_name[:255],
                mime_type=mime_type[:100],
                file_path=file_path,
                size_bytes=size_bytes,
                width=width,
                height=height,
                timestamp_ms=resolved_ts,
                caption=(caption or "").strip() or None,
                extracted_text=(extracted_text or "").strip() or None,
            )
            db.add(row)
            session.updated_at = now()
            await db.flush()
            return attachment_item(row)

    async def get_attachment_row(self, session_id: str, attachment_id: str) -> tuple[SessionAttachmentItem, str]:
        async with self.db.sessions() as db:
            row = await db.get(SessionAttachment, attachment_id)
            if row is None or row.session_id != session_id:
                raise missing("课堂附件")
            return attachment_item(row), row.file_path

    async def get_attachments_for_chat(
        self, session_id: str, attachment_ids: list[str],
    ) -> list[tuple[SessionAttachmentItem, str, str | None]]:
        if not attachment_ids:
            return []
        async with self.db.sessions() as db:
            rows = list(await db.scalars(
                select(SessionAttachment).where(
                    SessionAttachment.session_id == session_id,
                    SessionAttachment.id.in_(attachment_ids),
                )
            ))
            by_id = {row.id: (attachment_item(row), row.file_path, row.extracted_text) for row in rows}
            return [by_id[aid] for aid in attachment_ids if aid in by_id]

    async def session_materials_text(self, session_id: str, max_chars: int = 8000) -> str:
        async with self.db.sessions() as db:
            rows = list(await db.scalars(
                select(SessionAttachment).where(
                    SessionAttachment.session_id == session_id,
                    SessionAttachment.extracted_text.is_not(None),
                ).order_by(SessionAttachment.created_at, SessionAttachment.id)
            ))
            chunks: list[str] = []
            used = 0
            for row in rows:
                text = (row.extracted_text or "").strip()
                if not text:
                    continue
                header = f"【讲义资料：{row.file_name}】\n"
                remain = max_chars - used - len(header)
                if remain <= 80:
                    break
                chunks.append(header + text[:remain])
                used += len(header) + min(len(text), remain)
            return "\n\n".join(chunks)

    async def delete_attachment(self, session_id: str, attachment_id: str) -> str:
        async with self.db.write() as db:
            row = await db.get(SessionAttachment, attachment_id)
            if row is None or row.session_id != session_id:
                raise missing("课堂附件")
            file_path = row.file_path
            await db.delete(row)
            return file_path

    async def _load_sticky_notes(self, db: AsyncSession, session_id: str) -> list[StickyNoteItem]:
        notes = list(await db.scalars(
            select(StickyNote)
            .where(StickyNote.session_id == session_id)
            .order_by(StickyNote.created_at, StickyNote.id)
        ))
        if not notes:
            return []
        ts_rows = list(await db.scalars(
            select(StickyNoteTimestamp)
            .where(StickyNoteTimestamp.session_id == session_id)
            .order_by(StickyNoteTimestamp.created_at, StickyNoteTimestamp.id)
        ))
        title_map = {
            note.id: sticky_note_display_title(note, idx + 1)
            for idx, note in enumerate(notes)
        }
        ts_by_note: dict[str, list[StickyNoteTimestamp]] = defaultdict(list)
        owner_by_sec: dict[int, StickyNoteTimestamp] = {}
        for ts in ts_rows:
            ts_by_note[ts.note_id].append(ts)
            owner_by_sec[ts.timestamp_sec] = ts

        items: list[StickyNoteItem] = []
        for note in notes:
            seen_sec_in_note: set[int] = set()
            conflict_secs: set[int] = set()
            conflicts: list[StickyNoteTimestampConflict] = []
            for sec, ts_text, _offset in extract_sticky_timestamps(note.content or ""):
                owner = owner_by_sec.get(sec)
                if owner is not None and owner.note_id != note.id:
                    if sec not in conflict_secs:
                        conflict_secs.add(sec)
                        conflicts.append(StickyNoteTimestampConflict(
                            timestamp_sec=sec,
                            timestamp_text=ts_text,
                            owner_note_id=owner.note_id,
                            owner_note_title=title_map.get(owner.note_id, "课堂便签"),
                        ))
                elif sec in seen_sec_in_note:
                    if sec not in conflict_secs:
                        conflict_secs.add(sec)
                        conflicts.append(StickyNoteTimestampConflict(
                            timestamp_sec=sec,
                            timestamp_text=ts_text,
                            owner_note_id=note.id,
                            owner_note_title=title_map.get(note.id, "当前便签"),
                        ))
                else:
                    seen_sec_in_note.add(sec)
            items.append(sticky_note_item(note, ts_by_note.get(note.id, []), conflicts))
        return items

    async def _sync_sticky_note_timestamps(
        self, db: AsyncSession, session_id: str, note: StickyNote,
    ) -> None:
        existing_rows = list(await db.scalars(
            select(StickyNoteTimestamp)
            .where(StickyNoteTimestamp.session_id == session_id)
            .order_by(StickyNoteTimestamp.created_at, StickyNoteTimestamp.id)
        ))
        owned_by_self: dict[int, StickyNoteTimestamp] = {}
        owned_by_other: set[int] = set()
        for row in existing_rows:
            if row.note_id == note.id:
                owned_by_self[row.timestamp_sec] = row
            else:
                owned_by_other.add(row.timestamp_sec)

        extracted = extract_sticky_timestamps(note.content or "")
        # Keep only the first occurrence of each valid second not already claimed by another note (先来后到).
        desired_by_sec: dict[int, tuple[str, int]] = {}
        for sec, ts_text, offset in extracted:
            if sec in owned_by_other or sec in desired_by_sec:
                continue
            desired_by_sec[sec] = (ts_text, offset)

        # Delete timestamps removed from this note first so those seconds are freed.
        for sec, row in list(owned_by_self.items()):
            if sec not in desired_by_sec:
                await db.delete(row)

        await db.flush()

        for sec, (ts_text, offset) in desired_by_sec.items():
            if sec in owned_by_self:
                row = owned_by_self[sec]
                row.timestamp_text = ts_text
                row.char_offset = offset
            else:
                db.add(StickyNoteTimestamp(
                    session_id=session_id,
                    note_id=note.id,
                    timestamp_sec=sec,
                    timestamp_text=ts_text,
                    char_offset=offset,
                ))
        await db.flush()

    async def list_sticky_notes(self, session_id: str) -> list[StickyNoteItem]:
        async with self.db.sessions() as db:
            await require(db, ClassSession, session_id, "课堂")
            return await self._load_sticky_notes(db, session_id)

    async def create_sticky_note(self, session_id: str, body: StickyNoteCreate) -> StickyNoteItem:
        async with self.db.write() as db:
            await require(db, ClassSession, session_id, "课堂")
            max_z = await db.scalar(
                select(func.max(StickyNote.z_order)).where(StickyNote.session_id == session_id)
            )
            note = StickyNote(
                session_id=session_id,
                title=body.title,
                content=body.content,
                paper_color=body.paper_color,
                pos_x=body.pos_x,
                pos_y=body.pos_y,
                width=body.width,
                height=body.height,
                is_open=body.is_open,
                z_order=max(body.z_order, (max_z or 0) + 1),
                is_translucent=body.is_translucent,
            )
            db.add(note)
            await db.flush()
            if note.content:
                await self._sync_sticky_note_timestamps(db, session_id, note)
            all_notes = await self._load_sticky_notes(db, session_id)
            return next(item for item in all_notes if item.id == note.id)

    async def update_sticky_note(
        self, session_id: str, note_id: str, patch: StickyNotePatch,
    ) -> StickyNoteItem:
        async with self.db.write() as db:
            note = await db.get(StickyNote, note_id)
            if note is None or note.session_id != session_id:
                raise missing("课堂便签")
            fields = patch.model_fields_set
            if "title" in fields and patch.title is not None:
                note.title = patch.title
            if "content" in fields and patch.content is not None:
                note.content = patch.content
            if "paper_color" in fields and patch.paper_color is not None:
                note.paper_color = patch.paper_color
            if "pos_x" in fields and patch.pos_x is not None:
                note.pos_x = patch.pos_x
            if "pos_y" in fields and patch.pos_y is not None:
                note.pos_y = patch.pos_y
            if "width" in fields and patch.width is not None:
                note.width = patch.width
            if "height" in fields and patch.height is not None:
                note.height = patch.height
            if "is_open" in fields and patch.is_open is not None:
                note.is_open = patch.is_open
            if "z_order" in fields and patch.z_order is not None:
                note.z_order = patch.z_order
            if "is_translucent" in fields and patch.is_translucent is not None:
                note.is_translucent = patch.is_translucent
            note.updated_at = now()
            await db.flush()
            if "content" in fields:
                await self._sync_sticky_note_timestamps(db, session_id, note)
            all_notes = await self._load_sticky_notes(db, session_id)
            return next(item for item in all_notes if item.id == note.id)

    async def set_all_sticky_notes_open(self, session_id: str, is_open: bool) -> list[StickyNoteItem]:
        async with self.db.write() as db:
            await require(db, ClassSession, session_id, "课堂")
            await db.execute(
                update(StickyNote)
                .where(StickyNote.session_id == session_id)
                .values(is_open=is_open)
            )
            return await self._load_sticky_notes(db, session_id)

    async def delete_sticky_note(self, session_id: str, note_id: str) -> None:
        async with self.db.write() as db:
            note = await db.get(StickyNote, note_id)
            if note is None or note.session_id != session_id:
                raise missing("课堂便签")
            await db.delete(note)

    async def search_global(
        self, query: str, *, folder_id: str | None = None, limit: int = 40,
    ) -> list[SearchHitItem]:
        q = query.strip()
        if not q:
            return []
        q_lower = q.casefold()
        tokens = [tok for tok in q_lower.split() if tok] or [q_lower]

        def make_snippet(text: str, radius: int = 46) -> str:
            compact = " ".join(text.split())
            idx = compact.casefold().find(tokens[0])
            if idx == -1:
                return compact[: radius * 2]
            start = max(0, idx - radius)
            end = min(len(compact), idx + len(tokens[0]) + radius)
            prefix = "..." if start > 0 else ""
            suffix = "..." if end < len(compact) else ""
            return f"{prefix}{compact[start:end]}{suffix}"

        def matches_all(text: str) -> bool:
            lowered = text.casefold()
            return all(tok in lowered for tok in tokens)

        hits: list[tuple[int, datetime, SearchHitItem]] = []
        async with self.db.sessions() as db:
            sess_stmt = select(ClassSession).order_by(ClassSession.updated_at.desc())
            if folder_id is not None:
                sess_stmt = sess_stmt.where(ClassSession.folder_id == folder_id)
            sessions = list(await db.scalars(sess_stmt))
            if not sessions:
                return []
            sess_map = {s.id: s for s in sessions}
            sess_ids = list(sess_map.keys())

            for s in sessions:
                if matches_all(s.title):
                    hits.append((
                        100,
                        s.updated_at,
                        SearchHitItem(
                            session_id=s.id,
                            session_title=s.title,
                            folder_id=s.folder_id,
                            kind="title",
                            snippet=s.title,
                            updated_at=iso_utc(s.updated_at),
                        ),
                    ))

            seg_rows = list(await db.scalars(select(Segment).where(Segment.session_id.in_(sess_ids))))
            seg_map = {seg.id: seg for seg in seg_rows}
            for seg in seg_rows:
                s = sess_map[seg.session_id]
                if matches_all(seg.topic_title):
                    hits.append((
                        90,
                        s.updated_at,
                        SearchHitItem(
                            session_id=s.id,
                            session_title=s.title,
                            folder_id=s.folder_id,
                            kind="topic",
                            segment_id=seg.id,
                            snippet=seg.topic_title,
                            updated_at=iso_utc(s.updated_at),
                        ),
                    ))

            hl_rows = list(await db.scalars(
                select(SegmentHighlight).where(SegmentHighlight.segment_id.in_(list(seg_map.keys())))
            )) if seg_map else []
            for hl in hl_rows:
                combined = f"{hl.term}：{hl.explanation}"
                if matches_all(combined):
                    seg = seg_map[hl.segment_id]
                    s = sess_map[seg.session_id]
                    hits.append((
                        85,
                        s.updated_at,
                        SearchHitItem(
                            session_id=s.id,
                            session_title=s.title,
                            folder_id=s.folder_id,
                            kind="highlight",
                            segment_id=seg.id,
                            snippet=make_snippet(combined),
                            updated_at=iso_utc(s.updated_at),
                        ),
                    ))

            utt_rows = list(await db.scalars(
                select(Utterance).where(Utterance.session_id.in_(sess_ids))
                .order_by(Utterance.start_time_ms)
            ))
            for utt in utt_rows:
                primary = utt.refined_text.strip() or utt.raw_text.strip()
                note = (utt.user_note or "").strip()
                s = sess_map[utt.session_id]
                if note and matches_all(note):
                    hits.append((
                        82,
                        s.updated_at,
                        SearchHitItem(
                            session_id=s.id,
                            session_title=s.title,
                            folder_id=s.folder_id,
                            kind="note",
                            segment_id=utt.segment_id,
                            utterance_id=utt.id,
                            timestamp_ms=utt.start_time_ms,
                            timestamp_text=format_ms(utt.start_time_ms),
                            snippet=make_snippet(f"批注：{note} | {primary}"),
                            updated_at=iso_utc(s.updated_at),
                        ),
                    ))
                elif primary and matches_all(primary):
                    hits.append((
                        75,
                        s.updated_at,
                        SearchHitItem(
                            session_id=s.id,
                            session_title=s.title,
                            folder_id=s.folder_id,
                            kind="utterance",
                            segment_id=utt.segment_id,
                            utterance_id=utt.id,
                            timestamp_ms=utt.start_time_ms,
                            timestamp_text=format_ms(utt.start_time_ms),
                            snippet=make_snippet(primary),
                            updated_at=iso_utc(s.updated_at),
                        ),
                    ))

            msg_rows = list(await db.scalars(
                select(Message).where(Message.session_id.in_(sess_ids)).order_by(Message.created_at)
            ))
            for msg in msg_rows:
                if matches_all(msg.content):
                    s = sess_map[msg.session_id]
                    role_prefix = "提问" if msg.role == "user" else "解答"
                    hits.append((
                        65,
                        s.updated_at,
                        SearchHitItem(
                            session_id=s.id,
                            session_title=s.title,
                            folder_id=s.folder_id,
                            kind="chat",
                            snippet=make_snippet(f"{role_prefix}：{msg.content}"),
                            updated_at=iso_utc(s.updated_at),
                        ),
                    ))

            sticky_rows = list(await db.scalars(
                select(StickyNote).where(StickyNote.session_id.in_(sess_ids)).order_by(StickyNote.updated_at.desc())
            ))
            for note in sticky_rows:
                combined = f"{note.title} {note.content}".strip()
                if combined and matches_all(combined):
                    s = sess_map[note.session_id]
                    label = sticky_note_display_title(note)
                    hits.append((
                        80,
                        note.updated_at,
                        SearchHitItem(
                            session_id=s.id,
                            session_title=s.title,
                            folder_id=s.folder_id,
                            kind="sticky_note",
                            sticky_note_id=note.id,
                            snippet=make_snippet(f"便签《{label}》：{note.content or note.title}"),
                            updated_at=iso_utc(note.updated_at),
                        ),
                    ))

        hits.sort(key=lambda item: (item[0], item[1]), reverse=True)
        return [item[2] for item in hits[:limit]]
