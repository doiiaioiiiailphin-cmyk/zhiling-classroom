from pathlib import Path
import tempfile
import unittest
import zipfile

from fastapi.testclient import TestClient

from backend.app.main import create_app
from backend.app.repository import extract_sticky_timestamps


class StickyNotesBackendTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def make_client(self):
        app = create_app(self.root, enable_os_hotkeys=False)
        return TestClient(app, base_url="http://localhost")

    def test_extract_sticky_timestamps_formats_and_validation(self):
        text = "重点 [03:54] 推导，详见 [01:02:05]；非法 [03:60] 与 [01:60:10] 应忽略，[00:00:09] 有效。"
        parsed = extract_sticky_timestamps(text)
        self.assertEqual(
            [(sec, label) for sec, label, _ in parsed],
            [(234, "03:54"), (3725, "01:02:05"), (9, "00:09")],
        )
        # char_offset must point directly to '['
        for _sec, _label, offset in parsed:
            self.assertEqual(text[offset], "[")

    def test_sticky_notes_crud_fcfs_uniqueness_search_and_export(self):
        with self.make_client() as client:
            created_sess = client.post("/api/v1/sessions", json={})
            self.assertEqual(created_sess.status_code, 201)
            session_id = created_sess.json()["data"]["session"]["id"]

            # 1. Note A claims [03:54] (234s) and [01:02:05] (3725s), plus duplicate [03:54] inside self
            r_a = client.post(
                f"/api/v1/sessions/{session_id}/sticky-notes",
                json={
                    "title": "高斯消元要点",
                    "content": "[03:54] 主元化一\n[01:02:05] 回代边界\n再次提及 [03:54]",
                    "paperColor": "butter",
                    "posX": 180,
                    "posY": 120,
                    "width": 360,
                    "height": 320,
                },
            )
            self.assertEqual(r_a.status_code, 201)
            note_a = r_a.json()["data"]
            self.assertEqual(note_a["paperColor"], "butter")
            self.assertEqual([t["timestampSec"] for t in note_a["timestamps"]], [234, 3725])
            self.assertEqual(len(note_a["conflicts"]), 1)
            self.assertEqual(note_a["conflicts"][0]["timestampSec"], 234)
            self.assertEqual(note_a["conflicts"][0]["ownerNoteId"], note_a["id"])

            # 2. Note B attempts to claim same second via [00:03:54] (234s) and new second [05:10] (310s)
            r_b = client.post(
                f"/api/v1/sessions/{session_id}/sticky-notes",
                json={
                    "title": "疑问速记",
                    "content": "这里 [00:03:54] 没听清，但 [05:10] 听懂了",
                    "paperColor": "sage",
                },
            )
            self.assertEqual(r_b.status_code, 201)
            note_b = r_b.json()["data"]
            # FCFS: Note B must NOT steal 234s from Note A, only binds 310s
            self.assertEqual([t["timestampSec"] for t in note_b["timestamps"]], [310])
            self.assertEqual(len(note_b["conflicts"]), 1)
            self.assertEqual(note_b["conflicts"][0]["timestampSec"], 234)
            self.assertEqual(note_b["conflicts"][0]["ownerNoteId"], note_a["id"])
            self.assertEqual(note_b["conflicts"][0]["ownerNoteTitle"], "高斯消元要点")

            # 3. Note A removes [03:54] -> second 234 is freed -> Note B re-saves and cleanly claims 234s
            r_a2 = client.patch(
                f"/api/v1/sessions/{session_id}/sticky-notes/{note_a['id']}",
                json={"content": "[01:02:05] 只保留回代边界", "isTranslucent": True},
            )
            self.assertEqual(r_a2.status_code, 200)
            note_a2 = r_a2.json()["data"]
            self.assertEqual([t["timestampSec"] for t in note_a2["timestamps"]], [3725])
            self.assertEqual(note_a2["conflicts"], [])
            self.assertTrue(note_a2["isTranslucent"])

            r_b2 = client.patch(
                f"/api/v1/sessions/{session_id}/sticky-notes/{note_b['id']}",
                json={"content": "这里 [03:54] 没听清，但 [05:10] 听懂了"},
            )
            self.assertEqual(r_b2.status_code, 200)
            note_b2 = r_b2.json()["data"]
            self.assertEqual([t["timestampSec"] for t in note_b2["timestamps"]], [234, 310])
            self.assertEqual(note_b2["conflicts"], [])

            # 4. Batch collapse all notes into basket & verify workspace returns them
            r_collapse = client.patch(
                f"/api/v1/sessions/{session_id}/sticky-notes",
                json={"isOpen": False},
            )
            self.assertEqual(r_collapse.status_code, 200)
            self.assertTrue(all(not n["isOpen"] for n in r_collapse.json()["data"]))

            ws = client.get(f"/api/v1/sessions/{session_id}/workspace").json()["data"]
            self.assertEqual(len(ws["stickyNotes"]), 2)
            self.assertTrue(all(not n["isOpen"] for n in ws["stickyNotes"]))

            # 5. Global search hits sticky_note
            hits = client.get("/api/v1/search", params={"q": "回代边界"}).json()["data"]
            sticky_hits = [h for h in hits if h["kind"] == "sticky_note"]
            self.assertEqual(len(sticky_hits), 1)
            self.assertEqual(sticky_hits[0]["stickyNoteId"], note_a["id"])

            # 6. Export Markdown, TXT, and DOCX include sticky notes when enabled
            md_res = client.post(
                f"/api/v1/sessions/{session_id}/export",
                json={"format": "markdown", "includeStickyNotes": True},
            )
            self.assertEqual(md_res.status_code, 200)
            self.assertIn("课堂便签速记", md_res.text)
            self.assertIn("高斯消元要点", md_res.text)

            md_excluded = client.post(
                f"/api/v1/sessions/{session_id}/export",
                json={"format": "markdown", "includeStickyNotes": False},
            )
            self.assertEqual(md_excluded.status_code, 200)
            self.assertNotIn("课堂便签速记", md_excluded.text)

            docx_res = client.post(
                f"/api/v1/sessions/{session_id}/export",
                json={"format": "docx", "includeStickyNotes": True},
            )
            self.assertEqual(docx_res.status_code, 200)
            import io
            with zipfile.ZipFile(io.BytesIO(docx_res.content)) as zf:
                xml_text = zf.read("word/document.xml").decode("utf-8")
                self.assertIn("课堂便签速记", xml_text)
                self.assertIn("高斯消元要点", xml_text)

            # 7. Delete Note B -> 234s & 310s freed cleanly
            r_del = client.delete(f"/api/v1/sessions/{session_id}/sticky-notes/{note_b['id']}")
            self.assertEqual(r_del.status_code, 204)
            remaining = client.get(f"/api/v1/sessions/{session_id}/sticky-notes").json()["data"]
            self.assertEqual(len(remaining), 1)
            self.assertEqual(remaining[0]["id"], note_a["id"])


if __name__ == "__main__":
    unittest.main()
