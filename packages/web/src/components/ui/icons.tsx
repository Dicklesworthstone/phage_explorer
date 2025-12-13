import React from 'react';

export type IconProps = {
  size?: number;
  title?: string;
  className?: string;
  strokeWidth?: number;
};

type IconBaseProps = IconProps & {
  children: React.ReactNode;
  viewBox?: string;
};

function IconBase({
  size = 16,
  title,
  className,
  strokeWidth = 2,
  viewBox = '0 0 24 24',
  children,
}: IconBaseProps): React.ReactElement {
  const ariaProps = title ? { role: 'img' as const, 'aria-label': title } : { 'aria-hidden': true as const };

  return (
    <svg
      width={size}
      height={size}
      viewBox={viewBox}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...ariaProps}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

export function IconSettings(props: IconProps): React.ReactElement {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V22a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H2a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33 1.65 1.65 0 0 0 1-1.51V2a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82 1.65 1.65 0 0 0 1.51 1H22a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </IconBase>
  );
}

export function IconSearch(props: IconProps): React.ReactElement {
  return (
    <IconBase {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </IconBase>
  );
}

export function IconLearn(props: IconProps): React.ReactElement {
  return (
    <IconBase {...props}>
      <path d="M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2z" />
      <path d="M22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z" />
    </IconBase>
  );
}

export function IconCube(props: IconProps): React.ReactElement {
  return (
    <IconBase {...props}>
      <path d="M21 16V8a2 2 0 0 0-1-1.73L13 2.27a2 2 0 0 0-2 0L4 6.27A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4a2 2 0 0 0 1-1.73z" />
      <path d="M3.27 6.96L12 12l8.73-5.04" />
      <path d="M12 22V12" />
    </IconBase>
  );
}

export function IconChevronDown(props: IconProps): React.ReactElement {
  return (
    <IconBase {...props}>
      <polyline points="6 9 12 15 18 9" />
    </IconBase>
  );
}

export function IconChevronUp(props: IconProps): React.ReactElement {
  return (
    <IconBase {...props}>
      <polyline points="18 15 12 9 6 15" />
    </IconBase>
  );
}

export function IconArrowLeft(props: IconProps): React.ReactElement {
  return (
    <IconBase {...props}>
      <path d="M19 12H5" />
      <polyline points="12 19 5 12 12 5" />
    </IconBase>
  );
}

export function IconArrowRight(props: IconProps): React.ReactElement {
  return (
    <IconBase {...props}>
      <path d="M5 12h14" />
      <polyline points="12 5 19 12 12 19" />
    </IconBase>
  );
}

export function IconRepeat(props: IconProps): React.ReactElement {
  return (
    <IconBase {...props}>
      <polyline points="17 1 21 5 17 9" />
      <path d="M3 11V9a4 4 0 0 1 4-4h14" />
      <polyline points="7 23 3 19 7 15" />
      <path d="M21 13v2a4 4 0 0 1-4 4H3" />
    </IconBase>
  );
}

export function IconLayers(props: IconProps): React.ReactElement {
  return (
    <IconBase {...props}>
      <polygon points="12 2 2 7 12 12 22 7 12 2" />
      <polyline points="2 17 12 22 22 17" />
      <polyline points="2 12 12 17 22 12" />
    </IconBase>
  );
}

export function IconTarget(props: IconProps): React.ReactElement {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="3" />
      <path d="M22 12h-4" />
      <path d="M6 12H2" />
      <path d="M12 6V2" />
      <path d="M12 22v-4" />
    </IconBase>
  );
}

export function IconDiff(props: IconProps): React.ReactElement {
  return (
    <IconBase {...props}>
      <path d="M4 12h6" />
      <path d="M14 12h6" />
      <path d="M17 9v6" />
    </IconBase>
  );
}

export function IconDna(props: IconProps): React.ReactElement {
  return (
    <IconBase {...props}>
      <path d="M7 3c5 5 5 13 0 18" />
      <path d="M17 3c-5 5-5 13 0 18" />
      <path d="M9 7h6" />
      <path d="M8 11h8" />
      <path d="M9 15h6" />
      <path d="M10 19h4" />
    </IconBase>
  );
}

export function IconTrendingUp(props: IconProps): React.ReactElement {
  return (
    <IconBase {...props}>
      <polyline points="23 6 13.5 15.5 8.5 10.5 1 18" />
      <polyline points="17 6 23 6 23 12" />
    </IconBase>
  );
}

export function IconAperture(props: IconProps): React.ReactElement {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="10" />
      <line x1="14.31" y1="8" x2="20.05" y2="17.94" />
      <line x1="9.69" y1="8" x2="21.17" y2="8" />
      <line x1="7.38" y1="12" x2="13.12" y2="2.06" />
      <line x1="9.69" y1="16" x2="3.95" y2="6.06" />
      <line x1="14.31" y1="16" x2="2.83" y2="16" />
      <line x1="16.62" y1="12" x2="10.88" y2="21.94" />
    </IconBase>
  );
}

export function IconMagnet(props: IconProps): React.ReactElement {
  return (
    <IconBase {...props}>
      <path d="M6 3v10a6 6 0 0 0 12 0V3" />
      <path d="M6 7h4" />
      <path d="M14 7h4" />
    </IconBase>
  );
}

export function IconFlask(props: IconProps): React.ReactElement {
  return (
    <IconBase {...props}>
      <path d="M10 2v6.5l-5 8.5a2 2 0 0 0 1.7 3h10.6a2 2 0 0 0 1.7-3l-5-8.5V2" />
      <path d="M8 2h8" />
      <path d="M9 9h6" />
    </IconBase>
  );
}

export function IconKeyboard(props: IconProps): React.ReactElement {
  return (
    <IconBase {...props}>
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <path d="M6 10h.01" />
      <path d="M10 10h.01" />
      <path d="M14 10h.01" />
      <path d="M18 10h.01" />
      <path d="M6 14h12" />
    </IconBase>
  );
}

export function IconAlertTriangle(props: IconProps): React.ReactElement {
  return (
    <IconBase {...props}>
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </IconBase>
  );
}

export function IconShield(props: IconProps): React.ReactElement {
  return (
    <IconBase {...props}>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </IconBase>
  );
}

export function IconBookmark(props: IconProps): React.ReactElement {
  return (
    <IconBase {...props}>
      <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
    </IconBase>
  );
}

export function IconUsers(props: IconProps): React.ReactElement {
  return (
    <IconBase {...props}>
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </IconBase>
  );
}

export function IconContrast(props: IconProps): React.ReactElement {
  const { title, className, size = 16, strokeWidth = 2 } = props;
  const ariaProps = title ? { role: 'img' as const, 'aria-label': title } : { 'aria-hidden': true as const };

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...ariaProps}
    >
      {title ? <title>{title}</title> : null}
      <circle cx="12" cy="12" r="10" />
      <path d="M12 2a10 10 0 0 1 0 20V2z" fill="currentColor" stroke="none" />
    </svg>
  );
}
