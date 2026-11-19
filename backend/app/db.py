from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from sqlalchemy import (
    Boolean, CheckConstraint, DateTime, ForeignKey, Index, Integer, LargeBinary,
    String, Text, URL, UniqueConstraint, event, func, text, update,
)
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def new_id() -> str:
    return uuid4().hex


class Base(DeclarativeBase):
    pass


class Timestamps:
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now, server_default=func.current_timestamp())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=now, onupdate=now, server_default=func.current_timestamp()
    )


class Folder(Timestamps, Base):
    __tablename__ = "folders"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(255))
    parent_id: Mapped[str | None] = mapped_column(
        ForeignKey("folders.id", ondelete="SET NULL"), index=True
    )
    hotwords_json: Mapped[str | None] = mapped_column(Text)


class ClassSession(Timestamps, Base):
    __tablename__ = "class_sessions"
    __table_args__ = (Index("ix_sessions_updated", "updated_at", "id"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=new_id)
    folder_id: Mapped[str | None] = mapped_column(
        ForeignKey("folders.id", ondelete="SET NULL"), index=True
    )
    title: Mapped[str] = mapped_column(String(255))
    status: Mapped[str] = mapped_column(String(20), default="idle", server_default="idle")
    duration_seconds: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    audio_file_path: Mapped[str | None] = mapped_column(Text)
    study_note_json: Mapped[str | None] = mapped_column(Text)
    flashcards_json: Mapped[str | None] = mapped_column(Text)


class Speaker(Base):
    __tablename__ = "speakers"
    __table_args__ = (UniqueConstraint("session_id", "diarization_channel"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=new_id)
    session_id: Mapped[str] = mapped_column(ForeignKey("class_sessions.id", ondelete="CASCADE"))
    diarization_channel: Mapped[str] = mapped_column(String(64))
    label: Mapped[str] = mapped_column(String(100))
    voice_embedding: Mapped[bytes | None] = mapped_column(LargeBinary)


class Segment(Timestamps, Base):
    __tablename__ = "knowledge_segments"
    __table_args__ = (UniqueConstraint("session_id", "order_index"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=new_id)
    session_id: Mapped[str] = mapped_column(ForeignKey("class_sessions.id", ondelete="CASCADE"))
    order_index: Mapped[int] = mapped_column(Integer)
    topic_title: Mapped[str] = mapped_column(String(255))
    detailed_explanation: Mapped[str | None] = mapped_column(Text)


class Utterance(Base):
    __tablename__ = "utterances"
    __table_args__ = (
        Index("ix_utterances_sequence", "session_id", "created_at", "id"),
        Index("ix_utterances_segment", "segment_id"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=new_id)
    session_id: Mapped[str] = mapped_column(ForeignKey("class_sessions.id", ondelete="CASCADE"))
    segment_id: Mapped[str] = mapped_column(ForeignKey("knowledge_segments.id", ondelete="CASCADE"))
    speaker_id: Mapped[str] = mapped_column(ForeignKey("speakers.id"))
    start_time_ms: Mapped[int] = mapped_column(Integer)
    end_time_ms: Mapped[int] = mapped_column(Integer)
    raw_text: Mapped[str] = mapped_column(Text)
    refined_text: Mapped[str] = mapped_column(Text)
    is_refined: Mapped[bool] = mapped_column(Boolean, default=False, server_default="0")
    is_bookmarked: Mapped[bool] = mapped_column(Boolean, default=False, server_default="0")
    bookmark_kind: Mapped[str | None] = mapped_column(String(24))
    user_note: Mapped[str | None] = mapped_column(Text)
    is_manual_edited: Mapped[bool] = mapped_column(Boolean, default=False, server_default="0")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now, server_default=func.current_timestamp())


class SegmentHighlight(Base):
    __tablename__ = "segment_highlights"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=new_id)
    segment_id: Mapped[str] = mapped_column(
        ForeignKey("knowledge_segments.id", ondelete="CASCADE"), index=True
    )
    term: Mapped[str] = mapped_column(String(128))
    explanation: Mapped[str] = mapped_column(Text)


class Message(Base):
    __tablename__ = "chat_messages"
    __table_args__ = (Index("ix_chat_sequence", "session_id", "created_at", "id"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=new_id)
    session_id: Mapped[str] = mapped_column(ForeignKey("class_sessions.id", ondelete="CASCADE"))
    role: Mapped[str] = mapped_column(String(20))
    content: Mapped[str] = mapped_column(Text)
    thinking: Mapped[str | None] = mapped_column(Text)
    referenced_segment_count: Mapped[int | None] = mapped_column(Integer)
    attachment_ids_json: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now, server_default=func.current_timestamp())


class SessionAttachment(Base):
    __tablename__ = "session_attachments"
    __table_args__ = (
        Index("ix_attachments_session_seq", "session_id", "created_at", "id"),
        Index("ix_attachments_segment", "segment_id"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=new_id)
    session_id: Mapped[str] = mapped_column(ForeignKey("class_sessions.id", ondelete="CASCADE"))
    segment_id: Mapped[str | None] = mapped_column(ForeignKey("knowledge_segments.id", ondelete="SET NULL"))
    kind: Mapped[str] = mapped_column(String(24))
    file_name: Mapped[str] = mapped_column(String(255))
    mime_type: Mapped[str] = mapped_column(String(100))
    file_path: Mapped[str] = mapped_column(Text)
    size_bytes: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    width: Mapped[int | None] = mapped_column(Integer)
    height: Mapped[int | None] = mapped_column(Integer)
    timestamp_ms: Mapped[int | None] = mapped_column(Integer)
    caption: Mapped[str | None] = mapped_column(Text)
    extracted_text: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now, server_default=func.current_timestamp())


class SettingsRow(Base):
    __tablename__ = "app_settings"
    __table_args__ = (CheckConstraint("id = 1"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    settings_json: Mapped[str] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=now, onupdate=now, server_default=func.current_timestamp()
    )


class Database:
    def __init__(self, path: Path):
        self.engine = create_async_engine(
            URL.create("sqlite+aiosqlite", database=str(path)), connect_args={"timeout": 10}
        )
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)

        @event.listens_for(self.engine.sync_engine, "connect")
        def sqlite_pragmas(connection, _):
            # Explicit transaction control gives reads a consistent snapshot on Python 3.11.
            connection.isolation_level = None
            cursor = connection.cursor()
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.execute("PRAGMA busy_timeout=10000")
            cursor.execute("PRAGMA journal_mode=WAL")
            cursor.close()

        @event.listens_for(self.engine.sync_engine, "begin")
        def sqlite_begin(connection):
            if connection.get_execution_options().get("sqlite_write"):
                connection.exec_driver_sql("BEGIN IMMEDIATE")
            else:
                connection.exec_driver_sql("BEGIN")

    @asynccontextmanager
    async def write(self):
        async with self.sessions.begin() as session:
            await session.connection(execution_options={"sqlite_write": True})
            yield session

    async def initialize(self):
        async with self.engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with self.write() as session:
            migrations = (
                ("app_settings", "updated_at", "DATETIME"),
                ("folders", "hotwords_json", "TEXT"),
                ("class_sessions", "study_note_json", "TEXT"),
                ("class_sessions", "flashcards_json", "TEXT"),
                ("utterances", "is_bookmarked", "BOOLEAN NOT NULL DEFAULT 0"),
                ("utterances", "bookmark_kind", "VARCHAR(24)"),
                ("utterances", "user_note", "TEXT"),
                ("utterances", "is_manual_edited", "BOOLEAN NOT NULL DEFAULT 0"),
                ("chat_messages", "thinking", "TEXT"),
                ("chat_messages", "attachment_ids_json", "TEXT"),
            )
            table_cols: dict[str, set[str]] = {}
            for table_name, col_name, col_ddl in migrations:
                if table_name not in table_cols:
                    rows = (await session.execute(text(f"PRAGMA table_info({table_name})"))).all()
                    table_cols[table_name] = {row[1] for row in rows}
                if table_cols[table_name] and col_name not in table_cols[table_name]:
                    await session.execute(text(f"ALTER TABLE {table_name} ADD COLUMN {col_name} {col_ddl}"))
                    table_cols[table_name].add(col_name)
                    if table_name == "app_settings" and col_name == "updated_at":
                        await session.execute(
                            text("UPDATE app_settings SET updated_at = CURRENT_TIMESTAMP WHERE updated_at IS NULL")
                        )
            await session.execute(
                update(ClassSession).where(ClassSession.status == "recording").values(status="paused")
            )
