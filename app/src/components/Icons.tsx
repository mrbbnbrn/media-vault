// Small stroke icons. Decorative unless given a label.

type P = { size?: number };
const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
});

export const LockIcon = ({ size = 20 }: P) => (
  <svg {...base(size)}>
    <rect x="4" y="10" width="16" height="11" rx="2" />
    <path d="M8 10V7a4 4 0 0 1 8 0v3" />
  </svg>
);
export const FolderIcon = ({ size = 18 }: P) => (
  <svg {...base(size)}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </svg>
);
export const WarnIcon = ({ size = 18 }: P) => (
  <svg {...base(size)}>
    <path d="M12 3l9 16H3z" />
    <path d="M12 10v4" />
    <path d="M12 17h.01" />
  </svg>
);
export const OfflineIcon = ({ size = 14 }: P) => (
  <svg {...base(size)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18" />
    <path d="M4 4l16 16" />
  </svg>
);
export const BackIcon = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <path d="M15 6l-6 6 6 6" />
  </svg>
);
export const GearIcon = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </svg>
);
export const PlusIcon = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);
export const ImagesIcon = ({ size = 28 }: P) => (
  <svg {...base(size)}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <circle cx="9" cy="10" r="2" />
    <path d="M21 16l-5-5-8 8" />
  </svg>
);
export const SearchIcon = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-3.5-3.5" />
  </svg>
);
export const PlayIcon = ({ size = 16 }: P) => (
  <svg {...base(size)} fill="currentColor" stroke="none">
    <path d="M7 4l13 8-13 8z" />
  </svg>
);
export const PauseIcon = ({ size = 16 }: P) => (
  <svg {...base(size)} fill="currentColor" stroke="none">
    <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
  </svg>
);
export const PrevIcon = ({ size = 16 }: P) => (
  <svg {...base(size)} fill="currentColor" stroke="none">
    <path d="M6 5h2v14H6zM20 5v14L9 12z" />
  </svg>
);
export const NextIcon = ({ size = 16 }: P) => (
  <svg {...base(size)} fill="currentColor" stroke="none">
    <path d="M16 5h2v14h-2zM4 5v14l11-7z" />
  </svg>
);
export const ShuffleIcon = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <path d="M16 3h5v5" />
    <path d="M4 20L21 3" />
    <path d="M21 16v5h-5" />
    <path d="M15 15l6 6" />
    <path d="M4 4l5 5" />
  </svg>
);
export const RepeatIcon = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <path d="M17 2l4 4-4 4" />
    <path d="M3 11V9a3 3 0 0 1 3-3h15" />
    <path d="M7 22l-4-4 4-4" />
    <path d="M21 13v2a3 3 0 0 1-3 3H3" />
  </svg>
);
export const SoundIcon = ({ size = 18 }: P) => (
  <svg {...base(size)}>
    <path d="M4 9v6h4l5 4V5L8 9z" />
    <path d="M16 9a4 4 0 0 1 0 6" />
    <path d="M18.5 6.5a8 8 0 0 1 0 11" />
  </svg>
);
export const MuteIcon = ({ size = 18 }: P) => (
  <svg {...base(size)}>
    <path d="M4 9v6h4l5 4V5L8 9z" />
    <path d="M17 9l5 6" />
    <path d="M22 9l-5 6" />
  </svg>
);
export const FullscreenIcon = ({ size = 18 }: P) => (
  <svg {...base(size)}>
    <path d="M4 9V4h5" />
    <path d="M20 9V4h-5" />
    <path d="M4 15v5h5" />
    <path d="M20 15v5h-5" />
  </svg>
);
export const HeartIcon = ({ size = 16, filled = false }: P & { filled?: boolean }) => (
  <svg {...base(size)} fill={filled ? 'currentColor' : 'none'}>
    <path d="M12 21s-7.5-4.6-9.5-9.2C1.2 8.6 3.4 5 6.9 5c2 0 3.6 1.1 5.1 3 1.5-1.9 3.1-3 5.1-3 3.5 0 5.7 3.6 4.4 6.8C19.5 16.4 12 21 12 21z" />
  </svg>
);
export const GridIcon = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <rect x="3" y="3" width="8" height="8" />
    <rect x="13" y="3" width="8" height="8" />
    <rect x="3" y="13" width="8" height="8" />
    <rect x="13" y="13" width="8" height="8" />
  </svg>
);
export const CloseIcon = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);
export const ChevronIcon = ({ size = 14, open = false }: P & { open?: boolean }) => (
  <svg {...base(size)} style={{ transform: open ? 'rotate(90deg)' : undefined, transition: 'transform 0.12s' }}>
    <path d="M9 6l6 6-6 6" />
  </svg>
);
export const TagIcon = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z" />
    <circle cx="7.5" cy="7.5" r="1.5" />
  </svg>
);
export const WeightIcon = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <path d="M6 8h12l2 12H4z" />
    <circle cx="12" cy="5" r="2" />
  </svg>
);
export const TrashIcon = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />
  </svg>
);
export const MoveIcon = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    <path d="M10 13h6M13 10l3 3-3 3" />
  </svg>
);
export const BrokenIcon = ({ size = 22 }: P) => (
  <svg {...base(size)}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M3 5l18 14" />
  </svg>
);
export const ImportIcon = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <path d="M12 3v12M7 10l5 5 5-5" />
    <path d="M4 17v3h16v-3" />
  </svg>
);
export const DiceIcon = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <rect x="4" y="4" width="16" height="16" rx="3" />
    <path d="M8.5 8.5h.01M15.5 15.5h.01M15.5 8.5h.01M8.5 15.5h.01M12 12h.01" strokeWidth={3} />
  </svg>
);
export const ChartIcon = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <path d="M4 20h16" />
    <path d="M7 16v-5M12 16V7M17 16v-8" />
  </svg>
);
export const PinIcon = ({ size = 14 }: P) => (
  <svg {...base(size)}>
    <path d="M9 4h6l-1 5 3 3H7l3-3z" />
    <path d="M12 12v8" />
  </svg>
);
export const HelpIcon = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.3" />
    <path d="M12 17h.01" />
  </svg>
);
export const ClockIcon = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
);
export const UndoIcon = ({ size = 14 }: P) => (
  <svg {...base(size)}>
    <path d="M9 14L4 9l5-5" />
    <path d="M4 9h10a6 6 0 0 1 0 12h-3" />
  </svg>
);
export const SheetIcon = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <rect x="3" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="3" width="7" height="7" rx="1" />
    <rect x="3" y="14" width="7" height="7" rx="1" />
    <rect x="14" y="14" width="7" height="7" rx="1" />
  </svg>
);
export const BookmarkIcon = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <path d="M6 3h12v18l-6-4-6 4z" />
  </svg>
);
export const CameraIcon = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <path d="M4 8h3l2-3h6l2 3h3v11H4z" />
    <circle cx="12" cy="13" r="3.5" />
  </svg>
);
export const FrameBackIcon = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <path d="M6 5v14" />
    <path d="M18 6l-8 6 8 6z" />
  </svg>
);
export const FrameNextIcon = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <path d="M18 5v14" />
    <path d="M6 6l8 6-8 6z" />
  </svg>
);
export const LoopIcon = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <path d="M17 2l3 3-3 3" />
    <path d="M4 11V9a4 4 0 0 1 4-4h12" />
    <path d="M7 22l-3-3 3-3" />
    <path d="M20 13v2a4 4 0 0 1-4 4H4" />
  </svg>
);
export const GifIcon = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M10 10H8v4h2v-2M13 10v4M16 14v-4h2M16 12h1.5" strokeWidth={1.6} />
  </svg>
);
export const RestoreIcon = ({ size = 14 }: P) => (
  <svg {...base(size)}>
    <path d="M3 12a9 9 0 1 0 3-6.7" />
    <path d="M3 4v5h5" />
  </svg>
);
export const FaceIcon = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21a8 8 0 0 1 16 0" />
  </svg>
);
export const SparkleIcon = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
    <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" strokeWidth={1.5} />
  </svg>
);
export const ShieldIcon = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z" />
    <path d="M9 12l2 2 4-4" />
  </svg>
);
export const ExportIcon = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <path d="M12 15V3" />
    <path d="M7 8l5-5 5 5" />
    <path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" />
  </svg>
);
