import { useMemo } from 'react';
import { glossaryCategories, glossaryIndex, GLOSSARY_TERMS } from '../glossary/terms';
import type { GlossaryCategory, GlossaryId, GlossaryTerm } from '../glossary/terms';

export interface UseGlossaryResult {
  terms: GlossaryTerm[];
  categories: GlossaryCategory[];
  getTerm: (id: GlossaryId) => GlossaryTerm | undefined;
  searchTerms: (query: string) => GlossaryTerm[];
  relatedTerms: (id: GlossaryId) => GlossaryTerm[];
  filterByCategory: (category: GlossaryCategory | 'all') => GlossaryTerm[];
}

export function useGlossary(): UseGlossaryResult {
  const terms = useMemo(() => GLOSSARY_TERMS, []);

  const categories = useMemo(() => glossaryCategories, []);

  const getTerm = (id: GlossaryId): GlossaryTerm | undefined => glossaryIndex.get(id);

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

  return {
    terms,
    categories,
    getTerm,
    searchTerms,
    relatedTerms,
    filterByCategory,
  };
}

export default useGlossary;

