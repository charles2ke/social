import type { ReactNode, SVGProps } from "react";

/**
 * Original line glyphs — one per supported platform, plus the handful of UI
 * icons the shell needs. They are stroked with `currentColor`, so a single set
 * works in both themes and no icon dependency is required.
 */
type IconProps = SVGProps<SVGSVGElement> & { title?: string };

function Icon({ title, children, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? "img" : "presentation"}
      aria-hidden={title ? undefined : true}
      {...props}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

const glyphs: Record<string, ReactNode> = {
  instagram: (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" rx="5" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="17" cy="7" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  facebook: (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" rx="5" />
      <path d="M14.5 8h-1.2A2.3 2.3 0 0 0 11 10.3V20" />
      <path d="M9 13h5" />
    </>
  ),
  whatsapp: (
    <>
      <path d="M20 11.7a8 8 0 0 1-11.9 7L4 20l1.4-4A8 8 0 1 1 20 11.7Z" />
      <path d="M9.3 9.4c.4 2.6 2.7 4.9 5.3 5.3l1-1.4 1.5.8" />
    </>
  ),
  linkedin: (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" rx="5" />
      <path d="M8 11v6" />
      <path d="M8 8.2h.01" />
      <path d="M12 17v-6" />
      <path d="M12 13.6a2.4 2.4 0 0 1 4.8 0V17" />
    </>
  ),
  substack: (
    <>
      <path d="M5 5h14" />
      <path d="M5 9.8h14" />
      <path d="M5 14.6 12 19l7-4.4" />
    </>
  ),
  youtube: (
    <>
      <rect x="2.5" y="5.5" width="19" height="13" rx="4.5" />
      <path d="m10.5 9.5 4.5 2.5-4.5 2.5Z" fill="currentColor" />
    </>
  ),
  snapchat: (
    <>
      <path d="M12 3.5c2.6 0 4.2 1.9 4.2 4.4 0 1-.1 1.9-.1 2.6.6.4 1.4.3 2 0 .5.9-.6 1.7-1.8 2.2.6 1.7 2 2.9 3.6 3.2-.2.7-1.7 1.1-3 1.2-.2.4-.3 1-.6 1.3-.9.5-2.2-.6-4.3-.6s-3.4 1.1-4.3.6c-.3-.3-.4-.9-.6-1.3-1.3-.1-2.8-.5-3-1.2 1.6-.3 3-1.5 3.6-3.2-1.2-.5-2.3-1.3-1.8-2.2.6.3 1.4.4 2 0 0-.7-.1-1.6-.1-2.6C7.8 5.4 9.4 3.5 12 3.5Z" />
    </>
  ),
  tiktok: (
    <>
      <path d="M14 4c.4 2.4 1.9 3.9 4.3 4.2" />
      <path d="M14 4v10.4a4.6 4.6 0 1 1-3.4-4.4" />
    </>
  ),
  strava: (
    <>
      <path d="M10 3.5 4.5 14h3.3L10 9.6 12.2 14h3.3L10 3.5Z" />
      <path d="M14.2 14 12.6 17l-1.6-3H8.4l4.2 6.5L16.8 14h-2.6Z" />
    </>
  ),
};

export function PlatformIcon({ platform, ...props }: IconProps & { platform: string }) {
  return <Icon {...props}>{glyphs[platform] ?? <circle cx="12" cy="12" r="8" />}</Icon>;
}

export const HomeIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m4 10.5 8-6.5 8 6.5V19a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19Z" />
    <path d="M9.5 20.5v-6h5v6" />
  </Icon>
);

export const SetupIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 14a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1v.3a2 2 0 1 1-4 0v-.2a1.6 1.6 0 0 0-2.8-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3.5 13H3.3a2 2 0 1 1 0-4h.2A1.6 1.6 0 0 0 4.6 6.3l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 2.7-1.1V2a2 2 0 1 1 4 0v.2a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7h.3a2 2 0 1 1 0 4h-.2a1.6 1.6 0 0 0-1.4 1Z" />
  </Icon>
);

export const SunIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.5v2M12 19.5v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2.5 12h2M19.5 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </Icon>
);

export const MoonIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />
  </Icon>
);

export const SystemIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="3" y="4.5" width="18" height="12" rx="2" />
    <path d="M9 20.5h6M12 16.5v4" />
  </Icon>
);

export const PlusIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);

export const TrashIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 7h16M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7" />
    <path d="M6.5 7 7.4 19a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4L17.5 7" />
  </Icon>
);

export const CheckIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m5 12.5 4.5 4.5L19 7" />
  </Icon>
);

export const AlertIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5v5M12 16h.01" />
  </Icon>
);

export const LinkIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M10 13.5a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-1.2 1.2" />
    <path d="M14 10.5a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l1.2-1.2" />
  </Icon>
);

export const CopyIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M15 6.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h.5" />
  </Icon>
);

export const MenuIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Icon>
);
