import { memo } from 'react';
import { FontAwesomeIcon, type FontAwesomeIconProps } from '@fortawesome/react-fontawesome';
import { iconRegistry, resolveIconName, type IconName } from './icons';

type IconProps = Omit<FontAwesomeIconProps, 'icon'> & {
  name: IconName | string;
  label?: string;
};

function IconComponent({ name, label, title, spin, pulse, ...props }: IconProps) {
  const resolvedName = resolveIconName(name);
  const impliedSpin = typeof name === 'string' && /\bfa-spin\b/.test(name);
  const impliedPulse = typeof name === 'string' && /\bfa-pulse\b/.test(name);
  return (
    <FontAwesomeIcon
      icon={iconRegistry[resolvedName]}
      aria-hidden={label ? undefined : (props['aria-hidden'] ?? true)}
      aria-label={label}
      title={title}
      spin={spin ?? impliedSpin}
      pulse={pulse ?? impliedPulse}
      {...props}
    />
  );
}

export const Icon = memo(IconComponent);
