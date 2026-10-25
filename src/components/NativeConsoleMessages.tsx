import { useImperativeHandle, useRef, useState, type Ref } from 'react';
import type { NativeConsoleMessage, NativeConsoleMessageOrigin, NativeConsoleMessages as Messages } from '../types';
import { SimmButton } from './primitives';
import { nativeConsoleOriginKey, nativeConsoleSourceKey } from '../utils/nativeConsoleMessages';

function sourceName(entry: Pick<NativeConsoleMessage, 'origin' | 'source'>) {
  return entry.origin ? `${entry.origin.kind} · ${entry.origin.name}` : entry.source || 'Unknown source';
}

export interface NativeConsoleMessagesHandle {
  showOrigin: (origin: NativeConsoleMessageOrigin, level: 'error' | 'warning') => void;
}

export function NativeConsoleMessages({ value, controlRef, onViewLogs }: { value: Messages; controlRef?: Ref<NativeConsoleMessagesHandle>; onViewLogs?: (level: 'error' | 'warning' | 'all') => void }) {
  const [open, setOpen] = useState(false);
  const [level, setLevel] = useState('all');
  const [source, setSource] = useState('');
  const [sourceLabel, setSourceLabel] = useState('');
  const section = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useImperativeHandle(controlRef, () => ({ showOrigin: (origin, level) => {
    setSource(nativeConsoleOriginKey(origin)); setSourceLabel(`${origin.kind} · ${origin.name}`);
    setLevel(level); setOpen(true);
    heading.current?.focus({ preventScroll: true });
    section.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  } }), []);
  if (onViewLogs) return <section className="native-console-messages" aria-label="Current launch messages">
    <h2>Messages <small>Current launch</small></h2>
    <div className="native-console-message-counts">
      <SimmButton className="btn btn-secondary" variant="outline" size="sm" onClick={() => onViewLogs('error')}>Errors <strong>{value.errors}</strong></SimmButton>
      <SimmButton className="btn btn-secondary" variant="outline" size="sm" onClick={() => onViewLogs('warning')}>Warnings <strong>{value.warnings}</strong></SimmButton>
    </div>
    <div className="native-console-message-source"><small>{value.state === 'waiting' ? 'Waiting for current launch log' : value.state === 'reading' ? 'Reading Latest.log…' : 'Latest.log'}</small>
      <SimmButton className="btn btn-secondary" variant="outline" size="sm" onClick={() => onViewLogs('all')}>View logs</SimmButton></div>
    {value.diagnostic ? <p className="native-console-error" role="status">{value.diagnostic}</p> : null}
  </section>;
  const sources = new Map([...value.entries, ...value.sources].map((entry) => [nativeConsoleSourceKey(entry), sourceName(entry)]));
  if (source && !sources.has(source)) sources.set(source, `${sourceLabel || source.slice('source:'.length) || 'Unknown source'} · No messages`);
  const visible = value.entries.filter((entry) => (level === 'all' || entry.level === level) && (!source || source === nativeConsoleSourceKey(entry)));
  const total = source
    ? value.sources.filter((entry) => nativeConsoleSourceKey(entry) === source).reduce((count, entry) => count + (level === 'error' ? entry.errors : level === 'warning' ? entry.warnings : entry.errors + entry.warnings), 0)
    : level === 'error' ? value.errors : level === 'warning' ? value.warnings : value.errors + value.warnings;
  const earlier = Math.max(0, total - visible.length);
  const show = (level: string) => { setLevel(level); setSource(''); setOpen(true); };
  return <section ref={section} className="native-console-messages" aria-label="Errors and warnings">
    <h2 ref={heading} tabIndex={-1}>Messages</h2>
    <div className="native-console-message-counts">
      <SimmButton className="btn btn-secondary" variant="outline" size="sm" aria-pressed={open && level === 'error'} onClick={() => show('error')}>Errors <strong>{value.errors}</strong></SimmButton>
      <SimmButton className="btn btn-secondary" variant="outline" size="sm" aria-pressed={open && level === 'warning'} onClick={() => show('warning')}>Warnings <strong>{value.warnings}</strong></SimmButton>
    </div>
    <div className="native-console-message-source"><small>{value.state === 'waiting' ? 'Waiting for current launch log' : value.state === 'reading' ? 'Reading Latest.log…' : 'Latest.log · current launch'}</small>
      <SimmButton className="btn btn-secondary" variant="outline" size="sm" aria-expanded={open} onClick={() => { setOpen(!open); if (!open) { setLevel('all'); setSource(''); } }}>{open ? 'Hide messages' : 'View messages'}</SimmButton>
    </div>
    {value.diagnostic ? <p className="native-console-error" role="status">{value.diagnostic}</p> : null}
    {open ? <div className="native-console-message-viewer">
      <label>Severity<select aria-label="Message severity" value={level} onChange={(event) => setLevel(event.target.value)}><option value="all">Errors and warnings</option><option value="error">Errors</option><option value="warning">Warnings</option></select></label>
      <label>Source<select aria-label="Message source" value={source} onChange={(event) => { setSource(event.target.value); setSourceLabel(sources.get(event.target.value) || ''); }}><option value="">All sources</option>{[...sources].sort((a, b) => a[1].localeCompare(b[1])).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label>
      {earlier > 0 ? <p className="native-console-note">Showing {visible.length} of {total} matching messages. Earlier messages are in Latest.log.</p> : null}
      {visible.length ? <ol className="native-console-message-list" aria-label="Warning and error messages" tabIndex={0}>
        {visible.map((entry) => <li key={`${value.generation}:${entry.id}`}><details>
          <summary><span className="native-console-message-meta"><span>{entry.level === 'error' ? 'Error' : 'Warning'}</span><time>{entry.timestamp || '—'}</time></span><strong>{sourceName(entry)}</strong><span className="native-console-message-preview">{entry.message.split('\n')[0] || 'Empty message'}</span></summary>
          <div className="native-console-message-body">
            {entry.origin?.fileName ? <p className="native-console-path">{entry.origin.fileName}</p> : null}
            <p className="native-console-note">Source tag: {entry.source || 'None'} · Line {entry.lineNumber}</p>
            {!entry.origin ? <p className="native-console-note">Mod/plugin: Unidentified</p> : null}
            <pre>{entry.message}</pre>
            {entry.truncated ? <p className="native-console-note">Long message shortened. Full text is in Latest.log.</p> : null}
          </div>
        </details></li>)}
      </ol> : <p className="native-console-note">{earlier > 0 ? 'No retained messages match these filters. Earlier messages are in Latest.log.' : value.entries.length ? 'No messages match these filters.' : value.state === 'ready' ? 'No errors or warnings in this log.' : 'No messages available yet.'}</p>}
    </div> : null}
  </section>;
}
