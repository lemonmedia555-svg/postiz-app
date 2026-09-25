import { FC } from 'react';
import clsx from 'clsx';

// Official full-color icon from https://brand.youtube/youtube-icon/.
// The source PNG includes clear space; at 48 × 42 CSS pixels the visible
// red icon is approximately 32 × 23 pixels.
export const YoutubeBrandIcon: FC<{ className?: string; href?: string }> = ({ className, href }) => {
  const icon = <img
    src="/icons/platforms/youtube.png"
    alt="YouTube"
    width={48}
    height={42}
    className={clsx('block h-[42px] w-[48px] max-w-none shrink-0 object-contain', !href && className)}
  />;
  return href ? <a href={href} className={className} aria-label="Open YouTube" target="_blank" rel="noopener noreferrer">{icon}</a> : icon;
};
