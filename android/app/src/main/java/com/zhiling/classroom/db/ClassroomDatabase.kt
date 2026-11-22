package com.zhiling.classroom.db

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import java.io.File

/**
 * 与桌面端 backend/app/db.py 100% 同构的 11 张 SQLite 数据表，支持 WAL 并发读写与外键级联。
 */
class ClassroomDatabase(
    context: Context,
    dbFile: File,
) : SQLiteOpenHelper(context, dbFile.absolutePath, null, DB_VERSION) {

    override fun onConfigure(db: SQLiteDatabase) {
        super.onConfigure(db)
        db.setForeignKeyConstraintsEnabled(true)
        db.enableWriteAheadLogging()
    }

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS folders (
                id VARCHAR(64) PRIMARY KEY NOT NULL,
                name VARCHAR(255) NOT NULL,
                parent_id VARCHAR(64) REFERENCES folders(id) ON DELETE SET NULL,
                hotwords_json TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """.trimIndent()
        )
        db.execSQL("CREATE INDEX IF NOT EXISTS ix_folders_parent_id ON folders(parent_id)")

        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS class_sessions (
                id VARCHAR(64) PRIMARY KEY NOT NULL,
                folder_id VARCHAR(64) REFERENCES folders(id) ON DELETE SET NULL,
                title VARCHAR(255) NOT NULL,
                status VARCHAR(20) NOT NULL DEFAULT 'idle',
                duration_seconds INTEGER NOT NULL DEFAULT 0,
                audio_file_path TEXT,
                study_note_json TEXT,
                flashcards_json TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """.trimIndent()
        )
        db.execSQL("CREATE INDEX IF NOT EXISTS ix_sessions_folder_id ON class_sessions(folder_id)")
        db.execSQL("CREATE INDEX IF NOT EXISTS ix_sessions_updated ON class_sessions(updated_at, id)")

        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS speakers (
                id VARCHAR(64) PRIMARY KEY NOT NULL,
                session_id VARCHAR(64) NOT NULL REFERENCES class_sessions(id) ON DELETE CASCADE,
                diarization_channel VARCHAR(64) NOT NULL,
                label VARCHAR(100) NOT NULL,
                voice_embedding BLOB,
                UNIQUE(session_id, diarization_channel)
            )
            """.trimIndent()
        )

        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS knowledge_segments (
                id VARCHAR(64) PRIMARY KEY NOT NULL,
                session_id VARCHAR(64) NOT NULL REFERENCES class_sessions(id) ON DELETE CASCADE,
                order_index INTEGER NOT NULL,
                topic_title VARCHAR(255) NOT NULL,
                detailed_explanation TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(session_id, order_index)
            )
            """.trimIndent()
        )

        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS utterances (
                id VARCHAR(64) PRIMARY KEY NOT NULL,
                session_id VARCHAR(64) NOT NULL REFERENCES class_sessions(id) ON DELETE CASCADE,
                segment_id VARCHAR(64) NOT NULL REFERENCES knowledge_segments(id) ON DELETE CASCADE,
                speaker_id VARCHAR(64) NOT NULL REFERENCES speakers(id),
                start_time_ms INTEGER NOT NULL,
                end_time_ms INTEGER NOT NULL,
                raw_text TEXT NOT NULL,
                refined_text TEXT NOT NULL,
                is_refined INTEGER NOT NULL DEFAULT 0,
                is_bookmarked INTEGER NOT NULL DEFAULT 0,
                bookmark_kind VARCHAR(24),
                user_note TEXT,
                is_manual_edited INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            )
            """.trimIndent()
        )
        db.execSQL("CREATE INDEX IF NOT EXISTS ix_utterances_sequence ON utterances(session_id, created_at, id)")
        db.execSQL("CREATE INDEX IF NOT EXISTS ix_utterances_segment ON utterances(segment_id)")

        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS segment_highlights (
                id VARCHAR(64) PRIMARY KEY NOT NULL,
                segment_id VARCHAR(64) NOT NULL REFERENCES knowledge_segments(id) ON DELETE CASCADE,
                term VARCHAR(128) NOT NULL,
                explanation TEXT NOT NULL
            )
            """.trimIndent()
        )
        db.execSQL("CREATE INDEX IF NOT EXISTS ix_highlights_segment ON segment_highlights(segment_id)")

        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS chat_messages (
                id VARCHAR(64) PRIMARY KEY NOT NULL,
                session_id VARCHAR(64) NOT NULL REFERENCES class_sessions(id) ON DELETE CASCADE,
                role VARCHAR(20) NOT NULL,
                content TEXT NOT NULL,
                thinking TEXT,
                referenced_segment_count INTEGER,
                attachment_ids_json TEXT,
                created_at TEXT NOT NULL
            )
            """.trimIndent()
        )
        db.execSQL("CREATE INDEX IF NOT EXISTS ix_chat_sequence ON chat_messages(session_id, created_at, id)")

        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS session_attachments (
                id VARCHAR(64) PRIMARY KEY NOT NULL,
                session_id VARCHAR(64) NOT NULL REFERENCES class_sessions(id) ON DELETE CASCADE,
                segment_id VARCHAR(64) REFERENCES knowledge_segments(id) ON DELETE SET NULL,
                kind VARCHAR(24) NOT NULL,
                file_name VARCHAR(255) NOT NULL,
                mime_type VARCHAR(100) NOT NULL,
                file_path TEXT NOT NULL,
                size_bytes INTEGER NOT NULL DEFAULT 0,
                width INTEGER,
                height INTEGER,
                timestamp_ms INTEGER,
                caption TEXT,
                extracted_text TEXT,
                created_at TEXT NOT NULL
            )
            """.trimIndent()
        )
        db.execSQL("CREATE INDEX IF NOT EXISTS ix_attachments_session_seq ON session_attachments(session_id, created_at, id)")
        db.execSQL("CREATE INDEX IF NOT EXISTS ix_attachments_segment ON session_attachments(segment_id)")

        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS sticky_notes (
                id VARCHAR(64) PRIMARY KEY NOT NULL,
                session_id VARCHAR(64) NOT NULL REFERENCES class_sessions(id) ON DELETE CASCADE,
                title VARCHAR(255) NOT NULL DEFAULT '',
                content TEXT NOT NULL DEFAULT '',
                paper_color VARCHAR(24) NOT NULL DEFAULT 'cream',
                pos_x INTEGER NOT NULL DEFAULT 120,
                pos_y INTEGER NOT NULL DEFAULT 96,
                width INTEGER NOT NULL DEFAULT 340,
                height INTEGER NOT NULL DEFAULT 300,
                is_open INTEGER NOT NULL DEFAULT 1,
                z_order INTEGER NOT NULL DEFAULT 1,
                is_translucent INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """.trimIndent()
        )
        db.execSQL("CREATE INDEX IF NOT EXISTS ix_sticky_notes_session ON sticky_notes(session_id, created_at, id)")

        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS sticky_note_timestamps (
                id VARCHAR(64) PRIMARY KEY NOT NULL,
                session_id VARCHAR(64) NOT NULL REFERENCES class_sessions(id) ON DELETE CASCADE,
                note_id VARCHAR(64) NOT NULL REFERENCES sticky_notes(id) ON DELETE CASCADE,
                timestamp_sec INTEGER NOT NULL,
                timestamp_text VARCHAR(16) NOT NULL,
                char_offset INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                UNIQUE(session_id, timestamp_sec)
            )
            """.trimIndent()
        )
        db.execSQL("CREATE INDEX IF NOT EXISTS ix_sticky_ts_note ON sticky_note_timestamps(note_id)")

        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS app_settings (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                payload_encrypted TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """.trimIndent()
        )
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        onCreate(db)
    }

    companion object {
        const val DB_VERSION = 1
    }
}
