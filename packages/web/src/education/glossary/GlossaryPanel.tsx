import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useGlossary } from '../hooks/useGlossary';
import { useContextTopic } from '../hooks/useBeginnerMode';
import { GlossaryTermLink } from '../components/TermTooltip';
import type { GlossaryCategory } from './terms';

interface GlossaryPanelProps {
  onSelect?: (termId: string) => void;
}

export function GlossaryPanel({ onSelect }: GlossaryPanelProps): React.ReactElement {
  const { terms, categories, searchTerms, filterByCategory, linkText } = useGlossary();
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
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(220px, 280px) 1fr',
        gap: '0.75rem',
        height: '100%',
        minHeight: 360,
        position: 'relative',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <input
              aria-label="Search glossary"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search terms"
              style={{
                flex: 1,
                padding: '0.45rem 0.65rem',
                borderRadius: 8,
                border: '1px solid var(--color-border-subtle)',
                background: 'var(--color-background-alt)',
                color: 'var(--color-text)',
              }}
            />
          </div>
          <div
            role="tablist"
            aria-label="Glossary categories"
            style={{
              display: 'flex',
              gap: 6,
              overflowX: 'auto',
              paddingBottom: 2,
            }}
          >
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
                  style={{
                    background: selected ? 'var(--color-surface-1)' : 'transparent',
                    borderColor: selected ? 'var(--color-accent, #22d3ee)' : 'var(--color-border-subtle)',
                    color: selected ? 'var(--color-accent, #22d3ee)' : 'var(--color-text)',
                  }}
                >
                  {cat}
                </button>
              );
            })}
          </div>
          {alphabet.length > 0 && (
            <div
              aria-label="Jump to terms by first letter"
              style={{
                display: 'flex',
                gap: 6,
                flexWrap: 'wrap',
              }}
            >
              <button
                type="button"
                onClick={() => setAlpha('all')}
                className="chip chip-ghost"
                aria-pressed={alpha === 'all'}
              >
                All
              </button>
              {alphabet.map((letter) => (
                <button
                  key={letter}
                  type="button"
                  onClick={() => setAlpha(letter)}
                  className="chip chip-ghost"
                  aria-pressed={alpha === letter}
                  style={{
                    background: alpha === letter ? 'var(--color-surface-1)' : 'transparent',
                    color: alpha === letter ? 'var(--color-accent, #22d3ee)' : 'var(--color-text)',
                    borderColor: alpha === letter ? 'var(--color-accent, #22d3ee)' : 'var(--color-border-subtle)',
                  }}
                >
                  {letter}
                </button>
              ))}
            </div>
          )}
        </div>
        <div
          style={{
            border: '1px solid var(--color-border-subtle)',
            borderRadius: 8,
            overflow: 'hidden',
            flex: 1,
            minHeight: 220,
          }}
        >
          <div
            ref={listRef}
            tabIndex={0}
            onKeyDown={handleKeyDown}
            role="listbox"
            style={{
              maxHeight: '100%',
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
            }}
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
                  style={{
                    textAlign: 'left',
                    padding: '0.55rem 0.75rem',
                    background: isActive ? 'var(--color-background-hover)' : 'transparent',
                    color: 'var(--color-text)',
                    border: 'none',
                    borderBottom: '1px solid var(--color-border-subtle)',
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ fontWeight: 700 }}>
                    <GlossaryTermLink termId={term.id}>{term.term}</GlossaryTermLink>
                  </div>
                  <div style={{ color: 'var(--color-text-muted)', fontSize: '0.85rem' }}>
                    {renderLinked(term.shortDef)}
                  </div>
                </button>
              );
            })}
            {filtered.length === 0 && (
              <div style={{ padding: '0.75rem', color: 'var(--color-text-muted)' }}>No terms found</div>
            )}
          </div>
        </div>
      </div>

      <div
        style={{
          border: '1px solid var(--color-border-subtle)',
          borderRadius: 10,
          padding: '0.75rem 1rem',
          background: 'var(--color-background-alt)',
          minHeight: 240,
        }}
      >
        {active ? (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)', textTransform: 'uppercase' }}>
                  {active.category}
                </div>
                <div style={{ fontSize: '1.15rem', fontWeight: 800 }}>
                  <GlossaryTermLink termId={active.id}>{active.term}</GlossaryTermLink>
                </div>
              </div>
            </div>
            <div style={{ marginTop: 8, lineHeight: 1.5, color: 'var(--color-text)' }}>
              {renderLinked(active.longDef)}
            </div>
            {active.related?.length ? (
              <div style={{ marginTop: 12 }}>
                <div style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)', marginBottom: 4 }}>Related</div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {active.related.map((rel) => (
                    <GlossaryTermLink termId={rel} key={rel}>
                      <span
                        style={{
                          fontSize: '0.85rem',
                          padding: '4px 8px',
                          borderRadius: 8,
                          background: 'rgba(34, 211, 238, 0.12)',
                          color: '#22d3ee',
                          display: 'inline-block',
                        }}
                      >
                        {rel}
                      </span>
                    </GlossaryTermLink>
                  ))}
                </div>
              </div>
            ) : null}
          </>
        ) : (
          <div style={{ color: 'var(--color-text-muted)' }}>Select a term to view its definition.</div>
        )}
      </div>
    </div>
  );
}

export default GlossaryPanel;

