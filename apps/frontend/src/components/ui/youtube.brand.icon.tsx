import { FC } from 'react';
import clsx from 'clsx';

// Official full-color icon from https://brand.youtube/youtube-icon/.
// The source PNG includes clear space; at 48 × 42 CSS pixels the visible
// red icon is approximately 32 × 23 pixels.
export const YoutubeBrandIcon: FC<{ className?: string }> = ({ className }) => (
  <img
    src="/icons/platforms/youtube.png"
    alt="YouTube"
    width={48}
    height={42}
    className={clsx('block h-[42px] w-[48px] max-w-none shrink-0 object-contain', className)}
  />
);
