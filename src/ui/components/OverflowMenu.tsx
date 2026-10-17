import { useEffect, useRef, type ReactNode } from 'react';

export const OverflowMenu = ({
  children,
  className = '',
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) => {
  const detailsRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      const details = detailsRef.current;
      if (details?.open && event.target instanceof Node && !details.contains(event.target)) {
        details.open = false;
      }
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, []);

  return (
    <details
      ref={detailsRef}
      className={`overflow-menu${className ? ` ${className}` : ''}`}
      onClick={(event) => {
        if (
          event.target instanceof Element &&
          event.target.closest<HTMLElement>('[data-menu-close="true"]')
        ) {
          window.setTimeout(() => {
            if (detailsRef.current) detailsRef.current.open = false;
          }, 0);
        }
      }}
    >
      <summary role="button" aria-label="More actions">
        <span className="sr-only">More actions</span>
        <span aria-hidden="true">•••</span>
      </summary>
      <div className="overflow-menu__panel">{children}</div>
    </details>
  );
};
