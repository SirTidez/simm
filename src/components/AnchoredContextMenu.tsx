import { useEffect, useMemo, useRef } from 'react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
} from '@/components/ui/context-menu';
import { Icon } from './Icon';

export interface AnchoredContextMenuItem {
  key: string;
  label: string;
  icon?: string;
  disabled?: boolean;
  danger?: boolean;
  onSelect: () => void;
}

interface Props {
  id?: string;
  x: number;
  y: number;
  items: AnchoredContextMenuItem[];
  onClose: () => void;
}

export function AnchoredContextMenu({ id, x, y, items, onClose }: Props) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const anchor = useMemo(
    () => ({
      getBoundingClientRect: () => new DOMRect(x, y, 0, 0),
    }),
    [x, y],
  );

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (menuRef.current && target && !menuRef.current.contains(target)) {
        onClose();
      }
    };

    const handleContextMenu = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (menuRef.current && target && !menuRef.current.contains(target)) {
        onClose();
      }
    };

    document.addEventListener('mousedown', handlePointerDown, true);
    document.addEventListener('contextmenu', handleContextMenu, true);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown, true);
      document.removeEventListener('contextmenu', handleContextMenu, true);
    };
  }, [onClose]);

  return (
    <ContextMenu
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <ContextMenuContent
        id={id}
        anchor={anchor}
        align="start"
        collisionAvoidance={{ side: 'shift', align: 'shift', fallbackAxisSide: 'end' }}
        collisionPadding={10}
        className="workspace-context-menu"
        positionMethod="fixed"
        ref={menuRef}
        side="bottom"
        sideOffset={0}
      >
        <ContextMenuGroup>
          {items.map((item) => (
            <ContextMenuItem
              key={item.key}
              className={`workspace-context-menu__item ${item.danger ? 'workspace-context-menu__item--danger' : ''}`}
              disabled={item.disabled}
              onClick={() => {
                if (item.disabled) return;
                item.onSelect();
              }}
              variant={item.danger ? 'destructive' : 'default'}
            >
              {item.icon ? <Icon name={item.icon} /> : <span className="workspace-context-menu__icon-placeholder" />}
              <span>{item.label}</span>
            </ContextMenuItem>
          ))}
        </ContextMenuGroup>
      </ContextMenuContent>
    </ContextMenu>
  );
}
