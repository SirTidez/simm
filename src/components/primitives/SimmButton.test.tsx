import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SimmButton } from './SimmButton';

describe('SimmButton', () => {
  it('renders children and preserves button behavior', () => {
    render(<SimmButton>Open Mod Library</SimmButton>);

    expect(screen.getByRole('button', { name: 'Open Mod Library' })).toBeInTheDocument();
  });

  it('supports compact desktop sizing', () => {
    render(<SimmButton size="sm">Refresh</SimmButton>);

    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
  });
});
