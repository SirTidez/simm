import {
  Fragment,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { safeExternalUrl } from './modCardHelpers';

type NexusBbCodeNode = string | {
  name: string;
  parameter?: string;
  children: NexusBbCodeNode[];
};

const SUPPORTED_TAGS = new Set([
  'b',
  'br',
  'center',
  'code',
  'color',
  'font',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'img',
  'left',
  'line',
  'list',
  'quote',
  'right',
  's',
  'size',
  'spoiler',
  'strike',
  'u',
  'url',
  'youtube',
  '*',
]);

const SELF_CLOSING_TAGS = new Set(['br', 'hr', 'line']);
const TAG_PATTERN = /\[(\/?)(([a-z][a-z0-9]*)|\*)(?:(?:=|\s+)([^\]]+))?\]/gi;
const HTML_BREAK_PATTERN = /<br\s*\/?\s*>/gi;
const DESCRIPTION_PREVIEW_HEIGHT_PX = 192;

function normalizeParameter(parameter?: string): string | undefined {
  const normalized = parameter?.trim();
  if (!normalized) return undefined;
  if (
    normalized.length >= 2
    && ((normalized.startsWith('"') && normalized.endsWith('"'))
      || (normalized.startsWith("'") && normalized.endsWith("'")))
  ) {
    return normalized.slice(1, -1).trim() || undefined;
  }
  return normalized;
}

function parseNexusBbCode(input: string): NexusBbCodeNode[] {
  const normalizedInput = input.replace(HTML_BREAK_PATTERN, '[br]');
  const root: { name: 'root'; children: NexusBbCodeNode[] } = { name: 'root', children: [] };
  const stack: Array<{ name: string; children: NexusBbCodeNode[] }> = [root];
  const current = () => stack[stack.length - 1];
  let cursor = 0;

  TAG_PATTERN.lastIndex = 0;
  for (let match = TAG_PATTERN.exec(normalizedInput); match; match = TAG_PATTERN.exec(normalizedInput)) {
    if (match.index > cursor) {
      current().children.push(normalizedInput.slice(cursor, match.index));
    }

    const rawTag = match[0];
    const closing = match[1] === '/';
    const name = match[2].toLowerCase();
    const parameter = normalizeParameter(match[4]);
    cursor = TAG_PATTERN.lastIndex;

    if (!SUPPORTED_TAGS.has(name)) {
      current().children.push(rawTag);
      continue;
    }

    if (closing) {
      if (name === 'list' && current().name === '*') {
        stack.pop();
      }
      if (stack.length > 1 && current().name === name) {
        stack.pop();
      } else {
        current().children.push(rawTag);
      }
      continue;
    }

    if (name === '*') {
      if (current().name === '*') {
        stack.pop();
      }
      if (current().name !== 'list') {
        current().children.push(rawTag);
        continue;
      }
    }

    const node = { name, parameter, children: [] as NexusBbCodeNode[] };
    current().children.push(node);
    if (!SELF_CLOSING_TAGS.has(name)) {
      stack.push(node);
    }
  }

  if (cursor < normalizedInput.length) {
    current().children.push(normalizedInput.slice(cursor));
  }

  return root.children;
}

function nodeText(nodes: NexusBbCodeNode[]): string {
  return nodes.map((node) => (
    typeof node === 'string' ? node : nodeText(node.children)
  )).join('');
}

function renderListChildren(children: NexusBbCodeNode[], path: string): ReactNode[] {
  return children.flatMap((child, index) => {
    const key = `${path}-${index}`;
    if (typeof child === 'string') {
      return child.trim() ? [<li key={key}>{child.trim()}</li>] : [];
    }
    if (child.name === '*') {
      return [<li key={key}>{renderNodes(child.children, key)}</li>];
    }
    return [<li key={key}>{renderNode(child, key)}</li>];
  });
}

function renderNode(node: Exclude<NexusBbCodeNode, string>, key: string): ReactNode {
  const children = renderNodes(node.children, key);
  switch (node.name) {
    case 'b':
      return <strong key={key}>{children}</strong>;
    case 'i':
      return <em key={key}>{children}</em>;
    case 'u':
      return <u key={key}>{children}</u>;
    case 's':
    case 'strike':
      return <s key={key}>{children}</s>;
    case 'br':
      return <br key={key} />;
    case 'hr':
    case 'line':
      return <hr key={key} />;
    case 'h1':
      return <h2 key={key}>{children}</h2>;
    case 'h2':
      return <h3 key={key}>{children}</h3>;
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return <h4 key={key}>{children}</h4>;
    case 'size': {
      const size = Math.min(6, Math.max(1, Number.parseInt(node.parameter || '3', 10) || 3));
      return <span key={key} className={`nexus-bbcode__size nexus-bbcode__size--${size}`}>{children}</span>;
    }
    case 'center':
    case 'right':
    case 'left':
      return <div key={key} className={`nexus-bbcode__align nexus-bbcode__align--${node.name}`}>{children}</div>;
    case 'list': {
      const ordered = node.parameter === '1' || node.parameter?.toLowerCase() === 'a';
      return ordered
        ? <ol key={key}>{renderListChildren(node.children, key)}</ol>
        : <ul key={key}>{renderListChildren(node.children, key)}</ul>;
    }
    case 'quote':
      return (
        <blockquote key={key}>
          {node.parameter ? <cite>{node.parameter}</cite> : null}
          {children}
        </blockquote>
      );
    case 'code':
      return <pre key={key}><code>{nodeText(node.children)}</code></pre>;
    case 'spoiler':
      return (
        <details key={key}>
          <summary>{node.parameter || 'Show details'}</summary>
          <div className="nexus-bbcode__spoiler-content">{children}</div>
        </details>
      );
    case 'url': {
      const target = safeExternalUrl(node.parameter || nodeText(node.children).trim());
      return target
        ? <a key={key} href={target} target="_blank" rel="noopener noreferrer">{children}</a>
        : <Fragment key={key}>{children}</Fragment>;
    }
    case 'img': {
      const target = safeExternalUrl(nodeText(node.children).trim());
      return target
        ? <a key={key} href={target} target="_blank" rel="noopener noreferrer">View image</a>
        : null;
    }
    case 'youtube': {
      const rawTarget = nodeText(node.children).trim();
      const target = /^[A-Za-z0-9_-]{6,20}$/.test(rawTarget)
        ? `https://www.youtube.com/watch?v=${rawTarget}`
        : safeExternalUrl(rawTarget);
      return target
        ? <a key={key} href={target} target="_blank" rel="noopener noreferrer">Watch video</a>
        : <Fragment key={key}>{children}</Fragment>;
    }
    case 'color':
    case 'font':
    case '*':
    default:
      return <Fragment key={key}>{children}</Fragment>;
  }
}

function renderNodes(nodes: NexusBbCodeNode[], path = 'nexus-bbcode'): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${path}-${index}`;
    return typeof node === 'string'
      ? <Fragment key={key}>{node}</Fragment>
      : renderNode(node, key);
  });
}

export function NexusBbCode({ children }: { children: string }) {
  return <div className="nexus-bbcode">{renderNodes(parseNexusBbCode(children))}</div>;
}

function descriptionLikelyNeedsPreview(input: string): boolean {
  const breakCount = input.match(/(?:\[br\]|<br\s*\/?\s*>|\r?\n)/gi)?.length ?? 0;
  return input.length > 360 || breakCount > 6;
}

export function NexusDescription({ children }: { children: string }) {
  const contentId = useId();
  const contentRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [canExpand, setCanExpand] = useState(() => descriptionLikelyNeedsPreview(children));

  useEffect(() => {
    setExpanded(false);
  }, [children]);

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return undefined;

    const measure = () => {
      setCanExpand(
        descriptionLikelyNeedsPreview(children)
          || content.scrollHeight > DESCRIPTION_PREVIEW_HEIGHT_PX + 1,
      );
    };

    measure();
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(measure);
      observer.observe(content);
      return () => observer.disconnect();
    }

    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [children]);

  return (
    <div className="nexus-description">
      <div
        id={contentId}
        ref={contentRef}
        className={[
          'nexus-description__content',
          expanded ? 'nexus-description__content--expanded' : 'nexus-description__content--collapsed',
          canExpand && !expanded ? 'nexus-description__content--clamped' : '',
        ].filter(Boolean).join(' ')}
      >
        <NexusBbCode>{children}</NexusBbCode>
      </div>
      {canExpand ? (
        <button
          type="button"
          className="nexus-description__toggle"
          aria-controls={contentId}
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? 'Show less' : 'Show full description'}
        </button>
      ) : null}
    </div>
  );
}
