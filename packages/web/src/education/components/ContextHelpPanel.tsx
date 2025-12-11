import React, { useCallback, useMemo, useState } from 'react';
import { useGlossary } from '../hooks/useGlossary';
import type { GlossaryId, GlossaryTerm } from '../glossary/terms';
import { GlossaryTermLink } from './TermTooltip';
import { InfoButton } from '../../components/ui';

export interface ContextHelpPanelProps {
  heading?: string;
  description?: string;
  topics?: GlossaryId[];
  relatedIds?: GlossaryId[];
}

export function ContextHelpPanel({
  heading = 'Context Help',
  description = 'Key concepts related to your current view.',
  topics = [],
  relatedIds = [],
}: ContextHelpPanelProps): JSX.Element {
  const { getTerm, relatedTerms, linkText } = useGlossary();
  const [collapsed, setCollapsed] = useState(false);

  const primaryTerms: GlossaryTerm[] = useMemo(() => {
    return topics
      .map((id) => getTerm(id))
      .filter((t): t is GlossaryTerm => Boolean(t));
  }, [getTerm, topics]);

  const related: GlossaryTerm[] = useMemo(() => {
    if (relatedIds.length) {
      return relatedIds
        .map((id) => getTerm(id))
        .filter((t): t is GlossaryTerm => Boolean(t));
    }
    // If no explicit related, derive from first primary
    const seed = primaryTerms[0];
    if (!seed) return [];
    return relatedTerms(seed.id);
  }, [getTerm, primaryTerms, relatedIds, relatedTerms]);

  const renderLinkedText = useCallback(
    (text: string) =>
      linkText(text, (term, label, index) => (
        <GlossaryTermLink termId={term.id} key={`${term.id}-${index}`}>
          {label}
        </GlossaryTermLink>
      )),
    [linkText],
  );

  return (
    <div className={`context-help ${collapsed ? 'context-help--collapsed' : ''}`}>
      <div className="context-help__header">
        <div>
          <p className="context-help__eyebrow">Learn</p>
          <h3 className="context-help__title">{heading}</h3>
          <p className="context-help__desc">{description}</p>
        </div>
        <InfoButton
          size="sm"
          label={collapsed ? 'Expand help' : 'Collapse help'}
          onClick={() => setCollapsed((v) => !v)}
          tooltip={collapsed ? 'Show context help' : 'Hide context help'}
        />
      </div>

      {!collapsed && (
        <>
          <div className="context-help__section">
            <p className="context-help__section-title">Key concepts</p>
            {primaryTerms.length === 0 ? (
              <p className="text-dim">No context detected yet.</p>
            ) : (
              <ul className="context-help__list">
                {primaryTerms.map((term) => (
                  <li key={term.id} className="context-help__item">
                    <div className="context-help__term">
                      <GlossaryTermLink termId={term.id}>{term.term}</GlossaryTermLink>
                    </div>
                    <div className="context-help__summary">
                      {renderLinkedText(term.shortDef)}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {related.length > 0 && (
            <div className="context-help__section">
              <p className="context-help__section-title">Related</p>
              <ul className="context-help__chips">
                {related.map((term) => (
                  <li key={term.id} className="chip chip-ghost">
                    <GlossaryTermLink termId={term.id}>{term.term}</GlossaryTermLink>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default ContextHelpPanel;
