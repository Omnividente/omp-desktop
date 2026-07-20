import type { SVGProps } from "react";

export type IconName =
  | "alert"
  | "arrow"
  | "check"
  | "chevron"
  | "clock"
  | "close"
  | "command"
  | "edit"
  | "trash"
  | "external"
  | "folder"
  | "folderOpen"
  | "history"
  | "logo"
  | "panel"
  | "play"
  | "plus"
  | "refresh"
  | "search"
  | "settings"
  | "spark"
  | "terminal";

interface IconProps extends SVGProps<SVGSVGElement> {
  name: IconName;
  size?: number;
}

const paths: Record<Exclude<IconName, "logo">, string[]> = {
  alert: ["M12 9v4", "M12 17h.01", "M10.3 3.9 2.5 17.5A2 2 0 0 0 4.2 20h15.6a2 2 0 0 0 1.7-2.5L13.7 3.9a2 2 0 0 0-3.4 0Z"],
  arrow: ["m9 18 6-6-6-6"],
  check: ["m5 12 4 4L19 6"],
  chevron: ["m9 18 6-6-6-6"],
  clock: ["M12 6v6l4 2", "M22 12a10 10 0 1 1-10-10 10 10 0 0 1 10 10Z"],
  close: ["m6 6 12 12", "m18 6-12 12"],
  command: ["M18 9a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12Z"],
  edit: ["m16.5 3.5 4 4L7 21H3v-4L16.5 3.5Z", "m14.5 5.5 4 4"],
  external: ["M15 3h6v6", "m10 11 11-11", "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"],
  folder: ["M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"],
  folderOpen: ["M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1", "M3 17.5 5.2 11h17.3l-2.2 6.5A2 2 0 0 1 18.4 19H4.9A2 2 0 0 1 3 17.5Z"],
  history: ["M3 12a9 9 0 1 0 3-6.7L3 8", "M3 3v5h5", "M12 7v5l3 2"],
  panel: ["M4 4h16v16H4z", "M9 4v16"],
  play: ["m8 5 11 7-11 7Z"],
  plus: ["M12 5v14", "M5 12h14"],
  refresh: ["M20 11a8 8 0 1 0-2.3 5.7L20 14", "M20 19v-5h-5"],
  search: ["m21 21-4.3-4.3", "M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z"],
  settings: ["M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z", "M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2 3.4-.2-.1a1.7 1.7 0 0 0-1.9-.2l-1 .6a1.7 1.7 0 0 0-.9 1.5v.2H10v-.2a1.7 1.7 0 0 0-.9-1.5l-1-.6a1.7 1.7 0 0 0-1.9.2l-.2.1L4 17l.1-.1a1.7 1.7 0 0 0 .3-1.9l-.6-1a1.7 1.7 0 0 0-1.5-.9H2V9h.3a1.7 1.7 0 0 0 1.5-.9l.6-1a1.7 1.7 0 0 0-.3-1.9L4 5l2-3.4.2.1a1.7 1.7 0 0 0 1.9.2l1-.6a1.7 1.7 0 0 0 .9-1.5V0h4v.2a1.7 1.7 0 0 0 .9 1.5l1 .6a1.7 1.7 0 0 0 1.9-.2l.2-.1 2 3.4-.1.1a1.7 1.7 0 0 0-.3 1.9l.6 1a1.7 1.7 0 0 0 1.5.9h.3v4h-.3a1.7 1.7 0 0 0-1.5.9Z"],
  spark: ["m12 3-1.1 3.3A4 4 0 0 1 8.3 9L5 10l3.3 1.1a4 4 0 0 1 2.6 2.6L12 17l1.1-3.3a4 4 0 0 1 2.6-2.6L19 10l-3.3-1.1a4 4 0 0 1-2.6-2.6Z", "m5 3 .5 1.5L7 5l-1.5.5L5 7l-.5-1.5L3 5l1.5-.5Z", "m19 17 .5 1.5L21 19l-1.5.5L19 21l-.5-1.5L17 19l1.5-.5Z"],
  terminal: ["m4 7 5 5-5 5", "M12 17h8"],
  trash: ["M4 7h16", "M9 7V4h6v3", "M6 7l1 14h10l1-14", "M10 11v6", "M14 11v6"],
};

export function Icon({ name, size = 18, ...props }: IconProps) {
  if (name === "logo") {
    return (
      <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" {...props}>
        <path d="M12 2.4 20.3 7v10L12 21.6 3.7 17V7L12 2.4Z" fill="currentColor" opacity=".18" />
        <path d="M8.1 8.2 12 6l3.9 2.2v4.5L12 15l-3.9-2.3V8.2Z" fill="currentColor" />
        <path d="m9.5 17.5 2.5 1.4 5.6-3.2V9.3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    );
  }

  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {paths[name].map((path) => (
        <path d={path} key={path} />
      ))}
    </svg>
  );
}
