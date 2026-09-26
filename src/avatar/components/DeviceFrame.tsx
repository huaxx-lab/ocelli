/**
 * DeviceFrame.tsx — the round device bezel.
 *
 * The brief requires the render to look like it is on the real hardware, at the
 * real size: the M5Stack StopWatch is a 1.75-inch 466×466 round AMOLED. So the
 * avatar is clipped to a true circle of exactly 466 CSS pixels on a desktop.
 *
 * On a phone that is wider than the viewport, so the frame scales down to fit
 * rather than overflowing. The canvas measures its own CSS size, so the avatar
 * stays sharp at any size instead of being upscaled and blurred.
 *
 * Deliberately NO bezel ring, glow, vignette or sheen: the reference device is
 * a plain black round panel, and every one of those decorations reads as a
 * drawn UI element rather than as the hardware.
 */

import { useEffect, useRef, type ReactNode } from 'react';
import styles from './DeviceFrame.module.css';

export interface DeviceFrameProps {
  children: ReactNode;
  /** Nominal diameter in CSS pixels. 466 = the StopWatch's resolution. */
  size?: number;
  className?: string;
}

export function DeviceFrame({ children, size = 466, className }: DeviceFrameProps) {
  const shellRef = useRef<HTMLDivElement | null>(null);

  // Expose the measured diameter as a CSS variable so the canvas host can size
  // its backing store to the *actual* rendered size, not the nominal one.
  useEffect(() => {
    const el = shellRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const apply = () => {
      const w = el.clientWidth;
      if (w > 0) el.style.setProperty('--device-diameter', `${w}px`);
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      ref={shellRef}
      className={`${styles.shell} ${className ?? ''}`}
      style={{ ['--device-nominal' as string]: `${size}px` }}
    >
      {/* The active area: a true circle, clipped. */}
      <div className={styles.screen}>{children}</div>
    </div>
  );
}
