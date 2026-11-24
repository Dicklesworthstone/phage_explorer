import { useEffect } from 'react';

// Sheets and the catalog drawer can overlap or unmount in any order. Snapshot
// each set of styles once; only its last owner restores it.
function sharedLock(apply: () => () => void) {
  let owners = 0;
  let restore: (() => void) | undefined;
  return () => {
    if (owners === 0) restore = apply();
    owners++;
    return () => {
      if (--owners === 0) {
        restore?.();
        restore = undefined;
      }
    };
  };
}

function setStyles(element: HTMLElement, properties: Record<string, string>) {
  const style = element.style;
  const previous = Object.keys(properties).map(property => ({
    property, value: style.getPropertyValue(property), priority: style.getPropertyPriority(property),
  }));
  for (const [property, value] of Object.entries(properties)) style.setProperty(property, value);
  return () => {
    for (const { property, value, priority } of previous) style.setProperty(property, value, priority);
  };
}

const lockOverflow = sharedLock(() => {
  const restoreBody = setStyles(document.body, {
    'overflow-x': 'hidden', 'overflow-y': 'hidden',
    'overscroll-behavior-x': 'none', 'overscroll-behavior-y': 'none',
  });
  const appBody = document.querySelector<HTMLElement>('.app-body');
  const restoreApp = appBody && setStyles(appBody, {
    'overflow-x': 'hidden', 'overflow-y': 'hidden', 'overscroll-behavior-y': 'none',
  });
  return () => {
    restoreApp?.();
    restoreBody();
  };
});

const lockPosition = sharedLock(() => {
  const { scrollX, scrollY } = window;
  const restoreBody = setStyles(document.body, {
    position: 'fixed', top: `-${scrollY}px`, left: `-${scrollX}px`, right: '0', width: '100%', 'padding-right': '0',
  });
  return () => {
    restoreBody();
    window.scrollTo(scrollX, scrollY);
  };
});

export function useModalScrollLock(active: boolean, fixPosition: boolean): void {
  useEffect(() => {
    if (!active) return;
    const releaseOverflow = lockOverflow();
    const releasePosition = fixPosition ? lockPosition() : undefined;
    return () => {
      releaseOverflow();
      releasePosition?.();
    };
  }, [active, fixPosition]);
}
