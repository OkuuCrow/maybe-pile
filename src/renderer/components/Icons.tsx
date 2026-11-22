/** Inline SVG icons (decorative: aria-hidden; meaning always carried by text). */
import type { ReactElement } from 'react';
import type { MediaType, Status } from '../../shared/enums';

interface IconProps {
  size?: number;
}

const base = (size: number, children: ReactElement | ReactElement[]) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    {children}
  </svg>
);

export const IconPlus = ({ size = 18 }: IconProps) =>
  base(size, [<path key="a" d="M12 5v14" />, <path key="b" d="M5 12h14" />]);
export const IconSearch = ({ size = 18 }: IconProps) =>
  base(size, [<circle key="a" cx="11" cy="11" r="7" />, <path key="b" d="m20 20-3.5-3.5" />]);
export const IconHome = ({ size = 18 }: IconProps) =>
  base(size, [<path key="a" d="M3 11 12 4l9 7" />, <path key="b" d="M5 10v10h14V10" />]);
export const IconStack = ({ size = 18 }: IconProps) =>
  base(size, [
    <rect key="a" x="4" y="14" width="16" height="5" rx="1" />,
    <rect key="b" x="5" y="8" width="14" height="5" rx="1" />,
    <rect key="c" x="7" y="3" width="10" height="4" rx="1" />,
  ]);
export const IconGear = ({ size = 18 }: IconProps) =>
  base(size, [
    <circle key="a" cx="12" cy="12" r="3" />,
    <path
      key="b"
      d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"
    />,
  ]);
export const IconClose = ({ size = 18 }: IconProps) =>
  base(size, [<path key="a" d="M18 6 6 18" />, <path key="b" d="m6 6 12 12" />]);
export const IconCheck = ({ size = 18 }: IconProps) => base(size, <path d="M20 6 9 17l-5-5" />);
export const IconAlert = ({ size = 18 }: IconProps) =>
  base(size, [
    <path key="a" d="M12 3 2 21h20L12 3z" />,
    <path key="b" d="M12 10v4" />,
    <path key="c" d="M12 18h.01" />,
  ]);
export const IconInfo = ({ size = 18 }: IconProps) =>
  base(size, [
    <circle key="a" cx="12" cy="12" r="9" />,
    <path key="b" d="M12 11v5" />,
    <path key="c" d="M12 8h.01" />,
  ]);
export const IconExternal = ({ size = 14 }: IconProps) =>
  base(size, [
    <path key="a" d="M14 4h6v6" />,
    <path key="b" d="M10 14 20 4" />,
    <path key="c" d="M20 14v6H4V4h6" />,
  ]);
export const IconGrid = ({ size = 18 }: IconProps) =>
  base(size, [
    <rect key="a" x="4" y="4" width="7" height="7" />,
    <rect key="b" x="13" y="4" width="7" height="7" />,
    <rect key="c" x="4" y="13" width="7" height="7" />,
    <rect key="d" x="13" y="13" width="7" height="7" />,
  ]);
export const IconList = ({ size = 18 }: IconProps) =>
  base(size, [<path key="a" d="M8 6h12M8 12h12M8 18h12" />, <path key="b" d="M4 6h.01M4 12h.01M4 18h.01" />]);
export const IconArrowUp = ({ size = 16 }: IconProps) => base(size, <path d="m6 15 6-6 6 6" />);
export const IconArrowDown = ({ size = 16 }: IconProps) => base(size, <path d="m6 9 6 6 6-6" />);
export const IconRefresh = ({ size = 16 }: IconProps) =>
  base(size, [<path key="a" d="M20 11a8 8 0 1 0-2.3 5.7" />, <path key="b" d="M20 4v7h-7" />]);
export const IconTrash = ({ size = 16 }: IconProps) =>
  base(size, [
    <path key="a" d="M4 7h16" />,
    <path key="b" d="M9 7V4h6v3" />,
    <path key="c" d="M6 7l1 13h10l1-13" />,
  ]);

const typePaths: Record<MediaType, ReactElement> = {
  movie: (
    <g>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M7 5v14M17 5v14M3 9h4M17 9h4M3 15h4M17 15h4" />
    </g>
  ),
  tv: (
    <g>
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <path d="M8 21h8M9 2l3 4 3-4" />
    </g>
  ),
  game: (
    <g>
      <path d="M6 9h12a4 4 0 0 1 0 8l-2-2H8l-2 2a4 4 0 0 1 0-8z" />
      <path d="M8 11v3M6.5 12.5h3M15 12h.01M17 13h.01" />
    </g>
  ),
  book: (
    <g>
      <path d="M4 4h6a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4z" />
      <path d="M20 4h-6a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h7z" />
    </g>
  ),
};

export const TypeIcon = ({ type, size = 16 }: { type: MediaType; size?: number }) =>
  base(size, typePaths[type]);

const statusPaths: Record<Status, ReactElement> = {
  planned: <circle cx="12" cy="12" r="8" strokeDasharray="3 3" />,
  in_progress: (
    <g>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" />
    </g>
  ),
  completed: (
    <g>
      <circle cx="12" cy="12" r="8" />
      <path d="m8 12 3 3 5-6" />
    </g>
  ),
  on_hold: (
    <g>
      <circle cx="12" cy="12" r="8" />
      <path d="M10 9v6M14 9v6" />
    </g>
  ),
  dropped: (
    <g>
      <circle cx="12" cy="12" r="8" />
      <path d="M9 9l6 6M15 9l-6 6" />
    </g>
  ),
};

export const StatusIcon = ({ status, size = 14 }: { status: Status; size?: number }) =>
  base(size, statusPaths[status]);
