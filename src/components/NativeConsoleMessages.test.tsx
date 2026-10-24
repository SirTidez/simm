import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { NativeConsoleMessages as Messages } from '../types';
import { NativeConsoleMessages } from './NativeConsoleMessages';
import { nativeConsoleOriginKey } from '../utils/nativeConsoleMessages';

afterEach(cleanup);
const value: Messages = {
  errors: 1, warnings: 2, omitted: 0, generation: 1, state: 'ready', diagnostic: null,
  sources: [],
  entries: [
    { id: 3, lineNumber: 8, level: 'error', timestamp: '12:01:03.004', source: 'Probe', origin: { name: 'Test plugin', fileName: 'Probe.dll', kind: 'Plugin' }, message: 'Plugin failed\n   at Probe.Run()', truncated: false },
    { id: 2, lineNumber: 6, level: 'warning', timestamp: '12:01:02.003', source: 'Save_Expansion', origin: { name: 'Save Expansion', fileName: 'SaveExpansion.dll', kind: 'Mod' }, message: 'Missing optional item', truncated: false },
    { id: 1, lineNumber: 2, level: 'warning', timestamp: null, source: 'Custom logger', origin: null, message: '<img src=x onerror=alert(1)>', truncated: false },
  ],
};

describe('Environment status messages', () => {
  it('opens the count for one severity and shows the matched plugin and full multiline message', () => {
    render(<NativeConsoleMessages value={value} />);
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Errors 1' }));
    expect(screen.getByRole('combobox', { name: 'Message severity' })).toHaveValue('error');
    const list = screen.getByRole('list', { name: 'Warning and error messages' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByText('Plugin · Test plugin', { selector: 'strong' })).toBeInTheDocument();
    fireEvent.click(screen.getByText('Plugin · Test plugin', { selector: 'strong' }));
    expect(screen.getByText('Probe.dll')).toBeVisible();
    expect(screen.getByText('Source tag: Probe · Line 8')).toBeVisible();
    expect(list.querySelector('pre')).toHaveTextContent('Plugin failed at Probe.Run()');
    expect(list.querySelector('pre')?.textContent).toContain('\n   at Probe.Run()');
  });

  it('filters warnings by source and preserves the original tag for an unmatched logger', () => {
    render(<NativeConsoleMessages value={value} />);
    fireEvent.click(screen.getByRole('button', { name: 'Warnings 2' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Message source' }), { target: { value: 'source:Custom logger' } });
    const list = screen.getByRole('list');
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    fireEvent.click(within(list).getByText('Custom logger'));
    expect(screen.getByText('Mod/plugin: Unidentified')).toBeVisible();
    expect(screen.getByText('<img src=x onerror=alert(1)>', { selector: 'pre' })).toBeVisible();
    expect(list.querySelector('img')).toBeNull();
  });

  it('keeps filters and expanded messages when the live counts update', () => {
    const view = render(<NativeConsoleMessages value={value} />);
    fireEvent.click(screen.getByRole('button', { name: 'Errors 1' }));
    fireEvent.click(screen.getByText('Plugin · Test plugin', { selector: 'strong' }));
    view.rerender(<NativeConsoleMessages value={{ ...value, errors: 2, entries: [{ ...value.entries[0], id: 4, message: 'Another error' }, ...value.entries] }} />);
    expect(screen.getByRole('button', { name: 'Errors 2' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('list').querySelector('details[open] .native-console-path')).toHaveTextContent('Probe.dll');
    expect(within(screen.getByRole('list')).getAllByRole('listitem')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Hide messages' }));
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('distinguishes waiting, empty logs, retention and truncated text', () => {
    const view = render(<NativeConsoleMessages value={{ ...value, errors: 0, warnings: 0, entries: [], state: 'waiting' }} />);
    expect(screen.getByText('Waiting for current launch log')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'View messages' }));
    expect(screen.getByText('No messages available yet.')).toBeInTheDocument();
    view.rerender(<NativeConsoleMessages value={{ ...value, errors: 0, warnings: 0, entries: [] }} />);
    expect(screen.getByText('No errors or warnings in this log.')).toBeInTheDocument();
    view.rerender(<NativeConsoleMessages value={{ ...value, errors: 7, omitted: 8, entries: [{ ...value.entries[0], truncated: true }] }} />);
    expect(screen.getByText('Showing 1 of 9 matching messages. Earlier messages are in Latest.log.')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Plugin · Test plugin', { selector: 'strong' }));
    expect(screen.getByText('Long message shortened. Full text is in Latest.log.')).toBeVisible();
  });

  it('keeps the source filter visible if rotation or retention removes its last message', () => {
    const view = render(<NativeConsoleMessages value={value} />);
    fireEvent.click(screen.getByRole('button', { name: 'View messages' }));
    const source = nativeConsoleOriginKey(value.entries[0].origin!);
    fireEvent.change(screen.getByRole('combobox', { name: 'Message source' }), { target: { value: source } });
    view.rerender(<NativeConsoleMessages value={{ ...value, generation: 2, errors: 0, entries: [value.entries[1]] }} />);
    expect(screen.getByRole('combobox', { name: 'Message source' })).toHaveValue(source);
    expect(screen.getByRole('option', { name: 'Plugin · Test plugin · No messages' })).toBeInTheDocument();
    expect(screen.getByText('No messages match these filters.')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Message source' }), { target: { value: '' } });
    expect(within(screen.getByRole('list')).getAllByRole('listitem')).toHaveLength(1);
  });
});
