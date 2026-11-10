const S = { viewBox: '0 0 16 16', width: 14, height: 14, fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

export const Icon = {
  crosshair: () => (
    <svg {...S}>
      <circle cx="8" cy="8" r="4.5" />
      <path d="M8 1v3M8 12v3M1 8h3M12 8h3" />
    </svg>
  ),
  sides: () => (
    <svg {...S}>
      <path d="M3 2v12M13 2v12M2 3h12M2 13h12" opacity=".45" />
      <rect x="5" y="5" width="6" height="6" rx="1" />
    </svg>
  ),
  corners: () => (
    <svg {...S}>
      <path d="M2 6V4a2 2 0 012-2h2M10 2h2a2 2 0 012 2v2M14 10v2a2 2 0 01-2 2h-2M6 14H4a2 2 0 01-2-2v-2" />
    </svg>
  ),
  padX: () => (
    <svg {...S}>
      <path d="M2 3v10M14 3v10" />
      <path d="M5 8h6M5 8l1.5-1.5M5 8l1.5 1.5M11 8l-1.5-1.5M11 8l-1.5 1.5" />
    </svg>
  ),
  padY: () => (
    <svg {...S}>
      <path d="M3 2h10M3 14h10" />
      <path d="M8 5v6M8 5L6.5 6.5M8 5l1.5 1.5M8 11l-1.5-1.5M8 11l1.5-1.5" />
    </svg>
  ),
  top: () => (
    <svg {...S}>
      <path d="M3 3h10" />
      <rect x="4" y="6" width="8" height="7" rx="1" opacity=".45" />
    </svg>
  ),
  right: () => (
    <svg {...S}>
      <path d="M13 3v10" />
      <rect x="3" y="4" width="7" height="8" rx="1" opacity=".45" />
    </svg>
  ),
  bottom: () => (
    <svg {...S}>
      <path d="M3 13h10" />
      <rect x="4" y="3" width="8" height="7" rx="1" opacity=".45" />
    </svg>
  ),
  left: () => (
    <svg {...S}>
      <path d="M3 3v10" />
      <rect x="6" y="4" width="7" height="8" rx="1" opacity=".45" />
    </svg>
  ),
  radius: () => (
    <svg {...S}>
      <path d="M3 13V8a5 5 0 015-5h5" />
    </svg>
  ),
  alignLeft: () => (
    <svg {...S}>
      <path d="M2 4h12M2 8h8M2 12h10" />
    </svg>
  ),
  alignCenter: () => (
    <svg {...S}>
      <path d="M2 4h12M4 8h8M3 12h10" />
    </svg>
  ),
  alignRight: () => (
    <svg {...S}>
      <path d="M2 4h12M6 8h8M4 12h10" />
    </svg>
  ),
  alignJustify: () => (
    <svg {...S}>
      <path d="M2 4h12M2 8h12M2 12h12" />
    </svg>
  ),
  file: () => (
    <svg {...S}>
      <path d="M4 1.5h5l3 3v10H4z" />
      <path d="M9 1.5v3h3" />
    </svg>
  ),
  diff: () => (
    <svg {...S}>
      <path d="M5 2v6M2 5h6M9 12h5" />
      <rect x="1.5" y="1.5" width="7" height="7" rx="1" opacity=".35" />
    </svg>
  ),
  undo: () => (
    <svg {...S}>
      <path d="M5 4L2 7l3 3" />
      <path d="M2 7h7a4 4 0 010 8H6" />
    </svg>
  ),
  redo: () => (
    <svg {...S}>
      <path d="M11 4l3 3-3 3" />
      <path d="M14 7H7a4 4 0 000 8h3" />
    </svg>
  ),
  /* 描边：粗细和三种线型 */
  stroke: () => (
    <svg {...S}>
      <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" strokeWidth="2.2" />
    </svg>
  ),
  solid: () => (
    <svg {...S}>
      <path d="M2 8h12" strokeWidth="1.6" />
    </svg>
  ),
  dashed: () => (
    <svg {...S}>
      <path d="M2 8h12" strokeWidth="1.6" strokeDasharray="3.2 2.2" strokeLinecap="butt" />
    </svg>
  ),
  dotted: () => (
    <svg {...S}>
      <path d="M2.5 8h11.5" strokeWidth="1.8" strokeDasharray="0.01 3" />
    </svg>
  ),
  x: () => (
    <svg {...S}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  ),
  check: () => (
    <svg {...S}>
      <path d="M3 8.5l3 3 7-7" />
    </svg>
  ),
  agent: () => (
    <svg {...S}>
      <path d="M8 1.5l1.6 3.9 3.9 1.6-3.9 1.6L8 12.5 6.4 8.6 2.5 7l3.9-1.6z" />
    </svg>
  ),
  globe: () => (
    <svg {...S}>
      <circle cx="8" cy="8" r="6.5" />
      <path d="M1.5 8h13M8 1.5c2 2 2 11 0 13M8 1.5c-2 2-2 11 0 13" />
    </svg>
  ),
  ruler: () => (
    <svg {...S}>
      <rect x="1.5" y="5" width="13" height="6" rx="1" />
      <path d="M4 5v2M6.5 5v3M9 5v2M11.5 5v3" />
    </svg>
  ),
  download: () => (
    <svg {...S}>
      <path d="M8 2v8M4.5 6.5L8 10l3.5-3.5M2.5 13.5h11" />
    </svg>
  ),
  code: () => (
    <svg {...S}>
      <path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5" />
    </svg>
  ),
  image: () => (
    <svg {...S}>
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
      <circle cx="6" cy="6.5" r="1.2" />
      <path d="M2.5 12l3.5-3.5 2.5 2.5 2-2 3 3" />
    </svg>
  ),
  video: () => (
    <svg {...S}>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M6.75 5.75v4.5L10.5 8z" />
    </svg>
  ),
  w: () => <b className="glyph">W</b>,
  h: () => <b className="glyph">H</b>,
  /* 主轴分布（按横向主轴画，纵向时整体旋转） */
  jStart: () => (
    <svg {...S}>
      <path d="M1.5 2.5v11" />
      <rect x="3.5" y="5" width="3" height="6" rx=".6" />
      <rect x="8" y="5" width="3" height="6" rx=".6" />
    </svg>
  ),
  jCenter: () => (
    <svg {...S}>
      <path d="M8 2v12" opacity=".4" />
      <rect x="3.5" y="5" width="3" height="6" rx=".6" />
      <rect x="9.5" y="5" width="3" height="6" rx=".6" />
    </svg>
  ),
  jEnd: () => (
    <svg {...S}>
      <path d="M14.5 2.5v11" />
      <rect x="5" y="5" width="3" height="6" rx=".6" />
      <rect x="9.5" y="5" width="3" height="6" rx=".6" />
    </svg>
  ),
  jBetween: () => (
    <svg {...S}>
      <path d="M1.5 2.5v11M14.5 2.5v11" />
      <rect x="3" y="5" width="3" height="6" rx=".6" />
      <rect x="10" y="5" width="3" height="6" rx=".6" />
    </svg>
  ),
  jAround: () => (
    <svg {...S}>
      <path d="M1.5 2.5v11M14.5 2.5v11" opacity=".4" />
      <rect x="4" y="5" width="2.5" height="6" rx=".6" />
      <rect x="9.5" y="5" width="2.5" height="6" rx=".6" />
      <path d="M2.5 8h1M12.5 8h1" />
    </svg>
  ),
  jEvenly: () => (
    <svg {...S}>
      <path d="M1.5 2.5v11M14.5 2.5v11" opacity=".4" />
      <rect x="3.5" y="5" width="2" height="6" rx=".5" />
      <rect x="7" y="5" width="2" height="6" rx=".5" />
      <rect x="10.5" y="5" width="2" height="6" rx=".5" />
    </svg>
  ),
  /* 交叉轴对齐（按纵向交叉轴画） */
  aStart: () => (
    <svg {...S}>
      <path d="M2.5 1.5h11" />
      <rect x="4" y="3.5" width="3" height="9" rx=".6" />
      <rect x="9" y="3.5" width="3" height="5" rx=".6" />
    </svg>
  ),
  aCenter: () => (
    <svg {...S}>
      <path d="M2 8h12" opacity=".4" />
      <rect x="4" y="3.5" width="3" height="9" rx=".6" />
      <rect x="9" y="5.5" width="3" height="5" rx=".6" />
    </svg>
  ),
  aEnd: () => (
    <svg {...S}>
      <path d="M2.5 14.5h11" />
      <rect x="4" y="3.5" width="3" height="9" rx=".6" />
      <rect x="9" y="7.5" width="3" height="5" rx=".6" />
    </svg>
  ),
  aStretch: () => (
    <svg {...S}>
      <path d="M2.5 1.5h11M2.5 14.5h11" />
      <rect x="4" y="3.5" width="3" height="9" rx=".6" />
      <rect x="9" y="3.5" width="3" height="9" rx=".6" />
    </svg>
  ),
  aBaseline: () => (
    <svg {...S}>
      <path d="M2 10h12" opacity=".5" />
      <path d="M3.5 10l1.75-6 1.75 6M4.1 8h2.3" />
      <path d="M9.5 10V6.5h2.25a1.75 1.75 0 010 3.5" />
    </svg>
  ),
  layers: () => (
    <svg {...S}>
      <path d="M8 2l6 3.2-6 3.2-6-3.2z" />
      <path d="M2 8.4l6 3.2 6-3.2" opacity=".5" />
    </svg>
  ),
  wrap: () => (
    <svg {...S}>
      <path d="M2 4h10a2.5 2.5 0 010 5H5" />
      <path d="M6.5 7.5L5 9l1.5 1.5" />
      <path d="M2 13h5" />
    </svg>
  ),
};
