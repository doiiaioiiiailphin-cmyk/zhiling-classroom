import math
import re
from collections import Counter
from dataclasses import dataclass

from ..schemas import KnowledgeSegment

CONTEXT_LIMIT = 24_000
RECENT_MS = 5 * 60 * 1000
TOKENS = re.compile(r"[a-z0-9_]+|[\u3400-\u9fff]+")


@dataclass(frozen=True)
class Passage:
    order: int
    title: str
    text: str

    def wire(self) -> dict:
        return {"orderIndex": self.order, "topicTitle": self.title, "text": self.text}


def terms(text: str) -> list[str]:
    tokens = []
    for token in TOKENS.findall(text.casefold()):
        if token.isascii():
            tokens.append(token)
        else:
            tokens.extend(token)
            tokens.extend(token[index:index + 2] for index in range(len(token) - 1))
    return tokens


def bm25(question: str, passages: list[Passage]) -> list[int]:
    query = set(terms(question))
    documents = [Counter(terms(passage.title + "\n" + passage.text)) for passage in passages]
    lengths = [sum(counts.values()) for counts in documents]
    average = max(1, sum(lengths) / max(1, len(lengths)))
    frequencies = Counter(token for counts in documents for token in counts.keys() & query)
    weight = {
        token: math.log(1 + (len(documents) - count + 0.5) / (count + 0.5))
        for token, count in frequencies.items()
    }
    scores = []
    for index, (counts, length) in enumerate(zip(documents, lengths)):
        normalizer = 1.2 * (0.25 + 0.75 * length / average)
        score = sum(
            weight[token] * counts[token] * 2.2 / (counts[token] + normalizer)
            for token in counts.keys() & query
        )
        scores.append((score, index))
    return [index for score, index in sorted(scores, reverse=True) if score > 0]


def classroom_context(segments: list[KnowledgeSegment], question: str) -> list[Passage]:
    def line(utterance) -> str:
        return f"[{utterance.timestamp_text}] {utterance.speaker_label}：{utterance.refined_text}"

    non_empty_segments = [
        (seg, [u for u in seg.utterances if u.refined_text.strip()])
        for seg in segments
    ]
    non_empty_segments = [(seg, utts) for seg, utts in non_empty_segments if utts]
    if not non_empty_segments:
        return []

    everything = [
        Passage(seg.order_index, seg.topic_title, "\n".join(line(utterance) for utterance in utts))
        for seg, utts in non_empty_segments
    ]
    cost = sum(len(passage.text) + len(passage.title) + 30 for passage in everything)
    if cost <= CONTEXT_LIMIT:
        return everything

    end = max(utterance.end_time_ms for _, utts in non_empty_segments for utterance in utts)
    older, recent = [], []
    for segment, utts in non_empty_segments:
        prefix = []
        tail = []
        for utterance in utts:
            destination = tail if utterance.end_time_ms >= end - RECENT_MS else prefix
            destination.append(line(utterance))
        for lines, passages in ((prefix, older), (tail, recent)):
            if not lines:
                continue
            text = "\n".join(lines)
            for cursor in range(0, len(text), 1800):
                passages.append(Passage(segment.order_index, segment.topic_title, text[cursor:cursor + 1800]))

    budget = CONTEXT_LIMIT
    chosen_recent = []
    for passage in reversed(recent):
        size = len(passage.text) + len(passage.title) + 30
        if budget - size < CONTEXT_LIMIT // 2:
            break
        chosen_recent.append(passage)
        budget -= size
    matched = []
    for index in bm25(question, older)[:8]:
        passage = older[index]
        size = len(passage.text) + len(passage.title) + 30
        if size <= budget:
            matched.append(index)
            budget -= size
    return sorted(
        [older[index] for index in sorted(matched)] + list(reversed(chosen_recent)), key=lambda item: item.order,
    )
