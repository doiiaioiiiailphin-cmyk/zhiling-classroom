from io import BytesIO
import re
from urllib.parse import quote
import xml.etree.ElementTree as ET
import zipfile

from ..schemas import SessionExportRequest, Workspace

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
ET.register_namespace("w", W_NS)


def _w(tag: str) -> str:
    return f"{{{W_NS}}}{tag}"


def _safe_filename(title: str) -> str:
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "_", title.strip())
    return (cleaned or "课堂笔记")[:80]


def _format_duration_cn(seconds: int) -> str:
    mins, secs = divmod(max(0, seconds), 60)
    hrs, mins = divmod(mins, 60)
    if hrs > 0:
        return f"{hrs}小时{mins:02d}分{secs:02d}秒"
    return f"{mins:02d}分{secs:02d}秒"


def _strip_markdown(text: str) -> str:
    out = re.sub(r"```[\w+-]*\n([\s\S]*?)```", r"\1", text)
    out = re.sub(r"^#{1,6}\s+", "", out, flags=re.MULTILINE)
    out = re.sub(r"\*\*([^*]+)\*\*", r"\1", out)
    out = re.sub(r"`([^`]+)`", r"\1", out)
    return out.strip()


def _collect_all_highlights(workspace: Workspace) -> list[tuple[str, str, str]]:
    seen: set[str] = set()
    rows: list[tuple[str, str, str]] = []
    for seg in workspace.segments:
        for hl in seg.highlights:
            key = hl.term.strip()
            if not key or key in seen:
                continue
            seen.add(key)
            rows.append((key, hl.explanation.strip(), seg.topic_title))
    return rows


def build_markdown(workspace: Workspace, req: SessionExportRequest) -> str:
    session = workspace.session
    lines: list[str] = [
        f"# {session.title}",
        "",
        f"> 课堂时长：{_format_duration_cn(session.duration_seconds)} | "
        f"知识分段：{len(workspace.segments)} 节 | "
        f"导出时间：{session.updated_at[:10]}",
        "",
    ]

    if req.include_study_note and workspace.study_note and workspace.study_note.content_markdown.strip():
        lines.extend([
            "## 一、全课精编笔记",
            "",
            workspace.study_note.content_markdown.strip(),
            "",
        ])

    highlights = _collect_all_highlights(workspace) if req.include_highlights else []
    if highlights:
        lines.extend([
            "## 二、核心术语与概念速查表",
            "",
            "| 重点术语 | 课堂语境释义 | 所属段落 |",
            "| :--- | :--- | :--- |",
        ])
        for term, exp, topic in highlights:
            safe_term = term.replace("|", "\\|").replace("\n", " ")
            safe_exp = exp.replace("|", "\\|").replace("\n", " ")
            safe_topic = topic.replace("|", "\\|").replace("\n", " ")
            lines.append(f"| **{safe_term}** | {safe_exp} | {safe_topic} |")
        lines.append("")

    if req.include_chat and workspace.messages:
        lines.extend(["## 三、课堂问答精选", ""])
        for msg in workspace.messages:
            role_label = "提问" if msg.role == "user" else "知聆解答"
            lines.append(f"### {role_label}")
            lines.append("")
            lines.append(msg.content.strip())
            lines.append("")

    if req.include_transcript and workspace.segments:
        lines.extend(["## 四、分段课堂逐字精修记录", ""])
        for seg in workspace.segments:
            utts = [u for u in seg.utterances if (u.refined_text or u.raw_text).strip()]
            if not utts:
                continue
            lines.append(f"### {seg.order_index}. {seg.topic_title}")
            lines.append("")
            if seg.detailed_explanation:
                lines.append(f"> **段落核心提要**：{seg.detailed_explanation.elaboration.strip()}")
                lines.append("")
            for utt in utts:
                body = utt.refined_text.strip() or utt.raw_text.strip()
                badge = ""
                if utt.is_bookmarked:
                    badge = " `[待搞懂]`" if utt.bookmark_kind == "confused" else " `[重点]`"
                lines.append(f"- **[{utt.timestamp_text}] {utt.speaker_label}**{badge}：{body}")
                if utt.user_note:
                    lines.append(f"  - *个人批注：{utt.user_note}*")
            lines.append("")

    return "\n".join(lines).strip() + "\n"


def build_plain_text(workspace: Workspace, req: SessionExportRequest) -> str:
    session = workspace.session
    lines: list[str] = [
        session.title,
        "=" * max(16, len(session.title) * 2),
        f"课堂时长：{_format_duration_cn(session.duration_seconds)} | 知识分段：{len(workspace.segments)} 节",
        "",
    ]

    if req.include_study_note and workspace.study_note and workspace.study_note.content_markdown.strip():
        lines.extend([
            "【一、全课精编笔记】",
            _strip_markdown(workspace.study_note.content_markdown),
            "",
        ])

    highlights = _collect_all_highlights(workspace) if req.include_highlights else []
    if highlights:
        lines.append("【二、核心术语与概念】")
        for term, exp, topic in highlights:
            lines.append(f"  * {term}（{topic}）：{exp}")
        lines.append("")

    if req.include_chat and workspace.messages:
        lines.append("【三、课堂问答记录】")
        for msg in workspace.messages:
            prefix = "问" if msg.role == "user" else "答"
            lines.append(f"[{prefix}] {_strip_markdown(msg.content)}")
            lines.append("")

    if req.include_transcript and workspace.segments:
        lines.append("【四、分段课堂记录】")
        for seg in workspace.segments:
            utts = [u for u in seg.utterances if (u.refined_text or u.raw_text).strip()]
            if not utts:
                continue
            lines.append(f"--- {seg.order_index}. {seg.topic_title} ---")
            for utt in utts:
                body = utt.refined_text.strip() or utt.raw_text.strip()
                mark = "[待搞懂] " if utt.is_bookmarked and utt.bookmark_kind == "confused" else (
                    "[重点] " if utt.is_bookmarked else ""
                )
                lines.append(f"[{utt.timestamp_text}] {utt.speaker_label}：{mark}{body}")
                if utt.user_note:
                    lines.append(f"    批注：{utt.user_note}")
            lines.append("")

    return "\n".join(lines).strip() + "\n"


def build_anki_tsv(workspace: Workspace) -> str:
    lines = ["#separator:tab", "#html:false", f"#deck:知聆课堂::{workspace.session.title}"]
    if workspace.flashcards:
        for card in workspace.flashcards:
            front = " ".join(card.front.replace("\t", " ").splitlines()).strip()
            back = " ".join(card.back.replace("\t", " ").splitlines()).strip()
            tag = re.sub(r"\s+", "_", card.tag.strip()) if card.tag else "知聆课堂"
            if front and back:
                lines.append(f"{front}\t{back}\t{tag}")
    else:
        for term, exp, topic in _collect_all_highlights(workspace):
            front = term.replace("\t", " ").strip()
            back = exp.replace("\t", " ").strip()
            tag = re.sub(r"\s+", "_", topic.strip()) or "重点术语"
            lines.append(f"{front}\t{back}\t{tag}")
    return "\n".join(lines) + "\n"


class _DocxBuilder:
    """Zero-dependency OpenXML (.docx) generator styled in Feishu classic office blue."""

    def __init__(self):
        self.body = ET.Element(_w("body"))

    @staticmethod
    def _set_run_style(
        rpr: ET.Element,
        *,
        bold: bool = False,
        italic: bool = False,
        color: str | None = None,
        size_half_pt: int = 22,
        mono: bool = False,
    ):
        fonts = ET.SubElement(rpr, _w("rFonts"))
        font_name = "Consolas" if mono else "Microsoft YaHei"
        fonts.set(_w("ascii"), font_name)
        fonts.set(_w("hAnsi"), font_name)
        fonts.set(_w("eastAsia"), "Microsoft YaHei")
        if bold:
            ET.SubElement(rpr, _w("b"))
        if italic:
            ET.SubElement(rpr, _w("i"))
        if color:
            c = ET.SubElement(rpr, _w("color"))
            c.set(_w("val"), color)
        sz = ET.SubElement(rpr, _w("sz"))
        sz.set(_w("val"), str(size_half_pt))
        sz_cs = ET.SubElement(rpr, _w("szCs"))
        sz_cs.set(_w("val"), str(size_half_pt))

    def add_paragraph(
        self,
        text: str = "",
        *,
        bold: bool = False,
        italic: bool = False,
        color: str = "1F2329",
        size_half_pt: int = 22,
        space_before: int = 80,
        space_after: int = 120,
        shading_fill: str | None = None,
        left_border_color: str | None = None,
        mono: bool = False,
    ) -> ET.Element:
        p = ET.SubElement(self.body, _w("p"))
        ppr = ET.SubElement(p, _w("pPr"))
        spacing = ET.SubElement(ppr, _w("spacing"))
        spacing.set(_w("before"), str(space_before))
        spacing.set(_w("after"), str(space_after))
        spacing.set(_w("line"), "340")
        spacing.set(_w("lineRule"), "auto")

        if left_border_color:
            pbdr = ET.SubElement(ppr, _w("pBdr"))
            left = ET.SubElement(pbdr, _w("left"))
            left.set(_w("val"), "single")
            left.set(_w("sz"), "18")
            left.set(_w("space"), "8")
            left.set(_w("color"), left_border_color)
            ind = ET.SubElement(ppr, _w("ind"))
            ind.set(_w("left"), "240")

        if shading_fill:
            shd = ET.SubElement(ppr, _w("shd"))
            shd.set(_w("val"), "clear")
            shd.set(_w("color"), "auto")
            shd.set(_w("fill"), shading_fill)

        if text:
            self._append_inline_runs(
                p, text, base_bold=bold, base_italic=italic,
                base_color=color, size_half_pt=size_half_pt, mono=mono,
            )
        return p

    def _append_inline_runs(
        self,
        p: ET.Element,
        text: str,
        *,
        base_bold: bool,
        base_italic: bool,
        base_color: str,
        size_half_pt: int,
        mono: bool,
    ):
        tokens = re.split(r"(\*\*[^*]+\*\*|`[^`]+`)", text)
        for tok in tokens:
            if not tok:
                continue
            run = ET.SubElement(p, _w("r"))
            rpr = ET.SubElement(run, _w("rPr"))
            if tok.startswith("**") and tok.endswith("**") and len(tok) > 4:
                self._set_run_style(
                    rpr, bold=True, italic=base_italic,
                    color=base_color, size_half_pt=size_half_pt, mono=mono,
                )
                content = tok[2:-2]
            elif tok.startswith("`") and tok.endswith("`") and len(tok) > 2:
                self._set_run_style(
                    rpr, bold=base_bold, italic=base_italic,
                    color="1456F0", size_half_pt=max(20, size_half_pt - 2), mono=True,
                )
                content = tok[1:-1]
            else:
                self._set_run_style(
                    rpr, bold=base_bold, italic=base_italic,
                    color=base_color, size_half_pt=size_half_pt, mono=mono,
                )
                content = tok
            t = ET.SubElement(run, _w("t"))
            t.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
            t.text = content

    def add_heading(self, text: str, level: int = 1):
        if level == 1:
            self.add_paragraph(
                text, bold=True, color="1456F0", size_half_pt=34,
                space_before=240, space_after=160,
            )
        elif level == 2:
            self.add_paragraph(
                text, bold=True, color="1456F0", size_half_pt=28,
                space_before=220, space_after=120, left_border_color="1456F0",
            )
        else:
            self.add_paragraph(
                text, bold=True, color="1F2329", size_half_pt=24,
                space_before=160, space_after=80,
            )

    def add_markdown_blocks(self, md: str):
        in_code = False
        code_lines: list[str] = []
        for raw_line in md.splitlines():
            line = raw_line.rstrip("\r")
            if line.strip().startswith("```"):
                if in_code:
                    if code_lines:
                        for cl in code_lines:
                            self.add_paragraph(
                                cl or " ", color="1F2329", size_half_pt=20,
                                space_before=20, space_after=20, shading_fill="F5F6F7", mono=True,
                            )
                        code_lines.clear()
                    in_code = False
                else:
                    in_code = True
                continue
            if in_code:
                code_lines.append(line)
                continue

            stripped = line.strip()
            if not stripped:
                continue
            if stripped.startswith("### "):
                self.add_heading(stripped[4:].strip(), level=3)
            elif stripped.startswith("## "):
                self.add_heading(stripped[3:].strip(), level=2)
            elif stripped.startswith("# "):
                self.add_heading(stripped[2:].strip(), level=2)
            elif stripped.startswith("> "):
                self.add_paragraph(
                    stripped[2:].strip(), color="4E5969", size_half_pt=21,
                    left_border_color="3370FF", shading_fill="F0F4FF",
                )
            elif re.match(r"^[-*+]\s+", stripped):
                bullet_body = re.sub(r"^[-*+]\s+", "", stripped)
                self.add_paragraph(f"• {bullet_body}", size_half_pt=22, space_before=40, space_after=60)
            else:
                self.add_paragraph(stripped, size_half_pt=22)

    def add_table(self, headers: list[str], rows: list[list[str]]):
        tbl = ET.SubElement(self.body, _w("tbl"))
        tbl_pr = ET.SubElement(tbl, _w("tblPr"))
        tbl_w = ET.SubElement(tbl_pr, _w("tblW"))
        tbl_w.set(_w("w"), "5000")
        tbl_w.set(_w("type"), "pct")
        borders = ET.SubElement(tbl_pr, _w("tblBorders"))
        for side in ("top", "left", "bottom", "right", "insideH", "insideV"):
            b = ET.SubElement(borders, _w(side))
            b.set(_w("val"), "single")
            b.set(_w("sz"), "6")
            b.set(_w("space"), "0")
            b.set(_w("color"), "DEE0E3")

        def append_row(cells: list[str], is_header: bool):
            tr = ET.SubElement(tbl, _w("tr"))
            for cell_text in cells:
                tc = ET.SubElement(tr, _w("tc"))
                tc_pr = ET.SubElement(tc, _w("tcPr"))
                if is_header:
                    shd = ET.SubElement(tc_pr, _w("shd"))
                    shd.set(_w("val"), "clear")
                    shd.set(_w("color"), "auto")
                    shd.set(_w("fill"), "EBF2FF")
                p = ET.SubElement(tc, _w("p"))
                ppr = ET.SubElement(p, _w("pPr"))
                sp = ET.SubElement(ppr, _w("spacing"))
                sp.set(_w("before"), "60")
                sp.set(_w("after"), "60")
                self._append_inline_runs(
                    p,
                    cell_text,
                    base_bold=is_header,
                    base_italic=False,
                    base_color="1456F0" if is_header else "1F2329",
                    size_half_pt=21,
                    mono=False,
                )

        append_row(headers, True)
        for row in rows:
            append_row(row, False)

    def to_bytes(self) -> bytes:
        sect_pr = ET.SubElement(self.body, _w("sectPr"))
        pg_sz = ET.SubElement(sect_pr, _w("pgSz"))
        pg_sz.set(_w("w"), "11906")
        pg_sz.set(_w("h"), "16838")
        pg_mar = ET.SubElement(sect_pr, _w("pgMar"))
        for attr, val in (("top", "1440"), ("right", "1440"), ("bottom", "1440"), ("left", "1440")):
            pg_mar.set(_w(attr), val)

        doc = ET.Element(_w("document"))
        doc.append(self.body)
        document_xml = ET.tostring(doc, encoding="utf-8", xml_declaration=True)

        content_types = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/word/document.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
            '</Types>'
        )
        rels = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" '
            'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
            'Target="word/document.xml"/>'
            '</Relationships>'
        )

        buf = BytesIO()
        with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("[Content_Types].xml", content_types.encode("utf-8"))
            zf.writestr("_rels/.rels", rels.encode("utf-8"))
            zf.writestr("word/document.xml", document_xml)
        return buf.getvalue()


def build_docx(workspace: Workspace, req: SessionExportRequest) -> bytes:
    builder = _DocxBuilder()
    session = workspace.session
    builder.add_heading(session.title, level=1)
    builder.add_paragraph(
        f"课堂时长：{_format_duration_cn(session.duration_seconds)}    "
        f"知识分段：{len(workspace.segments)} 节    "
        f"更新日期：{session.updated_at[:10]}",
        color="646A73",
        size_half_pt=20,
        shading_fill="F5F6F7",
    )

    if req.include_study_note and workspace.study_note and workspace.study_note.content_markdown.strip():
        builder.add_heading("一、全课精编笔记", level=2)
        builder.add_markdown_blocks(workspace.study_note.content_markdown)

    highlights = _collect_all_highlights(workspace) if req.include_highlights else []
    if highlights:
        builder.add_heading("二、核心术语与概念速查表", level=2)
        builder.add_table(
            ["重点术语", "课堂语境释义", "所属段落"],
            [[term, exp, topic] for term, exp, topic in highlights],
        )

    if req.include_chat and workspace.messages:
        builder.add_heading("三、课堂问答精选", level=2)
        for msg in workspace.messages:
            if msg.role == "user":
                builder.add_paragraph(
                    f"提问：{msg.content.strip()}",
                    bold=True,
                    color="1456F0",
                    shading_fill="EBF2FF",
                )
            else:
                builder.add_markdown_blocks(msg.content)

    if req.include_transcript and workspace.segments:
        builder.add_heading("四、分段课堂逐字精修记录", level=2)
        for seg in workspace.segments:
            utts = [u for u in seg.utterances if (u.refined_text or u.raw_text).strip()]
            if not utts:
                continue
            builder.add_heading(f"{seg.order_index}. {seg.topic_title}", level=3)
            if seg.detailed_explanation:
                builder.add_paragraph(
                    f"段落提要：{seg.detailed_explanation.elaboration.strip()}",
                    color="4E5969",
                    left_border_color="3370FF",
                    shading_fill="F0F4FF",
                )
            for utt in utts:
                body = utt.refined_text.strip() or utt.raw_text.strip()
                badge = " [待搞懂]" if utt.is_bookmarked and utt.bookmark_kind == "confused" else (
                    " [重点]" if utt.is_bookmarked else ""
                )
                builder.add_paragraph(
                    f"**[{utt.timestamp_text}] {utt.speaker_label}{badge}**：{body}",
                    space_before=40,
                    space_after=60,
                )
                if utt.user_note:
                    builder.add_paragraph(
                        f"个人批注：{utt.user_note}",
                        italic=True,
                        color="646A73",
                        size_half_pt=20,
                        space_before=20,
                        space_after=60,
                        shading_fill="FFFBE6",
                    )

    return builder.to_bytes()


def export_session_document(
    workspace: Workspace, req: SessionExportRequest,
) -> tuple[bytes, str, dict[str, str]]:
    base_name = _safe_filename(workspace.session.title)
    match req.format:
        case "markdown":
            raw = build_markdown(workspace, req).encode("utf-8")
            ext, mime = "md", "text/markdown; charset=utf-8"
        case "txt":
            raw = build_plain_text(workspace, req).encode("utf-8")
            ext, mime = "txt", "text/plain; charset=utf-8"
        case "docx":
            raw = build_docx(workspace, req)
            ext = "docx"
            mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        case "anki":
            raw = build_anki_tsv(workspace).encode("utf-8")
            ext, mime = "tsv", "text/tab-separated-values; charset=utf-8"
    filename = f"{base_name}.{ext}"
    encoded = quote(filename, safe="")
    headers = {
        "Content-Disposition": f"attachment; filename=\"classroom.{ext}\"; filename*=UTF-8''{encoded}",
        "Cache-Control": "no-store",
    }
    return raw, mime, headers
