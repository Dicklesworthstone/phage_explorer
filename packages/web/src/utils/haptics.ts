/**
 * Haptics Utility - Native-Feeling Touch Feedback
 *
 * Provides tactile feedback patterns similar to iOS/Android native apps.
 * Gracefully degrades on devices without vibration support.
 *
 * Design inspired by Apple's Human Interface Guidelines and
 * Android's Material Design haptic patterns.
 */

export type HapticPattern =
  | 'light'      // Subtle tap - selecting items, toggles
  | 'medium'     // Standard confirmation - button press
  | 'heavy'      // Strong feedback - important actions
  | 'success'    // Positive outcome - task complete
  | 'warning'    // Caution - destructive action available
  | 'error'      // Negative outcome - error occurred
  | 'selection'  // Quick selection change - picker, slider
  | 'impact';    // Physical impact feel - drag drop

// Vibration patterns in milliseconds [vibrate, pause, vibrate, ...]
const HAPTIC_PATTERNS: Record<HapticPattern, number | number[]> = {
  light: 10,
  medium: 25,
  heavy: 50,
  success: [15, 50, 25],       // Short-pause-longer
  warning: [30, 80, 30],       // Alert pattern
  error: [50, 100, 50, 100, 50], // Triple buzz
  selection: 5,                 // Barely perceptible
  impact: 35,
};

// Check if device supports vibration
function supportsVibration(): boolean {
  return typeof navigator !== 'undefined' && 'vibrate' in navigator;
}

// Check if user prefers reduced motion
function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Trigger haptic feedback with specified pattern
 */
export function haptic(pattern: HapticPattern = 'medium'): void {
  // Skip if user prefers reduced motion
  if (prefersReducedMotion()) return;

  // Skip if device doesn't support vibration
  if (!supportsVibration()) return;

  try {
    const vibrationPattern = HAPTIC_PATTERNS[pattern];
    navigator.vibrate(vibrationPattern);
  } catch {
    // Silently fail - haptics are non-critical
  }
}

/**
 * Light tap - for toggles, selections, minor interactions
 */
export function hapticLight(): void {
  haptic('light');
}

/**
 * Medium tap - for button presses, confirmations
 */
export function hapticMedium(): void {
  haptic('medium');
}

/**
 * Heavy tap - for important actions, navigation
 */
export function hapticHeavy(): void {
  haptic('heavy');
}

/**
 * Success pattern - for completed actions
 */
export function hapticSuccess(): void {
  haptic('success');
}

/**
 * Warning pattern - for destructive action warnings
 */
export function hapticWarning(): void {
  haptic('warning');
}

/**
 * Error pattern - for failed actions
 */
export function hapticError(): void {
  haptic('error');
}

/**
 * Selection pattern - for quick selections (pickers, sliders)
 */
export function hapticSelection(): void {
  haptic('selection');
}

/**
 * Impact pattern - for drag/drop, physical interactions
 */
export function hapticImpact(): void {
  haptic('impact');
}

/**
 * Custom vibration pattern
 * @param pattern - Array of [vibrate, pause, vibrate, ...] in ms
 */
export function hapticCustom(pattern: number[]): void {
  if (prefersReducedMotion()) return;
  if (!supportsVibration()) return;

  try {
    navigator.vibrate(pattern);
  } catch {
    // Silently fail
  }
}

/**
 * Cancel any ongoing vibration
 */
export function hapticCancel(): void {
  if (!supportsVibration()) return;

  try {
    navigator.vibrate(0);
  } catch {
    // Silently fail
  }
}

/**
 * React hook helper - returns haptic functions
 * Usage: const { tap, success } = useHaptics();
 */
export const haptics = {
  light: hapticLight,
  medium: hapticMedium,
  heavy: hapticHeavy,
  success: hapticSuccess,
  warning: hapticWarning,
  error: hapticError,
  selection: hapticSelection,
  impact: hapticImpact,
  cancel: hapticCancel,
  custom: hapticCustom,
};

export default haptics;
