import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useGlossary } from '../hooks/useGlossary';
import { useContextTopic } from '../hooks/useBeginnerMode';
import { GlossaryTermLink } from '../components/TermTooltip';
import type { GlossaryCategory } from './terms';

interface GlossaryPanelProps {
  onSelect?: (termId: string) => void;
}

export function GlossaryPanel({ onSelect }: GlossaryPanelProps): React.ReactElement {
  const { terms, categories, searchTerms, filterByCategory, linkText, getTerm } = useGlossary();
  const contextTopic = useContextTopic();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<GlossaryCategory | 'all'>('all');
  const [alpha, setAlpha] = useState<string | 'all'>('all');
  const [activeId, setActiveId] = useState<string | null>(contextTopic);
  const listRef = useRef<HTMLDivElement | null>(null);

  const renderLinked = useCallback(
    (text: string) =>
      linkText(text, (term, label, index) => (
        <GlossaryTermLink termId={term.id} key={`${term.id}-${index}`}>
          {label}
        </GlossaryTermLink>
      )),
    [linkText],
  );

  const categoryTerms = useMemo(
    () => (category === 'all' ? terms : filterByCategory(category)),
    [category, filterByCategory, terms]
  );

  const filtered = useMemo(() => {
    let base = categoryTerms;
    if (query.trim()) {
      const matches = searchTerms(query);
      base = matches.filter((term) => (category === 'all' ? true : term.category === category));
    }
    if (alpha !== 'all') {
      base = base.filter((term) => term.term.toUpperCase().startsWith(alpha));
    }
    return base;
  }, [alpha, category, categoryTerms, query, searchTerms]);

  const alphabet = useMemo(() => {
    const letters = new Set<string>();
    categoryTerms.forEach((term) => {
      const letter = term.term.charAt(0).toUpperCase();
      if (letter) letters.add(letter);
    });
    return Array.from(letters).sort();
  }, [categoryTerms]);

  useEffect(() => {
    setAlpha('all');
  }, [category]);

  useEffect(() => {
    if (!contextTopic) return;
    setQuery('');
    setCategory('all');
    setAlpha('all');
    setActiveId(contextTopic);

    if (typeof window === 'undefined') return;
    const raf = window.requestAnimationFrame(() => {
      const element = listRef.current?.querySelector<HTMLElement>(`[data-term-id="${contextTopic}"]`);
      if (!element) return;
      element.scrollIntoView({ block: 'nearest' });
      element.focus();
    });
    return () => window.cancelAnimationFrame(raf);
  }, [contextTopic]);

  useEffect(() => {
    if (filtered.length === 0) {
      setActiveId(null);
      return;
    }
    const stillVisible = filtered.some((t) => t.id === activeId);
    if (!stillVisible) {
      setActiveId(filtered[0].id);
    }
  }, [activeId, filtered]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (filtered.length === 0) return;
    const currentIndex = filtered.findIndex((t) => t.id === activeId);
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      const nextIndex = currentIndex < 0 ? 0 : Math.min(filtered.length - 1, currentIndex + 1);
      setActiveId(filtered[nextIndex].id);
      listRef.current?.querySelector<HTMLElement>(`[data-term-id="${filtered[nextIndex].id}"]`)?.focus();
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      const prevIndex = currentIndex < 0 ? 0 : Math.max(0, currentIndex - 1);
      setActiveId(filtered[prevIndex].id);
      listRef.current?.querySelector<HTMLElement>(`[data-term-id="${filtered[prevIndex].id}"]`)?.focus();
    }
    if (event.key === 'Enter' && currentIndex >= 0) {
      event.preventDefault();
      const termId = filtered[currentIndex].id;
      onSelect?.(termId);
    }
  };

  const active = filtered.find((t) => t.id === activeId) ?? filtered[0];

  return (
    <div className="glossary-panel">
      <div className="glossary-panel__sidebar">
        <div className="glossary-panel__controls">
          <div className="glossary-panel__search-row">
            <input
              data-glossary-search
              aria-label="Search glossary"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search terms"
              className="input glossary-panel__search"
            />
          </div>
          <div role="tablist" aria-label="Glossary categories" className="glossary-panel__chips">
            <button
              role="tab"
              aria-selected={category === 'all'}
              onClick={() => setCategory('all')}
              className="chip"
              type="button"
            >
              All
            </button>
            {categories.map((cat) => {
              const selected = category === cat;
              return (
                <button
                  key={cat}
                  role="tab"
                  aria-selected={selected}
                  onClick={() => setCategory(cat)}
                  className="chip"
                  type="button"
                >
                  {cat}
                </button>
              );
            })}
          </div>
          {alphabet.length > 0 && (
            <div aria-label="Jump to terms by first letter" className="glossary-panel__chips glossary-panel__chips--alpha">
              <button type="button" onClick={() => setAlpha('all')} className="chip chip-ghost" aria-pressed={alpha === 'all'}>
                All
              </button>
              {alphabet.map((letter) => (
                <button
                  key={letter}
                  type="button"
                  onClick={() => setAlpha(letter)}
                  className="chip chip-ghost"
                  aria-pressed={alpha === letter}
                >
                  {letter}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="glossary-panel__list">
          <div
            ref={listRef}
            data-glossary-listbox
            tabIndex={0}
            onKeyDown={handleKeyDown}
            role="listbox"
            className="glossary-panel__listbox"
          >
            {filtered.map((term) => {
              const isActive = active?.id === term.id;
              return (
                <button
                  key={term.id}
                  data-term-id={term.id}
                  role="option"
                  onClick={() => {
                    setActiveId(term.id);
                    onSelect?.(term.id);
                  }}
                  aria-selected={isActive}
                  className="glossary-panel__term"
                >
                  <div className="glossary-panel__term-title">{term.term}</div>
                  <div className="glossary-panel__term-desc">{term.shortDef}</div>
                </button>
              );
            })}
            {filtered.length === 0 && <div className="glossary-panel__empty">No terms found</div>}
          </div>
        </div>
      </div>

      <div className="glossary-panel__detail">
        {active ? (
          <>
            <div className="glossary-panel__detail-header">
              <div>
                <div className="glossary-panel__detail-eyebrow">{active.category}</div>
                <div className="glossary-panel__detail-title">
                  <GlossaryTermLink termId={active.id}>{active.term}</GlossaryTermLink>
                </div>
              </div>
            </div>
            <div className="glossary-panel__detail-body">{renderLinked(active.longDef)}</div>
            {active.related?.length ? (
              <div className="glossary-panel__related">
                <div className="glossary-panel__related-label">Related</div>
                <div className="glossary-panel__related-list">
                  {active.related.map((rel) => (
                    <GlossaryTermLink termId={rel} key={rel}>
                      <span className="chip glossary-panel__related-chip">{getTerm(rel)?.term ?? String(rel)}</span>
                    </GlossaryTermLink>
                  ))}
                </div>
              </div>
            ) : null}
          </>
        ) : (
          <div className="glossary-panel__empty-detail">Select a term to view its definition.</div>
        )}
      </div>
    </div>
  );
}

export default GlossaryPanel;
