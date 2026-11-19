import React, { useMemo } from 'react';
import type { HighlightedTerm } from '../../types/domain';
import { MarkdownRenderer } from '../ui/MarkdownRenderer';
import { Tooltip } from '../ui/Tooltip';

interface HighlightedTextProps {
  text: string;
  highlights: HighlightedTerm[];
  enabled: boolean;
}

interface TextSlice {
  key: string;
  content: string;
  termInfo?: HighlightedTerm;
}

export const HighlightedText: React.FC<HighlightedTextProps> = React.memo(({
  text,
  highlights,
  enabled,
}) => {
  const slices = useMemo<TextSlice[]>(() => {
    if (!enabled || !highlights || highlights.length === 0 || !text) {
      return [{ key: 'plain-0', content: text }];
    }

    // 按词条长度降序匹配，避免长专有名词被短词截断
    const validTerms = [...highlights]
      .filter((h) => h.term.trim().length > 0)
      .sort((a, b) => b.term.length - a.term.length);

    if (validTerms.length === 0) {
      return [{ key: 'plain-0', content: text }];
    }

    const matches: Array<{ start: number; end: number; termInfo: HighlightedTerm }> = [];
    const occupied = new Array<boolean>(text.length).fill(false);

    for (const item of validTerms) {
      let fromIndex = 0;
      while (fromIndex < text.length) {
        const foundIdx = text.indexOf(item.term, fromIndex);
        if (foundIdx === -1) break;
        const endIdx = foundIdx + item.term.length;

        let hasOverlap = false;
        for (let i = foundIdx; i < endIdx; i++) {
          if (occupied[i]) {
            hasOverlap = true;
            break;
          }
        }

        if (!hasOverlap) {
          for (let i = foundIdx; i < endIdx; i++) {
            occupied[i] = true;
          }
          matches.push({ start: foundIdx, end: endIdx, termInfo: item });
        }

        fromIndex = foundIdx + 1;
      }
    }

    if (matches.length === 0) {
      return [{ key: 'plain-0', content: text }];
    }

    matches.sort((a, b) => a.start - b.start);

    const result: TextSlice[] = [];
    let cursor = 0;
    matches.forEach((m, idx) => {
      if (m.start > cursor) {
        result.push({
          key: `plain-${idx}-${cursor}`,
          content: text.slice(cursor, m.start),
        });
      }
      result.push({
        key: `hl-${m.termInfo.id}-${m.start}`,
        content: text.slice(m.start, m.end),
        termInfo: m.termInfo,
      });
      cursor = m.end;
    });

    if (cursor < text.length) {
      result.push({
        key: `plain-tail-${cursor}`,
        content: text.slice(cursor),
      });
    }

    return result;
  }, [text, highlights, enabled]);

  return (
    <span className="text-[15px] leading-[1.8] text-[#1F2329]">
      {slices.map((slice) => {
        if (!slice.termInfo) {
          return <React.Fragment key={slice.key}>{slice.content}</React.Fragment>;
        }

        return (
          <Tooltip
            key={slice.key}
            placement="top"
            maxWidthClass="max-w-sm"
            delayMs={80}
            content={
              <div className="space-y-1 py-0.5">
                <div className="text-[14px] font-semibold text-[#1456F0]">
                  {slice.termInfo.term}
                </div>
                <div className="text-[14px] leading-relaxed text-[#1F2329]">
                  <MarkdownRenderer
                    content={slice.termInfo.explanation}
                    variant="compact"
                  />
                </div>
              </div>
            }
          >
            <mark className="bg-[#FFF299] hover:bg-[#FFE46B] text-[#1F2329] rounded-[4px] px-1 py-0.5 border-b border-[#E3C846] transition-colors cursor-help">
              {slice.content}
            </mark>
          </Tooltip>
        );
      })}
    </span>
  );
});

HighlightedText.displayName = 'HighlightedText';
