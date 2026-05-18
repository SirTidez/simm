import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AnchoredContextMenu } from './AnchoredContextMenu';

describe('AnchoredContextMenu', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders menu items and selects enabled actions', async () => {
    const onClose = vi.fn();
    const onSelect = vi.fn();
    const disabledSelect = vi.fn();

    render(
      <AnchoredContextMenu
        x={120}
        y={180}
        onClose={onClose}
        items={[
          {
            key: 'open',
            label: 'Open Folder',
            icon: 'fas fa-folder-open',
            onSelect,
          },
          {
            key: 'disabled',
            label: 'Disabled Action',
            disabled: true,
            onSelect: disabledSelect,
          },
        ]}
      />,
    );

    expect(await screen.findByRole('menu')).toBeTruthy();

    fireEvent.click(screen.getByRole('menuitem', { name: /open folder/i }));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('menuitem', { name: /disabled action/i }));
    expect(disabledSelect).not.toHaveBeenCalled();
  });

  it('closes on Escape', async () => {
    const onClose = vi.fn();

    render(
      <AnchoredContextMenu
        x={120}
        y={180}
        onClose={onClose}
        items={[
          {
            key: 'delete',
            label: 'Delete',
            danger: true,
            onSelect: vi.fn(),
          },
        ]}
      />,
    );

    expect(await screen.findByRole('menu')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes when clicking outside the menu', async () => {
    const onClose = vi.fn();

    render(
      <>
        <button type="button">Outside</button>
        <AnchoredContextMenu
          x={120}
          y={180}
          onClose={onClose}
          items={[
            {
              key: 'delete',
              label: 'Delete',
              danger: true,
              onSelect: vi.fn(),
            },
          ]}
        />
      </>,
    );

    expect(await screen.findByRole('menu')).toBeTruthy();

    fireEvent.mouseDown(document);

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
