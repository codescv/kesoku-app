import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';
import { isNative } from './platform';

/** Light tap feedback for button presses. No-op on the web; never throws. */
export async function hapticTap(): Promise<void> {
  if (!isNative()) return;
  try {
    await Haptics.impact({ style: ImpactStyle.Light });
  } catch {
    // Haptics are best-effort (e.g. disabled by the user or unsupported hardware).
  }
}

/** Success notification haptic (e.g. completing a workout set or finishing a workout). No-op on web; never throws. */
export async function hapticSuccess(): Promise<void> {
  if (!isNative()) return;
  try {
    await Haptics.notification({ type: NotificationType.Success });
  } catch {
    // Best-effort only.
  }
}
