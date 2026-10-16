/**
 * Canonical SVG icons from prototype/messenger-shell/desktop.html.
 */

export function ChatIcon({ className }: { className?: string }) {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <path d="M3 10a7 7 0 1114 0 7 7 0 01-14 0z" stroke="currentColor" strokeWidth="1.5" />
      <path d="M6.2 13.4L4.9 16.8l3.3-1.5" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

export function SettingsIcon({ className }: { className?: string }) {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <circle cx="10" cy="10" r="2.6" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10 2.5v2M10 15.5v2M17.5 10h-2M4.5 10h-2M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4M15.3 15.3l-1.4-1.4M6.1 6.1L4.7 4.7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function PanelIcon({ className }: { className?: string }) {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <rect x="2.5" y="3.5" width="15" height="13" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7.5 3.5v13" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

export function ListIcon({ className }: { className?: string }) {
  return (
    <svg width="19" height="19" viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <path d="M3 5.5h14M3 10h14M3 14.5h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function PhoneIcon({ className }: { className?: string }) {
  return (
    <svg width="19" height="19" viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <path d="M6.2 3.2c.5-.4 1.2-.3 1.6.2l1.5 2.2c.4.5.3 1.2-.2 1.6l-.9.8c.7 1.5 1.8 2.6 3.3 3.3l.8-.9c.4-.5 1.1-.6 1.6-.2l2.2 1.5c.5.4.6 1.1.2 1.6l-.8 1.2c-.5.7-1.4 1-2.2.8C9.9 16.8 3.2 10.1 2.7 5.6c-.2-.8.1-1.7.8-2.2l1.2-.8z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

export function VideoIcon({ className }: { className?: string }) {
  return (
    <svg width="19" height="19" viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <rect x="2.5" y="5" width="11" height="10" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M13.5 8.8l4-2.6v7.6l-4-2.6" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

export function InfoIcon({ className }: { className?: string }) {
  return (
    <svg width="19" height="19" viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <circle cx="10" cy="10" r="7.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10 9v4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="10" cy="6.6" r=".9" fill="currentColor" />
    </svg>
  );
}

export function ClipIcon({ className }: { className?: string }) {
  return (
    <svg width="19" height="19" viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <path d="M16.5 8.5l-5.8 5.8a3.1 3.1 0 01-4.4-4.4l6.2-6.2a2.1 2.1 0 013 3L9 13.3a1 1 0 01-1.5-1.5l5.6-5.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function SmileIcon({ className }: { className?: string }) {
  return (
    <svg width="19" height="19" viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <circle cx="10" cy="10" r="7.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7 11.4c.7.9 1.7 1.4 3 1.4s2.3-.5 3-1.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="7.6" cy="7.9" r=".95" fill="currentColor" />
      <circle cx="12.4" cy="7.9" r=".95" fill="currentColor" />
    </svg>
  );
}

export function SendIcon({ className }: { className?: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" className={className} aria-hidden="true">
      <path d="M2.5 9L15.5 3l-4 12-2.6-4.4L2.5 9z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

export function SearchIcon({ className }: { className?: string }) {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <circle cx="7" cy="7" r="4.6" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10.6 10.6L14 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function PlusIcon({ className }: { className?: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" className={className} aria-hidden="true">
      <path d="M9 3.5v11M3.5 9h11" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}
