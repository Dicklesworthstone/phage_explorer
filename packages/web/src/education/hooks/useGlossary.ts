import type { ReactNode } from 'react';
import { createElement, useMemo } from 'react';
import { glossaryCategories, glossaryIndex, GLOSSARY_TERMS } from '../glossary/terms';
import type { GlossaryCategory, GlossaryId, GlossaryTerm } from '../glossary/terms';

export interface UseGlossaryResult {
  terms: GlossaryTerm[];
  categories: GlossaryCategory[];
  getTerm: (id: GlossaryId) => GlossaryTerm | undefined;
  searchTerms: (query: string) => GlossaryTerm[];
  relatedTerms: (id: GlossaryId) => GlossaryTerm[];
  filterByCategory: (category: GlossaryCategory | 'all') => GlossaryTerm[];
  linkText: (
    text: string,
    render?: (term: GlossaryTerm, label: string, index: number) => ReactNode
  ) => ReactNode[];
}

export function useGlossary(): UseGlossaryResult {
  const terms = useMemo(() => GLOSSARY_TERMS, []);

  const categories = useMemo(() => glossaryCategories, []);

  const getTerm = (id: GlossaryId): GlossaryTerm | undefined => glossaryIndex.get(id);

  const indexByLower = useMemo(() => {
    const map = new Map<string, GlossaryTerm>();
    for (const term of terms) {
      map.set(term.term.toLowerCase(), term);
    }
    return map;
  }, [terms]);

  const matcher = useMemo(() => {
    const escaped = terms
      .map((t) => t.term)
      .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .sort((a, b) => b.length - a.length); // prefer longest matches first
    if (escaped.length === 0) return null;
    return new RegExp(`\\b(${escaped.join('|')})\\b`, 'gi');
  }, [terms]);

  const searchTerms = (query: string): GlossaryTerm[] => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return terms;
    return terms.filter((term) => {
      return (
        term.term.toLowerCase().includes(normalized) ||
        term.shortDef.toLowerCase().includes(normalized) ||
        term.longDef.toLowerCase().includes(normalized)
      );
    });
  };

  const relatedTerms = (id: GlossaryId): GlossaryTerm[] => {
    const entry = glossaryIndex.get(id);
    if (!entry?.related?.length) return [];
    return entry.related
      .map((relId) => glossaryIndex.get(relId))
      .filter((rel): rel is GlossaryTerm => Boolean(rel));
  };

  const filterByCategory = (category: GlossaryCategory | 'all'): GlossaryTerm[] => {
    if (category === 'all') return terms;
    return terms.filter((term) => term.category === category);
  };

  const linkText = (
    text: string,
    render: (term: GlossaryTerm, label: string, index: number) => ReactNode = (term, label, index) =>
      createElement('strong', { key: `${term.id}-${index}` }, label)
  ): ReactNode[] => {
    if (!matcher) return [text];

    const nodes: ReactNode[] = [];
    let lastIndex = 0;
    let matchIndex = 0;

    for (const match of text.matchAll(matcher)) {
      const start = match.index ?? 0;
      const matchedText = match[0];

      if (start > lastIndex) {
        nodes.push(text.slice(lastIndex, start));
      }

      const term = indexByLower.get(matchedText.toLowerCase());
      if (term) {
        nodes.push(render(term, matchedText, matchIndex));
      } else {
        nodes.push(matchedText);
      }

      lastIndex = start + matchedText.length;
      matchIndex += 1;
    }

    if (lastIndex < text.length) {
      nodes.push(text.slice(lastIndex));
    }

    return nodes;
  };

  return {
    terms,
    categories,
    getTerm,
    searchTerms,
    relatedTerms,
    filterByCategory,
    linkText,
  };
}

export default useGlossary;
