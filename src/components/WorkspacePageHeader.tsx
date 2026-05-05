import type { ReactNode } from 'react';

interface WorkspacePageHeaderProps {
  title: string;
  description: string;
  eyebrow?: string;
  children?: ReactNode;
}

export function WorkspacePageHeader({
  title,
  description,
  eyebrow,
  children,
}: WorkspacePageHeaderProps) {
  return (
    <header className="workspace-page-header">
      <div className="workspace-page-header__copy">
        {eyebrow && <span className="workspace-page-header__eyebrow">{eyebrow}</span>}
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      {children && (
        <div className="workspace-page-header__aside">
          {children}
        </div>
      )}
    </header>
  );
}
